/**
 * Publish pipeline (per-run) — orchestrator for one publish operation
 * (N items × M targets × locale variants).
 *
 * Today admin's POST `/api/publish` and CLI's `runPublish` each inline
 * the same fan-out: validate → scan templates → loadSite → expand
 * dependencies → init targets → loop (target × item) → write dep
 * indices → write site manifest → cache purge → record history →
 * audit. Two callers, ~1500 lines of duplicated orchestration.
 *
 * `publishRun` is the seam both callers route through. Per-item core
 * (`publishItemCore` in publish-item.ts) handles single-item rendering;
 * this orchestrator owns cross-item concerns: dependency expansion via
 * `findDependentsFromSidecars`, shared template-scan, shared loadSite,
 * per-target init, fan-out fail-soft, progress emission, aggregate
 * result.
 *
 * Pipeline order is locked semantics, not configuration. Per-run:
 *
 *   1. validate input (items + targets non-empty, names known)
 *   2. capability gate per target (publish:non-production /
 *      publish:production via Principal)
 *   3. boot: scan + hash templates ONCE
 *   4. boot: loadSite ONCE per source
 *   5. expand items via findDependentsFromSidecars (transitive —
 *      publishing @header pulls dependent pages)
 *   6. boot: init target storage (registry connect, per-target type
 *      resolution per design-rendering.md)
 *   7. (RESERVED) per-target review-publish-approval gate — Review
 *      Cut 9: targets w/ requiresPublishApproval create request,
 *      don't deploy
 *   8. (RESERVED) dispatchBeforePublishRun hooks
 *   9. for each target: { for each item: per-item pipeline }
 *  10. for each target: publishDepIndices (asset-refs, fragment-deps,
 *      archive-aliases sidecars)
 *  11. for each target: publishSiteManifest (site.json snapshot)
 *  12. for each target: cache-purge dispatch (cloudflare/configured
 *      strategy, fire-and-forget)
 *  13. record history revision per target
 *  14. (RESERVED) dispatchAfterPublishRun hooks
 *  15. audit success per (item, target, outcome)
 *  16. (RESERVED) cascades — Soft-Delete Q6 auto-cancel scheduled
 *      actions on publish-of-archived
 *  17. aggregate PublishRunResult, return
 *
 * Boot fail-fast (steps 1-6), per-item/per-target fail-soft (Q4 lock).
 */

import { publishAssets } from './assets/publish.js'
import type { Principal } from './auth/types.js'
import { createContentRoot, type ContentRoot } from './content-root.js'
import { publishFragment, resolveFragmentRenderMode } from './fragments/publish.js'
import { hashManifest } from './hash.js'
import type { HistoryProvider } from './history.js'
import { publishPage, resolvePageRenderMode } from './pages/publish.js'
import type { PublishItemKind, PublishItemResult, PublishRenderMode, PublishTarget } from './publish-item.js'
import { publishDepIndices, publishSiteManifest } from './publish-rendered.js'
import type { Site } from './site-loader.js'
import { templateHashesFrom, type TemplateInfo } from './templates-scan.js'
import { getType } from './types.js'

/**
 * Map the config's target type onto the publish pipeline's rendering
 * type. Config `TargetType` is still `'static' | 'dynamic'`, and today's
 * `'dynamic'` is the ESI target: a worker assembles pages from separately
 * published fragments at request time. The pipeline already speaks the
 * three-type taxonomy of design-rendering.md (`'esi'` = ESI placeholders;
 * `'dynamic'` = request-time SSR with static page fallback), so passing
 * `'dynamic'` through baked every page and broke fragment-only publishes.
 * When design-rendering.md Cut 1 widens `TargetType`, this mapping goes.
 */
function renderTargetType(type: 'static' | 'dynamic'): PublishTarget['type'] {
  return type === 'dynamic' ? 'esi' : 'static'
}
import type { PurgeStrategy, SiteManifest, StorageProvider, TargetConfig } from './types.js'

/**
 * Reference to one item being published. Locale undefined =
 * default locale variant only; locale set = explicit variant
 * (caller can split a single page name into multiple ItemRefs
 * for per-locale fan-out).
 */
export interface PublishItemRef {
  readonly kind: PublishItemKind
  readonly name: string
  readonly locale?: string
}

/**
 * Per-target outcome. Fan-out fail-soft (Q4): one target's failure
 * doesn't block others. `failed: true` when target init failed OR
 * when ALL items for this target failed; otherwise `false` even
 * when some items failed (per-item failures live in items[]).
 */
export interface PublishTargetResult {
  readonly name: string
  readonly failed: boolean
  readonly failureReason?: string
  /** Files written across this target (sum of item.files). */
  readonly filesWritten: number
  /** Files removed across this target (sum of item.removed). */
  readonly filesRemoved: number
}

/**
 * Aggregate result of one publish run. `ok` derived: every item
 * succeeded AND every target succeeded. Caller (CLI exit code,
 * admin response status) reads this directly.
 */
export interface PublishRunResult {
  readonly ok: boolean
  readonly items: readonly PublishItemResult[]
  readonly targets: readonly PublishTargetResult[]
}

/**
 * Streaming progress event. Emitted via `onProgress` callback in
 * input. Admin route forwards to SSE; CLI writes to stdout.
 */
export type PublishProgressEvent =
  | { readonly kind: 'run-start'; readonly totalItems: number; readonly totalTargets: number }
  | { readonly kind: 'target-start'; readonly target: string }
  | {
      readonly kind: 'item-start'
      readonly item: PublishItemRef
      readonly target: string
      readonly mode: PublishRenderMode
    }
  | { readonly kind: 'item-done'; readonly result: PublishItemResult; readonly target: string }
  | { readonly kind: 'target-done'; readonly result: PublishTargetResult }
  | { readonly kind: 'run-done'; readonly result: PublishRunResult }

/**
 * Inputs to `publishRun`. Caller assembles items + targets + source
 * wiring; orchestrator does the rest.
 */
export interface PublishRunInput {
  /**
   * Items to publish. v1 spine treats this list verbatim — caller
   * (CLI / admin route) does dependency expansion via
   * `findDependentsFromSidecars` BEFORE calling. Reserved future:
   * orchestrator owns expansion when CLI + admin both migrate.
   */
  readonly items: readonly PublishItemRef[]
  /** Target names to publish to (must exist in `targetStorages` + `targetConfigs`). */
  readonly targets: readonly string[]
  /**
   * Loaded site. Caller does `loadSite()` ONCE for the publish run
   * (loadSite is heavy; orchestrator reuses across all items × targets).
   */
  readonly site: Site
  /** Source content tree — used by per-item core for sidecar refs. */
  readonly sourceRoot: ContentRoot
  /** Project-level site manifest (drives target type resolution etc.). */
  readonly siteManifest: SiteManifest
  /**
   * Per-target storage providers (registry-resolved). Caller calls
   * `createTargetRegistry` and unwraps before passing.
   */
  readonly targetStorages: ReadonlyMap<string, StorageProvider>
  /**
   * Per-target manifest hashes for incremental publish. Caller computes
   * via `hashManifest(item, { templateHashes, fragmentHashes? })`.
   * Optional — when absent and `templateInfos` is supplied, orchestrator
   * computes per-item hashes inline (using the canonical hashManifest
   * with templateHashes from scan + fragmentHashes for static-mode pages).
   */
  readonly itemHashes?: ReadonlyMap<string, string>
  /**
   * Pre-scanned templates. When supplied, orchestrator uses the
   * derived hashes for sidecar emission AND short-circuits with
   * `TEMPLATE_INVALID` when invalid templates are detected. Caller
   * (CLI / admin route) does the scan once before the run.
   *
   * When absent, orchestrator skips template-hash computation and
   * trusts caller-supplied `itemHashes`.
   */
  readonly templateInfos?: readonly TemplateInfo[]
  /**
   * Per-target asset publish. When true (default), orchestrator runs
   * `publishAssets` per target before per-item renders so static-mode
   * pages don't bake in URLs to bytes that aren't on the target yet.
   */
  readonly publishAssetsBeforeItems?: boolean
  /**
   * Per-target dep-index emit. When true (default), orchestrator runs
   * `publishDepIndices` after all items publish (asset-refs +
   * fragment-deps + archive-aliases sidecars on target).
   */
  readonly publishDepIndicesAfter?: boolean
  /**
   * Per-target site manifest emit. When true (default), orchestrator
   * runs `publishSiteManifest` after items publish so target's
   * `site.json` reflects the source's site name + version.
   */
  readonly publishSiteManifestAfter?: boolean
  /** Authenticated principal driving this publish (reserved for capability gates + audit). */
  readonly principal?: Principal
  /** History provider per source (reserved for revision recording — Cut 5+ extension). */
  readonly history?: HistoryProvider
  /** Cache purge strategy (reserved — fire-and-forget post-publish). */
  readonly purgeStrategy?: PurgeStrategy
  /**
   * `--force`: reserved for future incremental skip logic. Today's
   * orchestrator publishes every item in the list verbatim — caller
   * pre-filters via compareTargets if it wants to skip unchanged.
   */
  readonly force?: boolean
  /** Streaming callback emitted at run / target / item boundaries. */
  readonly onProgress?: (event: PublishProgressEvent) => void
}

/**
 * Item-key encoding for `itemHashes` lookup. Mirrors compareTargets
 * convention: `pages/{name}` for default locale; `pages/{name}:{locale}`
 * for locale variants. Same for fragments.
 */
function itemKey(ref: PublishItemRef): string {
  const base = `${ref.kind === 'page' ? 'pages' : 'fragments'}/${ref.name}`
  return ref.locale ? `${base}:${ref.locale}` : base
}

/**
 * Publish pipeline orchestrator (per-run) — Cut 5.
 *
 * Ports the load-bearing fan-out from `cli/index.ts:runPublish` +
 * admin-api/routes/publish.ts: validate inputs → loop targets ×
 * items via `publishPage` / `publishFragment` → aggregate per-target
 * + per-item results → emit progress events.
 *
 * v1 scope (intentional): pure fan-out. Caller-supplied responsibilities
 * (kept in CLI / admin until Cuts 6-7 migrate them):
 *   - Template scan + hash (`scanTemplates` / `templateHashesFrom`)
 *   - loadSite (passed in via `input.site`)
 *   - Asset publish (publishAssets — runs before publishRun)
 *   - Dependency expansion (findDependentsFromSidecars — caller pre-expands items)
 *   - Compare/incremental skip (compareTargets — caller pre-filters items)
 *   - Per-target dep indices (publishDepIndices — runs after publishRun)
 *   - Site manifest emit (publishSiteManifest — runs after publishRun)
 *   - Cache purge (purgeStrategy — runs after publishRun, reserved input)
 *   - History recording (recordWrite — runs after publishRun, reserved input)
 *   - Audit events (per-item + per-run — reserved Cut 5+)
 *
 * Per Q4 fail-soft: per-target init failures fail just that target;
 * per-item failures continue with next item. Boot fail-fast (steps
 * 1-2) only when input is structurally invalid.
 */
export async function publishRun(input: PublishRunInput): Promise<PublishRunResult> {
  // Step 1 — validate input. Empty items + targets is fast-path
  // success (no-op); unknown target is operator error → boot fail-fast.
  if (input.items.length === 0 && input.targets.length === 0) {
    return { ok: true, items: [], targets: [] }
  }
  if (input.targets.length === 0) {
    throw new Error('publishRun: no targets specified')
  }
  for (const targetName of input.targets) {
    if (!input.targetStorages.has(targetName)) {
      throw new Error(`publishRun: target "${targetName}" not in registry`)
    }
  }

  // Step 3 — template precheck. Invalid templates abort the run
  // (boot fail-fast per Q4) — refuse to publish broken templates.
  if (input.templateInfos) {
    const invalid = input.templateInfos.filter(t => !t.valid)
    if (invalid.length > 0) {
      throw new Error(`publishRun: refusing to publish with invalid templates: ${invalid.map(t => t.name).join(', ')}`)
    }
  }

  // Compute hash maps once: templateHashes for all items;
  // fragmentHashes for static-mode page hash composition (so a fragment
  // change invalidates every static page that bakes it in).
  const templateHashes = input.templateInfos ? templateHashesFrom([...input.templateInfos]) : new Map<string, string>()
  const fragmentHashes = new Map<string, string>()
  if (input.templateInfos) {
    for (const [fragName, frag] of input.site.fragments) {
      fragmentHashes.set(fragName, hashManifest(frag, { templateHashes }))
    }
  }

  // Defaults for per-target side-effects (Q5 spine steps 10-12).
  const doAssetPublish = input.publishAssetsBeforeItems ?? true
  const doDepIndices = input.publishDepIndicesAfter ?? true
  const doSiteManifest = input.publishSiteManifestAfter ?? true

  input.onProgress?.({
    kind: 'run-start',
    totalItems: input.items.length,
    totalTargets: input.targets.length,
  })

  const allItems: PublishItemResult[] = []
  const allTargets: PublishTargetResult[] = []

  // Steps 9-12 condensed: loop targets × items. Per-target failure
  // (no storage) skips the whole target; per-item failures aggregate.
  for (const targetName of input.targets) {
    const targetStorage = input.targetStorages.get(targetName)
    if (!targetStorage) {
      // Defensive — already validated above, but keep typed.
      allTargets.push({
        name: targetName,
        failed: true,
        failureReason: 'target storage not initialized',
        filesWritten: 0,
        filesRemoved: 0,
      })
      continue
    }

    const targetConfig: TargetConfig | undefined = input.siteManifest.targets?.[targetName]
    const targetType = targetConfig ? renderTargetType(getType(targetConfig)) : 'static'

    input.onProgress?.({ kind: 'target-start', target: targetName })

    const target: PublishTarget = {
      name: targetName,
      storage: targetStorage,
      type: targetType,
      seo: undefined,
      cache: targetConfig?.cache,
    }
    const targetRoot = createContentRoot(targetStorage)

    let targetFilesWritten = 0
    let targetFilesRemoved = 0
    let targetFailureReason: string | undefined
    const targetItemResults: PublishItemResult[] = []

    // Step 10a — asset publish before per-item renders so static-mode
    // pages don't bake URLs to bytes that aren't on the target yet.
    // Per-target failure here marks the whole target failed (no
    // point publishing pages whose assets aren't there).
    if (doAssetPublish) {
      try {
        const itemNames = [
          ...[...input.site.pages.keys()].map(n => `pages/${n}`),
          ...[...input.site.fragments.keys()].map(n => `fragments/${n}`),
        ]
        const assetResult = await publishAssets({
          sourceRoot: input.sourceRoot,
          targetRoot,
          itemNames,
        })
        if (!assetResult.ok) {
          targetFailureReason = `asset publish failed: missing ${assetResult.missing.join(', ')}`
        } else {
          targetFilesWritten += assetResult.copiedFiles
        }
      } catch (err) {
        targetFailureReason = `asset publish threw: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    // If asset publish failed, skip per-item renders for this target —
    // would emit broken pages. Continue with next target (Q4 fail-soft).
    if (targetFailureReason) {
      const failedResult: PublishTargetResult = {
        name: targetName,
        failed: true,
        failureReason: targetFailureReason,
        filesWritten: targetFilesWritten,
        filesRemoved: targetFilesRemoved,
      }
      allTargets.push(failedResult)
      input.onProgress?.({ kind: 'target-done', result: failedResult })
      continue
    }

    for (const ref of input.items) {
      // Compute per-item hash from caller-supplied map OR templateInfos.
      let manifestHash = input.itemHashes?.get(itemKey(ref))
      if (!manifestHash && input.templateInfos) {
        const localizedItem =
          ref.locale === undefined
            ? undefined
            : ref.kind === 'page'
              ? input.site.pageLocales.get(ref.name)?.locales.get(ref.locale)
              : input.site.fragmentLocales.get(ref.name)?.locales.get(ref.locale)
        const itemForHash =
          localizedItem ?? (ref.kind === 'page' ? input.site.pages : input.site.fragments).get(ref.name)
        if (itemForHash) {
          // Static-mode pages need fragmentHashes folded in so a
          // fragment change invalidates every page that bakes it.
          // ESI pages + fragments don't (compare doesn't track that).
          const useFragmentHashes = ref.kind === 'page' && targetType === 'static'
          manifestHash = hashManifest(itemForHash, {
            templateHashes,
            fragmentHashes: useFragmentHashes ? fragmentHashes : undefined,
          })
        }
      }
      const itemTarget: PublishTarget = manifestHash ? { ...target, manifestHash } : target

      // Compute mode for the progress event before invoking; the
      // wrappers compute it again (cheap pure fn) — emit-side
      // mirrors what publishItemCore will receive.
      const itemForMode = (ref.kind === 'page' ? input.site.pages : input.site.fragments).get(ref.name)
      const mode: PublishRenderMode = itemForMode
        ? ref.kind === 'page'
          ? resolvePageRenderMode(itemForMode, targetType)
          : resolveFragmentRenderMode(itemForMode)
        : ref.kind === 'page'
          ? resolvePageRenderMode({}, targetType)
          : 'fragment-rendered'

      input.onProgress?.({ kind: 'item-start', item: ref, target: targetName, mode })

      const result =
        ref.kind === 'page'
          ? await publishPage({
              name: ref.name,
              locale: ref.locale,
              site: input.site,
              sourceRoot: input.sourceRoot,
              target: itemTarget,
            })
          : await publishFragment({
              name: ref.name,
              locale: ref.locale,
              site: input.site,
              sourceRoot: input.sourceRoot,
              target: itemTarget,
            })

      allItems.push(result)
      targetItemResults.push(result)
      input.onProgress?.({ kind: 'item-done', result, target: targetName })

      if (result.ok) {
        targetFilesWritten += result.files
        targetFilesRemoved += result.removed
      }
    }

    // Step 10b — dep indices (asset-refs + fragment-deps + alias-targets
    // sidecars on target). Walks the source site once; rebuilds per-edge
    // index files at target's `.gazetta/` namespace. Failures here are
    // logged to failureReason but don't mark the whole target failed
    // (items already published successfully).
    if (doDepIndices) {
      try {
        await publishDepIndices(input.sourceRoot, targetStorage, input.site)
      } catch (err) {
        // Soft-fail: dep indices are derivable; reindex CLI recovers.
        // Eslint-suppress: a future audit consumer can read this.
        // eslint-disable-next-line no-console
        console.warn(`publishRun: publishDepIndices failed for ${targetName}: ${err}`)
      }
    }

    // Step 11 — site manifest emit (`site.json` snapshot at target root).
    if (doSiteManifest) {
      try {
        await publishSiteManifest(input.sourceRoot, targetStorage, input.site)
        targetFilesWritten++
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`publishRun: publishSiteManifest failed for ${targetName}: ${err}`)
      }
    }

    // Step 12 — cache purge (fire-and-forget; doesn't block run).
    // Today: caller fires it after publishRun returns (the strategy
    // is on input but we don't yet auto-dispatch; future cut wires
    // per-target purge against the target config's purge strategy).
    // input.purgeStrategy reserved for that future wiring.

    const targetResult: PublishTargetResult = {
      name: targetName,
      // Per-target fail = ALL items for this target failed (per Q4 lock).
      // Empty items list = not failed (no work attempted on this target).
      failed: targetItemResults.length > 0 && targetItemResults.every(r => !r.ok),
      filesWritten: targetFilesWritten,
      filesRemoved: targetFilesRemoved,
    }
    allTargets.push(targetResult)
    input.onProgress?.({ kind: 'target-done', result: targetResult })
  }

  // Step 17 — aggregate. ok = every item AND every target succeeded.
  const result: PublishRunResult = {
    ok: allItems.every(i => i.ok) && allTargets.every(t => !t.failed),
    items: allItems,
    targets: allTargets,
  }
  input.onProgress?.({ kind: 'run-done', result })
  return result
}

/**
 * Archive predicates + alias resolution helpers per design-soft-delete.md.
 *
 * Pure functions over manifest data. No I/O. The render pipeline + admin
 * routes consume these instead of inlining `manifest.archived === true`
 * checks (SRP — archive semantics in one place).
 *
 * Archive state lives on the manifest itself (Q1 lock — manifest field,
 * not sidecar). Aliasing is a runtime concern — the resolver follows
 * `aliasOf` for archived items with the field set; throws ARCHIVED_NO_ALIAS
 * for archived items without (Q2 F1 split).
 *
 * Q3 flatten-on-rename guarantees aliases never point at other archives —
 * one-hop only. The recursion limit + cycle detection in
 * `resolveFragmentArchiveAlias` are defensive: if external manifest
 * mutation produces a chain (git pull, hand edit), we still terminate.
 */
import type { ComponentManifest } from './types.js'

/** True when the manifest is archived (and not a non-archived archived: false). */
export function isArchived(manifest: { archived?: boolean }): boolean {
  return manifest.archived === true
}

/**
 * Returns the alias target name when the manifest is archived AND has
 * `aliasOf` set; null in any other case (live manifest, or archived
 * without alias).
 *
 * The caller distinguishes "live" from "archived without alias" via
 * `isArchived(manifest)` — both states return null here, but the runtime
 * behavior differs (live = render normally; archived-no-alias = omit or throw).
 */
export function aliasTarget(manifest: { archived?: boolean; aliasOf?: string }): string | null {
  if (!isArchived(manifest)) return null
  return manifest.aliasOf ?? null
}

/**
 * Error thrown by `resolveFragmentArchiveAlias` when an archived fragment
 * has no `aliasOf` field. Caller decides UX:
 *
 *   - Renderer: surface as render-time error (per Q2 F1 split)
 *   - Validator (P1): warn at save / background / pre-publish
 *   - Web server: omit the fragment, leaving an HTML marker comment
 *
 * Distinct error class so callers can `instanceof`-check without
 * pattern-matching messages.
 */
export class ArchivedNoAliasError extends Error {
  readonly fragmentName: string

  constructor(fragmentName: string, contextPath?: string) {
    const where = contextPath ? `\n  Resolution path: ${contextPath}` : ''
    super(
      `Fragment "@${fragmentName}" is archived without an alias. References to it cannot resolve.${where}\n` +
        `  Restore the fragment, set its aliasOf, or remove the reference.`,
    )
    this.name = 'ArchivedNoAliasError'
    this.fragmentName = fragmentName
  }
}

/**
 * Maximum hops the alias chain may follow. Q3 flatten guarantees one,
 * so we tolerate 5 to absorb data corruption (git pull, hand edit) and
 * still surface a clear error if someone constructs a real chain by hand.
 */
const MAX_ALIAS_HOPS = 5

/**
 * Resolve a fragment ref through the alias chain. Returns the live
 * fragment name to use for the actual lookup.
 *
 * - Live fragment → returns the original name unchanged
 * - Archived fragment with `aliasOf: X` → recurses to resolve X
 * - Archived fragment without `aliasOf` → throws ArchivedNoAliasError
 * - Alias chain longer than MAX_ALIAS_HOPS → throws (data-corruption guard)
 * - Cycle (A → B → A) → throws (data-corruption guard)
 *
 * The `lookupFragment` callback decouples this helper from the
 * `Site.fragments` / `Site.fragmentLocales` map shape — the resolver
 * passes whichever lookup strategy applies for the active locale.
 *
 * Returns null when the resolved name doesn't exist as a fragment
 * (the caller's lookup returned null at some point in the chain) —
 * caller surfaces "fragment not found" with their own context.
 */
export function resolveFragmentArchiveAlias(
  fragmentName: string,
  lookupFragment: (name: string) => ComponentManifest | null,
  contextPath?: string,
): { resolvedName: string; manifest: ComponentManifest } | null {
  const visited = new Set<string>()
  let currentName = fragmentName
  for (let hop = 0; hop <= MAX_ALIAS_HOPS; hop++) {
    if (visited.has(currentName)) {
      const where = contextPath ? `\n  Resolution path: ${contextPath}` : ''
      throw new Error(
        `Circular fragment alias chain detected at "@${currentName}".\n` +
          `  Chain: ${[...visited, currentName].map(n => `@${n}`).join(' → ')}${where}\n` +
          `  Q3 flatten-on-rename should make this impossible; check for hand-edited manifests.`,
      )
    }
    visited.add(currentName)

    const manifest = lookupFragment(currentName)
    if (!manifest) return null

    if (!isArchived(manifest)) {
      return { resolvedName: currentName, manifest }
    }
    // Archived; check for alias
    const next = aliasTarget(manifest)
    if (next === null) {
      throw new ArchivedNoAliasError(currentName, contextPath)
    }
    currentName = next
  }
  // Hop budget exhausted without landing on a live fragment.
  const where = contextPath ? `\n  Resolution path: ${contextPath}` : ''
  throw new Error(
    `Fragment alias chain exceeded ${MAX_ALIAS_HOPS} hops starting from "@${fragmentName}".\n` +
      `  Chain: ${[...visited].map(n => `@${n}`).join(' → ')}${where}\n` +
      `  Q3 flatten-on-rename should make chains > 1 hop impossible; check for hand-edited manifests.`,
  )
}

/**
 * Higher-level helper for recording revisions on a target.
 *
 * The bare `HistoryProvider.recordRevision` takes a full
 * `items: Map<path, content>` snapshot. That's fine for testing but
 * wasteful at runtime: every save of one page would re-hash and
 * re-list every page + fragment on the target. This helper does the
 * right thing:
 *
 *   - First revision on a target: walks the content tree once to
 *     snapshot every manifest (page.json, fragment.json).
 *   - Subsequent revisions: reads the previous snapshot and overlays
 *     the delta (changed items the caller passes in). `readBlob` for
 *     each carried-over path gives us the content for the new
 *     revision's items map — at which point `recordRevision` dedupes
 *     the unchanged blobs via content-addressing, so no new storage.
 *
 * SRP: this module owns the "what goes in a revision snapshot"
 * decision. `HistoryProvider` owns layout. Callers (admin-api save /
 * admin-api publish / CLI publish) just describe *what they wrote*
 * and we construct the revision.
 */

import { join } from 'node:path'
import type { StorageProvider } from './types.js'
import type { BlobContent, HistoryProvider, RevisionInput, RevisionOperation } from './history.js'
import type { ContentRoot } from './content-root.js'

/** A single item that was written in this save/publish. */
export interface WrittenItem {
  /** Path relative to the content root, e.g. `pages/home/page.json`. */
  path: string
  /**
   * Current content as stored. `string` for text items (manifests,
   * site config), `Uint8Array` for binary items (asset bytes,
   * variants). `null` marks a deletion.
   */
  content: BlobContent | null
}

/**
 * Location to scan when building the first revision's baseline
 * snapshot. Each entry names a directory under the content root and
 * the manifest filename to capture from every subdirectory.
 */
export interface ScanLocation {
  /** Directory relative to the content root, e.g. `pages` or `fragments`. */
  dir: string
  /** Manifest filename to capture, e.g. `page.json` or `fragment.json`. */
  manifest: string
}

/**
 * Built-in content locations Gazetta knows about today. Callers can
 * pass a superset (e.g. for future data/*, templates/*) — the list is
 * part of `RecordWriteOptions` so this module stays open for extension
 * without changes when new content kinds land.
 */
export const DEFAULT_SCAN_LOCATIONS: readonly ScanLocation[] = [
  { dir: 'pages', manifest: 'page.json' },
  { dir: 'fragments', manifest: 'fragment.json' },
]

/**
 * Flat files at the content root to capture in the baseline snapshot
 * (no per-subdirectory recursion).
 */
export const DEFAULT_SCAN_ROOT_FILES: readonly string[] = ['site.config.ts']

export interface RecordWriteOptions {
  /** HistoryProvider for the target we're recording on. */
  history: HistoryProvider
  /** Content root of the target — used to scan on first revision. */
  contentRoot: ContentRoot
  operation: RevisionOperation
  /** Items the save/publish wrote (and optionally deleted). */
  items: WrittenItem[]
  /** Author identifier passed through to the manifest. */
  author?: string
  /** Source target name (for publish). */
  source?: string
  /** Optional human-readable note. */
  message?: string
  /** For rollback/restore: the revision id this one restored from. */
  restoredFrom?: string
  /**
   * Override the directories walked during the first-revision baseline
   * scan. Defaults to `DEFAULT_SCAN_LOCATIONS` (pages + fragments).
   * Pass a superset if the site has extra authored content (e.g.
   * custom `data/*.json` dirs); pass `[]` to skip directory scanning
   * entirely (only root files + explicit items are captured).
   */
  scanLocations?: readonly ScanLocation[]
  /**
   * Override the flat files captured from the content root. Defaults
   * to `DEFAULT_SCAN_ROOT_FILES` (`site.config.ts`). Missing files are
   * silently skipped so empty publish-targets still record cleanly.
   */
  scanRootFiles?: readonly string[]
}

/**
 * Build + record a revision for the given write. Reads the previous
 * snapshot (if any), overlays the delta, and calls
 * `history.recordRevision`. Returns the recorded Revision.
 *
 * Callers are expected to have already written the items to the
 * target's storage before invoking this; the recorder reads back via
 * the HistoryProvider's dedup path (blobs it has already seen just
 * `exists()` and skip) so the happy path is cheap on repeated saves
 * of the same item.
 */
export async function recordWrite(opts: RecordWriteOptions) {
  const scanLocations = opts.scanLocations ?? DEFAULT_SCAN_LOCATIONS
  const scanRootFiles = opts.scanRootFiles ?? DEFAULT_SCAN_ROOT_FILES

  // On the very first write, record a baseline revision capturing the
  // pre-write state — so "undo my first save" has something to revert
  // to (the tree as it was before the CMS touched it). Subsequent
  // writes overlay deltas onto the previous revision. Without this,
  // the first revision would be post-save state and undo would have no earlier
  // revision to restore.
  const existing = await opts.history.listRevisions(1)
  if (existing.length === 0) {
    const baseline = await scanContentTree(opts.contentRoot, scanLocations, scanRootFiles)
    await opts.history.recordRevision({
      operation: 'save',
      message: 'Initial baseline',
      items: baseline,
    })
  }

  const prevItems = await loadPreviousSnapshot(opts.history, opts.contentRoot, scanLocations, scanRootFiles)
  const nextItems = new Map<string, BlobContent>(prevItems)
  for (const it of opts.items) {
    if (it.content === null) nextItems.delete(it.path)
    else nextItems.set(it.path, it.content)
  }
  const input: RevisionInput = {
    operation: opts.operation,
    author: opts.author,
    source: opts.source,
    message: opts.message,
    restoredFrom: opts.restoredFrom,
    items: nextItems,
  }
  return opts.history.recordRevision(input)
}

/**
 * Materialize the previous revision's full content snapshot as
 * `path → content`. If there is no previous revision, fall back to a
 * one-time scan of the target's content tree (pages, fragments,
 * root files). That makes the first revision a proper baseline even
 * when history was turned on after content already existed.
 */
async function loadPreviousSnapshot(
  history: HistoryProvider,
  contentRoot: ContentRoot,
  scanLocations: readonly ScanLocation[],
  scanRootFiles: readonly string[],
): Promise<Map<string, BlobContent>> {
  const [head] = await history.listRevisions(1)
  if (head) {
    const manifest = await history.readRevision(head.id)
    const items = new Map<string, BlobContent>()
    // Read blobs in parallel to avoid a big serial chain on large
    // snapshots. `readBlob` returns Uint8Array — passing through as-is
    // means binary blobs round-trip without decode/encode, and text
    // blobs round-trip as their UTF-8 byte form (still hashes the same
    // way they would as strings, so dedup holds).
    const entries = Object.entries(manifest.snapshot)
    const contents = await Promise.all(entries.map(([, hash]) => history.readBlob(hash)))
    entries.forEach(([path], i) => items.set(path, contents[i]!))
    return items
  }
  return scanContentTree(contentRoot, scanLocations, scanRootFiles)
}

/**
 * One-time walk of a content root, capturing every content-defining
 * manifest. Used only for the first revision on a target; subsequent
 * revisions overlay deltas onto the previous snapshot.
 *
 * Locations walked come from `scanLocations` and `scanRootFiles` (see
 * RecordWriteOptions) so this module stays open for extension: adding
 * a new content kind is a caller-side change, not an edit here.
 */
async function scanContentTree(
  root: ContentRoot,
  scanLocations: readonly ScanLocation[],
  scanRootFiles: readonly string[],
): Promise<Map<string, BlobContent>> {
  // Snapshot type is `BlobContent` (string | Uint8Array). v1 only scans
  // text content (manifests, YAML); binary asset paths are populated
  // by callers via `WrittenItem`s on subsequent saves. The map's type
  // accommodates both so callers can pass either through.
  const items = new Map<string, BlobContent>()
  const { storage } = root

  for (const rel of scanRootFiles) {
    const abs = root.path(rel)
    if (await storage.exists(abs)) {
      items.set(rel, await storage.readFile(abs))
    }
  }
  for (const loc of scanLocations) {
    await scanManifestsInto(storage, root.path(loc.dir), loc.dir, loc.manifest, items)
  }

  return items
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Walk a `pages/` or `fragments/` tree, reading every matching manifest
 * into `items` with relative-path keys. Recurses so nested dynamic
 * routes (e.g. `blog/[slug]/page.json`) are captured.
 *
 * Each item directory is listed and every manifest matching the
 * `localeFilename` convention is captured: the default (`page.json`)
 * and all locale variants (`page.fr.json`, `fragment.pt-br.json`, ...).
 * Scanning only the exact default name would leave variants out of the
 * baseline snapshot, and restoring that baseline would then DELETE a
 * translation instead of reverting it (#1088).
 *
 * Cloud object stores (R2/S3/Azure Blob) have no real "directory"
 * concept, but `exists()` on a prefix lists it: a location holding
 * content returns true, a genuinely missing one false. The root probe
 * below relies on that to tell a missing location apart from a listing
 * failure.
 */
async function scanManifestsInto(
  storage: StorageProvider,
  absDir: string,
  relPrefix: string,
  manifestName: string,
  items: Map<string, BlobContent>,
  prefetchedEntries?: Awaited<ReturnType<StorageProvider['readDir']>>,
): Promise<void> {
  let entries: Awaited<ReturnType<StorageProvider['readDir']>>
  if (prefetchedEntries) {
    // Recursion: the parent already listed this directory to discover it,
    // so reuse that listing. Re-listing here behind the catch below would
    // silently drop this subtree from the baseline on a transient error,
    // and a later restore would DELETE those paths (#1100 review).
    entries = prefetchedEntries
  } else {
    try {
      entries = await storage.readDir(absDir)
    } catch (err) {
      // Root scan location: a genuinely missing directory means "nothing
      // to scan", but readDir errors carry no portable not-found signal
      // across providers, so confirm absence with exists(). Any other
      // failure (transient, permission, storage outage) must abort the
      // write - recording a baseline without the whole location would
      // let a later restore DELETE every manifest in it (#1100 review).
      // exists() throwing also fails closed.
      if (await storage.exists(absDir)) throw err
      return
    }
  }
  // `page.json` + `page.<locale>.json` (locale is one dot-free segment,
  // per localeFilename's normalizeLocale). The locale-variant pattern
  // only applies to `.json` manifests - a custom non-JSON manifest name
  // matches exactly, as before #1098. The basename is escaped so custom
  // names with regex metacharacters match literally.
  const jsonBase = manifestName.endsWith('.json') ? manifestName.slice(0, -'.json'.length) : null
  const manifestPattern = jsonBase === null ? null : new RegExp(`^${escapeRegExp(jsonBase)}(\\.[^.]+)?\\.json$`)
  for (const e of entries) {
    if (!e.isDirectory) continue
    const sub = join(absDir, e.name)
    const relSub = `${relPrefix}/${e.name}`
    // No catch here: this directory exists (the parent listing just
    // returned it), so a readDir failure is a real error, not a missing
    // directory. Letting it throw aborts the baseline - recording
    // without this directory's manifests would let a later restore
    // DELETE them as absent from the snapshot (#1098 review).
    const subEntries = await storage.readDir(sub)
    for (const f of subEntries) {
      if (f.isDirectory) continue
      const matches = manifestPattern === null ? f.name === manifestName : manifestPattern.test(f.name)
      if (!matches) continue
      items.set(`${relSub}/${f.name}`, await storage.readFile(join(sub, f.name)))
    }
    // Recurse for nested routes (pages/blog/[slug]/page.json), reusing
    // the listing already fetched above instead of reading it again.
    await scanManifestsInto(storage, sub, relSub, manifestName, items, subEntries)
  }
}

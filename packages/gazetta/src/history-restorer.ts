/**
 * Apply a past revision's snapshot to a target's content tree.
 *
 * This is the write side of undo / rollback. Design-publishing.md:
 *   "Undo and rollback restore a prior revision — both are soft
 *    (forward-only; create a new revision reverting to the past state,
 *    never destroy history)."
 *
 * Algorithm:
 *   1. Load the target revision's snapshot (itemPath → blob hash).
 *   2. Diff against the current on-disk content (via the HistoryProvider's
 *      most-recent revision). Anything present now but absent from the
 *      target snapshot is deleted; everything in the snapshot is written
 *      from its blob.
 *   3. Record a new revision with operation='rollback' and
 *      restoredFrom=<targetRevId>, so the audit trail shows where the
 *      state came from and history stays forward-only.
 *
 * The caller (admin-api / CLI) owns orchestration — picking which
 * revision to restore (head-1 for undo, arbitrary for rollback) and
 * any side effects beyond the content tree (e.g., sidecar writer
 * invalidation).
 */

import type { ContentRoot } from './content-root.js'
import type { HistoryProvider, Revision, RevisionManifest, RevisionOperation } from './history.js'

export interface RestoreRevisionOptions {
  /** HistoryProvider for the target being restored. */
  history: HistoryProvider
  /** Content root of the target — destination for the restore writes. */
  contentRoot: ContentRoot
  /** Id of the revision to restore to (see `formatId` for the id scheme). */
  revisionId: string
  /** Free-form author identifier passed to the forward revision. */
  author?: string
  /** Human-readable note ("Undo publish from local"). */
  message?: string
}

/**
 * Restore `revisionId`'s content onto the target. Writes any items
 * present in the snapshot (content fetched via `readBlob`); deletes
 * items that exist today but aren't in the restored snapshot. Returns
 * the new forward revision — always operation='rollback' so audit
 * consumers can distinguish restores from normal saves/publishes.
 */
export async function restoreRevision(opts: RestoreRevisionOptions): Promise<Revision> {
  const { history, contentRoot, revisionId } = opts
  const target = await history.readRevision(revisionId)
  // Current state = the most recent revision's snapshot. If none
  // exists yet we're restoring onto an empty tree — nothing to delete
  // and no "unchanged" entries to skip.
  const currentSnapshot = await loadHeadSnapshot(history)

  const toDelete = Object.keys(currentSnapshot).filter(p => !(p in target.snapshot))
  // Only write items whose blob hash differs from what's currently on
  // disk (per head snapshot). Without this, restoring typically rewrites
  // every item in the snapshot — an undo of a single-page edit would
  // touch every page + fragment manifest, triggering a storm of file-
  // watch events and SSE reloads in the dev server. Equal hashes →
  // same content → skip the write.
  const toWrite = Object.entries(target.snapshot).filter(([path, hash]) => currentSnapshot[path] !== hash)

  // Delete first: rolling back a "delete" in the old revision means the
  // item came back; rolling back an "add" means the item goes away.
  // Delete-before-write keeps storage from briefly holding both.
  for (const path of toDelete) {
    const abs = contentRoot.path(path)
    try {
      await contentRoot.storage.rm(abs)
    } catch {
      // Best-effort: a missing path at rm time is fine (already gone).
    }
  }

  for (const [path, hash] of toWrite) {
    const bytes = await history.readBlob(hash)
    const abs = contentRoot.path(path)
    const parent = abs.substring(0, abs.lastIndexOf('/'))
    if (parent) await contentRoot.storage.mkdir(parent)
    // Restore via writeBytes — uniform bytes-in for both text and
    // binary content. Text blobs are UTF-8-encoded bytes
    // (indistinguishable from what writeFile would have stored);
    // binary blobs (asset bytes, variants) round-trip raw.
    await contentRoot.storage.writeBytes(abs, bytes)
  }

  // After restoring manifests, rebuild the asset-refs sidecar index.
  // Manifests are the source of truth; a restore can change which
  // assets and fragments each item references, which would leave the
  // per-edge dep sidecars stale. Easier to rebuild than diff per-item —
  // we have the full set of post-restore manifests on disk.
  if (toWrite.length > 0 || toDelete.length > 0) {
    try {
      const { loadSite } = await import('./site-loader.js')
      const { rebuildDepIndex } = await import('./publish-rendered.js')
      const { ASSET_REFS } = await import('./assets/asset-deps.js')
      const { FRAGMENT_DEPS } = await import('./fragment-deps.js')
      const site = await loadSite({ contentRoot, manifest: { name: '(history-restore)' } })
      await Promise.all([
        rebuildDepIndex(ASSET_REFS, site, contentRoot.storage, contentRoot.rootPath),
        rebuildDepIndex(FRAGMENT_DEPS, site, contentRoot.storage, contentRoot.rootPath),
      ])
    } catch (err) {
      // Non-fatal: if site config is missing or load fails, dep indices
      // might drift. Reindex CLI recovers.
      // eslint-disable-next-line no-console
      console.warn(`dep-sidecar rebuild after restore failed: ${(err as Error).message}`)
    }
  }

  // Record a new forward revision capturing the restored state. Uses
  // the same snapshot we just wrote — no need to re-read from disk.
  return recordFromSnapshot(history, target, {
    operation: 'rollback',
    restoredFrom: revisionId,
    author: opts.author,
    message: opts.message,
  })
}

/**
 * Re-record an existing snapshot as a forward revision. Blobs already
 * exist (they're the same content), so the HistoryProvider's exists()
 * check skips the writes — cheap.
 *
 * Items map carries `Uint8Array` because that's what `readBlob`
 * returns. Text and binary blobs round-trip identically — the
 * provider hashes raw bytes either way, so dedup holds.
 */
async function recordFromSnapshot(
  history: HistoryProvider,
  target: RevisionManifest,
  meta: { operation: RevisionOperation; restoredFrom?: string; author?: string; message?: string },
): Promise<Revision> {
  const items = new Map<string, Uint8Array>()
  for (const [path, hash] of Object.entries(target.snapshot)) {
    items.set(path, await history.readBlob(hash))
  }
  return history.recordRevision({
    operation: meta.operation,
    author: meta.author,
    message: meta.message,
    restoredFrom: meta.restoredFrom,
    items,
  })
}

/**
 * Head revision's snapshot, or `{}` if there are no revisions yet.
 * Used by restore to figure out what's currently on-disk and needs
 * deleting when the restored revision doesn't include it.
 */
async function loadHeadSnapshot(history: HistoryProvider): Promise<Record<string, string>> {
  const [head] = await history.listRevisions(1)
  if (!head) return {}
  const m = await history.readRevision(head.id)
  return m.snapshot
}

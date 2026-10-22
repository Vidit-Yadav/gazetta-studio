/**
 * History / revisions for a target.
 *
 * Every write to a target (save or publish) records a revision. Undo and
 * rollback restore a prior revision — both are soft (forward-only; create
 * a new revision reverting to the past state, never destroy history).
 *
 * Storage layout per target (all inside the target's storage, in the
 * reserved `.gazetta/` namespace that the runtime never reads):
 *
 *   .gazetta/
 *     history/
 *       index.json              ordered revision list
 *       objects/<hh>/<rest>     content-addressed blobs, sharded by first 2 hex chars
 *       revisions/<id>.json    revision manifest: metadata + item→hash map
 *
 * One uniform approach across all storage providers — the provider
 * interface remains read/write bytes at paths; no provider-native
 * versioning (S3 object versions, git commits) is used.
 *
 * This module declares the types and provider interface. Implementation
 * lands in a later phase.
 */

/** Operation that produced a revision. */
export type RevisionOperation = 'save' | 'publish' | 'rollback'

/** Metadata + item→hash snapshot for one write to a target. */
export interface Revision {
  /** Unique id: `rev-<unixMillis>-<seq>-<suffix>` (legacy: `rev-<ms>` or `rev-<ms>-<seq>`). */
  id: string
  /** ISO 8601 timestamp when the revision was recorded. */
  timestamp: string
  /** What kind of write this was. */
  operation: RevisionOperation
  /** Author identifier. Free-form for v1; upgrades to auth identity later. */
  author?: string
  /** Source target name, if this revision was produced by a publish from another target. */
  source?: string
  /** Paths of items affected by this write (e.g. `pages/home`, `fragments/header`). */
  items: string[]
  /** Optional human-readable note. */
  message?: string
  /** For rollback/restore: the revision id this one restored from. */
  restoredFrom?: string
}

/** Full revision manifest as stored in `revisions/<id>.json`. */
export interface RevisionManifest extends Revision {
  /**
   * Snapshot of the full content tree at this revision, as `path → content hash`.
   * The hash references a blob under `.gazetta/history/objects/`.
   * Unchanged items across revisions share blobs (content-addressed dedupe).
   */
  snapshot: Record<string, string>
}

/** Retention policy for a target's history. */
export interface HistoryRetention {
  /** Keep at most N most-recent revisions. Default: 50. Oldest evicted. */
  maxRevisions?: number
}

/**
 * Content carried in a revision snapshot — either UTF-8 text (for JSON
 * manifests, YAML, HTML, CSS, JS) or raw bytes (asset bytes, variants,
 * fonts). The provider hashes either via SHA-256 over the raw bytes
 * (text encoded as UTF-8 first), so dedup works uniformly: identical
 * text and identical bytes share a blob.
 *
 * Per Q9 lock, one blob store, mixed content. The public `readBlob`
 * always returns bytes; callers that expect text decode on read.
 */
export type BlobContent = string | Uint8Array

/** Input to `recordRevision` — metadata plus the current content tree. */
export interface RevisionInput {
  operation: RevisionOperation
  /** Author identifier (free-form for v1). */
  author?: string
  /** Source target, when this revision was produced by a publish. */
  source?: string
  /** Optional human-readable note. */
  message?: string
  /** For rollback/restore: the revision id this one restored from. */
  restoredFrom?: string
  /**
   * Full content tree snapshot at this revision: `itemPath → content`.
   * Content is `string | Uint8Array` — text and binary first-class
   * (asset bytes, variants, fonts; per Q9 lock).
   *
   * Unchanged items should carry identical content across calls so the
   * provider can dedupe via content-addressing.
   */
  items: Map<string, BlobContent>
}

/**
 * Uniform history API. Implemented on top of any StorageProvider — reads
 * and writes bytes under `.gazetta/history/`. No provider-native
 * versioning (S3 object versions, git commits) is used.
 */
export interface HistoryProvider {
  /**
   * Record a new revision on the target.
   *
   * Writes any new item blobs to `objects/<hash[:2]>/<hash[2:]>`, writes
   * the revision manifest to `revisions/<id>.json`, updates
   * `index.json`, and applies retention (evicts oldest if over limit).
   *
   * `items` parameter carries the full content tree; only blobs that
   * don't already exist are written. Returns the recorded Revision.
   */
  recordRevision(input: RevisionInput): Promise<Revision>

  /** List revisions, newest first. `limit` caps the list size. */
  listRevisions(limit?: number): Promise<Revision[]>

  /** Read a revision's full manifest (metadata + snapshot). */
  readRevision(id: string): Promise<RevisionManifest>

  /**
   * Read a content blob by hash. Returns raw bytes — callers that
   * expect text (page/fragment manifests, site.config.ts) decode UTF-8 on
   * receipt. Callers that expect binary (asset bytes, variants) use
   * the bytes as-is.
   *
   * The pre-step-20 signature returned `string`. The widening to
   * `Uint8Array` is a foundation contract change; existing string
   * consumers must wrap with `new TextDecoder().decode(bytes)`.
   */
  readBlob(hash: string): Promise<Uint8Array>

  /**
   * Delete a revision and its manifest. Orphaned blobs are garbage-
   * collected by the implementation (lazy or immediate, adapter's choice).
   */
  deleteRevision(id: string): Promise<void>
}

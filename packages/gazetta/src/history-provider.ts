/**
 * HistoryProvider implementation on top of any StorageProvider.
 *
 * Layout per target (inside `.gazetta/history/` under the target's
 * storage root):
 *
 *   index.json                     { revisions: ['rev-<ms>-1-a1b2c3d4', ...] }
 *   revisions/<id>.json            one manifest per revision — metadata +
 *                                  items map (itemPath → blob hash)
 *   objects/<hh>/<rest>            content-addressed blobs (SHA-256, sharded
 *                                  by first 2 hex chars)
 *
 * Design-decisions.md #18:
 *  - One uniform approach across all providers (no native versioning).
 *  - Content-addressed blobs → unchanged items share storage across
 *    revisions; storage scales with unique content, not revision count.
 *  - Soft undo only — every restore writes a new forward revision.
 *  - Retention default 50; oldest evicted on write.
 *
 * SRP: this module owns .gazetta/history/ layout and retention. Nothing
 * else. The write pipeline (save/publish) calls `recordRevision`; undo/
 * rollback call `readRevision` + `readBlob`. Restore happens outside —
 * this module doesn't touch the content tree.
 */

import { createHash, randomBytes } from 'node:crypto'
import { rmIgnoreMissing } from './providers/_rm-ignore-missing.js'
import type { StorageProvider } from './types.js'
import type { BlobContent, HistoryProvider, Revision, RevisionInput, RevisionManifest } from './history.js'
import { DEFAULT_HISTORY_RETENTION } from './types.js'

export interface CreateHistoryProviderOptions {
  /** Storage under which `.gazetta/history/` lives. Usually the target's storage. */
  storage: StorageProvider
  /**
   * Path prefix where history lives. Default: `.gazetta/history`. Callers
   * with a rooted storage (filesystem target with `path:`) pass the
   * default; anything more exotic (e.g. history under a sub-prefix)
   * overrides.
   */
  rootPath?: string
  /**
   * Maximum number of revisions to keep; older ones evicted on write.
   * Default: `DEFAULT_HISTORY_RETENTION` (50). Pass < 1 → clamped to 1
   * (zero retention would self-evict every write).
   */
  retention?: number
}

/**
 * Shape of the history index file. Kept minimal — the list is append-
 * heavy and read-cheap, so we serialize the full ordered id list
 * rather than try to be clever. Oldest first, newest last.
 *
 * IDs are timestamp-based (`rev-<unixMillis>-<seq>-<suffix>`) so retention
 * evictions stay auditable ("what happened around Jan 5?") and lex-
 * sort matches chronological order. See `formatId` for the full scheme.
 */
interface HistoryIndex {
  /** Revision ids in creation order (oldest first). */
  revisions: string[]
}

/**
 * Build a HistoryProvider backed by the given storage. No I/O happens
 * at construction time — everything is lazy on first call.
 */
export function createHistoryProvider(opts: CreateHistoryProviderOptions): HistoryProvider {
  const { storage } = opts
  const root = opts.rootPath ?? '.gazetta/history'
  const retention = Math.max(1, opts.retention ?? DEFAULT_HISTORY_RETENTION)
  const indexPath = join(root, 'index.json')

  /**
   * Read the index cache or return an empty one if it doesn't exist yet.
   * The cache is never the source of truth - the revisions/ listing is
   * (see listRevisionIds); a stale or lost cache is rebuilt from it.
   */
  async function readIndex(): Promise<HistoryIndex> {
    if (!(await storage.exists(indexPath))) {
      return { revisions: [] }
    }
    let parsed: HistoryIndex & { nextId?: number }
    try {
      parsed = JSON.parse(await storage.readFile(indexPath)) as HistoryIndex & { nextId?: number }
    } catch {
      // A corrupt or unparseable cache is disposable: treat it as empty and
      // let the next syncIndexCache rewrite it from the revisions/ listing.
      // Without this, one bad byte in index.json would fail every future
      // recordRevision even though the listing (the real source of truth)
      // is perfectly healthy.
      return { revisions: [] }
    }
    // Forward-compat: tolerate legacy `nextId` by ignoring it. Old indexes
    // (from the numeric-id era) continue to read cleanly, new writes use
    // the timestamp scheme. No migration pass needed — retention naturally
    // evicts the legacy ids over time.
    return { revisions: parsed.revisions ?? [] }
  }

  /**
   * Ensure the parent directory exists before writing. Object-store
   * providers (R2, S3) ignore mkdir. Filesystem requires it because
   * `writeFile` fails on missing parents, and our sharded blob paths
   * (objects/<hh>/<rest>) plus revisions/rev-NNNN.json live in dirs
   * that don't exist until the first write.
   */
  async function writeWithParents(path: string, content: string): Promise<void> {
    const parent = path.substring(0, path.lastIndexOf('/'))
    if (parent) await storage.mkdir(parent)
    await storage.writeFile(path, content)
  }

  async function writeIndex(idx: HistoryIndex): Promise<void> {
    await writeWithParents(indexPath, JSON.stringify(idx, null, 2) + '\n')
  }

  function blobPath(hash: string): string {
    // Shard by first two hex chars — keeps any one `objects/` subdirectory
    // from ballooning past a few thousand entries on large sites.
    return join(root, 'objects', hash.slice(0, 2), hash.slice(2))
  }

  function revisionPath(id: string): string {
    return join(root, 'revisions', `${id}.json`)
  }

  /**
   * Revision ids are generated by `formatId` and always match this shape
   * (legacy numeric-era ids included). `readRevision`/`deleteRevision` take
   * caller-supplied ids: `join` is plain string concatenation, so an id
   * containing `..` segments would resolve outside `revisions/` on
   * providers that normalize paths (the filesystem provider does), turning
   * delete into an arbitrary-file delete inside the storage root. Reject
   * anything outside the generated shape at the public boundary.
   */
  const REVISION_ID_PATTERN = /^rev-\d+(?:-\d+)?(?:-[0-9a-f]{8})?$/
  const isRevisionId = (id: string): boolean => REVISION_ID_PATTERN.test(id)

  /**
   * Chronological order key: timestamp first, then the NUMERIC same-
   * millisecond sequence, then the random suffix. A bare `rev-<ms>` is
   * sequence 1, so a lexicographic sort would misorder `-10` before `-2`
   * once one millisecond sees 10+ revisions. Legacy ids (no suffix) sort
   * before suffixed ids at the same (ms, seq): they predate the suffixed
   * scheme. Non-matching names sort last, by name.
   */
  const revisionIdKey = (id: string): [number, number, string] => {
    const m = /^rev-(\d+)(?:-(\d+))?(?:-([0-9a-f]{8}))?$/.exec(id)
    if (!m) return [Number.POSITIVE_INFINITY, 0, id]
    return [Number(m[1]), m[2] ? Number(m[2]) : 1, m[3] ?? '']
  }
  const compareRevisionIds = (a: string, b: string): number => {
    const [am, as, an] = revisionIdKey(a)
    const [bm, bs, bn] = revisionIdKey(b)
    return am - bm || as - bs || (an < bn ? -1 : an > bn ? 1 : 0)
  }

  /**
   * The revisions/ directory listing is the source of truth for which
   * revisions exist. Per-revision files never serialize through one
   * shared file, so concurrent writers on one target cannot lose each
   * other's entries - the per-edge pattern the rest of Gazetta uses
   * for multi-instance writes (sidecars.md). index.json is only a
   * cache of this listing (#1089).
   *
   * Ids are timestamp-based, so chronological order (oldest first) is a
   * numeric compare on (timestamp, sequence) - see compareRevisionIds;
   * plain lexicographic sort breaks on same-millisecond sequences >= 10.
   */
  async function listRevisionIds(): Promise<string[]> {
    if (!(await storage.exists(join(root, 'revisions')))) return []
    const entries = await storage.readDir(join(root, 'revisions'))
    return entries
      .filter(e => !e.isDirectory && e.name.endsWith('.json'))
      .map(e => e.name.slice(0, -'.json'.length))
      .sort(compareRevisionIds)
  }

  /**
   * Best-effort rewrite of the index cache from the listing. Every
   * writer syncs only AFTER its manifest is durable, and a durable
   * manifest is visible in the listing - so the listing alone is a
   * complete cache source. Unioning with the previous cache instead
   * would resurrect evicted and deleted ids forever (#1107 review).
   * A lost cache update is harmless: the listing stays authoritative.
   */
  async function syncIndexCache(): Promise<void> {
    try {
      const idx = await readIndex()
      const ids = await listRevisionIds()
      if (ids.length === idx.revisions.length && ids.every((v, i) => v === idx.revisions[i])) return
      await writeIndex({ revisions: ids })
    } catch {
      // Swallowed on purpose: the cache is derived state. Callers invoke
      // this only AFTER the manifest is durable, and readers list the
      // revisions/ directory - so a cache read/write failure here must not
      // fail a save whose record already exists.
    }
  }

  /**
   * SHA-256 hex of the content. Strong enough that collisions can be
   * ignored for practical purposes (blob identity), cheap enough at
   * our scale (tens of KB per item, hundreds of items per revision).
   *
   * Accepts both text and bytes per Q9 lock. Text encodes UTF-8 first
   * — matches the bytes that would be written through `writeFile`,
   * so a string blob and a `Uint8Array` of its UTF-8 encoding hash
   * to the same value (and dedupe correctly).
   */
  function hashContent(content: BlobContent): string {
    const bytes = content instanceof Uint8Array ? content : Buffer.from(content, 'utf-8')
    return createHash('sha256').update(bytes).digest('hex')
  }

  /**
   * Allocate a fresh revision id. Scheme: `rev-<unixMillis>-<seq>-<suffix>`
   * ("rev-1760...050-1-a1b2c3d4", ...). `seq` is the per-millisecond
   * sequence from a FRESH revisions/ listing (starting at 1, so
   * sequential writes in one millisecond keep their order); `suffix` is
   * 8 random hex chars that keep concurrent writers apart without any
   * coordination (#1112). Legacy ids (`rev-<ms>`, `rev-<ms>-<seq>`) still
   * parse and sort - they count as sequence 1 / N for allocation.
   *
   * Why millis + random suffix rather than a monotonic counter:
   *   - Retention evictions leave you with a window of revisions you
   *     can date-read from the filename alone.
   *   - No counter to overflow or reset when history is disabled then
   *     re-enabled.
   *   - Two writers that list in the same millisecond pick the same seq
   *     but different suffixes, so neither overwrites the other's file.
   *
   * `_clock` is injectable for deterministic tests — production uses
   * Date.now(). Stays private to createHistoryProvider.
   */
  function formatId(existing: readonly string[], now: number): string {
    const base = `rev-${now}`
    // Next sequence for this millisecond. A bare `rev-<ms>` is sequence 1;
    // `rev-<ms>-N` and `rev-<ms>-N-<suffix>` are sequence N.
    let seq = 1
    for (const id of existing) {
      if (id === base) {
        seq = Math.max(seq, 2)
        continue
      }
      if (!id.startsWith(`${base}-`)) continue
      const rest = Number(id.slice(base.length + 1).split('-')[0])
      if (Number.isFinite(rest)) seq = Math.max(seq, rest + 1)
    }
    return `${base}-${seq}-${randomBytes(4).toString('hex')}`
  }

  /**
   * Write any blob that's not already stored. Returns the hash. Dedup
   * check is a single `exists()` — cheaper than reading the existing
   * blob to confirm equal content (hashes collide vanishingly).
   *
   * Always goes through `writeBytes` — text content is encoded UTF-8
   * first. Uniform bytes-in / bytes-out means binary blobs (asset
   * bytes, variants, fonts) round-trip without a string detour, and
   * text blobs round-trip through their UTF-8 encoding (same bytes
   * `writeFile` would have stored).
   */
  async function writeBlob(content: BlobContent): Promise<string> {
    const hash = hashContent(content)
    const path = blobPath(hash)
    if (await storage.exists(path)) return hash
    const parent = path.substring(0, path.lastIndexOf('/'))
    if (parent) await storage.mkdir(parent)
    const bytes = content instanceof Uint8Array ? content : Buffer.from(content, 'utf-8')
    await storage.writeBytes(path, bytes)
    return hash
  }

  async function recordRevision(input: RevisionInput): Promise<Revision> {
    // Write blobs (dedup via content-addressing) and build the
    // path → hash snapshot. Content-addressed writes commute, so
    // concurrent writers can do this phase simultaneously safely.
    const snapshot: Record<string, string> = {}
    // Deterministic order so rev manifests diff cleanly on inspection.
    const sortedEntries = [...input.items.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    for (const [path, content] of sortedEntries) {
      snapshot[path] = await writeBlob(content)
    }

    // Allocate the id against a FRESH listing, then write the manifest
    // once. Ids carry a random suffix (see formatId), so two writers that
    // list in the same millisecond pick different filenames and neither
    // overwrites the other's manifest - no read-back or retry loop is
    // needed even without a create-exclusive write in the storage
    // contract (#1112).
    const id = formatId(await listRevisionIds(), Date.now())
    const manifest: RevisionManifest = {
      id,
      timestamp: new Date().toISOString(),
      operation: input.operation,
      author: input.author,
      source: input.source,
      items: [...input.items.keys()].sort(),
      message: input.message,
      restoredFrom: input.restoredFrom,
      snapshot,
    }
    const json = JSON.stringify(manifest, null, 2) + '\n'
    await writeWithParents(revisionPath(id), json)

    // Refresh the index cache, then apply retention. The manifest is
    // already durable at this point, and the listing - not the cache -
    // is what readers use, so a mid-write failure here leaves only a
    // stale cache that the next write rebuilds (#1089).
    await syncIndexCache()
    await applyRetention(id)

    // Return the public Revision shape (no snapshot).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { snapshot: _snapshot, ...revision } = manifest
    return revision
  }

  /**
   * Evict oldest revisions to fit `retention`. Deletes manifests; blobs
   * become eligible for GC if no remaining revision references them.
   * GC is lazy — blob files stay until an explicit GC pass, which is
   * fine for v1 (disk is cheap; a future `gazetta gc` command can walk
   * all manifests and prune orphans).
   */
  async function applyRetention(protectedId?: string): Promise<void> {
    const ids = await listRevisionIds()
    const excess = ids.length - retention
    if (excess <= 0) return
    const evict = ids.slice(0, excess)
    if (protectedId) {
      // Under clock skew the just-written id can sort oldest; deleting it
      // would silently drop the record the caller believes is durable.
      // Evict the next oldest instead.
      const idx = evict.indexOf(protectedId)
      if (idx >= 0) {
        const replacement = ids[excess]
        if (!replacement) return
        evict[idx] = replacement
      }
    }
    for (const id of evict) {
      // Idempotent delete: a concurrent writer can pick the same
      // eviction set, and a plain rm on the already-deleted manifest
      // would fail the whole write (#1107 review).
      await rmIgnoreMissing(storage, revisionPath(id))
    }
    await syncIndexCache()
  }

  async function listRevisions(limit?: number): Promise<Revision[]> {
    const ids = (await listRevisionIds()).reverse() // newest first
    const sliced = typeof limit === 'number' ? ids.slice(0, limit) : ids
    // Read manifests in parallel; strip snapshot for the summary list.
    return Promise.all(
      sliced.map(async id => {
        const m = await readManifest(id)
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { snapshot: _snapshot, ...rev } = m
        return rev
      }),
    )
  }

  async function readManifest(id: string): Promise<RevisionManifest> {
    return JSON.parse(await storage.readFile(revisionPath(id))) as RevisionManifest
  }

  async function readRevision(id: string): Promise<RevisionManifest> {
    if (!isRevisionId(id)) throw new Error('invalid revision id')
    return readManifest(id)
  }

  async function readBlob(hash: string): Promise<Uint8Array> {
    // Bytes-in / bytes-out — binary blobs (asset bytes, variants,
    // fonts) round-trip without a string-decode detour; text blobs
    // (manifests, YAML, etc.) come back as their UTF-8 byte form
    // and callers that expect text decode at the boundary.
    return storage.readBytes(blobPath(hash))
  }

  async function deleteRevision(id: string): Promise<void> {
    if (!isRevisionId(id)) return // unknown id shape: treat as not found
    const path = revisionPath(id)
    // Idempotent delete: a concurrent deleteRevision can pass the same
    // existence check, and a plain rm on the already-deleted manifest
    // would throw (same race retention handles with rmIgnoreMissing).
    await rmIgnoreMissing(storage, path)
    await syncIndexCache()
    // Orphan blobs left for lazy GC — see applyRetention rationale.
  }

  return {
    recordRevision,
    listRevisions,
    readRevision,
    readBlob,
    deleteRevision,
  }
}

/**
 * `posix.join` behavior without importing it — keeps the module self-
 * contained and works identically across platforms. Storage providers
 * normalize separators internally, but our stored paths are POSIX.
 */
function join(...parts: string[]): string {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/')
}

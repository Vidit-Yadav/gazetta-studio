/**
 * Unit tests for createHistoryProvider. Uses an in-memory StorageProvider
 * so we exercise the real layout logic (index.json, revisions/, objects/
 * sharding) without touching disk.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createHistoryProvider } from '../src/history-provider.js'
import type { RevisionInput } from '../src/history.js'
import { memoryStorage } from './_helpers/memory-storage.js'

function input(items: Record<string, string>, overrides: Partial<RevisionInput> = {}): RevisionInput {
  return {
    operation: 'save',
    items: new Map(Object.entries(items)),
    ...overrides,
  }
}

/** Revision id matcher: `rev-<unixMillis>-<seq>-<suffix>`, plus the legacy `rev-<unixMillis>` / `rev-<unixMillis>-<seq>` forms. */
const ID_SHAPE = /^rev-\d{10,}(?:-\d+)?(?:-[0-9a-f]{8})?$/

describe('createHistoryProvider', () => {
  let storage: ReturnType<typeof memoryStorage>
  beforeEach(() => {
    storage = memoryStorage()
  })

  describe('recordRevision', () => {
    it('assigns timestamp-based ids (rev-<unixMillis>-<seq>-<suffix>)', async () => {
      const h = createHistoryProvider({ storage })
      const r1 = await h.recordRevision(input({ 'pages/home': 'a' }))
      const r2 = await h.recordRevision(input({ 'pages/home': 'b' }))
      expect(r1.id).toMatch(ID_SHAPE)
      expect(r2.id).toMatch(ID_SHAPE)
      // Same-millisecond collision resolves via `-<seq>` suffix — both
      // ids must still be distinct and lex-orderable by creation time.
      expect(r1.id).not.toBe(r2.id)
      expect([r1.id, r2.id].sort()).toEqual([r1.id, r2.id])
    })

    it('writes a manifest per revision under revisions/', async () => {
      const h = createHistoryProvider({ storage })
      const r = await h.recordRevision(input({ 'pages/home': 'a' }))
      expect(await storage.exists(`.gazetta/history/revisions/${r.id}.json`)).toBe(true)
    })

    it('stores items as content-addressed blobs (sharded by first 2 hex chars)', async () => {
      const h = createHistoryProvider({ storage })
      await h.recordRevision(input({ 'pages/home': 'hello' }))
      // sha256('hello') = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
      const shardedPath = '.gazetta/history/objects/2c/f24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
      expect(await storage.exists(shardedPath)).toBe(true)
      expect(await storage.readFile(shardedPath)).toBe('hello')
    })

    it('dedupes unchanged content across revisions (writes blob only once)', async () => {
      const h = createHistoryProvider({ storage })
      await h.recordRevision(input({ 'pages/home': 'same', 'pages/about': 'same' }))
      await h.recordRevision(input({ 'pages/home': 'same', 'pages/about': 'changed' }))
      // Two unique contents → two blobs, not four.
      const blobs = [...storage.dump().keys()].filter(k => k.startsWith('.gazetta/history/objects/'))
      expect(blobs).toHaveLength(2)
    })

    it('returns the recorded Revision metadata (without the snapshot)', async () => {
      const h = createHistoryProvider({ storage })
      const rev = await h.recordRevision(
        input({ 'pages/home': 'a' }, { operation: 'publish', source: 'local', message: 'hotfix' }),
      )
      expect(rev.id).toMatch(ID_SHAPE)
      expect(rev).toMatchObject({
        operation: 'publish',
        source: 'local',
        message: 'hotfix',
        items: ['pages/home'],
      })
      expect(rev).not.toHaveProperty('snapshot')
      expect(rev.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('sorts item paths deterministically in the manifest', async () => {
      const h = createHistoryProvider({ storage })
      const r = await h.recordRevision(input({ 'pages/z': 'z', 'pages/a': 'a', 'pages/m': 'm' }))
      const manifest = JSON.parse(await storage.readFile(`.gazetta/history/revisions/${r.id}.json`))
      expect(manifest.items).toEqual(['pages/a', 'pages/m', 'pages/z'])
      expect(Object.keys(manifest.snapshot)).toEqual(['pages/a', 'pages/m', 'pages/z'])
    })
  })

  describe('listRevisions', () => {
    it('returns revisions newest-first', async () => {
      const h = createHistoryProvider({ storage })
      const r1 = await h.recordRevision(input({ a: '1' }))
      const r2 = await h.recordRevision(input({ a: '2' }))
      const r3 = await h.recordRevision(input({ a: '3' }))
      const list = await h.listRevisions()
      expect(list.map(r => r.id)).toEqual([r3.id, r2.id, r1.id])
    })

    it('honors the limit parameter', async () => {
      const h = createHistoryProvider({ storage })
      const ids: string[] = []
      for (let i = 0; i < 5; i++) ids.push((await h.recordRevision(input({ a: `${i}` }))).id)
      const list = await h.listRevisions(2)
      expect(list).toHaveLength(2)
      expect(list[0].id).toBe(ids[4])
    })

    it('empty when no revisions exist yet', async () => {
      const h = createHistoryProvider({ storage })
      expect(await h.listRevisions()).toEqual([])
    })
  })

  describe('readRevision', () => {
    it('returns the full manifest with snapshot', async () => {
      const h = createHistoryProvider({ storage })
      const r = await h.recordRevision(input({ 'pages/home': 'a', 'pages/about': 'b' }))
      const m = await h.readRevision(r.id)
      expect(m.items).toEqual(['pages/about', 'pages/home'])
      expect(Object.keys(m.snapshot).sort()).toEqual(['pages/about', 'pages/home'])
    })
  })

  describe('readBlob', () => {
    it('returns the content as bytes for a given hash', async () => {
      const h = createHistoryProvider({ storage })
      const r = await h.recordRevision(input({ 'pages/home': 'hello' }))
      const m = await h.readRevision(r.id)
      const bytes = await h.readBlob(m.snapshot['pages/home']!)
      // readBlob returns Uint8Array (per Q9 lock — text and binary
      // both first-class). Decode UTF-8 to compare against the
      // original string.
      expect(new TextDecoder().decode(bytes)).toBe('hello')
    })

    it('round-trips binary content (Uint8Array in → Uint8Array out)', async () => {
      const h = createHistoryProvider({ storage })
      const original = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]) // JPEG SOI marker
      const r = await h.recordRevision(input({ 'assets/hero-abc12345.jpg': original }))
      const m = await h.readRevision(r.id)
      const bytes = await h.readBlob(m.snapshot['assets/hero-abc12345.jpg']!)
      expect(bytes).toBeInstanceOf(Uint8Array)
      expect(Array.from(bytes)).toEqual(Array.from(original))
    })

    it('text and identical-bytes hash to the same blob (dedup holds)', async () => {
      const h = createHistoryProvider({ storage })
      const text = 'identical content'
      const bytes = new TextEncoder().encode(text)

      const r1 = await h.recordRevision(input({ 'item-a': text }))
      const r2 = await h.recordRevision(input({ 'item-b': bytes }))

      const m1 = await h.readRevision(r1.id)
      const m2 = await h.readRevision(r2.id)
      // Same hash because the underlying bytes (UTF-8 of the text)
      // match the explicit Uint8Array.
      expect(m1.snapshot['item-a']).toBe(m2.snapshot['item-b'])
    })
  })

  describe('retention', () => {
    it('keeps only the most recent N revisions (default 50)', async () => {
      const h = createHistoryProvider({ storage, retention: 3 })
      const ids: string[] = []
      for (let i = 0; i < 5; i++) ids.push((await h.recordRevision(input({ a: `${i}` }))).id)
      const list = await h.listRevisions()
      expect(list.map(r => r.id)).toEqual([ids[4], ids[3], ids[2]])
    })

    it('evicts oldest manifests on write; new ids remain orderable after evictions', async () => {
      const h = createHistoryProvider({ storage, retention: 2 })
      const r1 = await h.recordRevision(input({ a: '1' }))
      const r2 = await h.recordRevision(input({ a: '2' }))
      const r3 = await h.recordRevision(input({ a: '3' })) // evicts r1
      expect(await storage.exists(`.gazetta/history/revisions/${r1.id}.json`)).toBe(false)
      expect(await storage.exists(`.gazetta/history/revisions/${r2.id}.json`)).toBe(true)
      // New ids don't collide with any retained or evicted id.
      const r4 = await h.recordRevision(input({ a: '4' }))
      expect(r4.id).not.toBe(r1.id)
      expect(r4.id).not.toBe(r2.id)
      expect(r4.id).not.toBe(r3.id)
      // ... and a lex-sort still matches chrono order across evictions.
      expect([r1.id, r2.id, r3.id, r4.id]).toEqual([r1.id, r2.id, r3.id, r4.id].slice().sort())
    })

    it('clamps retention <= 0 to 1 (disable via history.enabled instead)', async () => {
      const h = createHistoryProvider({ storage, retention: 0 })
      await h.recordRevision(input({ a: '1' }))
      const r2 = await h.recordRevision(input({ a: '2' }))
      const list = await h.listRevisions()
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe(r2.id)
    })
  })

  describe('deleteRevision', () => {
    it('removes the manifest and drops from the index', async () => {
      const h = createHistoryProvider({ storage })
      const r1 = await h.recordRevision(input({ a: '1' }))
      const r2 = await h.recordRevision(input({ a: '2' }))
      await h.deleteRevision(r1.id)
      expect(await storage.exists(`.gazetta/history/revisions/${r1.id}.json`)).toBe(false)
      const list = await h.listRevisions()
      expect(list.map(r => r.id)).toEqual([r2.id])
    })

    it('no-op for unknown id', async () => {
      const h = createHistoryProvider({ storage })
      await h.recordRevision(input({ a: '1' }))
      await h.deleteRevision('rev-9999999999999') // should not throw
      const list = await h.listRevisions()
      expect(list).toHaveLength(1)
    })
  })

  describe('id validation (#1107 review)', () => {
    it('deleteRevision never issues an rm for ids outside the generated shape', async () => {
      // join() is string concatenation; on providers that normalize paths
      // (filesystem) an id like '../../../secret' would resolve OUTSIDE
      // revisions/ and delete an unrelated file inside the storage root.
      const inner = memoryStorage()
      const rmCalls: string[] = []
      const spy = {
        ...inner,
        async rm(path: string) {
          rmCalls.push(path)
          return inner.rm(path)
        },
      }
      const h = createHistoryProvider({ storage: spy })
      await h.recordRevision(input({ a: '1' }))
      rmCalls.length = 0
      // Seed the path a traversal id would resolve to, so a missing guard
      // is observable as an rm call (memory storage keys are literal; the
      // filesystem provider would normalize the same path outside
      // revisions/).
      await inner.writeFile('.gazetta/history/revisions/../../../secret.json', 'x')
      await h.deleteRevision('../../../secret')
      await h.deleteRevision('rev-123.json')
      await h.deleteRevision('not-a-revision-id')
      expect(rmCalls).toEqual([])
      // The real revision is untouched.
      expect(await h.listRevisions()).toHaveLength(1)
    })

    it('readRevision rejects ids outside the generated shape', async () => {
      const h = createHistoryProvider({ storage })
      await expect(h.readRevision('../../../secret')).rejects.toThrow(/invalid revision id/)
      await expect(h.readRevision('rev-123.json')).rejects.toThrow(/invalid revision id/)
    })
  })

  describe('listing order (#1107 review)', () => {
    it('orders same-millisecond sequence suffixes numerically, not lexicographically', async () => {
      // 'rev-<ms>-10' sorts before 'rev-<ms>-2' in a plain string sort,
      // which would corrupt both listRevisions order and retention's
      // oldest-first eviction once one millisecond sees 10+ revisions.
      const h = createHistoryProvider({ storage })
      const base = 'rev-1700000000000'
      for (const seq of [10, 2]) {
        await storage.writeFile(
          `.gazetta/history/revisions/${base}-${seq}.json`,
          JSON.stringify({
            id: `${base}-${seq}`,
            timestamp: '2023-11-14T22:13:20.000Z',
            operation: 'save',
            items: [],
            snapshot: {},
          }),
        )
      }
      const list = await h.listRevisions() // newest first
      expect(list.map(r => r.id)).toEqual([`${base}-10`, `${base}-2`])
    })
  })

  describe('retention under clock skew (#1107 review)', () => {
    it('never evicts the revision the current write just recorded', async () => {
      // A skewed-clock instance can hold a future-dated id; a normal write
      // then sorts OLDER than it, and naive oldest-first eviction at
      // retention=1 would delete the revision this very call just made
      // durable. The writer's own id is protected instead.
      const h = createHistoryProvider({ storage, retention: 1 })
      await storage.writeFile(
        '.gazetta/history/revisions/rev-9999999999999.json',
        JSON.stringify({
          id: 'rev-9999999999999',
          timestamp: '2286-11-20T17:46:39.000Z',
          operation: 'save',
          items: [],
          snapshot: {},
        }),
      )
      const r = await h.recordRevision(input({ a: '1' }))
      const list = await h.listRevisions()
      expect(list.map(x => x.id)).toEqual([r.id])
    })
  })

  describe('index cache resilience (#1107 review)', () => {
    it('a corrupt index.json neither blocks writes nor stays corrupt', async () => {
      const h = createHistoryProvider({ storage })
      await h.recordRevision(input({ a: '1' }))
      await storage.writeFile('.gazetta/history/index.json', 'not json{{{')
      // The cache is disposable; the listing is truth. This must not throw.
      const r2 = await h.recordRevision(input({ a: '2' }))
      expect(await h.listRevisions()).toHaveLength(2)
      // The next sync healed the cache from the listing.
      const healed = JSON.parse(await storage.readFile('.gazetta/history/index.json'))
      expect(healed.revisions).toContain(r2.id)
    })
  })

  describe('rootPath option', () => {
    it('stores history under the provided path', async () => {
      const h = createHistoryProvider({ storage, rootPath: 'custom/path' })
      const r = await h.recordRevision(input({ a: '1' }))
      expect(await storage.exists('custom/path/index.json')).toBe(true)
      expect(await storage.exists(`custom/path/revisions/${r.id}.json`)).toBe(true)
    })
  })
})

describe('concurrent recordRevision (#1089)', () => {
  it('two unawaited recordRevision calls both land in listRevisions with distinct ids', async () => {
    // Storage double that delays the index read so both writers read the
    // same starting index - the interleaving that used to lose a revision.
    const inner = memoryStorage()
    const storage = {
      ...inner,
      async readFile(path: string) {
        if (path.endsWith('index.json')) await new Promise(r => setTimeout(r, 10))
        return inner.readFile(path)
      },
    }
    const h = createHistoryProvider({ storage })
    const [r1, r2] = await Promise.all([
      h.recordRevision(input({ 'pages/home': 'from-a' })),
      h.recordRevision(input({ 'pages/about': 'from-b' })),
    ])
    expect(r1.id).not.toBe(r2.id)
    const list = await h.listRevisions()
    const ids = list.map(r => r.id)
    expect(ids).toContain(r1.id)
    expect(ids).toContain(r2.id)
    // And both revisions' content must be intact - no manifest overwrite.
    const m1 = await h.readRevision(r1.id)
    const m2 = await h.readRevision(r2.id)
    expect(m1.items).toContain('pages/home')
    expect(m2.items).toContain('pages/about')
  })

  it('listRevisions reflects revisions whose manifest exists even when index.json is stale', async () => {
    // The revisions/ listing is the source of truth; index.json is a cache.
    const storage = memoryStorage()
    const h = createHistoryProvider({ storage })
    const r = await h.recordRevision(input({ 'pages/home': 'a' }))
    // Simulate a lost index update (the #1089 failure): rewrite the index
    // without the id, leaving the manifest on disk.
    await storage.writeFile('.gazetta/history/index.json', JSON.stringify({ revisions: [] }) + '\n')
    const list = await h.listRevisions()
    expect(list.map(x => x.id)).toContain(r.id)
  })
})

describe('index cache hygiene and concurrent retention (#1107 review)', () => {
  it('the index cache drops evicted ids after retention', async () => {
    const storage = memoryStorage()
    const h = createHistoryProvider({ storage, retention: 2 })
    const r1 = await h.recordRevision(input({ 'pages/home': 'a' }))
    const r2 = await h.recordRevision(input({ 'pages/home': 'b' }))
    const r3 = await h.recordRevision(input({ 'pages/home': 'c' }))
    expect(r1.id).not.toBe(r2.id)
    const raw = JSON.parse(await storage.readFile('.gazetta/history/index.json')) as { revisions: string[] }
    expect(raw.revisions).toHaveLength(2)
    expect(raw.revisions).not.toContain(r1.id)
    expect(raw.revisions).toContain(r3.id)
  })

  it('two concurrent writers past retention do not fail on duplicate eviction', async () => {
    // fs-faithful rm: deleting a missing path throws, like the real
    // filesystem provider. Two writers that both decide to evict the
    // same oldest revision must not fail on the duplicate delete.
    const inner = memoryStorage()
    const storage = {
      ...inner,
      async rm(path: string) {
        if (!(await inner.exists(path))) throw new Error(`Cannot delete ${path}: ENOENT`)
        return inner.rm(path)
      },
      async readFile(path: string) {
        if (path.endsWith('index.json')) await new Promise(r => setTimeout(r, 10))
        return inner.readFile(path)
      },
      async readDir(path: string) {
        // Delay the revisions/ listing so both writers compute the same
        // eviction set before either deletes - the reported race.
        if (path.endsWith('revisions')) await new Promise(r => setTimeout(r, 10))
        return inner.readDir(path)
      },
    }
    const h = createHistoryProvider({ storage, retention: 1 })
    await h.recordRevision(input({ 'pages/home': 'seed' }))
    const [r1, r2] = await Promise.all([
      h.recordRevision(input({ 'pages/a': 'from-a' })),
      h.recordRevision(input({ 'pages/b': 'from-b' })),
    ])
    expect(r1.id).not.toBe(r2.id)
    // retention=1: exactly one revision survives, and it is one of the two.
    const list = await h.listRevisions()
    expect(list).toHaveLength(1)
  })
})

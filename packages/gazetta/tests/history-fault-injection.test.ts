/**
 * Fault-injection tests for history + publish — testing-plan.md Priority 1.4.
 *
 * The history subsystem claims soft-undo correctness under failure: per
 * history-provider.ts:197-201, "Do the index write last so a mid-write
 * failure leaves orphan blobs and an orphan manifest (both harmless)
 * rather than a dangling index entry pointing at a missing manifest."
 *
 * This test file injects failures at each write step (blob, manifest,
 * index) and verifies:
 *
 *   1. A failure during blob writes leaves the index unchanged — no
 *      phantom revision is readable.
 *   2. A failure during manifest write leaves blobs behind but index
 *      unchanged.
 *   3. A failure during index write leaves blobs + manifest behind but
 *      listRevisions() doesn't see the new id.
 *   4. After ANY mid-write failure, the NEXT successful recordRevision
 *      produces a clean revision — no dangling references, no stale
 *      state.
 *   5. Retention eviction is atomic — a failure during eviction doesn't
 *      corrupt the index.
 *
 * Mechanism: wrap an in-memory StorageProvider with a decorator that
 * fails the Nth write. Fault-injection tests don't verify the happy
 * path (other tests do that); they verify the claimed failure-mode
 * invariants.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHistoryProvider } from '../src/history-provider.js'
import { type MemoryStorage, memoryStorage } from './_helpers/memory-storage.js'

// ---------------------------------------------------------------------------
// Chaos decorator: fail the Nth write matching a predicate.
// ---------------------------------------------------------------------------

interface FaultSpec {
  /** Predicate on the path. When matched, counts toward skipUntilFail. */
  match: (path: string) => boolean
  /** Number of matching writes to let through before failing the next one. */
  skipUntilFail: number
  /** Error to throw on the triggered failure. */
  error: string
}

/**
 * Wrap a storage so its `writeFile` and `writeBytes` calls fail the
 * Nth call matching `spec.match`. One-shot: after the fault triggers,
 * subsequent calls pass through normally.
 *
 * Intercepts BOTH text (`writeFile`) and bytes (`writeBytes`) writes
 * because the history provider routes blob writes through `writeBytes`
 * (after step 20) while index + revision-manifest writes still use
 * `writeFile`. Match-by-path then catches the right call regardless
 * of which write API the provider used.
 */
function withFault(inner: MemoryStorage, spec: FaultSpec): MemoryStorage & { triggered: () => boolean } {
  let seen = 0
  let hasFired = false
  function maybeFail(path: string): void {
    if (hasFired || !spec.match(path)) return
    if (seen === spec.skipUntilFail) {
      hasFired = true
      throw new Error(spec.error)
    }
    seen += 1
  }
  return {
    ...inner,
    async writeFile(path, content) {
      maybeFail(path)
      return inner.writeFile(path, content)
    },
    async writeBytes(path, content) {
      maybeFail(path)
      return inner.writeBytes(path, content)
    },
    triggered() {
      return hasFired
    },
  }
}

// ---------------------------------------------------------------------------
// Small helpers used by multiple tests.
// ---------------------------------------------------------------------------

function blobCount(storage: MemoryStorage): number {
  return [...storage.dump().keys()].filter(p => p.startsWith('.gazetta/history/objects/')).length
}
function manifestCount(storage: MemoryStorage): number {
  return [...storage.dump().keys()].filter(p => p.startsWith('.gazetta/history/revisions/')).length
}
async function readIndex(storage: MemoryStorage): Promise<{ revisions: string[] } | null> {
  try {
    return JSON.parse(await storage.readFile('.gazetta/history/index.json'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('history fault injection — mid-blob-write failure', () => {
  let storage: MemoryStorage
  beforeEach(() => {
    storage = memoryStorage()
  })

  it('leaves no index update when a blob write fails partway through', async () => {
    const faulted = withFault(storage, {
      match: p => p.startsWith('.gazetta/history/objects/'),
      skipUntilFail: 2, // let 2 blobs through, fail the 3rd
      error: 'storage transient',
    })
    const history = createHistoryProvider({ storage: faulted })

    await expect(
      history.recordRevision({
        operation: 'save',
        items: new Map([
          ['a.json', '{"a":1}'],
          ['b.json', '{"b":1}'],
          ['c.json', '{"c":1}'],
          ['d.json', '{"d":1}'],
        ]),
      }),
    ).rejects.toThrow(/storage transient/)
    expect(faulted.triggered()).toBe(true)

    // Index was never updated — listRevisions sees nothing.
    expect(await history.listRevisions()).toEqual([])
    // Orphan blobs may be present (2 that made it before the fault) —
    // that's explicitly allowed by the design (lazy GC).
    expect(blobCount(storage)).toBeLessThanOrEqual(2)
    // No manifest was written (blobs fail before manifest).
    expect(manifestCount(storage)).toBe(0)
  })

  it('allows a subsequent recordRevision to succeed cleanly after a blob-write failure', async () => {
    const faulted = withFault(storage, {
      match: p => p.startsWith('.gazetta/history/objects/'),
      skipUntilFail: 0,
      error: 'first write fails',
    })
    const history = createHistoryProvider({ storage: faulted })
    await expect(
      history.recordRevision({
        operation: 'save',
        items: new Map([['a.json', '{"a":1}']]),
      }),
    ).rejects.toThrow()

    // Second attempt runs against the same storage (fault latch is one-shot).
    const rev = await history.recordRevision({
      operation: 'save',
      items: new Map([['a.json', '{"a":2}']]),
    })
    expect(rev.id).toMatch(/^rev-\d+/)

    const list = await history.listRevisions()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(rev.id)
    // Manifest is readable and references a stored blob
    const manifest = await history.readRevision(rev.id)
    const hashForA = manifest.snapshot['a.json']
    expect(hashForA).toBeDefined()
    // readBlob returns Uint8Array — decode UTF-8 to compare against the
    // original string.
    expect(new TextDecoder().decode(await history.readBlob(hashForA!))).toBe('{"a":2}')
  })
})

describe('history fault injection — mid-manifest-write failure', () => {
  let storage: MemoryStorage
  beforeEach(() => {
    storage = memoryStorage()
  })

  it('leaves blobs behind but index unchanged when manifest write fails', async () => {
    const faulted = withFault(storage, {
      match: p => p.startsWith('.gazetta/history/revisions/'),
      skipUntilFail: 0,
      error: 'manifest write fails',
    })
    const history = createHistoryProvider({ storage: faulted })

    await expect(
      history.recordRevision({
        operation: 'save',
        items: new Map([['a.json', '{"a":1}']]),
      }),
    ).rejects.toThrow(/manifest write fails/)

    expect(await history.listRevisions()).toEqual([])
    // Blobs that made it before the manifest-write attempt are allowed
    // as orphans — lazy GC takes them eventually.
    expect(manifestCount(storage)).toBe(0)
    // Index must not list a phantom revision
    const idx = await readIndex(storage)
    expect(idx).toBeNull()
  })
})

describe('history fault injection — mid-index-write failure', () => {
  let storage: MemoryStorage
  beforeEach(() => {
    storage = memoryStorage()
  })

  it('does not corrupt the index when the index write fails', async () => {
    // First succeed a revision, then fault the second index write.
    const history = createHistoryProvider({ storage })
    await history.recordRevision({
      operation: 'save',
      items: new Map([['a.json', '{"a":1}']]),
    })
    const firstList = await history.listRevisions()
    expect(firstList).toHaveLength(1)

    // Snapshot the index as-of now.
    const indexBefore = await readIndex(storage)

    // Now make the NEXT write to index.json fail.
    const faulted = withFault(storage, {
      match: p => p === '.gazetta/history/index.json',
      skipUntilFail: 0,
      error: 'index write fails',
    })
    const history2 = createHistoryProvider({ storage: faulted })
    // Since #1089 the manifest is the record and index.json only a cache,
    // so a cache-write failure must not fail the save (#1107 review): the
    // call resolves with the recorded revision.
    const rev = await history2.recordRevision({
      operation: 'save',
      items: new Map([['b.json', '{"b":1}']]),
    })
    expect(faulted.triggered()).toBe(true)

    // Index is still the pre-failure snapshot — the failed write did not
    // corrupt the cache file.
    const indexAfter = await readIndex(storage)
    expect(indexAfter).toEqual(indexBefore)
    // And the revision itself is NOT lost: the revisions/ listing is the
    // source of truth, so listRevisions sees both revisions despite the
    // failed cache write.
    const list = await history2.listRevisions()
    expect(list).toHaveLength(2)
    expect(list.map(r => r.id)).toContain(firstList[0].id)
    expect(list.map(r => r.id)).toContain(rev.id)
  })
})

describe('history fault injection — retention eviction atomicity', () => {
  let storage: MemoryStorage
  beforeEach(() => {
    storage = memoryStorage()
  })

  it('does not lose the new revision when eviction of the old one fails', async () => {
    const history = createHistoryProvider({ storage, retention: 1 })
    // First revision — no eviction yet.
    const rev1 = await history.recordRevision({
      operation: 'save',
      items: new Map([['a.json', '{"v":1}']]),
    })
    expect((await history.listRevisions())[0].id).toBe(rev1.id)

    // Second revision should trigger eviction of rev1. Inject a fault
    // on the `rm` of the old manifest. (applyRetention does rm then
    // writeIndex; failure during rm happens AFTER the index update that
    // removed the old id, so the new revision is durable and rev1 is
    // unreadable from listRevisions — which is what retention wants
    // anyway. Orphan manifest is harmless.)
    const originalRm = storage.rm.bind(storage)
    let rmFailed = false
    storage.rm = async (path: string) => {
      if (!rmFailed && path.startsWith('.gazetta/history/revisions/')) {
        rmFailed = true
        throw new Error('rm fails')
      }
      return originalRm(path)
    }

    // The second write itself should fail (recordRevision throws because
    // applyRetention propagates). But the new revision must be observable
    // or NOT observable consistently — no torn state where index says
    // "evicted" but file lingers as phantom.
    await expect(
      history.recordRevision({
        operation: 'save',
        items: new Map([['a.json', '{"v":2}']]),
      }),
    ).rejects.toThrow(/rm fails/)

    // The index was written with both revisions before applyRetention
    // ran, then the rm failed before it could remove rev1's manifest.
    // The critical invariant — every index entry has a readable manifest
    // — must still hold. Retention has "not yet applied" state; not
    // torn. A subsequent recordRevision's retention pass will finish
    // the eviction.
    const list = await history.listRevisions()
    for (const r of list) {
      // Must not throw — manifest is readable for every listed id
      await expect(history.readRevision(r.id)).resolves.toBeDefined()
    }
  })
})

describe('history fault injection — recovery invariant', () => {
  let storage: MemoryStorage
  beforeEach(() => {
    storage = memoryStorage()
  })

  it('recovery invariant: after any mid-write failure, the index still points to manifests that exist', async () => {
    // Drive three failure scenarios in sequence against the same storage,
    // verifying the invariant after each. Index consistency — "every id
    // in index.json has a readable manifest" — must hold throughout.
    async function assertIndexPointsAtReadableManifests(history: ReturnType<typeof createHistoryProvider>) {
      const list = await history.listRevisions()
      for (const rev of list) {
        await expect(history.readRevision(rev.id)).resolves.toBeDefined()
      }
    }

    // Baseline: one successful revision.
    const history = createHistoryProvider({ storage })
    await history.recordRevision({
      operation: 'save',
      items: new Map([['a.json', '{"a":1}']]),
    })
    await assertIndexPointsAtReadableManifests(history)

    // Fault 1: blob write fails on the next attempt.
    const f1 = withFault(storage, {
      match: p => p.startsWith('.gazetta/history/objects/'),
      skipUntilFail: 0,
      error: 'blob fail',
    })
    const h1 = createHistoryProvider({ storage: f1 })
    await expect(
      h1.recordRevision({
        operation: 'save',
        items: new Map([['b.json', '{"b":1}']]),
      }),
    ).rejects.toThrow()
    await assertIndexPointsAtReadableManifests(h1)

    // Fault 2: manifest write fails on the next attempt (against the
    // original unwrapped storage — different code path).
    const f2 = withFault(storage, {
      match: p => p.startsWith('.gazetta/history/revisions/'),
      skipUntilFail: 0,
      error: 'manifest fail',
    })
    const h2 = createHistoryProvider({ storage: f2 })
    await expect(
      h2.recordRevision({
        operation: 'save',
        items: new Map([['c.json', '{"c":1}']]),
      }),
    ).rejects.toThrow()
    await assertIndexPointsAtReadableManifests(h2)

    // Final successful revision — everything should still work.
    const rev = await history.recordRevision({
      operation: 'save',
      items: new Map([['d.json', '{"d":1}']]),
    })
    expect(rev.id).toBeDefined()
    await assertIndexPointsAtReadableManifests(history)
  })
})

// ---------------------------------------------------------------------------
// Concurrent writers (#1112)
// ---------------------------------------------------------------------------

/**
 * Storage decorator that forces the lost-revision interleaving from #1112:
 * both writers check/list revisions/ BEFORE either writes its manifest, so
 * their `formatId` calls see the same listing. The first matching `exists`
 * waits for the second to arrive (a two-party rendezvous, capped at the
 * first two calls so later listings pass straight through).
 */
function withRendezvousList(inner: MemoryStorage): MemoryStorage {
  let waiting: (() => void) | null = null
  let gated = 0
  return {
    ...inner,
    async exists(path: string) {
      if (path.endsWith('/revisions') && gated < 2) {
        gated += 1
        if (waiting === null) {
          await new Promise<void>(resolve => {
            waiting = resolve
          })
        } else {
          const release = waiting
          waiting = null
          release()
        }
      }
      return inner.exists(path)
    },
  }
}

describe('concurrent recordRevision (#1112)', () => {
  let storage: MemoryStorage
  beforeEach(() => {
    storage = memoryStorage()
  })

  it('two writers listing in the same millisecond both keep their revision', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_760_000_000_000)
    try {
      const gated = withRendezvousList(storage)
      const a = createHistoryProvider({ storage: gated })
      const b = createHistoryProvider({ storage: gated })
      const [ra, rb] = await Promise.all([
        a.recordRevision({ operation: 'save', items: new Map([['pages/home', 'from A']]) }),
        b.recordRevision({ operation: 'save', items: new Map([['pages/home', 'from B']]) }),
      ])
      // Distinct filenames: neither manifest overwrote the other.
      expect(ra.id).not.toBe(rb.id)
      const ids = (await a.listRevisions()).map(r => r.id)
      expect(ids).toContain(ra.id)
      expect(ids).toContain(rb.id)
    } finally {
      vi.useRealTimers()
    }
  })

  it('two sequential writes in one millisecond list in the order written', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_760_000_000_000)
    try {
      const h = createHistoryProvider({ storage })
      const r1 = await h.recordRevision({ operation: 'save', items: new Map([['pages/home', 'one']]) })
      const r2 = await h.recordRevision({ operation: 'save', items: new Map([['pages/home', 'two']]) })
      expect(r1.id).toMatch(/^rev-1760000000000-1-[0-9a-f]{8}$/)
      expect(r2.id).toMatch(/^rev-1760000000000-2-[0-9a-f]{8}$/)
      // listRevisions is newest-first.
      expect((await h.listRevisions()).map(r => r.id)).toEqual([r2.id, r1.id])
    } finally {
      vi.useRealTimers()
    }
  })

  it('legacy ids load and sort together with suffixed ids', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_760_000_000_000)
    try {
      const root = '.gazetta/history'
      const legacyManifest = (id: string) =>
        JSON.stringify(
          { id, timestamp: new Date().toISOString(), operation: 'save', items: ['pages/home'], snapshot: {} },
          null,
          2,
        ) + '\n'
      await storage.writeFile(`${root}/revisions/rev-1760000000000.json`, legacyManifest('rev-1760000000000'))
      await storage.writeFile(`${root}/revisions/rev-1760000000000-2.json`, legacyManifest('rev-1760000000000-2'))

      const h = createHistoryProvider({ storage })
      // The next allocation continues the legacy sequence at the same ms.
      const r = await h.recordRevision({ operation: 'save', items: new Map([['pages/home', 'new']]) })
      expect(r.id).toMatch(/^rev-1760000000000-3-[0-9a-f]{8}$/)

      // Newest first; legacy ids sort by (ms, numeric seq) before the new one.
      expect((await h.listRevisions()).map(x => x.id)).toEqual([r.id, 'rev-1760000000000-2', 'rev-1760000000000'])

      // Legacy ids still pass the public boundary validation.
      const legacy = await h.readRevision('rev-1760000000000-2')
      expect(legacy.id).toBe('rev-1760000000000-2')
    } finally {
      vi.useRealTimers()
    }
  })
})

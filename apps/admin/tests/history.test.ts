/**
 * Integration tests for history-on-save and history-on-publish in the
 * admin-api. Uses a temp copy of the starter site so mutations don't
 * leak between runs — the existing api.test.ts mutates in place, which
 * is fine for single-item asserts but would clobber history state.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import type { Hono } from 'hono'
import {
  createFilesystemProvider,
  createSourceContext,
  createHistoryProvider,
  loadSiteConfig,
  siteConfigToManifest,
  type SourceContext,
  type SiteManifest,
} from 'gazetta'
import { createAdminApp } from '../src/server/index.js'

const starterSiteDir = resolve(import.meta.dirname, '../../../examples/starter/sites/main')
const templatesDir = resolve(import.meta.dirname, '../../../examples/starter/templates')

let _manifest: SiteManifest | null = null
async function getManifest(): Promise<SiteManifest> {
  if (_manifest) return _manifest
  const loaded = await loadSiteConfig(starterSiteDir)
  if (!loaded) throw new Error(`No site.config.ts at ${starterSiteDir}`)
  _manifest = siteConfigToManifest(loaded.config)
  return _manifest
}

/**
 * Spin up an isolated working dir for a history test. Seeds the minimal
 * manifest tree (the four items the assertions reference) directly,
 * rather than `cp -r` from the live starter target — that shared dir
 * is mutated in place by api.test.ts and audit-event writes via
 * write-file-atomic, which races with the cp walker (#351). Templates
 * are loaded from examples/starter/templates as usual.
 */
const SEED_MANIFESTS: Record<string, unknown> = {
  'pages/home/page.json': { template: 'page-default', content: { title: 'Home' } },
  'pages/about/page.json': { template: 'page-default', content: { title: 'About' } },
  'fragments/header/fragment.json': { template: 'header-layout' },
  'fragments/footer/fragment.json': { template: 'footer-layout' },
}

async function setupWorkingCopy(name: string) {
  const tempDir = resolve(import.meta.dirname, '../../../.tmp', name)
  await rm(tempDir, { recursive: true, force: true })
  for (const [path, contents] of Object.entries(SEED_MANIFESTS)) {
    const fullPath = resolve(tempDir, path)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, JSON.stringify(contents, null, 2))
  }
  return tempDir
}

describe('setupWorkingCopy isolation (issue #351)', () => {
  // The shared `examples/starter/sites/main/targets/local/` directory is
  // mutated in place by api.test.ts (writes pages, fragments, and audit
  // events via write-file-atomic). When history.test.ts's setupWorkingCopy
  // does `cp -r` against that same dir, audit-write temp files
  // (`events-{id}.jsonl.{rand}`) can be lstat'd by the walker and then
  // disappear (atomic rename) before the copy reaches them — ENOENT.
  //
  // The fix is to stop copying from the shared starter dir entirely:
  // seed the minimal manifest tree (the four files the history tests
  // exercise) directly into the tempdir. This test pins that contract:
  // the temp working copy must contain ONLY the seeded manifests, no
  // ambient files inherited from the live starter target.
  it('produces only the minimal seeded manifest tree, not the full starter target', async () => {
    const dir = await setupWorkingCopy('setup-isolation-test')
    try {
      const entries = await readdir(dir, { recursive: true, withFileTypes: true })
      const files = entries
        .filter(e => e.isFile())
        .map(e => relative(dir, resolve(e.parentPath, e.name)))
        .sort()
      expect(files).toEqual([
        'fragments/footer/fragment.json',
        'fragments/header/fragment.json',
        'pages/about/page.json',
        'pages/home/page.json',
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('History on save', () => {
  let contentDir: string
  let app: Hono
  let source: SourceContext

  beforeAll(async () => {
    contentDir = await setupWorkingCopy('history-save-test')
    const storage = createFilesystemProvider(contentDir)
    const history = createHistoryProvider({ storage })
    const manifest = await getManifest()
    source = createSourceContext({ storage, siteDir: '', projectSiteDir: starterSiteDir, history, manifest })
    app = createAdminApp({
      source,
      siteDir: starterSiteDir,
      templatesDir,
      targets: new Map([['local', storage]]),
      targetConfigs: { local: { storage: { type: 'filesystem' }, environment: 'local', editable: true } },
      disableCacheStatsLogger: true,
    })
  })

  afterAll(async () => {
    await rm(contentDir, { recursive: true, force: true })
  })

  it('records a revision on PUT /api/pages/:name', async () => {
    // First save — triggers the initial full-tree scan.
    const res = await app.request('/api/pages/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title: 'Edited' } }),
    })
    expect(res.status).toBe(200)

    // First recordWrite emits a baseline revision (the scan) plus the
    // delta revision — so "undo my first save" has a prior state to
    // roll back to. IDs are timestamp-based (rev-<unixMillis>-<seq>-<suffix>) so we
    // read them from the index rather than hard-coding.
    const indexPath = resolve(contentDir, '.gazetta/history/index.json')
    const index = JSON.parse(await readFile(indexPath, 'utf-8'))
    expect(index.revisions).toHaveLength(2)
    const [baselineId, firstSaveId] = index.revisions

    const baseline = JSON.parse(
      await readFile(resolve(contentDir, '.gazetta/history/revisions', `${baselineId}.json`), 'utf-8'),
    )
    expect(baseline.message).toBe('Initial baseline')

    const manifest = JSON.parse(
      await readFile(resolve(contentDir, '.gazetta/history/revisions', `${firstSaveId}.json`), 'utf-8'),
    )
    expect(manifest.operation).toBe('save')
    // Full-tree snapshot: every page + fragment manifest is captured,
    // not just the one that was saved.
    expect(Object.keys(manifest.snapshot).sort()).toEqual(
      expect.arrayContaining([
        'pages/home/page.json',
        'pages/about/page.json',
        'fragments/header/fragment.json',
        'fragments/footer/fragment.json',
      ]),
    )
  })

  it('second save writes delta onto the previous snapshot', async () => {
    const res = await app.request('/api/pages/about', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title: 'About edited' } }),
    })
    expect(res.status).toBe(200)

    const index = JSON.parse(await readFile(resolve(contentDir, '.gazetta/history/index.json'), 'utf-8'))
    // baseline + first save + second save = 3 revisions.
    expect(index.revisions).toHaveLength(3)
    const [, firstSaveId, secondSaveId] = index.revisions
    const firstSave = JSON.parse(
      await readFile(resolve(contentDir, '.gazetta/history/revisions', `${firstSaveId}.json`), 'utf-8'),
    )
    const secondSave = JSON.parse(
      await readFile(resolve(contentDir, '.gazetta/history/revisions', `${secondSaveId}.json`), 'utf-8'),
    )
    // Unchanged items share blobs (same hash) across revisions.
    expect(secondSave.snapshot['pages/home/page.json']).toBe(firstSave.snapshot['pages/home/page.json'])
    // pages/about changed — different blob.
    expect(secondSave.snapshot['pages/about/page.json']).not.toBe(firstSave.snapshot['pages/about/page.json'])
  })

  it('records a revision on DELETE /api/pages/:name (archive) with the manifest carrying archived: true', async () => {
    // Per Cut 7 cutover: DELETE = soft-delete (archive). The manifest
    // stays in the snapshot but flips to `archived: true`. Hard delete
    // (purge) is opt-in via `?permanent=true` and DOES remove from the
    // snapshot — covered by the next test.
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '.history-delete-test', template: 'page-default' }),
    })
    const del = await app.request('/api/pages/.history-delete-test', { method: 'DELETE' })
    expect(del.status).toBe(200)

    const entries = await readdir(resolve(contentDir, '.gazetta/history/revisions'))
    const latest = entries.sort().at(-1)!
    const manifest = JSON.parse(await readFile(resolve(contentDir, '.gazetta/history/revisions', latest), 'utf-8'))
    // Page still in the snapshot.
    expect(manifest.snapshot).toHaveProperty('pages/.history-delete-test/page.json')
    // The blob the snapshot points at carries `archived: true`.
    const blobHash = manifest.snapshot['pages/.history-delete-test/page.json']
    const blobPath = resolve(contentDir, '.gazetta/history/objects', blobHash.slice(0, 2), blobHash.slice(2))
    const blob = JSON.parse(await readFile(blobPath, 'utf-8'))
    expect(blob.archived).toBe(true)
  })

  it('records a revision on DELETE /api/pages/:name?permanent=true (purge) with the item removed from the snapshot', async () => {
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'history-purge-test', template: 'page-default' }),
    })
    const del = await app.request('/api/pages/history-purge-test?permanent=true', { method: 'DELETE' })
    expect(del.status).toBe(200)

    const entries = await readdir(resolve(contentDir, '.gazetta/history/revisions'))
    const latest = entries.sort().at(-1)!
    const manifest = JSON.parse(await readFile(resolve(contentDir, '.gazetta/history/revisions', latest), 'utf-8'))
    expect(manifest.snapshot).not.toHaveProperty('pages/history-purge-test/page.json')
  })
})

describe('History disabled on save', () => {
  let contentDir: string
  let app: Hono

  beforeAll(async () => {
    contentDir = await setupWorkingCopy('history-disabled-test')
    const storage = createFilesystemProvider(contentDir)
    // No history provider → source.history is undefined → no revisions.
    const manifest = await getManifest()
    const source = createSourceContext({ storage, siteDir: '', projectSiteDir: starterSiteDir, manifest })
    app = createAdminApp({ source, siteDir: starterSiteDir, templatesDir, disableCacheStatsLogger: true })
  })

  afterAll(async () => {
    await rm(contentDir, { recursive: true, force: true })
  })

  it('does not create .gazetta/history/ when the source has no history provider', async () => {
    const res = await app.request('/api/pages/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title: 'Quiet save' } }),
    })
    expect(res.status).toBe(200)

    // Happy path — the history directory should not exist.
    await expect(readFile(resolve(contentDir, '.gazetta/history/index.json'), 'utf-8')).rejects.toThrow()
  })
})

describe('Retention', () => {
  let contentDir: string
  let app: Hono

  beforeAll(async () => {
    contentDir = await setupWorkingCopy('history-retention-test')
    const storage = createFilesystemProvider(contentDir)
    const history = createHistoryProvider({ storage, retention: 2 })
    const manifest = await getManifest()
    const source = createSourceContext({ storage, siteDir: '', projectSiteDir: starterSiteDir, history, manifest })
    app = createAdminApp({ source, siteDir: starterSiteDir, templatesDir, disableCacheStatsLogger: true })
  })

  afterAll(async () => {
    await rm(contentDir, { recursive: true, force: true })
  })

  it('evicts oldest revisions once retention is hit', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.request('/api/pages/home', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { title: `rev ${i}` } }),
      })
      expect(res.status).toBe(200)
    }
    const index = JSON.parse(await readFile(resolve(contentDir, '.gazetta/history/index.json'), 'utf-8'))
    // 5 PUTs = 1 baseline + 5 save revisions = 6 entries; retention (2)
    // keeps the 2 most recent.
    expect(index.revisions).toHaveLength(2)
    // Retention preserves chrono order — lex sort matches index order
    // (since ids are unix-millis-based and filling in a loop is strictly
    // increasing per-call).
    expect(index.revisions).toEqual([...index.revisions].sort())
  })
})

describe('History HTTP endpoints', () => {
  let contentDir: string
  let app: Hono

  beforeAll(async () => {
    contentDir = await setupWorkingCopy('history-http-test')
    const storage = createFilesystemProvider(contentDir)
    const history = createHistoryProvider({ storage })
    const manifest = await getManifest()
    const source = createSourceContext({ storage, siteDir: '', projectSiteDir: starterSiteDir, history, manifest })
    app = createAdminApp({
      source,
      siteDir: starterSiteDir,
      templatesDir,
      targets: new Map([['local', storage]]),
      targetConfigs: { local: { storage: { type: 'filesystem' }, environment: 'local', editable: true } },
      disableCacheStatsLogger: true,
    })
  })

  afterAll(async () => {
    await rm(contentDir, { recursive: true, force: true })
  })

  async function save(title: string) {
    const res = await app.request('/api/pages/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title } }),
    })
    expect(res.status).toBe(200)
  }

  it('GET /api/history lists revisions newest first', async () => {
    await save('one')
    await save('two')
    await save('three')
    const res = await app.request('/api/history?target=local')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { revisions: { id: string; operation: string; message?: string }[] }
    // Baseline + 3 saves = 4 revisions, newest first.
    expect(body.revisions).toHaveLength(4)
    // Ids follow rev-<unixMillis>-<seq>-<suffix>; legacy rev-<unixMillis>[-seq] also matches.
    for (const r of body.revisions) expect(r.id).toMatch(/^rev-\d{10,}(?:-\d+)?(?:-[0-9a-f]{8})?$/)
    // Newest-first ordering: id list in reverse-chrono (lex-desc).
    expect(body.revisions.map(r => r.id)).toEqual([...body.revisions.map(r => r.id)].sort().reverse())
    // Oldest entry is the baseline with its sentinel message.
    expect(body.revisions.at(-1)?.message).toBe('Initial baseline')
  })

  it('GET /api/history 400 without ?target=', async () => {
    const res = await app.request('/api/history')
    expect(res.status).toBe(400)
  })

  it('POST /api/history/undo restores previous revision with operation=rollback', async () => {
    // Read current content — should be "three" from the prior test.
    const before = await app.request('/api/pages/home')
    const beforeBody = (await before.json()) as { content: { title: string } }
    expect(beforeBody.content.title).toBe('three')

    // Capture the expected restoredFrom: it's head-1 in newest-first order.
    const listRes = await app.request('/api/history?target=local')
    const listBody = (await listRes.json()) as { revisions: { id: string }[] }
    const expectedRestoredFrom = listBody.revisions[1].id

    const res = await app.request('/api/history/undo?target=local', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { revision: { operation: string }; restoredFrom: string }
    expect(body.revision.operation).toBe('rollback')
    expect(body.restoredFrom).toBe(expectedRestoredFrom)

    // Content now reflects the previous save's state ("two").
    const after = await app.request('/api/pages/home')
    const afterBody = (await after.json()) as { content: { title: string } }
    expect(afterBody.content.title).toBe('two')
  })

  it('POST /api/history/restore restores an arbitrary revision', async () => {
    // Current state is now "two" from the undo above; find the id of the
    // earliest save (title="one") — it's the second-oldest revision
    // (baseline is oldest). Use newest-first list: the oldest non-
    // baseline save is at list.length-2.
    const listRes = await app.request('/api/history?target=local')
    const listBody = (await listRes.json()) as { revisions: { id: string; message?: string }[] }
    const firstSaveId = listBody.revisions[listBody.revisions.length - 2].id

    const res = await app.request(`/api/history/restore?target=local&id=${firstSaveId}`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { revision: { operation: string }; restoredFrom: string }
    expect(body.revision.operation).toBe('rollback')
    expect(body.restoredFrom).toBe(firstSaveId)

    const after = await app.request('/api/pages/home')
    const afterBody = (await after.json()) as { content: { title: string } }
    expect(afterBody.content.title).toBe('one')
  })

  it('POST /api/history/undo 409 when there is nothing to undo', async () => {
    // Fresh working copy, no prior revision.
    const fresh = await setupWorkingCopy('history-http-no-undo-test')
    try {
      const storage = createFilesystemProvider(fresh)
      const history = createHistoryProvider({ storage })
      const source = createSourceContext({ storage, siteDir: '', projectSiteDir: starterSiteDir, history })
      const freshApp = createAdminApp({
        source,
        siteDir: starterSiteDir,
        templatesDir,
        targets: new Map([['local', storage]]),
        targetConfigs: { local: { storage: { type: 'filesystem' }, environment: 'local', editable: true } },
        disableCacheStatsLogger: true,
      })
      const res = await freshApp.request('/api/history/undo?target=local', { method: 'POST' })
      expect(res.status).toBe(409)
    } finally {
      await rm(fresh, { recursive: true, force: true })
    }
  })

  it('POST /api/history/restore 404 for unknown revision id', async () => {
    const res = await app.request('/api/history/restore?target=local&id=rev-9999', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

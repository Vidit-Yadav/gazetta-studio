import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { rm, cp } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { loadSiteConfig, siteConfigToManifest } from '../src/config/loader.js'
import { tempDir } from './_helpers/temp.js'

// Copy the starter into .tmp/ so admin API tests can mutate pages/fragments
// without dirtying the real repo. See #123.
const realStarter = resolve(import.meta.dirname, '../../../examples/starter')
const projectRoot = tempDir('admin-api-test-' + Date.now())
const projectSiteDir = resolve(projectRoot, 'sites/main')
// Content lives inside the local target (post-transformation layout).
const localTargetDir = resolve(projectSiteDir, 'targets/local')
const storage = createFilesystemProvider(localTargetDir)
let app: Hono

beforeAll(async () => {
  await rm(projectRoot, { recursive: true, force: true })
  await cp(realStarter, projectRoot, {
    recursive: true,
    filter: src => !src.includes('/dist') && !src.includes('/node_modules') && !src.includes('/.tmp'),
  })
  // Read the project-level manifest from the TS config — routes use it
  // instead of reading from the target's storage (targets have no config).
  const loaded = await loadSiteConfig(projectSiteDir)
  if (!loaded) throw new Error(`No site.config.ts at ${projectSiteDir}`)
  const manifest = siteConfigToManifest(loaded.config)
  // Target-rooted source: storage points at targets/local, siteDir is '',
  // projectSiteDir is the actual project site directory.
  const source = createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir,
    manifest,
  })
  app = createAdminApp({
    source,
    siteDir: projectSiteDir, // used for templatesDir/adminDir defaults
    templatesDir: resolve(projectRoot, 'templates'),
    adminDir: resolve(projectRoot, 'admin'),
    disableCacheStatsLogger: true,
  })
})

afterAll(async () => {
  await rm(projectRoot, { recursive: true, force: true })
})

async function get(path: string) {
  const res = await app.request(path)
  return { status: res.status, body: await res.json() }
}

async function getText(path: string) {
  const res = await app.request(path)
  return { status: res.status, body: await res.text() }
}

describe('GET /api/site', () => {
  it('returns site manifest', async () => {
    const { status, body } = await get('/api/site')
    expect(status).toBe(200)
    expect(body.name).toBe('Gazetta Starter')
  })
})

describe('GET /api/health', () => {
  it('returns ok + ISO timestamp without auth', async () => {
    const { status, body } = await get('/api/health')
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    // ISO 8601 with Z; smoke check that timestamp parses back as the
    // same instant. Pins the documented response shape from
    // design-offline.md Q2.
    expect(typeof body.timestamp).toBe('string')
    const parsed = new Date(body.timestamp)
    expect(Number.isFinite(parsed.getTime())).toBe(true)
  })

  it('produces a fresh timestamp on each call', async () => {
    // Browser-side connection-detection cadence relies on each call
    // getting a fresh response so a CDN-cached old response can't
    // masquerade as a live heartbeat.
    const a = (await get('/api/health')).body.timestamp as string
    await new Promise(r => setTimeout(r, 5))
    const b = (await get('/api/health')).body.timestamp as string
    expect(b).not.toBe(a)
  })
})

describe('GET /api/system/cache/stats', () => {
  it('returns the source cache snapshot', async () => {
    // Hit /api/pages first so the cache has something to report —
    // the stats() shape is provider-defined but the floor (hits,
    // misses, size) is required by the AdminCache contract.
    await get('/api/pages')
    const { status, body } = await get('/api/system/cache/stats')
    expect(status).toBe(200)
    expect(body).toMatchObject({
      hits: expect.any(Number),
      misses: expect.any(Number),
      size: expect.any(Number),
    })
    // /api/pages writes to the cache on miss → at least one entry.
    expect(body.size).toBeGreaterThanOrEqual(1)
  })

  it('includes the instance field for multi-instance correlation (Gap 1)', async () => {
    const { body } = await get('/api/system/cache/stats')
    // Instance is resolved from K_REVISION → os.hostname() → random hex.
    // We don't pin a specific value — only that the field is present
    // and non-empty. Operators in multi-instance deployments use this
    // to know which pod / revision answered.
    expect(typeof body.instance).toBe('string')
    expect(body.instance.length).toBeGreaterThan(0)
  })
})

describe('GET /api/system/cache/invalidations (SSE)', () => {
  it('opens an SSE stream and emits an invalidation event on save', async () => {
    // Use AbortController so we can cleanly close the long-lived
    // stream after asserting. Without it the test runtime would
    // hang waiting on a never-closing connection.
    const ctrl = new AbortController()
    const res = await app.request('/api/system/cache/invalidations', { signal: ctrl.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    expect(res.body).toBeTruthy()

    // Read the stream incrementally. After the initial 'ready' event,
    // trigger a save via /api/pages and assert that an invalidation
    // event arrives in a bounded window.
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const collected: string[] = []
    let saveTriggered = false

    const readPromise = (async () => {
      while (true) {
        const { value, done } = await reader.read()
        if (done) return
        collected.push(decoder.decode(value, { stream: true }))
        // After the first chunk lands ('ready' event) trigger a save.
        if (!saveTriggered) {
          saveTriggered = true
          // Don't await — the save's response cycle is independent
          // of this stream; we just want the invalidation it triggers.
          void app.request('/api/pages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'sse-cache-test', template: 'page-default' }),
          })
        }
        // Stop reading once an invalidation event arrives.
        if (collected.join('').includes('event: invalidation')) return
      }
    })()

    // Bound the wait so a regression doesn't hang the suite.
    const timeoutPromise = new Promise<void>(resolve => setTimeout(resolve, 5000))
    await Promise.race([readPromise, timeoutPromise])
    ctrl.abort()
    try {
      reader.cancel()
    } catch {
      // already aborted
    }

    const text = collected.join('')
    expect(text).toContain('event: ready')
    expect(text).toContain('event: invalidation')
    expect(text).toMatch(/data: \{[^}]*"prefix":"pages:"/)

    // Cleanup the page we created.
    await rm(resolve(localTargetDir, 'pages/sse-cache-test'), { recursive: true, force: true })
  }, 15_000)
})

describe('GET /api/pages', () => {
  it('returns all pages', async () => {
    const { status, body } = await get('/api/pages')
    expect(status).toBe(200)
    expect(body.length).toBeGreaterThanOrEqual(4)
    const names = body.map((p: { name: string }) => p.name)
    expect(names).toContain('home')
    expect(names).toContain('404')
    expect(names).toContain('about')
    expect(names).toContain('blog/[slug]')
  })

  it('pages have route and template', async () => {
    const { body } = await get('/api/pages')
    const home = body.find((p: { name: string }) => p.name === 'home')
    expect(home.route).toBe('/')
    expect(home.template).toBe('page-default')
  })
})

describe('GET /api/pages/:name', () => {
  it('returns page detail', async () => {
    const { status, body } = await get('/api/pages/home')
    expect(status).toBe(200)
    expect(body.route).toBe('/')
    expect(body.components).toContain('@header')
    expect(body.components).toContain('@footer')
    const hero = body.components.find((c: any) => typeof c === 'object' && c.name === 'hero')
    expect(hero).toBeDefined()
    expect(hero.template).toBe('hero')
  })

  it('returns nested page', async () => {
    const { status, body } = await get('/api/pages/blog/[slug]')
    expect(status).toBe(200)
    expect(body.route).toBe('/blog/:slug')
  })

  it('returns 404 for missing page', async () => {
    const { status } = await get('/api/pages/nonexistent')
    expect(status).toBe(404)
  })
})

describe('GET /api/fragments', () => {
  it('returns all fragments', async () => {
    const { status, body } = await get('/api/fragments')
    expect(status).toBe(200)
    expect(body).toHaveLength(2)
    const names = body.map((f: { name: string }) => f.name)
    expect(names).toContain('header')
    expect(names).toContain('footer')
  })

  // The three tests below pin the summary-projection contract that the
  // mutation-watcher (issue #623) surfaced as uncovered: `locales`
  // array construction, archive-state spread, and aliasOf spread. Each
  // pins one branch of the summary map in fragments.ts's `GET
  // /api/fragments` handler. A subsequent regression that flattens any
  // of these branches (e.g. `locales: []`, `archived` never surfaced,
  // `aliasOf` never surfaced) trips a specific assertion here.

  it('surfaces `locales` for fragments with locale variants', async () => {
    // The starter's `header` fragment ships fr / ar / ja variants; if
    // the summary map replaces `[...localeEntry.locales.keys()]` with
    // `[]` the array becomes empty and this assertion fails.
    const { body } = await get('/api/fragments')
    const header = body.find((f: { name: string }) => f.name === 'header')
    expect(header).toBeDefined()
    expect(Array.isArray(header.locales)).toBe(true)
    expect(header.locales).toEqual(expect.arrayContaining(['fr', 'ar', 'ja']))
    expect(header.locales).toHaveLength(3)

    // Now the absence branch: a freshly-created fragment has no locale
    // variants → `localeEntry` is undefined → `locales` field must be
    // absent from the summary. If the summary map drops the
    // `localeEntry ?` guard, `locales` would appear on every entry
    // and this absence check fails.
    await app.request('/api/fragments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'issue-623-nolocale', template: 'footer-layout' }),
    })
    const { body: post } = await get('/api/fragments')
    const noLocale = post.find((f: { name: string }) => f.name === 'issue-623-nolocale')
    expect(noLocale).toBeDefined()
    expect(noLocale.locales).toBeUndefined()

    // Cleanup.
    await rm(resolve(localTargetDir, 'fragments/issue-623-nolocale'), { recursive: true, force: true })
  })

  it('surfaces `archived` and `aliasOf` on archived fragments', async () => {
    // Fresh fragment (via POST); archive it with an alias; then the
    // list must show both `archived: true` AND `aliasOf: 'header'`.
    // The summary uses two spread branches; a mutation that flips
    // either `archived === true` predicate OR either spread body
    // (e.g. `{ archived: true }` → `{}`) fails this assertion.
    await app.request('/api/fragments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'issue-623-archived', template: 'footer-layout' }),
    })
    const archiveRes = await app.request('/api/fragments/issue-623-archived/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'header' }),
    })
    expect(archiveRes.status).toBe(200)

    const { body } = await get('/api/fragments')
    const archived = body.find((f: { name: string }) => f.name === 'issue-623-archived')
    expect(archived).toBeDefined()
    expect(archived.archived).toBe(true)
    expect(archived.aliasOf).toBe('header')

    // Cleanup — purge the archive so subsequent tests see a clean tree.
    await app.request('/api/fragments/issue-623-archived/purge?force=true', { method: 'DELETE' })
  })

  it('reflects a newly-created fragment on the next GET (paired-invalidation round-trip)', async () => {
    // Warm the cache first — the list at this point does NOT contain
    // `issue-623-cache`. The `if (cached) return c.json(cached)`
    // branch on a subsequent GET must NOT serve this stale entry once
    // the POST below invalidates the `fragments:` prefix. If the
    // invalidation path is removed OR the cache-hit guard is flipped
    // in a way that stops honoring fresh writes, the second GET below
    // misses `issue-623-cache` in the list.
    const preWarm = await get('/api/fragments')
    expect(preWarm.body.find((f: { name: string }) => f.name === 'issue-623-cache')).toBeUndefined()

    await app.request('/api/fragments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'issue-623-cache', template: 'footer-layout' }),
    })

    const postCreate = await get('/api/fragments')
    const created = postCreate.body.find((f: { name: string }) => f.name === 'issue-623-cache')
    expect(created).toBeDefined()
    expect(created.template).toBe('footer-layout')
    // No locale variants on a fresh fragment; no archive fields.
    expect(created.locales).toBeUndefined()
    expect(created.archived).toBeUndefined()
    expect(created.aliasOf).toBeUndefined()

    // Cleanup.
    await rm(resolve(localTargetDir, 'fragments/issue-623-cache'), { recursive: true, force: true })
  })
})

describe('GET /api/fragments/:name', () => {
  it('returns fragment detail', async () => {
    const { status, body } = await get('/api/fragments/header')
    expect(status).toBe(200)
    expect(body.template).toBe('header-layout')
    const logo = body.components.find((c: any) => typeof c === 'object' && c.name === 'logo')
    const nav = body.components.find((c: any) => typeof c === 'object' && c.name === 'nav')
    expect(logo).toBeDefined()
    expect(nav).toBeDefined()
  })

  it('returns 404 for missing fragment', async () => {
    const { status } = await get('/api/fragments/nonexistent')
    expect(status).toBe(404)
  })
})

describe('GET /api/templates', () => {
  it('returns all templates', async () => {
    const { status, body } = await get('/api/templates')
    expect(status).toBe(200)
    const names = body.map((t: { name: string }) => t.name)
    expect(names).toContain('hero')
    expect(names).toContain('page-default')
    expect(names).toContain('feature-card')
  })
})

describe('GET /api/templates/:name/schema', () => {
  it('returns JSON Schema for a template', async () => {
    const { status, body } = await get('/api/templates/hero/schema')
    expect(status).toBe(200)
    expect(body.type).toBe('object')
    expect(body.properties.title).toBeDefined()
    expect(body.properties.subtitle).toBeDefined()
  })

  it('returns 500 for missing template', async () => {
    const { status } = await get('/api/templates/nonexistent/schema')
    expect(status).toBe(500)
  })
})

describe('GET /api/templates/:name/impact (Validation Cut 6)', () => {
  it('lists pages + fragments using the template, with empty issues when no scanner', async () => {
    // The starter's `home` page top-level-uses `page-default` and
    // contains nested inline components (hero, features-grid, etc.).
    // Without a scanner injected (this admin app's setup), every item
    // reports empty issues — accurate, since validation didn't run.
    const { status, body } = await get('/api/templates/page-default/impact')
    expect(status).toBe(200)
    expect(body.template).toBe('page-default')
    expect(Array.isArray(body.items)).toBe(true)
    // home, about, blog/[slug] all use page-default in starter
    const names = body.items.map((i: { name: string }) => i.name)
    expect(names).toContain('home')
    // Every item has issues: [] without a scanner
    for (const item of body.items) expect(item.issues).toEqual([])
    expect(body.affectedItemCount).toBe(0)
  })

  it('finds nested inline components recursively (hero is inline-only on home)', async () => {
    // `hero` doesn't appear at any page's top level — it's an inline
    // component inside home/page.json. The recursive walk must catch it.
    const { status, body } = await get('/api/templates/hero/impact')
    expect(status).toBe(200)
    const names = body.items.map((i: { name: string }) => i.name)
    expect(names).toContain('home')
  })

  it('returns an empty list for a template that no item references', async () => {
    const { status, body } = await get('/api/templates/no-such-template/impact')
    expect(status).toBe(200)
    expect(body.items).toEqual([])
    expect(body.affectedItemCount).toBe(0)
  })
})

describe('component data via page API', () => {
  it('page detail includes inline component content', async () => {
    const { status, body } = await get('/api/pages/home')
    expect(status).toBe(200)
    const hero = body.components.find((c: any) => typeof c === 'object' && c.name === 'hero')
    expect(hero.content.title).toBe('Welcome to Gazetta')
  })
})

describe('GET /preview/*', () => {
  it('renders home page', async () => {
    const { status, body } = await getText('/preview/')
    expect(status).toBe(200)
    expect(body).toContain('Welcome to Gazetta')
    expect(body).toContain('<!DOCTYPE html>')
  })

  it('renders about page', async () => {
    const { status, body } = await getText('/preview/about')
    expect(status).toBe(200)
    expect(body).toContain('About Gazetta')
  })

  it('renders dynamic route', async () => {
    const { status, body } = await getText('/preview/blog/hello-world')
    expect(status).toBe(200)
    expect(body).toContain('Hello from Gazetta')
  })

  it('returns 404 for missing route', async () => {
    const { status } = await getText('/preview/nonexistent')
    expect(status).toBe(404)
  })
})

describe('GET /preview/* for archived pages (#971)', () => {
  it('shows a redirect placeholder for a Manual Redirect instead of a template error', async () => {
    const created = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-about-971', to: 'about' }),
    })
    expect(created.status).toBe(201)
    const { status, body } = await getText('/preview/old-about-971')
    expect(status).toBe(200)
    expect(body).not.toContain('Template Error')
    expect(body).toContain('301')
    expect(body).toContain('href="/about"')
  })

  it('shows a gone placeholder for an archived page without an alias', async () => {
    const created = await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'gone-971', template: 'page-default' }),
    })
    expect(created.status).toBeLessThan(300)
    const archived = await app.request('/api/pages/gone-971/archive', { method: 'POST' })
    expect(archived.status).toBeLessThan(300)
    const { status, body } = await getText('/preview/gone-971')
    expect(status).toBe(200)
    expect(body).not.toContain('Template Error')
    expect(body).toContain('410')
  })
})

describe('GET /preview/@fragment for archived fragments (#1001)', () => {
  it('shows an alias placeholder for an archived fragment instead of a template error', async () => {
    const created = await app.request('/api/fragments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'archived-frag-alias-1001', template: 'footer-layout' }),
    })
    expect(created.status).toBe(200)
    const archived = await app.request('/api/fragments/archived-frag-alias-1001/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'header' }),
    })
    expect(archived.status).toBe(200)
    expect(((await archived.json()) as { aliasOf?: string }).aliasOf).toBe('header')

    const { status, body } = await getText('/preview/@archived-frag-alias-1001')
    expect(status).toBe(200)
    expect(body).not.toContain('Template Error')
    // Fragments are aliased by name, not by route: the placeholder must
    // name @header and must not manufacture a page link for it.
    expect(body).toContain('@header')
    expect(body).not.toMatch(/href="[^"]*header/)
  })

  it('shows a gone placeholder for an archived fragment without an alias', async () => {
    const created = await app.request('/api/fragments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'archived-frag-gone-1001', template: 'footer-layout' }),
    })
    expect(created.status).toBe(200)
    const archived = await app.request('/api/fragments/archived-frag-gone-1001/archive', { method: 'POST' })
    expect(archived.status).toBe(200)

    const { status, body } = await getText('/preview/@archived-frag-gone-1001')
    expect(status).toBe(200)
    expect(body).not.toContain('Template Error')
    expect(body).toContain('410 Gone')
  })
})

describe('GET /preview/@fragment', () => {
  it('renders fragment standalone', async () => {
    const { status, body } = await getText('/preview/@header')
    expect(status).toBe(200)
    expect(body).toContain('<!DOCTYPE html>')
  })

  it('returns 500 for missing fragment', async () => {
    const { status } = await getText('/preview/@nonexistent')
    expect(status).toBe(500)
  })
})

describe('POST /preview/@fragment', () => {
  it('renders fragment with content overrides', async () => {
    const footerPath = resolve(localTargetDir, 'fragments/footer')
    const res = await app.request('/preview/@footer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        overrides: {
          content: { [footerPath]: { text: 'Draft Footer' } },
          structural: {},
        },
      }),
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<!DOCTYPE html>')
  })
})

describe('POST /preview/*', () => {
  it('renders with content overrides', async () => {
    const res = await app.request('/preview/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        overrides: {
          content: { hero: { title: 'Draft Title', subtitle: 'Draft Subtitle' } },
          structural: {},
        },
      }),
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Draft Title')
    expect(html).toContain('Draft Subtitle')
  })

  it('renders normally without overrides', async () => {
    const res = await app.request('/preview/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Welcome to Gazetta')
  })

  it('renders with a structural override (reordered components)', async () => {
    // Pull the original components, swap the first two non-fragment children, send as override.
    const original = await app.request('/api/pages/home').then(r => r.json())
    const components = (original as { components: unknown[] }).components.slice()
    // Find the hero (index 1, after @header) and features (index 2) and swap them.
    const heroIdx = components.findIndex(
      c => typeof c === 'object' && c !== null && (c as { name?: string }).name === 'hero',
    )
    const featuresIdx = components.findIndex(
      c => typeof c === 'object' && c !== null && (c as { name?: string }).name === 'features',
    )
    expect(heroIdx).toBeGreaterThan(-1)
    expect(featuresIdx).toBeGreaterThan(-1)
    ;[components[heroIdx], components[featuresIdx]] = [components[featuresIdx], components[heroIdx]]

    const res = await app.request('/preview/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        overrides: {
          content: {},
          structural: { 'page:home': components },
        },
      }),
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    // Both components still rendered
    expect(html).toContain('Welcome to Gazetta')
    expect(html).toContain('Why Gazetta?')
    // 'Why Gazetta?' (features heading) now appears before 'Welcome to Gazetta' (hero title).
    expect(html.indexOf('Why Gazetta?')).toBeLessThan(html.indexOf('Welcome to Gazetta'))
  })

  it('does not mutate the underlying Site (concurrent override + plain renders)', async () => {
    // Sequentially: render with structural override, then render without — second
    // render should reflect ORIGINAL order, proving the override did not mutate
    // the in-memory Site.
    const original = await app.request('/api/pages/home').then(r => r.json())
    const components = (original as { components: unknown[] }).components.slice().reverse()

    await app.request('/preview/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        overrides: { content: {}, structural: { 'page:home': components } },
      }),
    })

    const res = await app.request('/preview/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: { content: {}, structural: {} } }),
    })
    const html = await res.text()
    // Original order: hero before features.
    expect(html.indexOf('Welcome to Gazetta')).toBeLessThan(html.indexOf('Why Gazetta?'))
  })
})

describe('POST /api/pages (create)', () => {
  afterAll(async () => {
    await rm(resolve(localTargetDir, 'pages/test-page'), { recursive: true, force: true })
    await rm(resolve(localTargetDir, 'pages/docs'), { recursive: true, force: true })
  })

  it('creates a new page', { timeout: 15_000 }, async () => {
    const res = await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-page', template: 'page-default' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)

    const { body: pages } = await get('/api/pages')
    expect(pages.some((p: { name: string }) => p.name === 'test-page')).toBe(true)
  })

  it('rejects duplicate page', async () => {
    const res = await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-page', template: 'page-default' }),
    })
    expect(res.status).toBe(409)
  })

  it('rejects missing fields', async () => {
    const res = await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('PUT /api/pages/:name', () => {
  afterAll(async () => {
    await rm(resolve(localTargetDir, 'pages/update-test'), { recursive: true, force: true })
  })

  it('updates page content', async () => {
    // Create
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'update-test', template: 'page-default' }),
    })

    // Update
    const res = await app.request('/api/pages/update-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title: 'Updated Title' } }),
    })
    expect(res.status).toBe(200)

    // Verify
    const { body } = await get('/api/pages/update-test')
    expect(body.content.title).toBe('Updated Title')
  })

  it('returns 404 for missing page', async () => {
    const res = await app.request('/api/pages/nonexistent', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: {} }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 409 with VALIDATION_FAILED when save introduces a missing asset ref', async () => {
    // Create a clean page first
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'val-test', template: 'page-default' }),
    })
    // Update with content that references a non-existent asset
    const res = await app.request('/api/pages/val-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { hero: { _asset: 'definitely-not-an-asset-name' } } }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; issues: Array<{ validator: string; message: string }> }
    expect(body.code).toBe('VALIDATION_FAILED')
    expect(body.issues.some(i => i.validator === 'referenced-asset-exists')).toBe(true)
    expect(body.issues.some(i => i.message.includes('definitely-not-an-asset-name'))).toBe(true)
    // Cleanup
    await rm(resolve(localTargetDir, 'pages/val-test'), { recursive: true, force: true })
  })

  it('returns 409 when a fragment ref is introduced that does not exist', async () => {
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'val-frag-test', template: 'page-default' }),
    })
    const res = await app.request('/api/pages/val-frag-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ components: ['@nonexistent-fragment'] }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; issues: Array<{ validator: string }> }
    expect(body.issues.some(i => i.validator === 'referenced-fragment-exists')).toBe(true)
    await rm(resolve(localTargetDir, 'pages/val-frag-test'), { recursive: true, force: true })
  })

  // Component IDs (per design-collaboration.md Cut 1) — saves auto-
  // generate stable IDs on InlineComponent entries lacking one;
  // existing IDs are preserved across reorders.
  // Templates must be real for the save-delta validator to pass —
  // these tests use templates that exist in examples/starter/templates/
  // (banner, counter, features-grid).
  it('auto-generates IDs on ID-less InlineComponents', async () => {
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'cid-test', template: 'page-default' }),
    })
    const putRes = await app.request('/api/pages/cid-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        components: [
          { name: 'a', template: 'banner', content: { heading: 'Hi', text: '', buttonText: '', buttonUrl: '' } },
          { name: 'b', template: 'counter' },
        ],
      }),
    })
    expect(putRes.status).toBe(200)
    const { body } = await get('/api/pages/cid-test')
    expect(body.components).toHaveLength(2)
    expect(body.components[0].id).toBeDefined()
    expect(body.components[1].id).toBeDefined()
    expect(body.components[0].id).not.toBe(body.components[1].id)
    await rm(resolve(localTargetDir, 'pages/cid-test'), { recursive: true, force: true })
  })

  it('preserves existing IDs across saves (the load-bearing reorder invariant)', async () => {
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'cid-reorder', template: 'page-default' }),
    })
    // First save adds IDs
    const first = await app.request('/api/pages/cid-reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        components: [
          { name: 'a', template: 'banner', content: { heading: 'A', text: '', buttonText: '', buttonUrl: '' } },
          { name: 'b', template: 'counter' },
        ],
      }),
    })
    expect(first.status).toBe(200)
    const firstBody = (await get('/api/pages/cid-reorder')).body
    const aId = firstBody.components[0].id
    const bId = firstBody.components[1].id
    // Author reorders and re-saves with the existing IDs intact —
    // simulating the admin's component-tree reorder flow.
    const second = await app.request('/api/pages/cid-reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        components: [
          { id: bId, name: 'b', template: 'counter' },
          {
            id: aId,
            name: 'a',
            template: 'banner',
            content: { heading: 'A', text: '', buttonText: '', buttonUrl: '' },
          },
        ],
      }),
    })
    expect(second.status).toBe(200)
    const after = (await get('/api/pages/cid-reorder')).body
    expect(after.components[0].id).toBe(bId)
    expect(after.components[1].id).toBe(aId)
    await rm(resolve(localTargetDir, 'pages/cid-reorder'), { recursive: true, force: true })
  })

  it('does not assign IDs to fragment-reference strings', async () => {
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'cid-frags', template: 'page-default' }),
    })
    const res = await app.request('/api/pages/cid-frags', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        components: ['@header', { name: 'body', template: 'counter' }, '@footer'],
      }),
    })
    expect(res.status).toBe(200)
    const { body } = await get('/api/pages/cid-frags')
    expect(body.components[0]).toBe('@header')
    expect(body.components[2]).toBe('@footer')
    expect(typeof body.components[1]).toBe('object')
    expect(body.components[1].id).toBeDefined()
    await rm(resolve(localTargetDir, 'pages/cid-frags'), { recursive: true, force: true })
  })
})

describe('save-etag concurrency (design-offline.md Q3)', () => {
  afterAll(async () => {
    await rm(resolve(localTargetDir, 'pages/etag-test'), { recursive: true, force: true })
    await rm(resolve(localTargetDir, 'fragments/etag-test'), { recursive: true, force: true })
  })

  function unquote(etag: string | null): string | null {
    return etag?.replace(/^"(.*)"$/, '$1') ?? null
  }

  it('GET /api/pages/:name returns ETag header (16 hex, RFC-7232 quoted)', async () => {
    const res = await app.request('/api/pages/home')
    expect(res.status).toBe(200)
    const etag = res.headers.get('ETag')
    expect(etag).not.toBeNull()
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/)
  })

  it('GET /api/fragments/:name returns ETag header', async () => {
    const res = await app.request('/api/fragments/header')
    expect(res.status).toBe(200)
    const etag = res.headers.get('ETag')
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/)
  })

  it('PUT without If-Match succeeds (last-write-wins for non-offline-aware clients)', async () => {
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'etag-test', template: 'page-default' }),
    })
    const res = await app.request('/api/pages/etag-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title: 'No If-Match' } }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; etag?: string }
    expect(body.ok).toBe(true)
    // Successful save echoes the new etag for client baseline update.
    expect(body.etag).toMatch(/^[0-9a-f]{16}$/)
    expect(res.headers.get('ETag')).toBe(`"${body.etag}"`)
  })

  it('PUT with matching If-Match succeeds', async () => {
    // Read current etag.
    const readRes = await app.request('/api/pages/etag-test')
    const currentEtag = unquote(readRes.headers.get('ETag'))!
    expect(currentEtag).toMatch(/^[0-9a-f]{16}$/)

    const res = await app.request('/api/pages/etag-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': `"${currentEtag}"` },
      body: JSON.stringify({ content: { title: 'Matching If-Match' } }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; etag: string }
    // New etag MUST differ from the pre-save etag (content changed).
    expect(body.etag).not.toBe(currentEtag)
  })

  it('PUT with stale If-Match returns 409 STALE with current manifest', async () => {
    // Read once to capture an etag, save twice via the no-If-Match
    // path so the etag goes stale.
    const readRes = await app.request('/api/pages/etag-test')
    const staleEtag = unquote(readRes.headers.get('ETag'))!

    // Drift the server state — simulates "another author saved while
    // I was offline."
    await app.request('/api/pages/etag-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title: 'Drift' } }),
    })

    // Now try to save with the stale etag.
    const res = await app.request('/api/pages/etag-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': `"${staleEtag}"` },
      body: JSON.stringify({ content: { title: 'My Edit' } }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      code: string
      current: { content: { title: string } }
      currentEtag: string
    }
    expect(body.code).toBe('STALE')
    // Current manifest body so the client can show the conflict diff.
    expect(body.current.content.title).toBe('Drift')
    expect(body.currentEtag).toMatch(/^[0-9a-f]{16}$/)
    expect(body.currentEtag).not.toBe(staleEtag)
    expect(res.headers.get('ETag')).toBe(`"${body.currentEtag}"`)
  })

  it('chained saves with projected etags work (offline replay sequence)', async () => {
    // Simulates the chained-projection pattern from design-offline.md
    // Q3: A1 saves with If-Match=baseline; A2 saves with If-Match=
    // projected-from-A1's-result. Both succeed end-to-end.
    const readRes = await app.request('/api/pages/etag-test')
    const baselineEtag = unquote(readRes.headers.get('ETag'))!

    // A1
    const a1 = await app.request('/api/pages/etag-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': `"${baselineEtag}"` },
      body: JSON.stringify({ content: { title: 'A1' } }),
    })
    expect(a1.status).toBe(200)
    const a1Body = (await a1.json()) as { etag: string }

    // A2 chains via A1's projected etag.
    const a2 = await app.request('/api/pages/etag-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': `"${a1Body.etag}"` },
      body: JSON.stringify({ content: { title: 'A2' } }),
    })
    expect(a2.status).toBe(200)
  })

  it('fragments PUT honors If-Match (same shape as pages)', async () => {
    await app.request('/api/fragments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'etag-test', template: 'header-layout' }),
    })
    const readRes = await app.request('/api/fragments/etag-test')
    const currentEtag = unquote(readRes.headers.get('ETag'))!
    expect(currentEtag).toMatch(/^[0-9a-f]{16}$/)

    // Stale If-Match → 409 STALE.
    const stale = await app.request('/api/fragments/etag-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"0000000000000000"' },
      body: JSON.stringify({ content: { title: 'Stale' } }),
    })
    expect(stale.status).toBe(409)
    const staleBody = (await stale.json()) as { code: string; current: unknown }
    expect(staleBody.code).toBe('STALE')
    expect(staleBody.current).toBeDefined()

    // Matching If-Match → success.
    const ok = await app.request('/api/fragments/etag-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': `"${currentEtag}"` },
      body: JSON.stringify({ content: { title: 'Fresh' } }),
    })
    expect(ok.status).toBe(200)
  })
})

describe('PUT /api/pages/:name (metadata round-trip)', () => {
  afterAll(async () => {
    await rm(resolve(localTargetDir, 'pages/meta-test'), { recursive: true, force: true })
  })

  it('saves and retrieves metadata', async () => {
    // Create page
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'meta-test', template: 'page-default' }),
    })

    // Set metadata
    const res = await app.request('/api/pages/meta-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metadata: {
          title: 'SEO Title',
          description: 'SEO desc',
          ogImage: '/img.jpg',
          canonical: 'https://example.com/meta-test',
          robots: 'noindex',
        },
      }),
    })
    expect(res.status).toBe(200)

    // Verify round-trip
    const { body } = await get('/api/pages/meta-test')
    expect(body.metadata).toEqual({
      title: 'SEO Title',
      description: 'SEO desc',
      ogImage: '/img.jpg',
      canonical: 'https://example.com/meta-test',
      robots: 'noindex',
    })
  })

  it('preserves metadata when updating only content', async () => {
    // Update content only — metadata should be preserved
    const res = await app.request('/api/pages/meta-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title: 'New Content Title' } }),
    })
    expect(res.status).toBe(200)

    const { body } = await get('/api/pages/meta-test')
    expect(body.content.title).toBe('New Content Title')
    expect(body.metadata.title).toBe('SEO Title')
    expect(body.metadata.robots).toBe('noindex')
  })

  it('clears metadata when explicitly set to empty object', async () => {
    const res = await app.request('/api/pages/meta-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: {} }),
    })
    expect(res.status).toBe(200)

    const { body } = await get('/api/pages/meta-test')
    expect(body.metadata).toEqual({})
  })
})

describe('PUT /api/pages/:name (update component content)', () => {
  it('updates page with modified component content', async () => {
    // Read current page
    const { body: page } = await get('/api/pages/home')
    const components = page.components.map((c: any) => {
      if (typeof c === 'object' && c.name === 'hero') {
        return { ...c, content: { title: 'Updated Hero', subtitle: 'New subtitle' } }
      }
      return c
    })

    // Update page
    const res = await app.request('/api/pages/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ components }),
    })
    expect(res.status).toBe(200)

    // Verify
    const { body: updated } = await get('/api/pages/home')
    const hero = updated.components.find((c: any) => typeof c === 'object' && c.name === 'hero')
    expect(hero.content.title).toBe('Updated Hero')

    // Restore original
    const restored = updated.components.map((c: any) => {
      if (typeof c === 'object' && c.name === 'hero') {
        return {
          ...c,
          content: {
            title: 'Welcome to Gazetta',
            subtitle: 'A stateless CMS that composes pages from reusable components',
          },
        }
      }
      return c
    })
    await app.request('/api/pages/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ components: restored }),
    })
  })
})

describe('DELETE /api/pages/:name', () => {
  it('archives a page (soft-delete is the default per Cut 7 cutover)', async () => {
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'to-archive', template: 'page-default' }),
    })

    const res = await app.request('/api/pages/to-archive', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; name: string; archivedAt: string }
    expect(body.ok).toBe(true)
    expect(typeof body.archivedAt).toBe('string')

    // Manifest still exists with archived: true (DELETE = archive, not hard-delete).
    const { status, body: page } = await get('/api/pages/to-archive')
    expect(status).toBe(200)
    expect((page as { archived?: boolean }).archived).toBe(true)
  })

  it('purges with ?permanent=true (explicit hard-delete intent)', async () => {
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'to-purge', template: 'page-default' }),
    })

    const res = await app.request('/api/pages/to-purge?permanent=true', { method: 'DELETE' })
    expect(res.status).toBe(200)

    const { status } = await get('/api/pages/to-purge')
    expect(status).toBe(404)
  })

  it('returns 404 for missing page', async () => {
    const res = await app.request('/api/pages/nonexistent', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/fragments (create)', () => {
  afterAll(async () => {
    await rm(resolve(localTargetDir, 'fragments/test-frag'), { recursive: true, force: true })
  })

  it('creates a new fragment', async () => {
    const res = await app.request('/api/fragments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-frag', template: 'footer-layout' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('rejects missing fields', async () => {
    const res = await app.request('/api/fragments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('PUT /api/fragments/:name component IDs', () => {
  // Component IDs apply uniformly to pages and fragments. The pages
  // suite covers full reorder semantics; here we just verify the
  // save handler wires the generator on this route too.
  afterAll(async () => {
    await rm(resolve(localTargetDir, 'fragments/cid-frag-test'), { recursive: true, force: true })
  })

  it('auto-generates IDs on InlineComponents within fragments', async () => {
    await app.request('/api/fragments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'cid-frag-test', template: 'footer-layout' }),
    })
    const res = await app.request('/api/fragments/cid-frag-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        components: [
          { name: 'a', template: 'counter' },
          { id: 'preserved', name: 'b', template: 'counter' },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const { body } = await get('/api/fragments/cid-frag-test')
    expect(body.components[0].id).toBeDefined()
    expect(body.components[1].id).toBe('preserved')
  })
})

describe('DELETE /api/fragments/:name', () => {
  it('archives a fragment (soft-delete is the default per Cut 7 cutover)', async () => {
    await app.request('/api/fragments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'to-archive-frag', template: 'footer-layout' }),
    })

    const res = await app.request('/api/fragments/to-archive-frag', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; archivedAt: string }
    expect(body.ok).toBe(true)
    expect(typeof body.archivedAt).toBe('string')
  })

  it('purges with ?permanent=true', async () => {
    await app.request('/api/fragments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'to-purge-frag', template: 'footer-layout' }),
    })
    const res = await app.request('/api/fragments/to-purge-frag?permanent=true', { method: 'DELETE' })
    expect(res.status).toBe(200)
  })

  it('returns 404 for missing fragment', async () => {
    const res = await app.request('/api/fragments/nonexistent', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

// Component create/delete is now done via PUT /api/pages/:name (update components array)

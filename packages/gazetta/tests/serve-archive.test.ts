import { describe, it, expect } from 'vitest'
import { createServer } from '../src/serve.js'
import { archiveMarker } from '../src/runtime/archive-marker.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const ARCHIVE_CACHE_CONTROL = 'max-age=300'
const LIVE_PAGE = '<!DOCTYPE html><html><body>Live page</body></html>'

function buildServer(seed: Record<string, string>, type: 'dynamic' | 'static' = 'dynamic') {
  const storage = memoryStorage()
  storage.seed(seed)
  return createServer({ storage, type })
}

function buildLocaleServer(seed: Record<string, string>) {
  const storage = memoryStorage()
  storage.seed(seed)
  return createServer({ storage, type: 'dynamic', locales: ['en', 'fr'], defaultLocale: 'en' })
}

function esiSeed(): Record<string, string> {
  return {
    'pages/home/index.html': LIVE_PAGE,
    'pages/live/index.html': `<!--cache:browser=60,edge=300-->\n${LIVE_PAGE}`,
    // Marker pages include an ESI reference: the archive response must be
    // returned before fragment composition runs.
    'pages/about/index.html':
      archiveMarker({ kind: 'alias', target: 'home' }) + '<!--esi:/fragments/header/index.html-->',
    'pages/legacy/index.html': archiveMarker({ kind: 'gone' }),
    'pages/old-docs/index.html': archiveMarker({ kind: 'alias', target: 'blog/[slug]' }),
    // Marker beyond the 200-byte detection window — not an archive marker.
    'pages/late/index.html': `${'x'.repeat(240)}\n${archiveMarker({ kind: 'gone' })}`,
    // Marker-like text inside a live page — not at byte 0.
    'pages/mention/index.html': '<p>Docs mention <!-- gazetta:archived alias=home --> inline</p>',
  }
}

describe('serve archive markers (dynamic/ESI)', () => {
  it('redirects an aliased page to the derived route of its target', async () => {
    const app = buildServer(esiSeed())
    const res = await app.request('http://localhost/about')

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/')
    expect(res.headers.get('cache-control')).toBe(ARCHIVE_CACHE_CONTROL)
  })

  it('uses the derived route for non-trivial page names', async () => {
    const app = buildServer(esiSeed())
    const res = await app.request('http://localhost/old-docs')

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/blog/:slug')
  })

  it('returns 410 Gone for a gone page', async () => {
    const app = buildServer(esiSeed())
    const res = await app.request('http://localhost/legacy')

    expect(res.status).toBe(410)
    expect(res.headers.get('cache-control')).toBe(ARCHIVE_CACHE_CONTROL)
  })

  it('leaves live pages untouched', async () => {
    const app = buildServer(esiSeed())
    const res = await app.request('http://localhost/')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Live page')
    expect(res.headers.get('location')).toBeNull()
  })

  it('preserves ETag/304 behavior for live pages', async () => {
    const app = buildServer(esiSeed())
    const first = await app.request('http://localhost/live')
    expect(first.status).toBe(200)
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()

    const second = await app.request('http://localhost/live', { headers: { 'If-None-Match': etag! } })
    expect(second.status).toBe(304)
  })

  it('ignores markers beyond the first 200 bytes', async () => {
    const app = buildServer(esiSeed())
    const res = await app.request('http://localhost/late')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('gazetta:archived gone')
  })

  it('ignores marker-like text that is not the first line', async () => {
    const app = buildServer(esiSeed())
    const res = await app.request('http://localhost/mention')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Docs mention')
  })
})

describe('serve archive markers (localized)', () => {
  it('honors archive markers on locale-suffixed files', async () => {
    const seed = esiSeed()
    seed['pages/about/index.fr.html'] = archiveMarker({ kind: 'alias', target: 'home' })
    const app = buildLocaleServer(seed)

    const res = await app.request('http://localhost/fr/about')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/')
    expect(res.headers.get('cache-control')).toBe(ARCHIVE_CACHE_CONTROL)
  })

  it('keeps locale fallback for live pages without a locale file', async () => {
    const seed = esiSeed()
    seed['pages/guides/index.html'] = '<!DOCTYPE html><html><body>Guides EN</body></html>'
    const app = buildLocaleServer(seed)

    const res = await app.request('http://localhost/fr/guides')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Guides EN')
    expect(res.headers.get('set-cookie')).toContain('locale=fr')
  })
})

describe('serve archive markers (static)', () => {
  function staticSeed(): Record<string, string> {
    return {
      'index.html': LIVE_PAGE,
      // static serve builds non-root paths with a leading slash.
      '/about/index.html': archiveMarker({ kind: 'alias', target: 'home' }),
      '/legacy/index.html': archiveMarker({ kind: 'gone' }),
    }
  }

  it('redirects an aliased static page', async () => {
    const app = buildServer(staticSeed(), 'static')
    const res = await app.request('http://localhost/about')

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/')
    expect(res.headers.get('cache-control')).toBe(ARCHIVE_CACHE_CONTROL)
  })

  it('returns 410 for a gone static page', async () => {
    const app = buildServer(staticSeed(), 'static')
    const res = await app.request('http://localhost/legacy')

    expect(res.status).toBe(410)
    expect(res.headers.get('cache-control')).toBe(ARCHIVE_CACHE_CONTROL)
  })

  it('leaves live static pages untouched', async () => {
    const app = buildServer(staticSeed(), 'static')
    const res = await app.request('http://localhost/')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Live page')
  })
})

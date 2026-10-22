import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWorker } from '../src/workers/cloudflare-r2.js'
import { archiveMarker } from '../src/runtime/archive-marker.js'

const ARCHIVE_CACHE_CONTROL = 'max-age=300'
const LIVE_PAGE = '<!DOCTYPE html><html><body>Live page</body></html>'

interface FakeBucket {
  bucket: {
    get(key: string): Promise<unknown>
    list(options?: { prefix?: string; delimiter?: string }): Promise<{
      objects: { key: string }[]
      delimitedPrefixes: string[]
      truncated: boolean
    }>
  }
  getCalls: string[]
}

function fakeBucket(seed: Record<string, string>): FakeBucket {
  const files = new Map(Object.entries(seed))
  const getCalls: string[] = []

  return {
    getCalls,
    bucket: {
      async get(key) {
        getCalls.push(key)
        const value = files.get(key)
        if (value === undefined) return null
        const bytes = new TextEncoder().encode(value)
        return {
          async text() {
            return value
          },
          async arrayBuffer() {
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
          },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes)
              controller.close()
            },
          }),
        }
      },
      async list(options = {}) {
        const prefix = options.prefix ?? ''
        const keys = [...files.keys()].filter(key => key.startsWith(prefix))
        const delimitedPrefixes = [
          ...new Set(
            keys
              .map(key => key.slice(prefix.length))
              .filter(rest => rest.includes('/'))
              .map(rest => `${prefix}${rest.slice(0, rest.indexOf('/') + 1)}`),
          ),
        ]
        return { objects: [], delimitedPrefixes, truncated: false }
      },
    },
  }
}

function esiSeed(): Record<string, string> {
  return {
    'pages/home/index.html':
      '<!--cache:browser=60,edge=300-->\n<!DOCTYPE html><html><head><!--esi-head:/fragments/header/index.html--></head><body>Live page<!--esi:/fragments/header/index.html--></body></html>',
    'pages/live/index.html': `<!--cache:browser=60,edge=300-->\n${LIVE_PAGE}`,
    'pages/about/index.html':
      archiveMarker({ kind: 'alias', target: 'home' }) + '<!--esi:/fragments/header/index.html-->',
    'pages/legacy/index.html': archiveMarker({ kind: 'gone' }),
    'pages/old-docs/index.html': archiveMarker({ kind: 'alias', target: 'blog/[slug]' }),
    'pages/cafe/index.html': archiveMarker({ kind: 'alias', target: 'café' }),
    'pages/café/index.html': LIVE_PAGE,
    'pages/with-aliased-fragment/index.html':
      '<html><head></head><body>Page<!--esi:/fragments/old-header/index.html--></body></html>',
    'pages/with-gone-fragment/index.html':
      '<html><head></head><body>Page<!--esi:/fragments/gone-header/index.html--></body></html>',
    'pages/with-unresolved-fragment/index.html':
      '<html><head></head><body>Page<!--esi:/fragments/broken-header/index.html--></body></html>',
    'pages/late/index.html': `${'x'.repeat(240)}\n${archiveMarker({ kind: 'gone' })}`,
    'fragments/header/index.html': '<head><style>.header{color:red}</style></head><body>Header</body>',
    'fragments/old-header/index.html': archiveMarker({ kind: 'alias', target: 'header' }),
    'fragments/gone-header/index.html': archiveMarker({ kind: 'gone' }),
    'fragments/broken-header/index.html': archiveMarker({ kind: 'alias', target: 'missing-header' }),
  }
}

let originalCaches: PropertyDescriptor | undefined
let cachePuts: string[]
let cacheStore: Map<string, Response>

beforeEach(() => {
  originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches')
  cachePuts = []
  cacheStore = new Map()
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    writable: true,
    value: {
      default: {
        match: async (request: Request) => cacheStore.get(request.url)?.clone(),
        put: async (request: Request, response: Response) => {
          cachePuts.push(request.url)
          cacheStore.set(request.url, response.clone())
        },
      },
    },
  })
})

afterEach(() => {
  if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches)
  else delete (globalThis as { caches?: unknown }).caches
})

async function fetchPage(app: ReturnType<typeof createWorker>, bucket: unknown, path: string) {
  return app.fetch(
    new Request(`https://example.com${path}`),
    { SITE_BUCKET: bucket } as never,
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  )
}

describe('Cloudflare worker archive markers', () => {
  it('redirects an aliased page to the derived route of its target', async () => {
    const { bucket, getCalls } = fakeBucket(esiSeed())
    const app = createWorker()

    const res = await fetchPage(app, bucket, '/about')

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/')
    expect(res.headers.get('cache-control')).toBe(ARCHIVE_CACHE_CONTROL)
    expect(getCalls.some(key => key.startsWith('fragments/'))).toBe(false)
    expect(cachePuts).toHaveLength(1)
  })

  it('serves a cached archive response without another R2 read', async () => {
    const { bucket, getCalls } = fakeBucket(esiSeed())
    const app = createWorker()

    expect((await fetchPage(app, bucket, '/about')).status).toBe(301)
    const callsAfterFirst = getCalls.length

    const second = await fetchPage(app, bucket, '/about')

    expect(second.status).toBe(301)
    expect(second.headers.get('location')).toBe('/')
    expect(getCalls).toHaveLength(callsAfterFirst)
  })

  it('percent-encodes non-Latin-1 alias targets', async () => {
    const { bucket } = fakeBucket(esiSeed())
    const app = createWorker()

    const res = await fetchPage(app, bucket, '/cafe')

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/caf%C3%A9')
  })

  it('handles a direct page index path through the asset route', async () => {
    const { bucket } = fakeBucket(esiSeed())
    const app = createWorker()

    const res = await fetchPage(app, bucket, '/pages/about/index.html')

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/')
    expect(res.headers.get('cache-control')).toBe(ARCHIVE_CACHE_CONTROL)
  })

  it('follows an archived fragment alias while composing ESI', async () => {
    const { bucket } = fakeBucket(esiSeed())
    const app = createWorker()

    const res = await fetchPage(app, bucket, '/with-aliased-fragment')

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Header')
    expect(body).not.toContain('gazetta:archived')
  })

  it('omits an ESI fragment archived without an alias', async () => {
    const { bucket } = fakeBucket(esiSeed())
    const app = createWorker()

    const res = await fetchPage(app, bucket, '/with-gone-fragment')

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Page')
    expect(body).toContain('<!-- fragment archived: @gone-header -->')
    expect(body).not.toContain('gazetta:archived')
  })

  it('omits an ESI fragment whose alias target does not resolve', async () => {
    const { bucket } = fakeBucket(esiSeed())
    const app = createWorker()

    const res = await fetchPage(app, bucket, '/with-unresolved-fragment')

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<!-- fragment archived: @broken-header -->')
    expect(body).not.toContain('gazetta:archived')
  })

  it('uses the derived route for non-trivial page names', async () => {
    const { bucket } = fakeBucket(esiSeed())
    const app = createWorker()

    const res = await fetchPage(app, bucket, '/old-docs')

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/blog/:slug')
  })

  it('returns 410 Gone for a gone page', async () => {
    const { bucket } = fakeBucket(esiSeed())
    const app = createWorker()

    const res = await fetchPage(app, bucket, '/legacy')

    expect(res.status).toBe(410)
    expect(res.headers.get('cache-control')).toBe(ARCHIVE_CACHE_CONTROL)
  })

  it('leaves live pages untouched and still composes ESI', async () => {
    const { bucket } = fakeBucket(esiSeed())
    const app = createWorker()

    const res = await fetchPage(app, bucket, '/')

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Live page')
    expect(body).toContain('Header')
    expect(body).not.toContain('gazetta:archived')
    expect(cachePuts).toHaveLength(1)
  })

  it('ignores markers beyond the first 200 bytes', async () => {
    const { bucket } = fakeBucket(esiSeed())
    const app = createWorker()

    const res = await fetchPage(app, bucket, '/late')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('gazetta:archived gone')
  })

  it('honors archive markers on locale-suffixed files', async () => {
    const seed = esiSeed()
    seed['pages/about/index.fr.html'] = archiveMarker({ kind: 'alias', target: 'home' })
    const { bucket } = fakeBucket(seed)
    const app = createWorker({ locales: ['en', 'fr'], defaultLocale: 'en' })

    const res = await fetchPage(app, bucket, '/fr/about')

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/fr')
    expect(res.headers.get('cache-control')).toBe(ARCHIVE_CACHE_CONTROL)
  })

  it('keeps the default-prefix locale on alias redirects', async () => {
    const seed = esiSeed()
    seed['pages/about/index.en.html'] = archiveMarker({ kind: 'alias', target: 'home' })
    const { bucket } = fakeBucket(seed)
    const app = createWorker({ locales: ['en', 'fr'], defaultLocale: 'en', defaultPrefix: true })

    const res = await fetchPage(app, bucket, '/en/about')

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/en')
  })

  it('keeps locale fallback for live pages without a locale file', async () => {
    const seed = esiSeed()
    seed['pages/guides/index.html'] = '<!DOCTYPE html><html><body>Guides EN</body></html>'
    const { bucket } = fakeBucket(seed)
    const app = createWorker({ locales: ['en', 'fr'], defaultLocale: 'en' })

    const res = await fetchPage(app, bucket, '/fr/guides')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Guides EN')
  })

  it('returns the built-in 404 instead of an archived 404 marker', async () => {
    const seed = esiSeed()
    seed['pages/404/index.html'] = archiveMarker({ kind: 'alias', target: 'home' })
    const { bucket } = fakeBucket(seed)
    const app = createWorker()

    const res = await fetchPage(app, bucket, '/missing')

    expect(res.status).toBe(404)
    const body = await res.text()
    expect(body).toContain('Page not found')
    expect(body).not.toContain('gazetta:archived')
  })
})

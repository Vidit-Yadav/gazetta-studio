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
    'pages/late/index.html': `${'x'.repeat(240)}\n${archiveMarker({ kind: 'gone' })}`,
    'fragments/header/index.html': '<head><style>.header{color:red}</style></head><body>Header</body>',
  }
}

let originalCaches: PropertyDescriptor | undefined
let cachePuts: string[]

beforeEach(() => {
  originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches')
  cachePuts = []
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    writable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async (request: Request) => {
          cachePuts.push(request.url)
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
    expect(cachePuts).toHaveLength(0)
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
    expect(res.headers.get('location')).toBe('/')
    expect(res.headers.get('cache-control')).toBe(ARCHIVE_CACHE_CONTROL)
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
})

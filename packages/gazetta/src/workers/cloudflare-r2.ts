/// <reference types="@cloudflare/workers-types" />

/**
 * Gazetta Cloudflare Worker — serves pages from R2 with ESI fragment assembly.
 *
 * Reads pre-rendered pages and fragments from an R2 bucket,
 * assembles them using ESI-style composition, and serves with
 * Cache API + ETag support. Locale-aware: extracts locale prefix
 * from URL, reads locale-suffixed files, falls back to default.
 *
 * Usage: import and re-export from your worker entry point:
 *
 *   import { createWorker } from 'gazetta/workers/cloudflare-r2'
 *   export default createWorker()
 *
 * Or customize:
 *
 *   import { createWorker } from 'gazetta/workers/cloudflare-r2'
 *   const worker = createWorker({
 *     bucketBinding: 'SITE_BUCKET',
 *     locales: ['en', 'fr', 'de'],
 *     defaultLocale: 'en',
 *   })
 *   export default worker
 */

import { Hono } from 'hono'
import { assembleEsi, parseCacheComment } from '../assemble.js'
import { archiveResponse } from '../runtime/archive-response.js'
import { fetchFragmentEntries } from '../runtime/fragment-fetch.js'

export interface CloudflareR2WorkerOptions {
  /** R2 bucket binding name (default: 'SITE_BUCKET') */
  bucketBinding?: string
  /** Supported locale codes (lowercase). Enables locale-prefix routing. */
  locales?: string[]
  /** Default locale — no URL prefix. Falls back to first in `locales`. */
  defaultLocale?: string
  /** When true, the default locale also gets a URL prefix (e.g. /en/about). */
  defaultPrefix?: boolean
  /** Custom middleware to add before page serving */
  middleware?: (app: Hono<{ Bindings: Record<string, R2Bucket> }>) => void
}

// ---------------------------------------------------------------------------
// Locale extraction (same logic as serve.ts — SRP)
// ---------------------------------------------------------------------------

function extractLocale(requestPath: string, locales: string[]): { locale: string | undefined; path: string } {
  if (locales.length === 0) return { locale: undefined, path: requestPath }
  const parts = requestPath.split('/').filter(Boolean)
  if (parts.length > 0 && locales.includes(parts[0])) {
    return { locale: parts[0], path: '/' + parts.slice(1).join('/') || '/' }
  }
  return { locale: undefined, path: requestPath }
}

// ---------------------------------------------------------------------------
// Fragment fetching with locale fallback (SRP)
// ---------------------------------------------------------------------------

async function readFragmentHtml(bucket: R2Bucket, path: string): Promise<string | null> {
  const key = path.slice(1)
  const obj = await bucket.get(key)
  if (obj) return obj.text()

  // Locale fallback: index.fr.html → index.html
  const localeFallback = key.replace(/\/index\.[a-z-]+\.html$/, '/index.html')
  if (localeFallback !== key) {
    const fallbackObj = await bucket.get(localeFallback)
    if (fallbackObj) return fallbackObj.text()
  }

  return null
}

// ---------------------------------------------------------------------------
// Page lookup with locale support (SRP)
// ---------------------------------------------------------------------------

async function findPage(
  bucket: R2Bucket,
  requestPath: string,
  locales?: string[],
): Promise<{ html: string; locale: string | undefined } | null> {
  const { locale, path: resolvedPath } = locales?.length
    ? extractLocale(requestPath, locales)
    : { locale: undefined, path: requestPath }
  const indexFile = locale ? `index.${locale}.html` : 'index.html'

  // Try exact page path
  const pagePath = resolvedPath === '/' ? `pages/home/${indexFile}` : `pages${resolvedPath}/${indexFile}`
  const obj = await bucket.get(pagePath)
  if (obj) return { html: await obj.text(), locale }

  // Locale fallback to default
  if (locale) {
    const fallback = resolvedPath === '/' ? 'pages/home/index.html' : `pages${resolvedPath}/index.html`
    const fallbackObj = await bucket.get(fallback)
    if (fallbackObj) return { html: await fallbackObj.text(), locale }
  }

  // Dynamic segments — list parent directory, find [param] entries
  const parts = resolvedPath.split('/').filter(Boolean)
  for (let i = parts.length - 1; i >= 0; i--) {
    const parentDir = parts.slice(0, i).join('/')
    const prefix = parentDir ? `pages/${parentDir}/` : 'pages/'
    const listed = await bucket.list({ prefix, delimiter: '/' })
    for (const item of listed.delimitedPrefixes) {
      const segment = item.replace(prefix, '').replace(/\/$/, '')
      if (segment.startsWith('[') && segment.endsWith(']')) {
        const dynamicParts = [...parts]
        dynamicParts[i] = segment
        const dynamicPath = `pages/${dynamicParts.join('/')}/${indexFile}`
        const dynObj = await bucket.get(dynamicPath)
        if (dynObj) return { html: await dynObj.text(), locale }
        // Dynamic route locale fallback
        if (locale) {
          const dynFallback = await bucket.get(`pages/${dynamicParts.join('/')}/index.html`)
          if (dynFallback) return { html: await dynFallback.text(), locale }
        }
      }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Worker composition
// ---------------------------------------------------------------------------

export function createWorker(options?: CloudflareR2WorkerOptions) {
  const bindingName = options?.bucketBinding ?? 'SITE_BUCKET'
  const locales = options?.locales
  const defaultLocale = options?.defaultLocale
  const defaultPrefix = options?.defaultPrefix
  const nonDefaultLocales = locales?.filter(l => l !== (defaultLocale ?? locales?.[0])) ?? []
  const archiveFor = (html: string, locale: string | undefined) =>
    archiveResponse(html, { locale, defaultLocale, defaultPrefix })

  const app = new Hono<{ Bindings: Record<string, R2Bucket> }>()

  // Custom middleware (e.g., www redirect, auth)
  if (options?.middleware) options.middleware(app)

  // Health check
  app.get('/health', async c => {
    const bucket = c.env[bindingName]
    const pages = await bucket.list({ prefix: 'pages/', delimiter: '/' })
    const fragments = await bucket.list({ prefix: 'fragments/', delimiter: '/' })
    return c.json({ ok: true, pages: pages.delimitedPrefixes.length, fragments: fragments.delimitedPrefixes.length })
  })

  // Root-level files (sitemap.xml, robots.txt) — served from R2
  app.get('/sitemap.xml', async c => {
    const obj = await c.env[bindingName].get('sitemap.xml')
    if (!obj) return c.notFound()
    return new Response(obj.body as ReadableStream, {
      headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
    })
  })
  app.get('/robots.txt', async c => {
    const obj = await c.env[bindingName].get('robots.txt')
    if (!obj) return c.notFound()
    return new Response(obj.body as ReadableStream, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
    })
  })

  // Static assets (CSS, JS) — immutable cache
  app.get('/pages/*', async c => serveStatic(c, c.env[bindingName], true))
  app.get('/fragments/*', async c => serveStatic(c, c.env[bindingName]))

  // Page serving with ESI assembly + Cache API
  app.get('*', async c => {
    const request = c.req.raw
    const cache = (caches as unknown as { default: Cache }).default

    const cached = await cache.match(request)
    if (cached) return cached

    const bucket = c.env[bindingName]
    const requestPath = new URL(c.req.url).pathname

    const result = await findPage(bucket, requestPath, locales)
    if (!result) {
      const notFound = await findPage(bucket, '/404')
      if (notFound && !archiveResponse(notFound.html)) {
        const { html: raw404 } = parseCacheComment(notFound.html)
        const fragEntries = await fetchFragmentEntries(path => readFragmentHtml(bucket, path), raw404)
        return c.html(assembleEsi(raw404, fragEntries), 404)
      }
      return c.html('<h1>404 — Page not found</h1>', 404)
    }

    const archived = archiveFor(result.html, result.locale)
    if (archived) {
      c.executionCtx.waitUntil(cache.put(request, archived.clone()))
      return archived
    }

    const { html: rawHtml, browser, edge } = parseCacheComment(result.html)

    // Read all fragments in parallel (with locale fallback)
    const fragEntries = await fetchFragmentEntries(path => readFragmentHtml(bucket, path), rawHtml)
    const assembled = assembleEsi(rawHtml, fragEntries)

    // Compute ETag
    const encoder = new TextEncoder()
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(assembled))
    const etag = `"${[...new Uint8Array(hashBuffer)]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16)}"`

    if (c.req.header('If-None-Match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } })
    }

    const response = new Response(assembled, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': `public, max-age=${browser}, s-maxage=${edge}`,
        ETag: etag,
      },
    })

    c.executionCtx.waitUntil(cache.put(request, response.clone()))
    return response
  })

  return app
}

async function serveStatic(c: any, bucket: R2Bucket, checkArchive = false) {
  const path = new URL(c.req.url).pathname.slice(1)
  const obj = await bucket.get(path)
  if (!obj) return c.notFound()

  const ext = path.split('.').pop()
  const contentType = ext === 'css' ? 'text/css' : ext === 'js' ? 'text/javascript' : 'text/html'

  if (checkArchive && ext === 'html') {
    const html = await obj.text()
    const archived = archiveResponse(html)
    if (archived) return archived
    return new Response(html, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  }

  return new Response(obj.body as ReadableStream, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}

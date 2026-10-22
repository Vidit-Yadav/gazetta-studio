/**
 * Gazetta Node production server — serves pages from any StorageProvider
 * with ESI fragment assembly. Same role as the Cloudflare Worker, but
 * runs on Node/Bun for self-hosted deployments (VPS, Docker, Fly.io).
 *
 * SOLID breakdown:
 * - extractLocale: strips locale prefix from URL (SRP)
 * - fetchFragment: reads a fragment file with locale fallback (SRP)
 * - findPage: resolves a request path to page HTML (SRP)
 * - acceptLanguageRedirect: middleware for language detection (SRP, OCP)
 * - createServer: composes the above into a Hono app
 */

import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { createHash } from 'node:crypto'
import type { StorageProvider, TargetType } from './types.js'
import { assembleEsi, parseCacheComment, splitFragment, findEsiPaths } from './assemble.js'
import { archiveResponse } from './runtime/archive-response.js'

export interface ServeOptions {
  storage: StorageProvider
  /** Target type: 'dynamic' assembles fragments at request time (ESI), 'static' serves pre-rendered HTML directly */
  type?: TargetType
  /** Supported locale codes (lowercase). When set, enables locale-prefix routing (e.g. /fr/about → pages/about/index.fr.html). */
  locales?: string[]
  /** Default locale — requests to the default locale have no URL prefix. Falls back to first in `locales`. */
  defaultLocale?: string
  /** When true, redirects unlocalized requests to the best Accept-Language match (302). */
  detection?: boolean
}

// ---------------------------------------------------------------------------
// Locale resolution (SRP)
// ---------------------------------------------------------------------------

export interface LocaleRoute {
  /** The locale extracted from the URL prefix, or undefined for default locale requests. */
  locale: string | undefined
  /** The request path with locale prefix stripped. */
  path: string
}

/**
 * Extract a locale prefix from a request path. Returns the locale (if any)
 * and the remaining path. Only matches against the provided supported set.
 */
export function extractLocale(requestPath: string, locales: string[]): LocaleRoute {
  if (locales.length === 0) return { locale: undefined, path: requestPath }
  const parts = requestPath.split('/').filter(Boolean)
  if (parts.length > 0 && locales.includes(parts[0])) {
    return { locale: parts[0], path: '/' + parts.slice(1).join('/') || '/' }
  }
  return { locale: undefined, path: requestPath }
}

// ---------------------------------------------------------------------------
// Accept-Language detection (SRP, OCP — pluggable middleware)
// ---------------------------------------------------------------------------

/**
 * Parse the Accept-Language header and return the best matching locale
 * from the supported set. Returns undefined if no match.
 */
export function matchAcceptLanguage(header: string | undefined, locales: string[]): string | undefined {
  if (!header || locales.length === 0) return undefined
  // Parse Accept-Language: fr-FR,fr;q=0.9,en;q=0.8 → sorted by quality
  const entries = header.split(',').map(part => {
    const [lang, ...params] = part.trim().split(';')
    const q = params.find(p => p.trim().startsWith('q='))
    return { lang: lang.trim().toLowerCase(), q: q ? parseFloat(q.trim().slice(2)) : 1 }
  })
  entries.sort((a, b) => b.q - a.q)

  for (const { lang } of entries) {
    // Exact match (e.g. fr-fr → fr-fr)
    if (locales.includes(lang)) return lang
    // Language-only match (e.g. fr-fr → fr)
    const base = lang.split('-')[0]
    if (locales.includes(base)) return base
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Fragment fetching with locale fallback (SRP)
// ---------------------------------------------------------------------------

interface FragmentParts {
  head: string
  body: string
}

async function fetchFragment(storage: StorageProvider, path: string): Promise<[string, FragmentParts]> {
  try {
    return [path, splitFragment(await storage.readFile(path.slice(1)))]
  } catch {
    // Locale fragment not found — fall back to default locale
    // e.g. /fragments/header/index.fr.html → /fragments/header/index.html
    const localeFallback = path.replace(/\/index\.[a-z-]+\.html$/, '/index.html')
    if (localeFallback !== path) {
      try {
        return [path, splitFragment(await storage.readFile(localeFallback.slice(1)))]
      } catch {
        /* fallback also missing */
      }
    }
    return [path, { head: '', body: `<!-- fragment not found: ${path} -->` }]
  }
}

// ---------------------------------------------------------------------------
// Page lookup (SRP)
// ---------------------------------------------------------------------------

export interface FindPageResult {
  html: string
  locale: string | undefined
}

/**
 * Resolve a request path to page HTML. Handles locale-suffixed files
 * (index.fr.html) and dynamic route segments ([param]).
 */
export async function findPage(
  storage: StorageProvider,
  requestPath: string,
  locales?: string[],
): Promise<FindPageResult | null> {
  const { locale, path: resolvedPath } = locales?.length
    ? extractLocale(requestPath, locales)
    : { locale: undefined, path: requestPath }
  const indexFile = locale ? `index.${locale}.html` : 'index.html'

  // Try exact page path
  const pagePath = resolvedPath === '/' ? `pages/home/${indexFile}` : `pages${resolvedPath}/${indexFile}`
  try {
    return { html: await storage.readFile(pagePath), locale }
  } catch {
    // Locale page not found — fall back to default locale file
    if (locale) {
      const fallback = resolvedPath === '/' ? 'pages/home/index.html' : `pages${resolvedPath}/index.html`
      try {
        return { html: await storage.readFile(fallback), locale }
      } catch {
        /* fallback also missing — continue to dynamic routes */
      }
    }
  }

  // Dynamic segments — list parent dir, find [param] entries
  const parts = resolvedPath.split('/').filter(Boolean)
  for (let i = parts.length - 1; i >= 0; i--) {
    const parentDir = parts.slice(0, i).join('/')
    const prefix = parentDir ? `pages/${parentDir}` : 'pages'
    try {
      const entries = await storage.readDir(prefix)
      for (const entry of entries) {
        if (entry.isDirectory && entry.name.startsWith('[') && entry.name.endsWith(']')) {
          const dynamicParts = [...parts]
          dynamicParts[i] = entry.name
          const dynamicPath = `pages/${dynamicParts.join('/')}/${indexFile}`
          try {
            return { html: await storage.readFile(dynamicPath), locale }
          } catch {
            if (locale) {
              try {
                return { html: await storage.readFile(`pages/${dynamicParts.join('/')}/index.html`), locale }
              } catch {
                /* fallback also missing */
              }
            }
          }
        }
      }
    } catch {
      /* dir not found */
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Server composition
// ---------------------------------------------------------------------------

export function createServer(options: ServeOptions) {
  const { storage, type = 'dynamic', locales, defaultLocale, detection } = options
  const nonDefaultLocales = locales?.filter(l => l !== (defaultLocale ?? locales?.[0])) ?? []
  const app = new Hono()

  app.use(logger())

  // Strip trailing slashes — normalize /fr/ to /fr, /about/ to /about.
  // Re-dispatches through Hono router. No redirect — preserves POST body.
  app.use(async (c, next) => {
    const url = new URL(c.req.url)
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1)
      return app.fetch(new Request(url, c.req.raw), c.env)
    }
    return next()
  })

  app.get('/health', c => c.json({ ok: true }))

  if (type === 'static') {
    app.get('*', async c => {
      const requestPath = new URL(c.req.url).pathname
      const filePath = requestPath === '/' ? 'index.html' : `${requestPath.replace(/\/$/, '')}/index.html`
      try {
        const html = await storage.readFile(filePath)
        const archived = archiveResponse(html)
        if (archived) return archived
        const etag = `"${createHash('sha256').update(html).digest('hex').slice(0, 16)}"`
        if (c.req.header('If-None-Match') === etag) return new Response(null, { status: 304, headers: { ETag: etag } })
        return c.html(html, 200, { 'Cache-Control': 'public, max-age=0, must-revalidate', ETag: etag })
      } catch {
        try {
          const html = await storage.readFile(requestPath.slice(1))
          return c.html(html)
        } catch {
          return c.html('<h1>404 — Page not found</h1>', 404)
        }
      }
    })
    return app
  }

  // ESI mode — assemble fragments at request time

  // Root-level files (sitemap.xml, robots.txt) — served from storage
  app.get('/sitemap.xml', async c => {
    try {
      const content = await storage.readFile('sitemap.xml')
      return new Response(content, {
        headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
      })
    } catch {
      return c.notFound()
    }
  })
  app.get('/robots.txt', async c => {
    try {
      const content = await storage.readFile('robots.txt')
      return new Response(content, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
      })
    } catch {
      return c.notFound()
    }
  })

  // Hashed CSS/JS — immutable cache
  app.get('/pages/*', async c => serveAsset(c, storage))
  app.get('/fragments/*', async c => serveAsset(c, storage))

  // Accept-Language detection — redirect unlocalized requests to best match
  if (detection && nonDefaultLocales.length > 0) {
    app.get('*', async (c, next) => {
      const requestPath = new URL(c.req.url).pathname
      // Only redirect paths that don't already have a locale prefix
      const { locale: existingLocale } = extractLocale(requestPath, nonDefaultLocales)
      if (existingLocale) return next()
      // Check cookie opt-out (user explicitly chose a locale)
      const localeCookie = c.req.header('Cookie')?.match(/(?:^|;\s*)locale=([a-z-]+)/)?.[1]
      if (localeCookie && nonDefaultLocales.includes(localeCookie)) {
        return c.redirect(`/${localeCookie}${requestPath === '/' ? '' : requestPath}`, 302)
      }
      // Match Accept-Language against non-default locales
      const match = matchAcceptLanguage(c.req.header('Accept-Language'), nonDefaultLocales)
      if (match) return c.redirect(`/${match}${requestPath === '/' ? '' : requestPath}`, 302)
      return next()
    })
  }

  // Page serving with ESI assembly
  app.get('*', async c => {
    const requestPath = new URL(c.req.url).pathname

    const result = await findPage(storage, requestPath, locales)
    if (!result) {
      const notFound = await findPage(storage, '/404')
      if (notFound) {
        const { html: raw404 } = parseCacheComment(notFound.html)
        const fragEntries = await Promise.all(findEsiPaths(raw404).map(p => fetchFragment(storage, p)))
        return c.html(assembleEsi(raw404, new Map(fragEntries)), 404)
      }
      return c.html('<h1>404 — Page not found</h1>', 404)
    }

    const archived = archiveResponse(result.html)
    if (archived) return archived

    const { html: rawHtml, browser, edge } = parseCacheComment(result.html)
    const fragEntries = await Promise.all(findEsiPaths(rawHtml).map(p => fetchFragment(storage, p)))
    const html = assembleEsi(rawHtml, new Map(fragEntries))

    const etag = `"${createHash('sha256').update(html).digest('hex').slice(0, 16)}"`
    if (c.req.header('If-None-Match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } })
    }

    const headers: Record<string, string> = {
      'Cache-Control': `public, max-age=${browser}, s-maxage=${edge}`,
      ETag: etag,
    }
    // Set locale cookie when visiting a locale-prefixed URL — persists the
    // author's language choice so Accept-Language detection doesn't override it.
    if (result.locale && nonDefaultLocales.length > 0) {
      headers['Set-Cookie'] = `locale=${result.locale}; Path=/; SameSite=Lax; Max-Age=31536000`
    }
    return c.html(html, 200, headers)
  })

  return app
}

async function serveAsset(c: any, storage: StorageProvider) {
  const path = new URL(c.req.url).pathname.slice(1)
  try {
    const content = await storage.readFile(path)
    const ext = path.split('.').pop()
    const contentType = ext === 'css' ? 'text/css' : ext === 'js' ? 'text/javascript' : 'text/html'
    return new Response(content, {
      headers: {
        'Content-Type': `${contentType}; charset=utf-8`,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  } catch {
    return c.notFound()
  }
}

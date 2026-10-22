import { join } from 'node:path'
import { memoryCache } from './cache/factories.js'
import { forSite } from './cache/per-site.js'
import type { AdminCache } from './cache/types.js'
import type { SiteConfig } from './config/types.js'
import { siteConfigToManifest } from './config/loader.js'
import { mapLimit } from './concurrency.js'
import { type ContentRoot, createContentRoot } from './content-root.js'
import { localeFromFilename, localeRoutePrefix, resolveSiteLocales } from './locale.js'
import { parseFragmentManifest, parsePageManifest } from './manifest.js'
import { deriveRoute } from './runtime/derive-route.js'
import type { FragmentManifest, PageManifest, SiteManifest, StorageProvider } from './types.js'

export { deriveRoute }

/** A page entry with its name, manifest, and optional locale. */
export interface PageEntry {
  name: string
  page: PageManifest & { dir: string }
  locale?: string
}

/** A fragment entry with its name, manifest, and optional locale. */
export interface FragmentEntry {
  name: string
  fragment: FragmentManifest & { dir: string }
  locale?: string
}

/** Flatten all pages including locale variants into a single list. */
export function allPageEntries(site: Site): PageEntry[] {
  const entries: PageEntry[] = []
  for (const [name, page] of site.pages) entries.push({ name, page })
  for (const [name, entry] of site.pageLocales) {
    for (const [locale, page] of entry.locales) entries.push({ name, page, locale })
  }
  return entries
}

/** Flatten all fragments including locale variants into a single list. */
export function allFragmentEntries(site: Site): FragmentEntry[] {
  const entries: FragmentEntry[] = []
  for (const [name, fragment] of site.fragments) entries.push({ name, fragment })
  for (const [name, entry] of site.fragmentLocales) {
    for (const [locale, fragment] of entry.locales) entries.push({ name, fragment, locale })
  }
  return entries
}

/** A page or fragment with its locale variants. */
export interface LocalizedEntry<T> {
  /** Default locale manifest (from page.json / fragment.json). */
  default: T
  /** Locale variants keyed by normalized locale code. Empty if single-locale. */
  locales: Map<string, T>
}

export interface Site {
  manifest: SiteManifest
  pages: Map<string, PageManifest & { dir: string }>
  /** Locale variants for pages. Only populated when site has `locales` config. */
  pageLocales: Map<string, LocalizedEntry<PageManifest & { dir: string }>>
  fragments: Map<string, FragmentManifest & { dir: string }>
  /** Locale variants for fragments. Only populated when site has `locales` config. */
  fragmentLocales: Map<string, LocalizedEntry<FragmentManifest & { dir: string }>>
  /** Content root — `{storage, rootPath}` pair for accessing site content. */
  contentRoot: ContentRoot
  /**
   * Storage provider for site content. Equivalent to `contentRoot.storage` —
   * kept as a convenience because resolver and template loading use it directly.
   */
  storage: StorageProvider
  /**
   * Rooting prefix for content under `storage`. Equivalent to `contentRoot.rootPath`.
   * Empty string when storage is target-rooted.
   */
  siteDir: string
  /** Directory containing template packages. Project-level, separate from content rooting. */
  templatesDir: string
  /**
   * AdminCache instance for L4 admin / origin-server caching. Always
   * present — `loadSite` either wires the operator-supplied instance
   * from `manifest.cache` (Path X — gazetta.config.ts defaults or per-
   * site override) or falls back to a fresh `memoryCache()`.
   *
   * Per-site key scoping is automatic via `forSite()` — consumers call
   * `site.cache.get('pages:home')` and the wrapper transparently
   * prefixes with `site:{name}:` before hitting the underlying provider.
   * Future shared backing services (Redis, Azure) inherit isolation
   * for free.
   */
  cache: AdminCache
}

interface DiscoverPagesResult {
  pages: Map<string, PageManifest & { dir: string }>
  pageLocales: Map<string, LocalizedEntry<PageManifest & { dir: string }>>
}

async function discoverPages(
  storage: StorageProvider,
  pagesDir: string,
  siteManifest: SiteManifest,
  result: DiscoverPagesResult = { pages: new Map(), pageLocales: new Map() },
  prefix = '',
): Promise<DiscoverPagesResult> {
  if (!(await storage.exists(pagesDir))) {
    if (!prefix) console.warn(`  Warning: pages/ directory not found at ${pagesDir}`)
    return result
  }

  const entries = await storage.readDir(pagesDir)
  const subdirs = entries.filter(e => e.isDirectory)

  // Parallelize manifest reads — sequential is untenable at 10k pages.
  // Bounded concurrency protects the fd table and cloud rate limits.
  await mapLimit(subdirs, async entry => {
    const dir = join(pagesDir, entry.name)
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    const manifestPath = join(dir, 'page.json')

    if (await storage.exists(manifestPath)) {
      try {
        const manifest = await parsePageManifest(storage, manifestPath)
        const route = deriveRoute(name)
        const pageWithDir = { ...manifest, route, dir }
        result.pages.set(name, pageWithDir)

        // Discover locale variants (page.fr.json, page.en-gb.json, etc.)
        const locales = new Map<string, PageManifest & { dir: string }>()
        const dirEntries = await storage.readDir(dir)
        for (const f of dirEntries) {
          if (f.isDirectory) continue
          const locale = localeFromFilename(f.name, 'page')
          if (!locale) continue
          try {
            const localeManifest = await parsePageManifest(storage, join(dir, f.name))
            const siteLocales = resolveSiteLocales(siteManifest)
            const routePrefix = siteLocales ? localeRoutePrefix(locale, siteLocales) : `/${locale}`
            const localeRoute = `${routePrefix}${route === '/' ? '' : route}` || '/'
            locales.set(locale, { ...localeManifest, route: localeRoute, dir })
          } catch (err) {
            console.warn(`  Warning: skipping page "${name}" locale "${locale}": ${(err as Error).message}`)
          }
        }
        if (locales.size > 0) {
          result.pageLocales.set(name, { default: pageWithDir, locales })
        }
      } catch (err) {
        console.warn(`  Warning: skipping page "${name}": ${(err as Error).message}`)
      }
    }

    // Recurse into subdirectories to find nested pages (e.g., blog/[slug]).
    await discoverPages(storage, dir, siteManifest, result, name)
  })
  return result
}

interface DiscoverFragmentsResult {
  fragments: Map<string, FragmentManifest & { dir: string }>
  fragmentLocales: Map<string, LocalizedEntry<FragmentManifest & { dir: string }>>
}

async function discoverFragments(storage: StorageProvider, fragmentsDir: string): Promise<DiscoverFragmentsResult> {
  const result: DiscoverFragmentsResult = { fragments: new Map(), fragmentLocales: new Map() }
  if (!(await storage.exists(fragmentsDir))) {
    console.warn(`  Warning: fragments/ directory not found at ${fragmentsDir}`)
    return result
  }

  const entries = await storage.readDir(fragmentsDir)
  const subdirs = entries.filter(e => e.isDirectory)

  await mapLimit(subdirs, async entry => {
    const fragDir = join(fragmentsDir, entry.name)
    const manifestPath = join(fragDir, 'fragment.json')
    if (!(await storage.exists(manifestPath))) return
    try {
      const manifest = await parseFragmentManifest(storage, manifestPath)
      const fragWithDir = { ...manifest, dir: fragDir }
      result.fragments.set(entry.name, fragWithDir)

      // Discover locale variants (fragment.fr.json, etc.)
      const locales = new Map<string, FragmentManifest & { dir: string }>()
      const dirEntries = await storage.readDir(fragDir)
      for (const f of dirEntries) {
        if (f.isDirectory) continue
        const locale = localeFromFilename(f.name, 'fragment')
        if (!locale) continue
        try {
          const localeManifest = await parseFragmentManifest(storage, join(fragDir, f.name))
          locales.set(locale, { ...localeManifest, dir: fragDir })
        } catch (err) {
          console.warn(`  Warning: skipping fragment "${entry.name}" locale "${locale}": ${(err as Error).message}`)
        }
      }
      if (locales.size > 0) {
        result.fragmentLocales.set(entry.name, { default: fragWithDir, locales })
      }
    } catch (err) {
      console.warn(`  Warning: skipping fragment "${entry.name}": ${(err as Error).message}`)
    }
  })
  return result
}

export interface LoadSiteOptions {
  /** @deprecated Pass `contentRoot` instead (preferred for new code). */
  siteDir?: string
  /** @deprecated Pass `contentRoot` instead (preferred for new code). */
  storage?: StorageProvider
  /** Content root — where site content lives. Preferred over siteDir/storage. */
  contentRoot?: ContentRoot
  /** Override templates directory (default: siteDir/templates). */
  templatesDir?: string
  /**
   * Pre-loaded runtime site manifest. Used when the caller already has a
   * `SiteManifest` in hand — typically from the dev server or admin API,
   * which load the manifest once and pass it to `loadSite` so target
   * content roots don't have to carry their own copy of site config.
   *
   * Mutually exclusive with `config`.
   */
  manifest?: SiteManifest
  /**
   * Pre-loaded TS-config result from `loadSiteConfig()` /
   * `loadProjectConfig()`. When provided, the config is converted to the
   * runtime manifest shape via `siteConfigToManifest()`.
   *
   * Mutually exclusive with `manifest`.
   */
  config?: SiteConfig
  /**
   * Pre-built per-site `AdminCache` — used when the caller owns the
   * cache lifetime (typically the admin-api boot, which builds one per
   * SourceContext so every load of the same source shares one cache).
   *
   * When provided, `loadSite` assumes the cache is already site-scoped
   * and uses it verbatim. When absent, falls back to constructing one
   * from `manifest.cache` (operator-supplied via Path X) or a fresh
   * `memoryCache()`, wrapped with `forSite()` per call. The fallback
   * suits CLI and tests where loadSite is called once.
   */
  cache?: AdminCache
}

/**
 * Load a site from a storage provider.
 *
 * Two input shapes are supported:
 * - **Preferred**: `{ contentRoot, templatesDir }` — storage rooting is
 *   whatever the caller chose (cwd-rooted with siteDir prefix, or target-
 *   rooted with empty prefix). Callers construct the root once; this
 *   function doesn't care.
 * - **Legacy**: `{ siteDir, storage, templatesDir? }` — the pair is wrapped
 *   in a ContentRoot internally. Retained for callers that haven't
 *   migrated yet.
 */
export async function loadSite(opts: LoadSiteOptions): Promise<Site> {
  let contentRoot: ContentRoot
  let siteDir: string
  let templatesDir: string

  if (opts.contentRoot) {
    // Preferred: caller built the ContentRoot
    contentRoot = opts.contentRoot
    siteDir = contentRoot.rootPath
    templatesDir = opts.templatesDir ?? join(siteDir, 'templates')
  } else {
    // Legacy options bag: { siteDir, storage, templatesDir? }
    if (!opts.siteDir || !opts.storage) {
      throw new Error('loadSite: either contentRoot, or both siteDir and storage, must be provided')
    }
    siteDir = opts.siteDir
    contentRoot = createContentRoot(opts.storage, siteDir)
    templatesDir = opts.templatesDir ?? join(siteDir, 'templates')
  }

  let manifest: SiteManifest
  if (opts.config && opts.manifest) {
    throw new Error('loadSite: pass either `config` or `manifest`, not both')
  }
  if (opts.config) {
    // TS config from new loader — convert to runtime manifest shape.
    manifest = siteConfigToManifest(opts.config)
  } else if (opts.manifest) {
    // Project-level bootstrap passed in the manifest — skip any storage read.
    manifest = opts.manifest
  } else {
    throw new Error('loadSite: either `config` or `manifest` must be provided')
  }
  const { pages, pageLocales } = await discoverPages(contentRoot.storage, contentRoot.path('pages'), manifest)
  const { fragments, fragmentLocales } = await discoverFragments(contentRoot.storage, contentRoot.path('fragments'))

  if (pages.size === 0) {
    console.warn(`  Warning: no pages found in ${contentRoot.path('pages')}`)
  }

  // Per-site cache resolution:
  //   1. If the caller owns the cache lifetime (admin-api boot via
  //      SourceContext), use the supplied instance verbatim — it's
  //      already site-scoped.
  //   2. Else use the operator-supplied instance from manifest.cache
  //      (Path X — set via gazetta.config.ts defaults or per-site
  //      override), wrapped with forSite() per call.
  //   3. Else fall back to a fresh MemoryCache (CLI, tests) wrapped
  //      with forSite(). Each loadSite() call gets its own — fine for
  //      one-shot uses; the admin-api path takes (1) to share across
  //      requests.
  const cache: AdminCache = opts.cache ?? forSite(manifest.cache ?? memoryCache(), manifest.name)

  return {
    manifest,
    pages,
    pageLocales,
    fragments,
    fragmentLocales,
    contentRoot,
    cache,
    // backward-compat fields
    siteDir,
    templatesDir,
    storage: contentRoot.storage,
  }
}

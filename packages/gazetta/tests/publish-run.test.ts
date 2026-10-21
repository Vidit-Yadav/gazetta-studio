/**
 * publishRun tests — Cut 5 (orchestrator ported).
 *
 * v1 spine is pure fan-out: validate → loop targets × items via
 * publishPage / publishFragment → aggregate. Caller owns template
 * scan, loadSite, asset publish, dep indices, site manifest, cache
 * purge (CLI / admin do these around publishRun).
 *
 * Per Q4 fail-soft: per-item failures continue; per-target init
 * failures fail just that target; boot fail-fast on invalid input.
 */
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  publishRun,
  type PublishItemRef,
  type PublishProgressEvent,
  type PublishRunInput,
  type PublishRunResult,
  type PublishTargetResult,
} from '../src/publish-run.js'
import { compareTargets } from '../src/compare.js'
import { createContentRoot } from '../src/content-root.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { loadSite, type Site } from '../src/site-loader.js'
import { scanTemplates } from '../src/templates-scan.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterManifest, starterProjectRoot, starterTargetDir, starterTemplatesDir } from './_helpers/starter.js'

async function loadStarterSite(): Promise<Site> {
  const storage = createFilesystemProvider(starterTargetDir)
  const contentRoot = createContentRoot(storage, '')
  const manifest = await starterManifest()
  return loadSite({ contentRoot, templatesDir: starterTemplatesDir, manifest })
}

async function setup() {
  const site = await loadStarterSite()
  const manifest = await starterManifest()
  const sourceRoot = createContentRoot(memoryStorage(), '')
  return { site, manifest, sourceRoot }
}

// ─── Type contract (Cut 1, preserved) ──────────────────────────────

describe('PublishItemRef type contract', () => {
  it('carries kind + name + optional locale', () => {
    const ref: PublishItemRef = { kind: 'page', name: 'home' }
    expectTypeOf(ref.kind).toEqualTypeOf<'page' | 'fragment'>()
  })
})

describe('PublishProgressEvent variants', () => {
  it('exhaustive switch on kind compiles', () => {
    const project = (e: PublishProgressEvent): string => {
      switch (e.kind) {
        case 'run-start':
          return `run ${e.totalItems}×${e.totalTargets}`
        case 'target-start':
          return `target-start ${e.target}`
        case 'item-start':
          return `item-start ${e.item.name}@${e.target}`
        case 'item-done':
          return `item-done ${e.result.name}`
        case 'target-done':
          return `target-done ${e.result.name}`
        case 'run-done':
          return `run-done ${e.result.ok}`
      }
    }
    expect(project({ kind: 'run-start', totalItems: 5, totalTargets: 2 })).toBe('run 5×2')
  })
})

// ─── Spine boot ────────────────────────────────────────────────────

describe('publishRun — boot phase', () => {
  it('returns ok with empty items + targets (fast-path no-op)', async () => {
    const { site, manifest, sourceRoot } = await setup()
    const result = await publishRun({
      items: [],
      targets: [],
      site,
      sourceRoot,
      siteManifest: manifest,
      targetStorages: new Map(),
    })
    expect(result.ok).toBe(true)
    expect(result.items).toHaveLength(0)
    expect(result.targets).toHaveLength(0)
  })

  it('throws on no targets but non-empty items (boot fail-fast)', async () => {
    const { site, manifest, sourceRoot } = await setup()
    await expect(
      publishRun({
        items: [{ kind: 'page', name: 'home' }],
        targets: [],
        site,
        sourceRoot,
        siteManifest: manifest,
        targetStorages: new Map(),
      }),
    ).rejects.toThrow(/no targets/)
  })

  it('throws on unknown target (operator error)', async () => {
    const { site, manifest, sourceRoot } = await setup()
    await expect(
      publishRun({
        items: [],
        targets: ['ghost'],
        site,
        sourceRoot,
        siteManifest: manifest,
        targetStorages: new Map(),
      }),
    ).rejects.toThrow(/not in registry/)
  })
})

// ─── Spine fan-out ─────────────────────────────────────────────────

describe('publishRun — fan-out', () => {
  it('publishes one item to one target → ok aggregate', async () => {
    const { site, manifest, sourceRoot } = await setup()
    const targetStorage = memoryStorage()
    const pageName = [...site.pages.keys()].find(k => !k.includes('['))!

    const result = await publishRun({
      items: [{ kind: 'page', name: pageName }],
      targets: ['local'],
      site,
      sourceRoot,
      siteManifest: manifest,
      targetStorages: new Map([['local', targetStorage]]),
    })

    expect(result.ok).toBe(true)
    expect(result.items).toHaveLength(1)
    expect(result.targets).toHaveLength(1)
    expect(result.targets[0]?.failed).toBe(false)
    expect(result.targets[0]?.filesWritten).toBeGreaterThanOrEqual(1)
  })

  it('publishes N items × M targets → N×M item results', async () => {
    const { site, manifest, sourceRoot } = await setup()
    const t1 = memoryStorage()
    const t2 = memoryStorage()
    const pageName = [...site.pages.keys()].find(k => !k.includes('['))!
    const fragName = [...site.fragments.keys()][0]
    if (!fragName) return

    const result = await publishRun({
      items: [
        { kind: 'page', name: pageName },
        { kind: 'fragment', name: fragName },
      ],
      targets: ['local', 'staging'],
      site,
      sourceRoot,
      siteManifest: manifest,
      targetStorages: new Map([
        ['local', t1],
        ['staging', t2],
      ]),
    })

    expect(result.items).toHaveLength(4) // 2 items × 2 targets
    expect(result.targets).toHaveLength(2)
    expect(result.ok).toBe(true)
  })

  it('per-item NOT_FOUND continues run (fail-soft)', async () => {
    const { site, manifest, sourceRoot } = await setup()
    const targetStorage = memoryStorage()
    const pageName = [...site.pages.keys()].find(k => !k.includes('['))!

    const result = await publishRun({
      items: [
        { kind: 'page', name: 'does-not-exist' },
        { kind: 'page', name: pageName },
      ],
      targets: ['local'],
      site,
      sourceRoot,
      siteManifest: manifest,
      targetStorages: new Map([['local', targetStorage]]),
    })

    expect(result.items).toHaveLength(2)
    expect(result.items[0]?.ok).toBe(false)
    if (!result.items[0]?.ok) expect(result.items[0]?.code).toBe('NOT_FOUND')
    expect(result.items[1]?.ok).toBe(true)
    expect(result.ok).toBe(false) // any item failed → run.ok false
    // Per-target failed only when ALL items failed for that target — here 1/2 failed → not failed
    expect(result.targets[0]?.failed).toBe(false)
  })

  it('all items fail on one target → target.failed true', async () => {
    const { site, manifest, sourceRoot } = await setup()
    const targetStorage = memoryStorage()

    const result = await publishRun({
      items: [
        { kind: 'page', name: 'ghost-1' },
        { kind: 'page', name: 'ghost-2' },
      ],
      targets: ['local'],
      site,
      sourceRoot,
      siteManifest: manifest,
      targetStorages: new Map([['local', targetStorage]]),
    })

    expect(result.targets[0]?.failed).toBe(true)
    expect(result.ok).toBe(false)
  })

  it('passes manifestHash through to spine (sidecars get written)', async () => {
    const { site, manifest, sourceRoot } = await setup()
    const targetStorage = memoryStorage()
    const pageName = [...site.pages.keys()].find(k => !k.includes('['))!

    await publishRun({
      items: [{ kind: 'page', name: pageName }],
      targets: ['local'],
      site,
      sourceRoot,
      siteManifest: manifest,
      targetStorages: new Map([['local', targetStorage]]),
      itemHashes: new Map([[`pages/${pageName}`, 'feedface']]),
    })

    const entries = await targetStorage.readDir(`pages/${pageName}`)
    expect(entries.find(e => e.name === '.feedface.hash')).toBeDefined()
  })

  it('#1000: locale variant hash matches its own manifest, so compare sees it unchanged', async () => {
    const { site, manifest, sourceRoot } = await setup()
    const targetStorage = memoryStorage()
    const templateInfos = await scanTemplates(starterTemplatesDir, starterProjectRoot)
    expect(site.pageLocales.get('home')?.locales.get('fr')).toBeDefined()

    await publishRun({
      items: [{ kind: 'page', name: 'home', locale: 'fr' }],
      targets: ['local'],
      site,
      sourceRoot,
      siteManifest: manifest,
      targetStorages: new Map([['local', targetStorage]]),
      templateInfos,
      publishAssetsBeforeItems: false,
      publishDepIndicesAfter: false,
      publishSiteManifestAfter: false,
    })

    const cmp = await compareTargets({
      sourceRoot: createContentRoot(createFilesystemProvider(starterTargetDir), ''),
      target: targetStorage,
      templatesDir: starterTemplatesDir,
      projectRoot: starterProjectRoot,
      type: 'static',
      scanTemplates: async () => templateInfos,
      manifest,
    })
    expect(cmp.unchanged).toContain('pages/home:fr')
  }, 30_000)
})

// ─── Progress events ───────────────────────────────────────────────

describe('publishRun — progress emission', () => {
  it('emits run-start / target-start / item-start / item-done / target-done / run-done', async () => {
    const { site, manifest, sourceRoot } = await setup()
    const targetStorage = memoryStorage()
    const pageName = [...site.pages.keys()].find(k => !k.includes('['))!
    const onProgress = vi.fn()

    await publishRun({
      items: [{ kind: 'page', name: pageName }],
      targets: ['local'],
      site,
      sourceRoot,
      siteManifest: manifest,
      targetStorages: new Map([['local', targetStorage]]),
      onProgress,
    })

    const events = onProgress.mock.calls.map(c => c[0] as PublishProgressEvent)
    const kinds = events.map(e => e.kind)
    expect(kinds[0]).toBe('run-start')
    expect(kinds).toContain('target-start')
    expect(kinds).toContain('item-start')
    expect(kinds).toContain('item-done')
    expect(kinds).toContain('target-done')
    expect(kinds[kinds.length - 1]).toBe('run-done')
  })

  it('item-start event carries resolved render mode', async () => {
    const { site, manifest, sourceRoot } = await setup()
    const targetStorage = memoryStorage()
    const pageName = [...site.pages.keys()].find(k => !k.includes('['))!
    const events: PublishProgressEvent[] = []

    await publishRun({
      items: [{ kind: 'page', name: pageName }],
      targets: ['local'],
      site,
      sourceRoot,
      siteManifest: manifest,
      targetStorages: new Map([['local', targetStorage]]),
      onProgress: e => events.push(e),
    })

    const itemStart = events.find(e => e.kind === 'item-start')
    expect(itemStart?.kind).toBe('item-start')
    if (itemStart?.kind === 'item-start') {
      // Mode resolves from target.type — starter `local` target is static by
      // default in site.config.ts; a live page on static → page-static.
      expect(['page-static', 'page-rendered']).toContain(itemStart.mode)
    }
  })
})

// ─── Extended spine: dep indices + site manifest + asset publish ──

describe('publishRun — per-target side effects', () => {
  it('writes site.json on each target by default', async () => {
    const { site, manifest, sourceRoot } = await setup()
    const targetStorage = memoryStorage()
    const pageName = [...site.pages.keys()].find(k => !k.includes('['))!

    await publishRun({
      items: [{ kind: 'page', name: pageName }],
      targets: ['local'],
      site,
      sourceRoot,
      siteManifest: manifest,
      targetStorages: new Map([['local', targetStorage]]),
    })
    expect(await targetStorage.exists('site.json')).toBe(true)
  })

  it('publishSiteManifestAfter: false skips site.json emit', async () => {
    const { site, manifest, sourceRoot } = await setup()
    const targetStorage = memoryStorage()
    const pageName = [...site.pages.keys()].find(k => !k.includes('['))!

    await publishRun({
      items: [{ kind: 'page', name: pageName }],
      targets: ['local'],
      site,
      sourceRoot,
      siteManifest: manifest,
      targetStorages: new Map([['local', targetStorage]]),
      publishSiteManifestAfter: false,
    })
    expect(await targetStorage.exists('site.json')).toBe(false)
  })

  it('writes dep-index sidecars to .gazetta/asset-refs/ by default', async () => {
    const { site, manifest, sourceRoot } = await setup()
    const targetStorage = memoryStorage()
    const pageName = [...site.pages.keys()].find(k => !k.includes('['))!

    await publishRun({
      items: [{ kind: 'page', name: pageName }],
      targets: ['local'],
      site,
      sourceRoot,
      siteManifest: manifest,
      targetStorages: new Map([['local', targetStorage]]),
    })
    // After dep indices run, .gazetta/asset-refs/ AND/OR .gazetta/fragment-deps/
    // should be present (depending on what the starter actually references).
    const gazettaExists = await targetStorage.exists('.gazetta')
    expect(gazettaExists).toBe(true)
  })

  it('publishDepIndicesAfter: false skips dep index rebuild', async () => {
    const { site, manifest, sourceRoot } = await setup()
    const targetStorage = memoryStorage()
    const pageName = [...site.pages.keys()].find(k => !k.includes('['))!

    await publishRun({
      items: [{ kind: 'page', name: pageName }],
      targets: ['local'],
      site,
      sourceRoot,
      siteManifest: manifest,
      targetStorages: new Map([['local', targetStorage]]),
      publishDepIndicesAfter: false,
      publishSiteManifestAfter: false,
    })
    // No dep indices written → no .gazetta/asset-refs/
    expect(await targetStorage.exists('.gazetta/asset-refs')).toBe(false)
  })
})

describe('publishRun — template precheck', () => {
  it('throws when templateInfos contains invalid templates (boot fail-fast)', async () => {
    const { site, manifest, sourceRoot } = await setup()
    const invalidInfo = {
      name: 'broken',
      valid: false,
      errors: ['no default export'],
      hash: '',
    } as unknown as Parameters<typeof publishRun>[0]['templateInfos'] extends readonly (infer T)[] | undefined
      ? T
      : never

    await expect(
      publishRun({
        items: [],
        targets: ['local'],
        site,
        sourceRoot,
        siteManifest: manifest,
        targetStorages: new Map([['local', memoryStorage()]]),
        templateInfos: [invalidInfo],
      }),
    ).rejects.toThrow(/invalid templates.*broken/)
  })
})

// ─── Aggregate result type ────────────────────────────────────────

describe('PublishRunResult type contract', () => {
  it('aggregates items + targets; ok derived', () => {
    const result: PublishRunResult = { ok: true, items: [], targets: [] }
    expectTypeOf(result.items).toEqualTypeOf<readonly import('../src/publish-item.js').PublishItemResult[]>()
    expectTypeOf(result.targets).toEqualTypeOf<readonly PublishTargetResult[]>()
  })
})

// ─── Render mode per target type (through the real entry point) ────

describe('publishRun — page render mode per target type', () => {
  // The starter's `esi-test` target is `type: 'dynamic'`, which today is
  // the ESI target type (the request-time worker assembles pages from
  // separately published fragments). Its pages must keep ESI
  // placeholders; baking fragments in means publishing a fragment alone
  // never reaches the pages that use it. `local` is the static control.
  it.each([
    ['esi-test', true],
    ['local', false],
  ] as const)('%s target: page has ESI placeholders = %s', async (targetName, expectEsi) => {
    const { site, manifest, sourceRoot } = await setup()
    expect(manifest.targets?.[targetName], `starter must define ${targetName}`).toBeDefined()
    const targetStorage = memoryStorage()

    const result = await publishRun({
      items: [{ kind: 'page', name: 'home' }],
      targets: [targetName],
      site,
      sourceRoot,
      siteManifest: manifest,
      targetStorages: new Map([[targetName, targetStorage]]),
    })
    expect(result.ok).toBe(true)

    // Home's HTML: under pages/home/ (ESI layout) or at the root (static
    // URL layout) — this test is about the placeholders, not the path.
    const keys = [...targetStorage.dump().keys()]
    const homePath = keys.find(k => k === 'pages/home/index.html' || k === 'index.html')
    expect(homePath, keys.join(', ')).toBeDefined()
    const html = await targetStorage.readFile(homePath!)
    expect(html.includes('<!--esi'), html.slice(0, 300)).toBe(expectEsi)
  })
})

// ─── Static output layout (through the real entry point) ───────────

describe('publishRun — static target writes pages at their URL paths', () => {
  // A static target is served by a plain file server (`gazetta serve`,
  // GitHub Pages, S3, nginx): `/about` must be `about/index.html`. Since
  // publish pipeline Cut 3 every page went to `pages/{name}/index.html`,
  // so every page 404'd. Locales are a path prefix; sidecars stay under
  // `pages/{name}/` (they aren't served).
  async function publishStatic(items: PublishItemRef[], tweak?: (site: Site) => void) {
    const { site, manifest, sourceRoot } = await setup()
    tweak?.(site)
    const targetStorage = memoryStorage()
    const result = await publishRun({
      items,
      targets: ['local'],
      site,
      sourceRoot,
      siteManifest: manifest,
      targetStorages: new Map([['local', targetStorage]]),
    })
    expect(result.ok, JSON.stringify(result.items)).toBe(true)
    return { site, files: [...targetStorage.dump().keys()], targetStorage }
  }

  it.each([
    [{ kind: 'page', name: 'home' }, 'index.html', 'Welcome to Gazetta'],
    [{ kind: 'page', name: 'about' }, 'about/index.html', 'About Gazetta'],
    [{ kind: 'page', name: 'about', locale: 'fr' }, 'fr/about/index.html', '<html'],
    [{ kind: 'page', name: 'home', locale: 'fr' }, 'fr/index.html', '<html'],
  ] as const)('%o → %s', async (ref, path, contains) => {
    const { files, targetStorage } = await publishStatic([ref])
    expect(files, files.join(', ')).toContain(path)
    expect(await targetStorage.readFile(path)).toContain(contains)
    expect(files.filter(f => /^pages\/[^/]+\/index(\.[a-z-]+)?\.html$/.test(f))).toEqual([])
  })

  it('archived page: the marker goes to its URL path', async () => {
    const { files, targetStorage } = await publishStatic([{ kind: 'page', name: 'about' }], site => {
      const about = site.pages.get('about')!
      site.pages.set('about', { ...about, archived: true, aliasOf: 'home' } as typeof about)
    })
    expect(files, files.join(', ')).toContain('about/index.html')
    expect(await targetStorage.readFile('about/index.html')).toContain('<!-- gazetta:archived alias=home -->')
    expect(files).not.toContain('pages/about/index.html')
  })
})

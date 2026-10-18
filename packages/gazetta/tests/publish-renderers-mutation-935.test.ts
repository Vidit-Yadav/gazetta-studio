/**
 * Coverage for `renderPageWithEsi` in `publish-renderers.ts`. Captures
 * mutants surfaced by Stryker run 39109392655 (issue #935).
 *
 * The ESI renderer's output was only loosely asserted (regex fragment
 * shape + conditional file checks), so most of its mutants survived.
 * This file pins the exact ESI markers, the locale-suffixed fragment
 * path, the accumulators for inline components' CSS/JS/head, and the
 * empty-output boundary:
 *
 *   - Lines 125-129 ArrayDeclaration (Survived x5) — the five
 *     accumulator initializers (`bodyParts`, `localCssParts`,
 *     `localJsParts`, `localHeadParts`, `esiHeadTags`). The sentinel
 *     leaks into body / head / hashed files. Killed by the exact-body
 *     assertion (fragment-only page), the `files` length 0 assertion,
 *     the exact CSS/JS file contents (mixed page), and the no-sentinel
 *     head check.
 *
 *   - Line 136 MethodExpression (Survived) — dropping the
 *     `childEntry.slice(1)` call keeps the `@` in `fragName`, so every
 *     marker path becomes `fragments/@nav/...`. Killed by the
 *     byte-exact `<!--esi:...-->` / `<!--esi-head:...-->` assertions.
 *
 *   - Line 137 StringLiteral (Survived) — the locale branch template
 *     `` `index.${ctx.locale}.html` `` → `""`. Only observable with a
 *     locale set; killed by the locale test asserting `index.fr.html`
 *     in the markers and in `indexFile`.
 *
 *   - Lines 139-140 StringLiteral — the `<!--esi-head:/${fragPath}-->`
 *     and `<!--esi:/${fragPath}-->` templates. Killed by the
 *     byte-exact marker assertions.
 *
 *   - Lines 144-145 ConditionalExpression — `if (rendered.css)` /
 *     `if (rendered.js)` → true. Forces empty strings into the
 *     accumulators; killed by the exact CSS line count / JS content
 *     (bare component between two full ones).
 *
 *   - Line 154 ConditionalExpression — `if (pageOutput.css)` → true.
 *     The plain page template contributes no CSS, so the mutant
 *     unshifts an empty string and the CSS file starts with a blank
 *     line; killed by the exact single-line CSS assertion on the
 *     `plain-page-css` page.
 *
 *   - Lines 163 / 173 ConditionalExpression — `if (pageCss)` /
 *     `if (pageJs)` → true. Forces a hashed file even when there is no
 *     CSS/JS to emit; killed by the fragment-only page asserting
 *     `files` length 0.
 *
 *   - Lines 199-200 head assembly — dropping `.filter(Boolean)` and
 *     narrowing the `.join('\n  ')` delimiter both surface as blank or
 *     comma-joined head lines; killed by asserting the exact
 *     charset→viewport delimiter and that no head line is blank.
 *
 *   - Lines 206-208 cache comment — numeric defaults (`?? 0`,
 *     `?? 86400`) and the exact `<!--cache:...-->` template; killed by
 *     exact `startsWith` assertions with and without `targetCache`.
 *
 * Equivalent mutants (documented so future triage doesn't re-litigate):
 *
 *   - Line 133 StringLiteral `.startsWith('@')` → `.startsWith('')`.
 *     `resolver.ts:76-80` throws on non-`@` string entries before this
 *     loop runs, so only `@`-prefixed strings ever reach the check and
 *     both forms return true for them. Same equivalence class was
 *     documented for the duplicated logic in
 *     `publish-rendered-mutation-649.test.ts`.
 *
 *   - Line 146 ConditionalExpression `if (rendered.head)` → true and
 *     line 155 `if (pageOutput.head)` → true. `renderComponent` returns
 *     `head: undefined` when empty (and `pageOutput.head` can be `""`);
 *     the falsy value is removed by `.filter(Boolean)` before the head
 *     is emitted, and the `templateHead` string it feeds into
 *     `resolveSeoTags` is only consumed via `.includes(...)` checks — an
 *     extra blank element can never flip an `includes()` result. Both
 *     were applied as mutations and the suite stayed green with
 *     byte-identical output.
 *
 * Out of scope: `renderPageStatic`, `renderFragmentRendered`,
 * `renderArchiveMarker` (per the issue — the remaining unlisted
 * mutants; separate coverage files own their slice of the source).
 *
 * Strategy: real filesystem templates so jiti loads them normally,
 * matching the mutation-649 / mutation-726 / mutation-811 pattern.
 * The renderer is a pure fn, so tests call `renderPageWithEsi`
 * directly and assert on the returned descriptor — no storage target
 * needed. Deterministic template output lets assertions pin exact
 * marker strings and file contents.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { renderPageWithEsi } from '../src/publish-renderers.js'
import { loadSite } from '../src/site-loader.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('publish-renderers-mutation-935-' + Date.now())
const sourceDir = join(testDir, 'source')
const templatesDir = join(testDir, 'templates')

const PAGE_CSS = '.mut935-page{background:blue}'
const PAGE_HEAD = '<meta name="mut935-page-head">'
const FULL_CSS = '.mut935-full{color:red}'
const FULL_JS = 'window.__mut935Full=1;'
const FULL_HEAD = '<meta name="mut935-full-head">'
const FULL_HTML = '<full>mut935</full>'
const BARE_HTML = '<bare>mut935</bare>'

async function writeTestFile(base: string, path: string, content: string) {
  const full = join(base, path)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, content)
}

async function loadTestSite() {
  return loadSite({
    siteDir: sourceDir,
    storage: createFilesystemProvider(),
    templatesDir,
    manifest: { name: '(mutation-935)' },
  })
}

function extractHead(html: string): string {
  const match = html.match(/<head>\n([\s\S]*?)\n<\/head>/)
  if (!match) throw new Error('rendered HTML has no <head> section')
  return match[1]
}

function extractBody(html: string): string {
  const match = html.match(/<body>\n([\s\S]*?)\n<\/body>/)
  if (!match) throw new Error('rendered HTML has no <body> section')
  return match[1]
}

beforeEach(async () => {
  await mkdir(sourceDir, { recursive: true })
  await mkdir(templatesDir, { recursive: true })

  // Page-level template contributing CSS + head (no JS — the ESI
  // renderer does not accumulate `pageOutput.js`).
  await mkdir(join(templatesDir, 'page-mut935'), { recursive: true })
  await writeFile(
    join(templatesDir, 'page-mut935/index.ts'),
    `import { z } from 'zod'
export const schema = z.object({})
export default () => ({
  html: '<main></main>',
  css: '${PAGE_CSS}',
  js: '',
  head: '${PAGE_HEAD}',
})
`,
  )

  // Page-level template with NO css/head — exercises the empty
  // page-level guards (`if (pageOutput.css)`, `if (pageOutput.head)`).
  await mkdir(join(templatesDir, 'page-plain-mut935'), { recursive: true })
  await writeFile(
    join(templatesDir, 'page-plain-mut935/index.ts'),
    `import { z } from 'zod'
export const schema = z.object({})
export default () => ({
  html: '<main></main>',
  css: '',
  js: '',
  head: '',
})
`,
  )

  // Inline component emitting all four channels.
  await mkdir(join(templatesDir, 'echo-full-mut935'), { recursive: true })
  await writeFile(
    join(templatesDir, 'echo-full-mut935/index.ts'),
    `import { z } from 'zod'
export const schema = z.object({})
export default () => ({
  html: '${FULL_HTML}',
  css: '${FULL_CSS}',
  js: '${FULL_JS}',
  head: '${FULL_HEAD}',
})
`,
  )

  // Inline component emitting html only — exercises the empty
  // accumulator guards (`if (rendered.css/js/head)`).
  await mkdir(join(templatesDir, 'echo-bare-mut935'), { recursive: true })
  await writeFile(
    join(templatesDir, 'echo-bare-mut935/index.ts'),
    `import { z } from 'zod'
export const schema = z.object({})
export default () => ({
  html: '${BARE_HTML}',
  css: '',
  js: '',
  head: '',
})
`,
  )

  // Fragment template — the fragment body is never rendered into the
  // ESI output (only its placeholder is), but resolvePage still loads
  // the manifest + template, so both must be valid.
  await mkdir(join(templatesDir, 'frag-tpl-mut935'), { recursive: true })
  await writeFile(
    join(templatesDir, 'frag-tpl-mut935/index.ts'),
    `import { z } from 'zod'
export const schema = z.object({})
export default () => ({ html: '<frag></frag>', css: '', js: '', head: '' })
`,
  )
  await writeTestFile(sourceDir, 'fragments/nav/fragment.json', JSON.stringify({ template: 'frag-tpl-mut935' }))
  await writeTestFile(sourceDir, 'fragments/footer/fragment.json', JSON.stringify({ template: 'frag-tpl-mut935' }))

  // Mixed page: fragment refs interleaved with inline components.
  await writeTestFile(
    sourceDir,
    'pages/mixed/page.json',
    JSON.stringify({
      template: 'page-mut935',
      components: [
        '@nav',
        { name: 'hero', template: 'echo-full-mut935' },
        { name: 'bare', template: 'echo-bare-mut935' },
        '@footer',
      ],
    }),
  )

  // Fragment-only page on the no-output page template.
  await writeTestFile(
    sourceDir,
    'pages/frag-only/page.json',
    JSON.stringify({ template: 'page-plain-mut935', components: ['@nav'] }),
  )

  // Inline-only page on the no-output page template (page CSS is empty).
  await writeTestFile(
    sourceDir,
    'pages/plain-page-css/page.json',
    JSON.stringify({ template: 'page-plain-mut935', components: [{ name: 'hero', template: 'echo-full-mut935' }] }),
  )
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('renderPageWithEsi — mixed @fragment + inline components', () => {
  it('emits byte-exact ESI head + body placeholders around inline component output', async () => {
    const site = await loadTestSite()
    const out = await renderPageWithEsi('mixed', { site })

    const head = extractHead(out.indexHtml)
    const body = extractBody(out.indexHtml)

    // Exact placeholder strings — any mutation to the marker template,
    // the `@`-slice, or the file name changes these bytes.
    expect(head).toContain('<!--esi-head:/fragments/nav/index.html-->')
    expect(head).toContain('<!--esi-head:/fragments/footer/index.html-->')
    expect(body).toContain('<!--esi:/fragments/nav/index.html-->')
    expect(body).toContain('<!--esi:/fragments/footer/index.html-->')

    // Exactly one placeholder of each kind per fragment — accumulator
    // sentinels or duplicated pushes would change the counts.
    expect(body.match(/<!--esi:/g)).toHaveLength(2)
    expect(head.match(/<!--esi-head:/g)).toHaveLength(2)

    // Body order follows `components`: @nav, hero, bare, @footer.
    const navAt = body.indexOf('<!--esi:/fragments/nav/index.html-->')
    const heroAt = body.indexOf(FULL_HTML)
    const bareAt = body.indexOf(BARE_HTML)
    const footerAt = body.indexOf('<!--esi:/fragments/footer/index.html-->')
    expect(navAt).toBeGreaterThan(-1)
    expect(heroAt).toBeGreaterThan(navAt)
    expect(bareAt).toBeGreaterThan(heroAt)
    expect(footerAt).toBeGreaterThan(bareAt)

    // Inline components are baked in (scoped); fragments are not.
    expect(body).not.toContain('<frag></frag>')
  })

  it('accumulates inline CSS/JS/head into hashed files and head tags', async () => {
    const site = await loadTestSite()
    const out = await renderPageWithEsi('mixed', { site })

    // Exactly two hashed files: page CSS + component JS.
    expect(out.files).toHaveLength(2)
    const css = out.files.find(f => f.path.endsWith('.css'))
    const js = out.files.find(f => f.path.endsWith('.js'))
    expect(css).toBeDefined()
    expect(js).toBeDefined()
    expect(css!.path).toMatch(/^pages\/mixed\/styles\.[a-f0-9]{8}\.css$/)
    expect(js!.path).toMatch(/^pages\/mixed\/script\.[a-f0-9]{8}\.js$/)

    // CSS = page-level first (unshift) then the full component's scoped
    // rule. The bare component contributes nothing: exactly 2 lines.
    // The always-push mutant (`if (rendered.css)` → true) appends an
    // empty entry, producing a third (blank) line.
    const cssLines = css!.content.split('\n')
    expect(cssLines).toHaveLength(2)
    expect(cssLines[0]).toBe(PAGE_CSS)
    expect(cssLines[1]).toMatch(/^\[data-gz="[a-f0-9]{8}"\] \.mut935-full\{color:red\}$/)
    expect(cssLines.every(line => line.length > 0)).toBe(true)

    // JS = the full component's JS only (pageOutput.js is discarded).
    // An always-push mutant appends a blank line.
    expect(js!.content).toBe(FULL_JS)

    const head = extractHead(out.indexHtml)
    // Page-level head first, then component head (unshift order).
    expect(head.indexOf(PAGE_HEAD)).toBeGreaterThan(-1)
    expect(head.indexOf(FULL_HEAD)).toBeGreaterThan(head.indexOf(PAGE_HEAD))
    // Head links point at the exact hashed files above.
    expect(head).toContain(`<link rel="stylesheet" href="/${css!.path}">`)
    expect(head).toContain(`<script type="module" src="/${js!.path}"></script>`)
    // The charset→viewport pair is joined with the exact `\n  `
    // delimiter (kills join-delimiter and dropped-join mutants).
    expect(head).toContain(
      '<meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    )
    // ESI head markers sit between the CSS link and the JS link.
    expect(head.indexOf('<link rel="stylesheet"')).toBeLessThan(head.indexOf('<!--esi-head:'))
    expect(head.indexOf('<!--esi-head:')).toBeLessThan(head.indexOf('<script type="module"'))
    // No blank lines anywhere in head (empty accumulator pushes inject
    // one via the joins).
    expect(head.split('\n').every(line => line.trim().length > 0)).toBe(true)

    // Cache comment: page → target → defaults; no cache config anywhere
    // means the documented defaults.
    expect(out.indexHtml.startsWith('<!--cache:browser=0,edge=86400-->\n')).toBe(true)
    expect(out.indexFile).toBe('index.html')
  })

  it('honors targetCache overrides in the cache comment', async () => {
    const site = await loadTestSite()
    const out = await renderPageWithEsi('mixed', { site, targetCache: { browser: 120, edge: 600 } })
    expect(out.indexHtml.startsWith('<!--cache:browser=120,edge=600-->\n')).toBe(true)
  })
})

describe('renderPageWithEsi — locale-suffixed fragment path', () => {
  it('uses index.<locale>.html for fragment placeholders and the index file', async () => {
    const site = await loadTestSite()
    const out = await renderPageWithEsi('frag-only', { site, locale: 'fr' })

    expect(out.indexFile).toBe('index.fr.html')
    expect(out.indexHtml).toContain('<!--esi-head:/fragments/nav/index.fr.html-->')
    expect(out.indexHtml).toContain('<!--esi:/fragments/nav/index.fr.html-->')
    // The default-locale variant must NOT appear — proves the locale
    // branch was taken.
    expect(out.indexHtml).not.toContain('/fragments/nav/index.html-->')
    // Locale also drives <html lang>.
    expect(out.indexHtml).toContain('<html lang="fr">')
  })
})

describe('renderPageWithEsi — empty-output boundary', () => {
  it('fragment-only page emits no hashed files and no bogus content', async () => {
    const site = await loadTestSite()
    const out = await renderPageWithEsi('frag-only', { site })

    // No CSS/JS emitted. An accumulator sentinel or always-push mutant
    // would force a hashed file into existence.
    expect(out.files).toHaveLength(0)

    const head = extractHead(out.indexHtml)
    const body = extractBody(out.indexHtml)

    // Body is exactly the single ESI placeholder — no accumulator
    // sentinel, no extra separators.
    expect(body).toBe('<!--esi:/fragments/nav/index.html-->')
    expect(body).not.toContain('Stryker was here')

    expect(head).toContain('<!--esi-head:/fragments/nav/index.html-->')
    // No hashed-file links when no files were emitted.
    expect(head).not.toContain('<link rel="stylesheet"')
    expect(head).not.toContain('<script type="module"')
    // Accumulator sentinels leak the literal mutant payload into head.
    expect(head).not.toContain('Stryker was here')
    // No blank lines — an always-push (or forced-truthy page-level
    // guard) mutant would insert one.
    expect(head.split('\n').every(line => line.trim().length > 0)).toBe(true)

    expect(out.indexFile).toBe('index.html')
  })

  it('page template without CSS does not prepend a blank CSS line', async () => {
    const site = await loadTestSite()
    const out = await renderPageWithEsi('plain-page-css', { site })

    const css = out.files.find(f => f.path.endsWith('.css'))
    expect(css).toBeDefined()
    // The page template contributed no CSS, so the file is exactly the
    // component's scoped rule — a forced-truthy `if (pageOutput.css)`
    // mutant unshifts "" and adds a leading blank line.
    expect(css!.content).toMatch(/^\[data-gz="[a-f0-9]{8}"\] \.mut935-full\{color:red\}$/)
    expect(css!.content.split('\n')).toHaveLength(1)
  })
})

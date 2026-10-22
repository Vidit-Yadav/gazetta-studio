/**
 * Property-based tests for publish renderers — Cut 2.
 *
 * Per testing-plan.md "Property-test scope expansion (next)":
 * renderer composition is a 30-line addition. PBT catches edge cases
 * AI's "safe middle" inputs miss — empty strings, Unicode in alias
 * targets, robots metadata edge cases, locale code variants.
 *
 * Scope intentionally narrow: archive-marker is pure + deterministic,
 * easiest to PBT. Page/fragment renderers depend on real templates
 * (loadSite); their PBT lands in Cut 5 against synthetic resolved
 * trees per testing-plan.md punch list.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { renderArchiveMarker } from '../src/publish-renderers.js'

const validAlias = fc.stringMatching(/^[A-Za-z0-9_-]{1,40}(?:\/[A-Za-z0-9_-]{1,40}){0,2}$/)

describe('renderArchiveMarker — properties', () => {
  it('always emits archived: true', () => {
    fc.assert(
      fc.property(
        fc.option(validAlias, { nil: undefined }),
        fc.option(fc.string({ minLength: 0, maxLength: 30 }), { nil: undefined }),
        (aliasOf, locale) => {
          const out = renderArchiveMarker({ aliasOf: aliasOf ?? undefined }, locale ?? undefined)
          expect(out.archived).toBe(true)
        },
      ),
    )
  })

  it('always emits zero hashed files (archive body is single line)', () => {
    fc.assert(
      fc.property(fc.option(validAlias, { nil: undefined }), aliasOf => {
        const out = renderArchiveMarker({ aliasOf: aliasOf ?? undefined })
        expect(out.files).toHaveLength(0)
      }),
    )
  })

  it('marker fits in first 200 bytes (worker contract)', () => {
    fc.assert(
      fc.property(fc.option(fc.stringMatching(/^[A-Za-z0-9_-]{1,168}$/), { nil: undefined }), aliasOf => {
        const out = renderArchiveMarker({ aliasOf: aliasOf ?? undefined })
        expect(out.indexHtml.length).toBeLessThanOrEqual(200)
      }),
    )
  })

  it('alias-form always contains "alias=" + the target', () => {
    fc.assert(
      fc.property(validAlias, aliasOf => {
        const out = renderArchiveMarker({ aliasOf })
        expect(out.indexHtml).toContain('alias=')
        expect(out.indexHtml).toContain(aliasOf)
      }),
    )
  })

  it('gone-form always contains "gone" when no aliasOf', () => {
    fc.assert(
      fc.property(fc.constantFrom(undefined, ''), aliasOf => {
        const out = renderArchiveMarker({ aliasOf: aliasOf || undefined })
        expect(out.indexHtml).toContain('gone')
      }),
    )
  })

  it('locale propagates to indexFile suffix verbatim (no normalization)', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{2}(-[a-z]{2})?$/), locale => {
        const out = renderArchiveMarker({ aliasOf: 'home' }, locale)
        expect(out.indexFile).toBe(`index.${locale}.html`)
      }),
    )
  })

  it('absent locale → unsuffixed index.html', () => {
    fc.assert(
      fc.property(fc.option(validAlias, { nil: undefined }), aliasOf => {
        const out = renderArchiveMarker({ aliasOf: aliasOf ?? undefined })
        expect(out.indexFile).toBe('index.html')
      }),
    )
  })
})

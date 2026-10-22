/**
 * Archive marker grammar tests per `design-soft-delete.md` Q10.
 *
 * Locked invariants:
 *   - Marker is single-line; first line of the file
 *   - Worker reads first 200 bytes; marker absence = live page
 *   - Round-trip: parse(emit(x)) === x
 *   - Bare-name target (worker resolves via deriveRoute)
 *   - No whitespace in target name
 *
 * The marker grammar is the worker's contract for archive behavior;
 * regression here = broken redirects in production. Tests pin every
 * branch.
 */
import { describe, it, expect } from 'vitest'
import { archiveMarker, parseArchiveMarker, type ArchiveMarker } from '../src/runtime/archive-marker.js'

describe('archiveMarker (emit)', () => {
  it('emits the alias marker with trailing newline', () => {
    const out = archiveMarker({ kind: 'alias', target: 'welcome' })
    expect(out).toBe('<!-- gazetta:archived alias=welcome -->\n')
  })

  it('emits the gone marker with trailing newline', () => {
    const out = archiveMarker({ kind: 'gone' })
    expect(out).toBe('<!-- gazetta:archived gone -->\n')
  })

  it('throws on empty alias target', () => {
    expect(() => archiveMarker({ kind: 'alias', target: '' })).toThrow(/Invalid archive alias target/)
  })

  it('throws on alias target containing whitespace', () => {
    expect(() => archiveMarker({ kind: 'alias', target: 'has space' })).toThrow(/Invalid archive alias target/)
    expect(() => archiveMarker({ kind: 'alias', target: 'has\ttab' })).toThrow(/Invalid archive alias target/)
    expect(() => archiveMarker({ kind: 'alias', target: 'has\nnewline' })).toThrow(/Invalid archive alias target/)
  })

  it('emits aliases with hyphens, slashes, and dots (real page names)', () => {
    expect(archiveMarker({ kind: 'alias', target: 'blog/2026/welcome' })).toBe(
      '<!-- gazetta:archived alias=blog/2026/welcome -->\n',
    )
    expect(archiveMarker({ kind: 'alias', target: 'old-page' })).toBe('<!-- gazetta:archived alias=old-page -->\n')
  })

  it('rejects absolute and protocol-relative targets', () => {
    expect(() => archiveMarker({ kind: 'alias', target: '/evil.example' })).toThrow(/relative/)
    expect(() => archiveMarker({ kind: 'alias', target: '//evil.example' })).toThrow(/relative/)
    expect(() => archiveMarker({ kind: 'alias', target: '\\evil.example' })).toThrow(/relative/)
    expect(() => archiveMarker({ kind: 'alias', target: 'docs\\page' })).toThrow(/relative/)
  })

  it('rejects query, fragment, and traversal segments', () => {
    expect(() => archiveMarker({ kind: 'alias', target: 'page?x=1' })).toThrow(/relative/)
    expect(() => archiveMarker({ kind: 'alias', target: 'page#top' })).toThrow(/relative/)
    expect(() => archiveMarker({ kind: 'alias', target: '../page' })).toThrow(/path segments/)
    expect(() => archiveMarker({ kind: 'alias', target: 'docs//page' })).toThrow(/path segments/)
  })

  it('keeps the emitted marker within the 200-byte inspection window', () => {
    const maxTarget = 'a'.repeat(168)
    expect(parseArchiveMarker(archiveMarker({ kind: 'alias', target: maxTarget }))).toEqual({
      kind: 'alias',
      target: maxTarget,
    })
    expect(() => archiveMarker({ kind: 'alias', target: 'a'.repeat(169) })).toThrow(/inspection window/)

    const unicodeTarget = 'é'.repeat(84)
    expect(parseArchiveMarker(archiveMarker({ kind: 'alias', target: unicodeTarget }))).toEqual({
      kind: 'alias',
      target: unicodeTarget,
    })
    expect(() => archiveMarker({ kind: 'alias', target: 'é'.repeat(85) })).toThrow(/inspection window/)
  })
})

describe('parseArchiveMarker', () => {
  it('parses an alias marker from a string', () => {
    const result = parseArchiveMarker('<!-- gazetta:archived alias=welcome -->\n<!doctype html>...')
    expect(result).toEqual({ kind: 'alias', target: 'welcome' })
  })

  it('parses a gone marker from a string', () => {
    const result = parseArchiveMarker('<!-- gazetta:archived gone -->\n<!doctype html>...')
    expect(result).toEqual({ kind: 'gone' })
  })

  it('returns null when no marker is present (live page)', () => {
    expect(parseArchiveMarker('<!doctype html><html><head></head></html>')).toBeNull()
  })

  it('returns null when the marker is not at byte 0 (mid-file)', () => {
    // Locked grammar: marker MUST be first line. Mid-file markers are
    // ignored (worker reads first 200 bytes only).
    const input = '<!doctype html><html><!-- gazetta:archived alias=welcome --></html>'
    expect(parseArchiveMarker(input)).toBeNull()
  })

  it('returns null on a malformed marker (missing closing -->)', () => {
    expect(parseArchiveMarker('<!-- gazetta:archived alias=welcome \n<!doctype html>')).toBeNull()
  })

  it('returns null on an unknown kind', () => {
    expect(parseArchiveMarker('<!-- gazetta:archived neither -->\n')).toBeNull()
  })

  it('returns null on alias= with empty target', () => {
    // Regex requires \S+ for the target, which forbids empty
    expect(parseArchiveMarker('<!-- gazetta:archived alias= -->\n')).toBeNull()
  })

  it('parses aliases with hyphens, slashes, and dots', () => {
    expect(parseArchiveMarker('<!-- gazetta:archived alias=blog/2026/welcome -->\n')).toEqual({
      kind: 'alias',
      target: 'blog/2026/welcome',
    })
    expect(parseArchiveMarker('<!-- gazetta:archived alias=old-page -->\n')).toEqual({
      kind: 'alias',
      target: 'old-page',
    })
  })

  it('parses from a Uint8Array (worker reading from storage)', () => {
    const bytes = new TextEncoder().encode('<!-- gazetta:archived alias=welcome -->\n<!doctype html>')
    expect(parseArchiveMarker(bytes)).toEqual({ kind: 'alias', target: 'welcome' })
  })

  it('parses gone from a Uint8Array', () => {
    const bytes = new TextEncoder().encode('<!-- gazetta:archived gone -->\n')
    expect(parseArchiveMarker(bytes)).toEqual({ kind: 'gone' })
  })

  it('reads only the first 200 bytes (workers do bounded range reads)', () => {
    // A marker beyond byte 200 is invisible by design �?" worker fetches
    // a 200-byte range to keep the per-request cost cheap. Filler
    // pushes the marker past the budget.
    const filler = '<!doctype html>'.repeat(20) // ~300 bytes
    const input = filler + '<!-- gazetta:archived alias=welcome -->'
    expect(parseArchiveMarker(input)).toBeNull()
  })

  it('measures the 200-byte window in bytes, not UTF-16 code units', () => {
    const filler = 'é'.repeat(150) // 300 bytes, 150 code units
    const input = filler + '<!-- gazetta:archived alias=welcome -->'
    expect(parseArchiveMarker(input)).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(parseArchiveMarker('')).toBeNull()
    expect(parseArchiveMarker(new Uint8Array(0))).toBeNull()
  })

  it('returns null when only the marker prefix is present (incomplete)', () => {
    expect(parseArchiveMarker('<!-- gazetta:')).toBeNull()
    expect(parseArchiveMarker('<!-- gazetta:archived ')).toBeNull()
  })
})

describe('round-trip (emit → parse)', () => {
  it.each<ArchiveMarker>([
    { kind: 'gone' },
    { kind: 'alias', target: 'welcome' },
    { kind: 'alias', target: 'blog/2026/welcome' },
    { kind: 'alias', target: 'a' }, // single-char target
    { kind: 'alias', target: 'old-page' },
  ])('round-trips %j', marker => {
    const emitted = archiveMarker(marker)
    expect(parseArchiveMarker(emitted)).toEqual(marker)
  })

  it('round-trips through Uint8Array (worker storage read path)', () => {
    const marker: ArchiveMarker = { kind: 'alias', target: 'welcome' }
    const emitted = archiveMarker(marker)
    const bytes = new TextEncoder().encode(emitted)
    expect(parseArchiveMarker(bytes)).toEqual(marker)
  })
})

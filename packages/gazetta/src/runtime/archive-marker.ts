/**
 * Archive marker grammar + parser for static + dynamic targets per
 * design-soft-delete.md Q10 lock.
 *
 * Static (and dynamic) targets emit HTML with the marker as the first
 * line of the file:
 *
 *   <!-- gazetta:archived alias=welcome -->
 *   <!-- gazetta:archived gone -->
 *
 * Worker reads the first ~200 bytes of `pages/{name}/index.html`,
 * parses the marker, and decides:
 *
 *   - alias=X    → 301 redirect to deriveRoute(X)
 *   - gone       → 410 Gone
 *   - no marker  → serve the HTML as-is (live page)
 *
 * Constraints (locked):
 *   - Marker MUST be the first line (worker reads only the prefix)
 *   - Single-line; no nested HTML; no whitespace games
 *   - `<bare-name>` is a name (page or fragment), not a route — the
 *     worker calls `deriveRoute()` to resolve to a URL when needed
 *
 * SRP: this module is the marker grammar. Emit + parse round-trip.
 * Publish-rendered.ts emits via `archiveMarker()`; workers parse via
 * `parseArchiveMarker()`. Workers never emit; publish never parses.
 */

/** Result of parsing the marker — null when no marker is present. */
export type ArchiveMarker = { kind: 'alias'; target: string } | { kind: 'gone' }

/** Number of leading bytes to inspect for a marker. */
const MARKER_PREFIX_BYTES = 200

/** Regex anchors at start of input; closed-form grammar. */
const MARKER_RE = /^<!-- gazetta:archived (alias=([\S]+)|gone) -->/

export type AliasTargetIssue = 'whitespace' | 'relative' | 'segments'

export function aliasTargetIssue(target: string): AliasTargetIssue | null {
  if (!target || /\s/.test(target)) return 'whitespace'
  if (target.startsWith('/') || target.includes('\\') || /[?#]/.test(target)) return 'relative'
  if (target.split('/').some(part => part === '' || part === '.' || part === '..')) return 'segments'
  return null
}

/**
 * Emit a marker line for a page/fragment that's archived. Returns the
 * full marker line including trailing newline so callers concatenate
 * it directly with the rendered HTML.
 *
 * For aliased archives: `archiveMarker({ kind: 'alias', target: 'welcome' })`
 * For pure soft-delete: `archiveMarker({ kind: 'gone' })`
 *
 * Validates the alias target is non-empty, contains no whitespace,
 * is a relative item name (not an absolute or protocol-relative path),
 * and keeps the marker within the 200-byte inspection window. Throws
 * on bad input rather than silently emitting an unparseable marker.
 */
export function archiveMarker(marker: ArchiveMarker): string {
  if (marker.kind === 'alias') {
    const target = marker.target
    const issue = aliasTargetIssue(target)
    if (issue === 'whitespace') {
      throw new Error(
        `Invalid archive alias target ${JSON.stringify(target)} — must be a non-empty string with no whitespace.`,
      )
    }
    if (issue === 'relative') {
      throw new Error(
        `Invalid archive alias target ${JSON.stringify(target)} — must be a relative page or fragment name.`,
      )
    }
    if (issue === 'segments') {
      throw new Error(
        `Invalid archive alias target ${JSON.stringify(target)} — must not contain empty, "." or ".." path segments.`,
      )
    }
    const line = `<!-- gazetta:archived alias=${target} -->`
    if (new TextEncoder().encode(line).byteLength > MARKER_PREFIX_BYTES) {
      throw new Error(
        `Invalid archive alias target ${JSON.stringify(target)} — marker exceeds the ${MARKER_PREFIX_BYTES}-byte inspection window.`,
      )
    }
    return `${line}\n`
  }
  return '<!-- gazetta:archived gone -->\n'
}

/**
 * Parse an archive marker from the leading bytes of an HTML file.
 *
 * Accepts either a `Uint8Array` (worker reading bytes from storage)
 * or a `string` (testing convenience).
 *
 * Returns the parsed marker, or null when no marker is present (the
 * normal case — live pages don't carry markers).
 *
 * Reads only the first MARKER_PREFIX_BYTES bytes; longer input is
 * truncated. The marker MUST be at byte 0; markers in the middle of
 * a file are not detected (per the locked grammar — first-line only).
 */
export function parseArchiveMarker(input: Uint8Array | string): ArchiveMarker | null {
  const prefix = decodePrefix(
    typeof input === 'string' ? new TextEncoder().encode(input.slice(0, MARKER_PREFIX_BYTES)) : input,
  )
  const match = MARKER_RE.exec(prefix)
  if (!match) return null
  if (match[1] === 'gone') return { kind: 'gone' }
  // match[1] starts with 'alias=', match[2] is the bare target name
  const target = match[2]
  if (!target) return null
  return { kind: 'alias', target }
}

/**
 * Decode the first MARKER_PREFIX_BYTES bytes as UTF-8. Bounded read;
 * the worker may pass a longer Uint8Array, we slice. Returns the
 * decoded string (or as much of it as fits in the prefix budget).
 */
function decodePrefix(bytes: Uint8Array): string {
  const slice = bytes.byteLength > MARKER_PREFIX_BYTES ? bytes.subarray(0, MARKER_PREFIX_BYTES) : bytes
  return new TextDecoder('utf-8', { fatal: false }).decode(slice)
}

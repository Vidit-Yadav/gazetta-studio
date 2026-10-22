/**
 * Translate a published archive marker into an HTTP response.
 *
 * Runtime-neutral: both `serve.ts` (Node/Bun) and the Cloudflare R2 worker
 * call this immediately after loading a page, before ESI composition.
 *
 *   alias=X → 301 redirect to deriveRoute(X)
 *   gone    → 410 Gone
 *   no marker → null (the page is live; caller continues normally)
 *
 * Archive responses use a short cache window so a re-published alias/gone
 * state propagates quickly (design-soft-delete.md Q10).
 */
import { parseArchiveMarker } from './archive-marker.js'
import { deriveRoute } from './derive-route.js'

export const ARCHIVE_CACHE_CONTROL = 'max-age=300'

export function archiveGoneResponse(): Response {
  return new Response(null, { status: 410, headers: { 'Cache-Control': ARCHIVE_CACHE_CONTROL } })
}

export function archiveResponse(input: Uint8Array | string): Response | null {
  const marker = parseArchiveMarker(input)
  if (!marker) return null

  if (marker.kind === 'gone') return archiveGoneResponse()

  const location = deriveRoute(marker.target)
  if (!location.startsWith('/') || location.startsWith('//') || location.includes('\\')) {
    return archiveGoneResponse()
  }

  try {
    const headers: Record<string, string> = {
      'Cache-Control': ARCHIVE_CACHE_CONTROL,
      Location: encodeURI(location).replace(/#/g, '%23').replace(/\?/g, '%3F'),
    }
    return new Response(null, { status: 301, headers })
  } catch {
    return archiveGoneResponse()
  }
}

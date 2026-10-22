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

const ARCHIVE_CACHE_CONTROL = 'max-age=300'

export function archiveResponse(input: Uint8Array | string): Response | null {
  const marker = parseArchiveMarker(input)
  if (!marker) return null

  const headers: Record<string, string> = { 'Cache-Control': ARCHIVE_CACHE_CONTROL }
  if (marker.kind === 'alias') {
    headers.Location = deriveRoute(marker.target)
    return new Response(null, { status: 301, headers })
  }
  return new Response(null, { status: 410, headers })
}

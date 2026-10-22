/**
 * Derive a public route from a page folder name. Runtime-neutral — shared
 * by the Node server, the Cloudflare worker, and publish tooling.
 *
 *   home        → /
 *   about       → /about
 *   blog/[slug] → /blog/:slug
 */
export function deriveRoute(pageName: string): string {
  if (pageName === 'home') return '/'
  return '/' + pageName.replace(/\[([^\]]+)\]/g, ':$1')
}

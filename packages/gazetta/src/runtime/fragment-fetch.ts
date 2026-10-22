import { findEsiPaths, splitFragment } from '../assemble.js'
import { aliasTargetIssue, parseArchiveMarker } from './archive-marker.js'

export interface FragmentParts {
  head: string
  body: string
}

export type FragmentReader = (path: string) => Promise<string | null>

const MAX_FRAGMENT_ALIAS_HOPS = 5

export function fragmentName(path: string): string {
  return path.replace(/^\/?fragments\//, '').replace(/\/index(?:\.[a-z-]+)?\.html$/, '')
}

export function aliasFragmentPath(path: string, target: string): string | null {
  if (aliasTargetIssue(target) !== null) return null
  const indexFile = path.slice(path.lastIndexOf('/') + 1)
  return `/fragments/${target}/${indexFile}`
}

function archivedFragment(path: string): [string, FragmentParts] {
  return [path, { head: '', body: `<!-- fragment archived: @${fragmentName(path)} -->` }]
}

export async function fetchFragment(read: FragmentReader, path: string): Promise<[string, FragmentParts]> {
  const visited = new Set<string>()
  let currentPath = path

  for (let hop = 0; hop <= MAX_FRAGMENT_ALIAS_HOPS; hop++) {
    if (visited.has(currentPath)) return archivedFragment(path)
    visited.add(currentPath)

    const html = await read(currentPath)
    if (html === null) {
      return currentPath === path
        ? [path, { head: '', body: `<!-- fragment not found: ${path} -->` }]
        : archivedFragment(path)
    }

    const marker = parseArchiveMarker(html)
    if (!marker) return [path, splitFragment(html)]
    if (marker.kind === 'gone') return archivedFragment(path)

    const nextPath = aliasFragmentPath(currentPath, marker.target)
    if (!nextPath) return archivedFragment(path)
    currentPath = nextPath
  }

  return archivedFragment(path)
}

export async function fetchFragmentEntries(read: FragmentReader, html: string): Promise<Map<string, FragmentParts>> {
  return new Map(await Promise.all(findEsiPaths(html).map(path => fetchFragment(read, path))))
}

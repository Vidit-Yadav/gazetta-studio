import { describe, expect, it } from 'vitest'
import { archiveMarker } from '../src/runtime/archive-marker.js'
import { fetchFragment, fetchFragmentEntries } from '../src/runtime/fragment-fetch.js'

function reader(files: Record<string, string>) {
  return async (path: string) => files[path] ?? null
}

describe('fetchFragment', () => {
  it('splits a live fragment', async () => {
    const [path, parts] = await fetchFragment(
      reader({ '/fragments/header/index.html': '<head><style></style></head><body>Header</body>' }),
      '/fragments/header/index.html',
    )

    expect(path).toBe('/fragments/header/index.html')
    expect(parts.head).toBe('<style></style>')
    expect(parts.body).toContain('Header')
  })

  it('follows an archived fragment alias', async () => {
    const [path, parts] = await fetchFragment(
      reader({
        '/fragments/old-header/index.html': archiveMarker({ kind: 'alias', target: 'header' }),
        '/fragments/header/index.html': '<body>Header</body>',
      }),
      '/fragments/old-header/index.html',
    )

    expect(path).toBe('/fragments/old-header/index.html')
    expect(parts.body).toContain('Header')
  })

  it('omits a fragment archived without an alias', async () => {
    const [, parts] = await fetchFragment(
      reader({ '/fragments/promo/index.html': archiveMarker({ kind: 'gone' }) }),
      '/fragments/promo/index.html',
    )

    expect(parts.body).toBe('<!-- fragment archived: @promo -->')
  })

  it('omits a fragment whose alias target is missing', async () => {
    const [, parts] = await fetchFragment(
      reader({ '/fragments/promo/index.html': archiveMarker({ kind: 'alias', target: 'missing' }) }),
      '/fragments/promo/index.html',
    )

    expect(parts.body).toBe('<!-- fragment archived: @promo -->')
  })

  it('keeps the existing not-found placeholder for a missing fragment', async () => {
    const [, parts] = await fetchFragment(reader({}), '/fragments/missing/index.html')

    expect(parts.body).toBe('<!-- fragment not found: /fragments/missing/index.html -->')
  })

  it('omits a fragment with a circular alias chain', async () => {
    const [, parts] = await fetchFragment(
      reader({
        '/fragments/a/index.html': archiveMarker({ kind: 'alias', target: 'b' }),
        '/fragments/b/index.html': archiveMarker({ kind: 'alias', target: 'a' }),
      }),
      '/fragments/a/index.html',
    )

    expect(parts.body).toBe('<!-- fragment archived: @a -->')
  })
})

describe('fetchFragmentEntries', () => {
  it('returns entries keyed by the referenced ESI path', async () => {
    const entries = await fetchFragmentEntries(
      reader({
        '/fragments/header/index.html': '<body>Header</body>',
        '/fragments/footer/index.html': '<body>Footer</body>',
      }),
      '<body><!--esi-head:/fragments/header/index.html--><!--esi:/fragments/footer/index.html--></body>',
    )

    expect([...entries.keys()]).toEqual(['/fragments/header/index.html', '/fragments/footer/index.html'])
    expect(entries.get('/fragments/footer/index.html')?.body).toContain('Footer')
  })
})

import { describe, it, expect } from 'vitest'
import { archiveMarker } from '../src/runtime/archive-marker.js'
import { archiveResponse } from '../src/runtime/archive-response.js'

const SAFE_MARKER = (target: string) => `<!-- gazetta:archived alias=${target} -->\n`

describe('archiveResponse', () => {
  it('returns null for a live page', () => {
    expect(archiveResponse('<!doctype html><html></html>')).toBeNull()
  })

  it('returns a 301 with cache control for an alias', () => {
    const res = archiveResponse(archiveMarker({ kind: 'alias', target: 'welcome' }))!
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/welcome')
    expect(res.headers.get('cache-control')).toBe('max-age=300')
  })

  it('percent-encodes non-Latin-1 targets in Location', () => {
    const res = archiveResponse(archiveMarker({ kind: 'alias', target: 'café' }))!
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/caf%C3%A9')
  })

  it('returns 410 for a gone marker', () => {
    const res = archiveResponse(archiveMarker({ kind: 'gone' }))!
    expect(res.status).toBe(410)
    expect(res.headers.get('cache-control')).toBe('max-age=300')
  })

  it.each([
    '/evil.example',
    '//evil.example',
    '\\evil.example',
    'docs\\page',
  ])('fails closed for an unsafe alias target %j', target => {
    const res = archiveResponse(SAFE_MARKER(target))!
    expect(res.status).toBe(410)
    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('cache-control')).toBe('max-age=300')
  })

  it('encodes malformed UTF-16 instead of throwing', () => {
    const res = archiveResponse(SAFE_MARKER('\uD800'))!
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/%EF%BF%BD')
  })
})

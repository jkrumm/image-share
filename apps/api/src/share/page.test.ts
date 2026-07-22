import { describe, expect, it } from 'bun:test'
import type { ImageRow, ShareRow } from '../db/schema.js'
import { render404Page, renderSharePage } from './page.js'

function makeShare(overrides: Partial<ShareRow> = {}): ShareRow {
  return {
    id: 1,
    slug: 'mallorca-2026',
    title: 'Mallorca 2026',
    sourceType: 'folder',
    root: 'fuji',
    dir: 'mallorca-2026',
    minRating: null,
    expiresAt: null,
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeImage(overrides: Partial<ImageRow> = {}): ImageRow {
  return {
    id: 10,
    root: 'fuji',
    relPath: 'mallorca-2026/DSCF0001.JPG',
    dir: 'mallorca-2026',
    stem: 'DSCF0001',
    ext: 'jpg',
    kind: 'jpeg',
    fileSize: 1234,
    mtimeMs: 1000,
    captureAt: '2026-06-01T10:00:00.000Z',
    orientation: 1,
    rating: 5,
    width: 4000,
    height: 3000,
    rawPath: null,
    indexedAt: '2026-06-02T00:00:00.000Z',
    ...overrides,
  }
}

describe('renderSharePage', () => {
  it('threads the token into every asset URL and uses share.title', () => {
    const html = renderSharePage({
      share: makeShare({ title: 'Mallorca trip' }),
      images: [makeImage()],
      token: 'tok-abc123',
      role: 'download',
    })
    expect(html).toContain('/s/mallorca-2026/img/10?size=thumb&amp;token=tok-abc123')
    expect(html).toContain('/s/mallorca-2026/img/10?size=med&amp;token=tok-abc123')
    expect(html).toContain('/s/mallorca-2026/zip?token=tok-abc123')
    expect(html).toContain('Mallorca trip')
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('<dialog id="lb">')
  })

  it('renders the note as plain text below the heading', () => {
    const html = renderSharePage({
      share: makeShare({ note: 'Shot on the Fuji, week of June 1st.' }),
      images: [makeImage()],
      token: 't',
      role: 'view',
    })
    expect(html).toContain('Shot on the Fuji, week of June 1st.')
  })

  it('view role: no download/zip affordances, no full size, no RAW', () => {
    const html = renderSharePage({
      share: makeShare(),
      images: [makeImage()],
      token: 't',
      role: 'view',
    })
    expect(html).toContain('"full":false')
    expect(html).toContain('"download":false')
    expect(html).not.toContain('Download all')
    expect(html).not.toContain('id="lbdl"')
    expect(html).not.toContain('id="lbraw"')
  })

  it('download role: download + zip shown, full size available, no RAW', () => {
    const html = renderSharePage({
      share: makeShare(),
      images: [makeImage()],
      token: 't',
      role: 'download',
    })
    expect(html).toContain('"full":true')
    expect(html).toContain('"download":true')
    expect(html).toContain('Download all')
    expect(html).toContain('id="lbdl"')
    expect(html).not.toContain('id="lbraw"')
  })

  it('full role: RAW link also shown', () => {
    const html = renderSharePage({
      share: makeShare(),
      images: [makeImage({ rawPath: 'DSCF0001.RAF' })],
      token: 't',
      role: 'full',
    })
    expect(html).toContain('id="lbraw"')
  })

  it('HTML-escapes malicious filenames in both attribute and JSON contexts', () => {
    const evil = 'mallorca-2026/"><img src=x onerror=alert(1)>.jpg'
    const html = renderSharePage({
      share: makeShare(),
      images: [makeImage({ relPath: evil, stem: '"><img src=x onerror=alert(1)>' })],
      token: 't',
      role: 'full',
    })
    // No breakout: the injected tag must never appear unescaped.
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('"><img')
    // Attribute context is entity-escaped; JSON/script context escapes `<`
    // (the only char that can open a `</script>` breakout — `>` is harmless).
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('\\u003cimg src=x onerror=alert(1)>')
  })

  it('renders an empty-state without a download button when there are no images', () => {
    const html = renderSharePage({ share: makeShare(), images: [], token: 't', role: 'full' })
    expect(html).toContain('No photos in this share yet.')
    expect(html).not.toContain('Download all')
  })
})

describe('render404Page', () => {
  it('is deterministic and reveals nothing about the share', () => {
    expect(render404Page()).toBe(render404Page())
    expect(render404Page()).toContain('does not exist or has been revoked')
  })
})

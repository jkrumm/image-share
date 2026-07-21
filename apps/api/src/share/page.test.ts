import { describe, expect, it } from 'bun:test'
import type { ImageRow, ShareRow } from '../db/schema.js'
import { render404Page, renderSharePage, renderUnlockPage } from './page.js'

function makeShare(overrides: Partial<ShareRow> = {}): ShareRow {
  return {
    id: 1,
    slug: 'mallorca-2026',
    root: 'library',
    dir: 'mallorca-2026',
    minRating: null,
    sizeLimit: 'medium',
    includeRaws: 0,
    passwordHash: null,
    expiresAt: null,
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeImage(overrides: Partial<ImageRow> = {}): ImageRow {
  return {
    id: 10,
    root: 'library',
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
  it('threads the token into every asset URL', () => {
    const html = renderSharePage({
      share: makeShare(),
      images: [makeImage()],
      token: 'tok-abc123',
      k: '',
    })
    // Grid thumb + srcset med and the zip button all carry the token. `&` is
    // entity-escaped to `&amp;` in HTML attribute context (browsers decode it).
    expect(html).toContain('/s/mallorca-2026/img/10?size=thumb&amp;token=tok-abc123')
    expect(html).toContain('/s/mallorca-2026/img/10?size=med&amp;token=tok-abc123')
    expect(html).toContain('/s/mallorca-2026/zip?token=tok-abc123')
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('<dialog id="lb">')
  })

  it('threads k into URLs for password shares and keeps JS auth in sync', () => {
    const html = renderSharePage({
      share: makeShare({ passwordHash: 'x' }),
      images: [makeImage()],
      token: 'tok-abc123',
      k: 'deadbeefcafebabe',
    })
    expect(html).toContain('token=tok-abc123&amp;k=deadbeefcafebabe')
    // The embedded lightbox config also carries token + k.
    expect(html).toContain('"token":"tok-abc123"')
    expect(html).toContain('"k":"deadbeefcafebabe"')
  })

  it('exposes full-size + RAW links only when the share permits them', () => {
    const medium = renderSharePage({
      share: makeShare({ sizeLimit: 'medium', includeRaws: 0 }),
      images: [makeImage()],
      token: 't',
      k: '',
    })
    expect(medium).toContain('"full":false')
    expect(medium).not.toContain('id="lbraw"')

    const full = renderSharePage({
      share: makeShare({ sizeLimit: 'full', includeRaws: 1 }),
      images: [makeImage({ rawPath: 'DSCF0001.RAF' })],
      token: 't',
      k: '',
    })
    expect(full).toContain('"full":true')
    expect(full).toContain('id="lbraw"')
  })

  it('HTML-escapes malicious filenames in both attribute and JSON contexts', () => {
    const evil = 'mallorca-2026/"><img src=x onerror=alert(1)>.jpg'
    const html = renderSharePage({
      share: makeShare(),
      images: [makeImage({ relPath: evil, stem: '"><img src=x onerror=alert(1)>' })],
      token: 't',
      k: '',
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
    const html = renderSharePage({ share: makeShare(), images: [], token: 't', k: '' })
    expect(html).toContain('No photos in this share yet.')
    expect(html).not.toContain('Download all')
  })
})

describe('renderUnlockPage', () => {
  it('posts the password to the unlock endpoint with the token in the query', () => {
    const html = renderUnlockPage({ slug: 'mallorca-2026', token: 'tok-abc123' })
    expect(html).toContain('action="/s/mallorca-2026/unlock?token=tok-abc123"')
    expect(html).toContain('type="password"')
    expect(html).not.toContain('Incorrect password')
  })

  it('shows the error message on a failed attempt', () => {
    const html = renderUnlockPage({ slug: 'x', token: 't', error: true })
    expect(html).toContain('Incorrect password')
  })
})

describe('render404Page', () => {
  it('is deterministic and reveals nothing about the share', () => {
    expect(render404Page()).toBe(render404Page())
    expect(render404Page()).toContain('does not exist or has been revoked')
  })
})

import { describe, expect, it } from 'bun:test'
import type { ImageRow, ShareRow } from '../db/schema.js'
import { LOCALES } from './page/i18n.js'
import { render404Page, renderLandingPage, renderSharePage } from './page/index.js'

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
      locale: 'en',
    })
    expect(html).toContain('/s/mallorca-2026/img/10?size=thumb&amp;token=tok-abc123')
    expect(html).toContain('/s/mallorca-2026/img/10?size=med&amp;token=tok-abc123')
    expect(html).toContain('/s/mallorca-2026/zip?token=tok-abc123')
    expect(html).toContain('Mallorca trip')
    expect(html).toContain('<dialog id="lb">')
  })

  it('renders the note as markdown below the heading', () => {
    const html = renderSharePage({
      share: makeShare({ note: 'Shot on the **Fuji**, week of June 1st.' }),
      images: [makeImage()],
      token: 't',
      role: 'view',
      locale: 'en',
    })
    expect(html).toContain(
      '<div class="note"><p>Shot on the <strong>Fuji</strong>, week of June 1st.</p></div>',
    )
  })

  it('the first image is eager/high-priority, later ones lazy', () => {
    const html = renderSharePage({
      share: makeShare(),
      images: [makeImage({ id: 1 }), makeImage({ id: 2 })],
      token: 't',
      role: 'view',
      locale: 'en',
    })
    expect(html).toContain('loading="eager" fetchpriority="high"')
    expect(html).toContain('loading="lazy" decoding="async"')
  })

  it('view role: no download/zip affordances, no full size, no RAW', () => {
    const html = renderSharePage({
      share: makeShare(),
      images: [makeImage()],
      token: 't',
      role: 'view',
      locale: 'en',
    })
    expect(html).toContain('"full":false')
    expect(html).toContain('"download":false')
    // Note: the localized string catalogue (client-side language switching)
    // is always embedded — gating is whether the element itself is rendered.
    expect(html).not.toContain('data-i18n="downloadAll"')
    expect(html).not.toContain('id="lbdl"')
    expect(html).not.toContain('id="lbraw"')
  })

  it('download role: download + zip shown, full size available, no RAW', () => {
    const html = renderSharePage({
      share: makeShare(),
      images: [makeImage()],
      token: 't',
      role: 'download',
      locale: 'en',
    })
    expect(html).toContain('"full":true')
    expect(html).toContain('"download":true')
    expect(html).toContain('data-i18n="downloadAll"')
    expect(html).toContain('id="lbdl"')
    expect(html).not.toContain('id="lbraw"')
  })

  it('full role: RAW link also shown', () => {
    const html = renderSharePage({
      share: makeShare(),
      images: [makeImage({ rawPath: 'DSCF0001.RAF' })],
      token: 't',
      role: 'full',
      locale: 'en',
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
      locale: 'en',
    })
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('"><img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('\\u003cimg src=x onerror=alert(1)>')
  })

  it('renders an empty-state without a download button when there are no images', () => {
    const html = renderSharePage({
      share: makeShare(),
      images: [],
      token: 't',
      role: 'full',
      locale: 'en',
    })
    expect(html).toContain('No photos in this share yet.')
    expect(html).not.toContain('data-i18n="downloadAll"')
  })

  it('all three views are present in the emitted CSS/markup', () => {
    const html = renderSharePage({
      share: makeShare(),
      images: [makeImage()],
      token: 't',
      role: 'view',
      locale: 'en',
    })
    expect(html).toContain("[data-view='stream']")
    expect(html).toContain("[data-view='bento']")
    expect(html).toContain("[data-view='grid']")
    expect(html).toContain('data-value="stream"')
    expect(html).toContain('data-value="bento"')
    expect(html).toContain('data-value="grid"')
  })

  it('all three locale catalogues are embedded for client-side switching', () => {
    const html = renderSharePage({
      share: makeShare(),
      images: [makeImage()],
      token: 't',
      role: 'view',
      locale: 'en',
    })
    for (const locale of LOCALES) {
      expect(html).toContain(`"${locale}":{`)
    }
  })

  it('renders the localized title/body for each locale', () => {
    for (const locale of LOCALES) {
      const html = renderSharePage({
        share: makeShare(),
        images: [makeImage()],
        token: 't',
        role: 'view',
        locale,
      })
      expect(html).toContain(`<html lang="${locale}"`)
    }
  })
})

describe('renderLandingPage', () => {
  it('is byte-identical across calls and carries no share data', () => {
    const a = renderLandingPage()
    const b = renderLandingPage()
    expect(a).toBe(b)
    expect(a).not.toMatch(/\/s\/[a-z0-9-]+/)
  })

  it('renders the empty/redirect/list containers for client-side population', () => {
    const html = renderLandingPage()
    expect(html).toContain('id="landing-empty"')
    expect(html).toContain('id="landing-redirect"')
    expect(html).toContain('id="landing-section"')
    expect(html).toContain('id="landing-list"')
  })
})

describe('render404Page', () => {
  it('is deterministic per locale and reveals nothing about the share', () => {
    expect(render404Page()).toBe(render404Page())
    expect(render404Page()).toContain('does not exist or has been revoked')
  })

  it('renders every supported locale', () => {
    expect(render404Page('de')).toContain('existiert nicht')
    expect(render404Page('es')).toContain('no existe')
  })
})

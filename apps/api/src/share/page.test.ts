import { describe, expect, it } from 'bun:test'
import type { ShareRow } from '../db/schema.js'
import type { ShareListImage } from '../lib/share-auth.js'
import { LOCALES, formatBytes } from './page/i18n.js'
import { baseCss, controlsCss } from './page/styles.js'
import {
  render404Page,
  renderLandingPage,
  renderSharePage,
  renderShareTiles,
  SHARE_PAGE_SIZE,
  type SharePageInput,
  type SharePageSummary,
} from './page/index.js'

function makeShare(overrides: Partial<ShareRow> = {}): ShareRow {
  return {
    id: 1,
    slug: 'mallorca-2026',
    title: 'Mallorca 2026',
    sourceType: 'folder',
    root: 'fuji',
    dir: 'mallorca-2026',
    album: null,
    recursive: true,
    minRating: null,
    expiresAt: null,
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeImage(overrides: Partial<ShareListImage> = {}): ShareListImage {
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
    rawFileSize: null,
    indexedAt: '2026-06-02T00:00:00.000Z',
    keywordsIndexedAt: '2026-06-02T00:00:00.000Z',
    ...overrides,
  }
}

function makeSummary(over: Partial<SharePageSummary> = {}): SharePageSummary {
  return {
    total: 1,
    firstCaptureAt: '2026-06-01T10:00:00.000Z',
    lastCaptureAt: '2026-06-01T10:00:00.000Z',
    zipBytes: 1234,
    ...over,
  }
}

/** Page input with sensible defaults so each test states only what it varies. */
function pageInput(over: Partial<SharePageInput> = {}): SharePageInput {
  const images = over.images ?? [makeImage()]
  return {
    share: makeShare(),
    images,
    from: 0,
    summary: makeSummary({ total: images.length }),
    token: 't',
    role: 'view',
    locale: 'en',
    ...over,
  }
}

describe('renderSharePage', () => {
  it('threads the token into every asset URL and uses share.title', () => {
    const html = renderSharePage(
      pageInput({ share: makeShare({ title: 'Mallorca trip' }), role: 'download' }),
    )
    expect(html).toContain('/s/mallorca-2026/img/10?size=thumb&amp;token=t')
    expect(html).toContain('/s/mallorca-2026/img/10?size=med&amp;token=t')
    expect(html).toContain('/s/mallorca-2026/zip?token=t')
    expect(html).toContain('Mallorca trip')
    expect(html).toContain('<dialog id="lb">')
  })

  it('the lightbox carries a hidden error message for a failed photo load', () => {
    const html = renderSharePage(pageInput())
    expect(html).toContain('id="lberror"')
    expect(html).toContain('data-i18n="lightboxLoadFailed"')
    expect(html).toContain("Couldn't load this photo.")
    // Hidden by default — only mainScript's fail() handler ever reveals it.
    expect(html).toMatch(/id="lberror"[^>]*hidden/)
  })

  it('renders the note as markdown below the heading', () => {
    const html = renderSharePage(
      pageInput({ share: makeShare({ note: 'Shot on the **Fuji**, week of June 1st.' }) }),
    )
    expect(html).toContain(
      '<div class="note"><p>Shot on the <strong>Fuji</strong>, week of June 1st.</p></div>',
    )
  })

  it('the first image is eager/high-priority, later ones lazy', () => {
    const html = renderSharePage(
      pageInput({ images: [makeImage({ id: 1 }), makeImage({ id: 2 })] }),
    )
    expect(html).toContain('loading="eager" fetchpriority="high"')
    expect(html).toContain('loading="lazy" decoding="async"')
  })

  it('view role: no download/zip affordances, no full size, no RAW', () => {
    const html = renderSharePage(pageInput({ role: 'view' }))
    expect(html).toContain('"full":false')
    expect(html).toContain('"download":false')
    // Note: the localized string catalogue (client-side language switching)
    // is always embedded — gating is whether the element itself is rendered.
    expect(html).not.toContain('data-i18n="downloadAll"')
    expect(html).not.toContain('id="lbdl"')
    expect(html).not.toContain('id="lbraw"')
  })

  it('download role: download + zip shown, full size available, no RAW', () => {
    const html = renderSharePage(pageInput({ role: 'download' }))
    expect(html).toContain('"full":true')
    expect(html).toContain('"download":true')
    expect(html).toContain('data-i18n="downloadAll"')
    expect(html).toContain('id="lbdl"')
    expect(html).not.toContain('id="lbraw"')
  })

  it('full role: RAW link also shown', () => {
    const html = renderSharePage(
      pageInput({ images: [makeImage({ rawPath: 'DSCF0001.RAF' })], role: 'full' }),
    )
    expect(html).toContain('id="lbraw"')
  })

  it('the RAW control ships a size slot alongside its cannot-open hint, and the tile carries the indexed RAF size', () => {
    // Regression: the RAW control used to show ONLY the hint, never the size —
    // backwards from the JPEG control, and backwards from what actually matters:
    // a .RAF is 30-60 MB, far bigger than the JPEG, so its size is the one a
    // visitor on a cellular plan needs most.
    const html = renderSharePage(
      pageInput({
        images: [makeImage({ rawPath: 'DSCF0001.RAF', rawFileSize: 42_000_000 })],
        role: 'full',
      }),
    )
    expect(html).toContain('data-raw-size="42000000"')
    expect(html).toMatch(
      /id="lbraw"[^>]*>.*?<span[^>]*id="lbrawsize"><\/span>.*?data-i18n="lightboxRawHint"/s,
    )
  })

  it('leaves data-raw-size empty when the image has no paired RAF', () => {
    const html = renderSharePage(
      pageInput({ images: [makeImage({ rawPath: null })], role: 'full' }),
    )
    expect(html).toContain('data-raw-size=""')
  })

  it('HTML-escapes malicious filenames in both attribute and JSON contexts', () => {
    const evil = 'mallorca-2026/"><img src=x onerror=alert(1)>.jpg'
    const html = renderSharePage(
      pageInput({
        images: [makeImage({ relPath: evil, stem: '"><img src=x onerror=alert(1)>' })],
        role: 'full',
      }),
    )
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('"><img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('escapes a malicious share title in the OG/Twitter meta tags', () => {
    const html = renderSharePage(
      pageInput({ share: makeShare({ title: '"><script>alert(1)</script>' }) }),
    )
    expect(html).not.toContain('"><script>alert(1)')
    expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)')
  })

  it('renders an empty-state without a download button when there are no images', () => {
    const html = renderSharePage(
      pageInput({ images: [], summary: makeSummary({ total: 0 }), role: 'full' }),
    )
    expect(html).toContain('No photos in this share yet.')
    expect(html).not.toContain('data-i18n="downloadAll"')
  })

  it('all three views are present in the emitted CSS/markup', () => {
    const html = renderSharePage(pageInput())
    expect(html).toContain("[data-view='stream']")
    expect(html).toContain("[data-view='bento']")
    expect(html).toContain("[data-view='grid']")
    expect(html).toContain('data-value="stream"')
    expect(html).toContain('data-value="bento"')
    expect(html).toContain('data-value="grid"')
  })

  it('all three locale catalogues are embedded for client-side switching', () => {
    const html = renderSharePage(pageInput())
    for (const locale of LOCALES) {
      expect(html).toContain(`"${locale}":{`)
    }
  })

  it('renders the localized title/body for each locale', () => {
    for (const locale of LOCALES) {
      const html = renderSharePage(pageInput({ locale }))
      expect(html).toContain(`<html lang="${locale}"`)
    }
  })

  // ── Stage 4 UX overhaul ────────────────────────────────────────────────────

  it('offers the 900px `small` candidate in the srcset of every tile', () => {
    const html = renderSharePage(pageInput())
    expect(html).toContain('?size=small&amp;token=t 900w')
    expect(html).toContain('?size=thumb&amp;token=t 480w')
    expect(html).toContain('?size=med&amp;token=t 1600w')
  })

  it('srcset width descriptors say what sharp actually rendered for a portrait, not the square target', () => {
    // A 2:3 portrait's `small` (900px target, fit:'inside') renders 600px
    // WIDE, not 900 — sharp scales by the constraining dimension (height).
    const html = renderSharePage(pageInput({ images: [makeImage({ width: 2000, height: 3000 })] }))
    expect(html).toContain('?size=thumb&amp;token=t 320w')
    expect(html).toContain('?size=small&amp;token=t 600w')
    expect(html).toContain('?size=med&amp;token=t 1067w')
    // A landscape/square image is still exactly the target — unaffected.
    expect(renderSharePage(pageInput())).toContain('?size=small&amp;token=t 900w')
  })

  it('every tile, including tile 0, ships the STREAM sizes server-side', () => {
    // Tile 0 ships loading=eager fetchpriority=high, so the browser's preload
    // scanner fetches it off the raw bytes before headScript's client-side
    // sizes repair (which the other 59 lazy tiles get) can run at all — the
    // server has no cookie to tell it the visitor's stored view, so tile 0
    // always emits the same STREAM sizes as everything else (see the comment
    // on `sizes` in `tileHtml`).
    const html = renderSharePage(
      pageInput({
        images: [makeImage({ id: 1 }), makeImage({ id: 2 })],
        summary: makeSummary({ total: 2 }),
      }),
    )
    const tile0 = html.slice(html.indexOf('data-i="0"'), html.indexOf('data-i="1"'))
    const tile1 = html.slice(html.indexOf('data-i="1"'))
    expect(tile0).toContain('sizes="(min-width:1024px) min(1680px')
    expect(tile1).toContain('sizes="(min-width:1024px) min(1680px')
  })

  it('tiles are real links so photos stay reachable with JS disabled', () => {
    const view = renderSharePage(pageInput({ role: 'view' }))
    // The view role may not reach `full`, so its no-JS link must stop at `med`.
    expect(view).toContain(
      '<a class="tile-btn" href="/s/mallorca-2026/img/10?size=med&amp;token=t"',
    )
    expect(view).toContain('<noscript>')

    const full = renderSharePage(pageInput({ role: 'download' }))
    expect(full).toContain(
      '<a class="tile-btn" href="/s/mallorca-2026/img/10?size=full&amp;token=t"',
    )
  })

  it('alt text is the capture date + position, not the raw filename', () => {
    const html = renderSharePage(
      pageInput({
        images: [makeImage(), makeImage({ id: 11 })],
        summary: makeSummary({ total: 2 }),
      }),
    )
    expect(html).toContain('alt="June 1, 2026 — Photo 1 of 2"')
    expect(html).toContain('alt="June 1, 2026 — Photo 2 of 2"')
    expect(html).not.toContain('alt="DSCF0001.JPG"')
    // The filename survives where it is useful: the lightbox label.
    expect(html).toContain('data-name="DSCF0001.JPG"')
  })

  it('emits the real aria-pressed state server-side for all nine controls', () => {
    const html = renderSharePage(pageInput({ locale: 'de' }))
    expect(html).toContain('data-value="stream" data-i18n-aria="viewStream"')
    // Exactly three pressed buttons: view=stream, theme=system, lang=<locale>.
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(3)
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(6)
    expect(html).toMatch(/data-value="de"[^>]*aria-pressed="true"/)
    expect(html).toMatch(/data-value="system"[^>]*aria-pressed="true"/)
  })

  it('the ZIP control carries the predicted size and the photo count', () => {
    const html = renderSharePage(
      pageInput({
        role: 'download',
        summary: makeSummary({ total: 84, zipBytes: 1_900_000_000 }),
      }),
    )
    expect(html).toContain('Download all (.zip)')
    expect(html).toContain('1.9 GB · 84 photos')
    expect(html).toContain('"zipBytes":1900000000')
  })

  it('localizes the ZIP size label per locale', () => {
    const de = renderSharePage(
      pageInput({
        locale: 'de',
        role: 'download',
        summary: makeSummary({ total: 84, zipBytes: 1_900_000_000 }),
      }),
    )
    expect(de).toContain('1,9 GB · 84 Fotos')
    expect(de).toContain('Alle herunterladen (.zip)')
  })

  it('adds link-preview metadata but deliberately never an og:image', () => {
    const html = renderSharePage(pageInput({ share: makeShare({ title: 'Segeln 25' }) }))
    expect(html).toContain('<meta property="og:title" content="Segeln 25">')
    expect(html).toContain('<meta property="og:description"')
    expect(html).toContain('<meta name="twitter:card" content="summary">')
    expect(html).toContain('name="theme-color"')
    expect(html).toContain('<link rel="icon" href="data:image/svg+xml,')
    // A crawler follows the tokenised URL — an og:image would be fetched and
    // cached by Meta/Apple beyond the reach of revoking the token.
    expect(html).not.toContain('og:image')
    expect(html).toContain('content="noindex, nofollow"')
  })

  it('keeps every asset inline — zero external requests', () => {
    const html = renderSharePage(pageInput())
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/)
    // The one <link> is the inline data-URI favicon.
    expect(html.match(/<link /g)).toHaveLength(1)
  })

  it('defines --pad-x on the share page too (shared geometry, not view-only CSS)', () => {
    expect(renderSharePage(pageInput())).toContain('--pad-x')
  })

  it('labels the share switcher menu with the previously dangling heading key', () => {
    expect(renderSharePage(pageInput())).toContain("t('switcherHeading')")
  })

  it('the switcher button and menu ship with the hidden attribute', () => {
    // Markup-only guard for the display-vs-[hidden] regression below: the
    // switcher must render `hidden` server-side regardless of how many shares
    // a visitor has remembered — mainScript decides at runtime whether to
    // reveal it, and CSS must never override that decision (see baseCss()).
    const html = renderSharePage(pageInput())
    expect(html).toMatch(/id="switcherBtn"[^>]* hidden[^>]*>/)
    expect(html).toMatch(/id="switcherMenu"[^>]* hidden[^>]*>/)
  })

  it('bento: a full-width tile carries its two-column row span, and rows follow the width', () => {
    // The library is 3:2 and the phone grid is two columns wide, so a landscape
    // tile IS the content width: with a fixed row height it was a ~2.5:1 strip
    // with ~40% of every photo cropped away by object-fit: cover.
    const html = renderSharePage(pageInput({ images: [makeImage({ width: 6000, height: 4000 })] }))
    expect(html).toContain('--col-span:2;--row-span:1;--row-span-narrow:2')
    expect(html).toContain('grid-row: span var(--row-span-narrow, var(--row-span, 1))')
    expect(html).toContain('grid-auto-rows: calc((100vw - 2 * var(--pad-x) - 4px) / 3)')
  })
})

// The sticky bar is 9 buttons in 3 groups and sits above the photos on every
// scroll, so it wrapping to a second row costs ~15% of a phone viewport
// permanently. Nine 44px buttons need 463px — more than any iPhone has — so the
// narrow breakpoint has to shrink them; this recomputes the real width from the
// emitted CSS rather than trusting the numbers not to drift back.
function toPx(value: string): number {
  if (value === '0') return 0
  const match = /^([\d.]+)(rem|px)$/.exec(value)
  if (!match) throw new Error(`unparseable CSS length: ${value}`)
  return match[2] === 'rem' ? Number(match[1]) * 16 : Number(match[1])
}

describe('sticky control bar geometry', () => {
  const NARROW = /@media \(max-width: 420px\) \{([\s\S]*?)\n\}/.exec(controlsCss())?.[1] ?? ''

  /** One declaration out of one rule of the narrow-breakpoint block. */
  function decl(selector: string, prop: string): string {
    const rule = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(NARROW)?.[1]
    if (!rule) throw new Error(`no '${selector}' rule at the narrow breakpoint`)
    const value = new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`).exec(rule)?.[1]
    if (!value) throw new Error(`no '${prop}' on '${selector}' at the narrow breakpoint`)
    return value.trim()
  }

  it('fits three segmented groups on a 360px phone without wrapping', () => {
    const buttonWidth = toPx(decl('.segmented button', 'min-width'))
    const segGap = toPx(decl('.segmented', 'gap'))
    const segPad = toPx(decl('.segmented', 'padding'))
    const topGap = toPx(decl('.topbar', 'gap'))
    const topPadX = toPx(decl('.topbar', 'padding').split(/\s+/)[1] as string)

    // 3 buttons + 2 inner gaps + both paddings + the 1px border on each side.
    const group = 3 * buttonWidth + 2 * segGap + 2 * segPad + 2
    const bar = 3 * group + 2 * topGap + 2 * topPadX

    expect(bar).toBeLessThanOrEqual(360)
    // The tap target only narrows: full height is kept, which is the axis a
    // thumb actually misses.
    expect(controlsCss()).toContain('height: var(--tap)')
    expect(NARROW).not.toContain('height:')
  })
})

describe('renderSharePage — progressive reveal', () => {
  const many = Array.from({ length: SHARE_PAGE_SIZE }, (_, i) => makeImage({ id: 100 + i }))

  it('renders no "show more" control when the window covers the whole share', () => {
    const html = renderSharePage(
      pageInput({ images: many, summary: makeSummary({ total: SHARE_PAGE_SIZE }) }),
    )
    expect(html).not.toContain('id="more"')
  })

  it('renders a plain-href "show more" link when there are further windows', () => {
    const html = renderSharePage(
      pageInput({ images: many, summary: makeSummary({ total: SHARE_PAGE_SIZE + 5 }) }),
    )
    expect(html).toContain(`id="more" data-from="${SHARE_PAGE_SIZE}"`)
    expect(html).toContain(`href="/s/mallorca-2026?token=t&amp;from=${SHARE_PAGE_SIZE}"`)
    expect(html).toContain(`"pageSize":${SHARE_PAGE_SIZE}`)
  })

  it('"show more" carries a hidden failure message for a failed fragment fetch', () => {
    const html = renderSharePage(
      pageInput({ images: many, summary: makeSummary({ total: SHARE_PAGE_SIZE + 5 }) }),
    )
    expect(html).toContain('id="moreError"')
    expect(html).toContain('data-i18n="moreLoadFailed"')
    expect(html).toMatch(/id="moreError"[^>]*hidden/)
  })

  it('does NOT inline a per-image JS array — the lightbox reads the DOM', () => {
    const html = renderSharePage(
      pageInput({ images: many, summary: makeSummary({ total: SHARE_PAGE_SIZE }) }),
    )
    expect(html).not.toContain('"imgs":')
  })

  it('a deep window numbers its tiles by global position', () => {
    const html = renderSharePage(
      pageInput({
        images: [makeImage({ id: 500 })],
        from: 120,
        summary: makeSummary({ total: 200 }),
      }),
    )
    expect(html).toContain('data-i="120"')
    expect(html).toContain('alt="June 1, 2026 — Photo 121 of 200"')
  })
})

describe('renderShareTiles', () => {
  it('returns only tiles — no document, no script, no style', () => {
    const frag = renderShareTiles(pageInput({ from: 60, summary: makeSummary({ total: 200 }) }))
    expect(frag).toContain('<figure class="tile')
    expect(frag).not.toContain('<!doctype')
    expect(frag).not.toContain('<script')
    expect(frag).not.toContain('<style')
    expect(frag).toContain('data-i="60"')
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

  it('has real page padding — --pad-x/--pad-y are defined, not dangling', () => {
    const html = renderLandingPage()
    expect(html).toContain('padding: var(--pad-y) var(--pad-x)')
    // The custom properties used to live only in viewsCss(), which the landing
    // page does not emit — so the page shipped flush against the corner.
    expect(html).toContain('--pad-x: 1rem')
    expect(html).toContain('--pad-x: 5rem')
  })

  it('the one-share redirect placeholder carries real copy, not an empty <p>', () => {
    const html = renderLandingPage()
    expect(html).toContain('<p id="landing-redirect" data-i18n="landingRedirect" hidden>')
    expect(html).toContain('Opening your share…')
  })

  it('wires the previously dangling landing catalogue keys', () => {
    const html = renderLandingPage()
    // They were defined in all three locales and referenced nowhere, so a
    // landing row rendered a bare Intl date with no label at all.
    for (const key of ['landingLastOpened', 'landingOpen']) {
      expect(html).toContain(`t('${key}')`)
    }
    expect(html).toContain('data-i18n="landingRedirect"')
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

  it('runs the pre-paint head script so a stored light theme is honoured', () => {
    // Without it the denial page ignored the visitor's explicit theme choice
    // and fell back to the system scheme.
    expect(render404Page()).toContain("localStorage.getItem('image-share.theme')")
  })

  it('carries its own tiny i18n script so a stored language wins over Accept-Language, too', () => {
    // headScript already rewrites html[lang] from localStorage pre-paint —
    // without notFoundScript the COPY stayed frozen in the server locale
    // while the <html lang> attribute changed out from under it.
    const html = render404Page('de')
    expect(html).toContain('data-i18n="notFoundTitle"')
    expect(html).toContain('data-i18n="notFoundBody"')
    expect(html).toContain('document.documentElement.lang')
    // Still deterministic per (locale, denial cause) — the opaque-404 contract.
    expect(html).toBe(render404Page('de'))
  })
})

describe('[hidden] vs display-setting classes', () => {
  // Regression: `.switcher-menu { display: flex }` (and `.actions .text-btn {
  // display: inline-flex }`) beat the UA `[hidden] { display: none }` rule at
  // equal-or-higher specificity, so #switcherBtn/#switcherMenu rendered
  // VISIBLY on screen even with `hidden` still on the element (confirmed live:
  // getComputedStyle().display === 'flex' with hidden === true). A global,
  // `!important` `[hidden]` rule is the fix — verify it ships, ahead of
  // whatever display-setting class an element also carries.
  it('baseCss() carries a global !important [hidden] guard', () => {
    expect(baseCss()).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important\s*;?\s*\}/)
  })

  it('the guard is present on every page baseCss() ships on (share, landing, 404)', () => {
    for (const html of [renderSharePage(pageInput()), renderLandingPage(), render404Page()]) {
      expect(html).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/)
    }
  })
})

describe('formatBytes', () => {
  it('uses decimal units and locale-appropriate separators', () => {
    expect(formatBytes('en', 0)).toBe('0 B')
    expect(formatBytes('en', 999)).toBe('999 B')
    expect(formatBytes('en', 1000)).toBe('1.0 kB')
    expect(formatBytes('en', 1_900_000_000)).toBe('1.9 GB')
    expect(formatBytes('de', 1_900_000_000)).toBe('1,9 GB')
    expect(formatBytes('en', 26_400_000)).toBe('26 MB')
  })
})

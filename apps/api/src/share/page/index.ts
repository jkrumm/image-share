import { basename } from 'node:path'
import type { ImageRow, ShareRow } from '../../db/schema.js'
import type { ShareTokenRole } from '../../lib/share-auth.js'
import { renditionDimension } from '../../renditions/render.js'
import { bentoSpanFor, narrowRowSpan } from './layout.js'
import {
  allMessages,
  formatBytes,
  interpolate,
  messages,
  photoCountLabel,
  type Locale,
  type Messages,
} from './i18n.js'
import { escapeHtml, renderMarkdown } from './markdown.js'
import {
  baseCss,
  controlsCss,
  headCss,
  landingCss,
  lightboxCss,
  notFoundCss,
  paletteCss,
  viewsCss,
} from './styles.js'
import { headScript, landingScript, mainScript, notFoundScript, SIZES_BY_VIEW } from './client.js'

// Server-rendered share/landing/404 pages (Stage 3 redesign — design §7). ALL
// CSS + JS is inline — zero external requests. Every user-controlled string
// (title, note, filenames, slug) is HTML-escaped; token/id are URL-encoded
// into asset URLs. See `client.ts`/`styles.ts`/`i18n.ts`/`markdown.ts`/
// `layout.ts` for the split-out pieces this module orchestrates.

/** Tiles rendered into one document / one progressive-reveal fragment. */
export const SHARE_PAGE_SIZE = 60

/** Aggregate share facts the header needs without enumerating every row. */
export interface SharePageSummary {
  /** Total images in the share (NOT the size of the rendered window). */
  total: number
  firstCaptureAt: string | null
  lastCaptureAt: string | null
  /** Predicted ZIP size in bytes, rendered into the download control's label. */
  zipBytes: number
}

export interface SharePageInput {
  share: ShareRow
  /** The window of images to render as tiles (see `SHARE_PAGE_SIZE`). */
  images: ImageRow[]
  /** Global index of `images[0]` within the share. */
  from: number
  summary: SharePageSummary
  /** Threaded into every asset URL. */
  token: string
  role: ShareTokenRole
  /** Initial locale (design §E) — server-parsed from `Accept-Language`, the
   * client may override it from `localStorage` before first paint. */
  locale: Locale
}

/** Serialize a value into an inline <script> without allowing `</script>` breakout. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/** Shared query suffix (`token=…`) threaded into every asset URL. */
function authQuery(token: string): string {
  return `token=${encodeURIComponent(token)}`
}

/** Human display name for an image (relative filename). */
function displayName(image: ImageRow): string {
  return basename(image.relPath)
}

/** `YYYY-MM-DD` for an ISO-ish capture timestamp, or '' when unknown. */
function captureDay(captureAt: string | null): string {
  if (!captureAt) return ''
  const parsed = new Date(captureAt)
  return Number.isNaN(parsed.getTime()) ? captureAt.slice(0, 10) : parsed.toISOString().slice(0, 10)
}

/** Distinct capture-day bounds (`[first]` or `[first, last]`), for the meta line. */
function captureDayBounds(summary: SharePageSummary): string[] {
  const first = captureDay(summary.firstCaptureAt)
  const last = captureDay(summary.lastCaptureAt)
  if (!first && !last) return []
  if (!last || first === last) return [first]
  return [first, last]
}

/**
 * SSR fallback for the meta line (design §B) — mirrored by `formatDateRange`
 * in `client.ts`'s `mainScript`, which recomputes it client-side so the
 * range follows a language switch without a round-trip.
 */
function formatDateRange(locale: Locale, days: readonly string[]): string {
  if (days.length === 0) return ''
  const long = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' })
  const first = new Date(days[0]!)
  if (days.length === 1) return long.format(first)
  const short = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'numeric' })
  const last = new Date(days[days.length - 1]!)
  return `${short.format(first)} – ${long.format(last)}`
}

function metaText(locale: Locale, total: number, days: readonly string[]): string {
  const count = photoCountLabel(locale, total)
  const range = formatDateRange(locale, days)
  return range ? `${range} · ${count}` : count
}

function segmentedGroup(
  group: string,
  ariaLabelKey: keyof Messages,
  items: ReadonlyArray<{ value: string; ariaKey: keyof Messages; icon: string }>,
  m: Messages,
  selected: string,
): string {
  const buttons = items
    .map(
      // `aria-pressed` carries the REAL default state, not a hardcoded "false"
      // on all nine buttons. The values below are request-independent defaults
      // (view=stream, theme=system, lang=the page's own locale); a stored
      // client-side preference is applied by `headScript` before first paint.
      // Without this a no-JS visitor saw three groups of identical grey icons.
      (item) => `<button type="button" data-value="${item.value}" data-i18n-aria="${item.ariaKey}"
      aria-label="${escapeHtml(m[item.ariaKey])}" aria-pressed="${item.value === selected}">${item.icon}</button>`,
    )
    .join('')
  return `<div class="segmented" data-group="${group}" role="group" data-i18n-aria="${ariaLabelKey}" aria-label="${escapeHtml(m[ariaLabelKey])}">
    <span class="pill" aria-hidden="true"></span>
    ${buttons}
  </div>`
}

const ICON_STREAM =
  '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="4" rx="1"/><rect x="4" y="10" width="16" height="4" rx="1"/><rect x="4" y="16" width="16" height="4" rx="1"/></svg>'
const ICON_BENTO =
  '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="12" height="8" rx="1"/><rect x="17" y="3" width="4" height="18" rx="1"/><rect x="3" y="13" width="4" height="8" rx="1"/><rect x="9" y="13" width="6" height="8" rx="1"/></svg>'
const ICON_GRID =
  '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>'
const ICON_SUN =
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
const ICON_MOON =
  '<svg viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/></svg>'
const ICON_MONITOR =
  '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/></svg>'

function controlsHtml(m: Messages, locale: Locale): string {
  const view = segmentedGroup(
    'view',
    'viewGroupLabel',
    [
      { value: 'stream', ariaKey: 'viewStream', icon: ICON_STREAM },
      { value: 'bento', ariaKey: 'viewBento', icon: ICON_BENTO },
      { value: 'grid', ariaKey: 'viewGrid', icon: ICON_GRID },
    ],
    m,
    'stream',
  )
  const theme = segmentedGroup(
    'theme',
    'themeGroupLabel',
    [
      { value: 'light', ariaKey: 'themeLight', icon: ICON_SUN },
      { value: 'dark', ariaKey: 'themeDark', icon: ICON_MOON },
      { value: 'system', ariaKey: 'themeSystem', icon: ICON_MONITOR },
    ],
    m,
    'system',
  )
  const lang = segmentedGroup(
    'lang',
    'langGroupLabel',
    [
      { value: 'de', ariaKey: 'langDe', icon: 'DE' },
      { value: 'en', ariaKey: 'langEn', icon: 'EN' },
      { value: 'es', ariaKey: 'langEs', icon: 'ES' },
    ],
    m,
    locale,
  )
  return `<header class="topbar">${view}${theme}${lang}</header>`
}

interface TileContext {
  slugU: string
  auth: string
  locale: Locale
  m: Messages
  total: number
  /** The largest rendition size this role may open — the tile's plain href. */
  linkSize: 'med' | 'full'
}

/**
 * The pixel WIDTH `sharp`'s `fit:'inside'` resize (`renditions/render.ts`)
 * actually produces for a `target` long-edge dimension. Landscape/square
 * images come out exactly `target` wide; a portrait's HEIGHT hits `target`
 * first, so its width is proportionally smaller — a 2:3 portrait's `small`
 * (900px target) renders 600px wide, not 900. The srcset `Nw` descriptor has
 * to say what sharp actually produced, or the browser's density math is
 * wrong for every non-landscape photo (a portrait `stream` box lands ~3x on
 * a DPR-3 phone with no larger candidate to recover with — `full` isn't
 * offered below `download` role, and even where it is, it's not in the
 * srcset). Unknown dimensions fall back to `target` (the old behavior).
 */
function renderedWidth(image: ImageRow, target: number): number {
  if (!image.width || !image.height) return target
  const scale = Math.min(target / image.width, target / image.height, 1)
  return Math.max(1, Math.round(image.width * scale))
}

/**
 * One gallery tile.
 *
 * The click target is an `<a>`, not a `<button>`: with JS off the lightbox is
 * inert and there was no other way to see a photo at full size or save it.
 * `mainScript` intercepts an unmodified left click and opens the lightbox
 * instead, so the plain-href path is a fallback, not the primary UX.
 */
function tileHtml(image: ImageRow, index: number, ctx: TileContext): string {
  const { slugU, auth } = ctx
  const name = displayName(image)
  const base = `/s/${slugU}/img/${image.id}`
  const thumb = `${base}?size=thumb&${auth}`
  const small = `${base}?size=small&${auth}`
  const med = `${base}?size=med&${auth}`
  const link = `${base}?size=${ctx.linkSize}&${auth}`
  const thumbW = renderedWidth(image, renditionDimension('thumb'))
  const smallW = renderedWidth(image, renditionDimension('small'))
  const medW = renderedWidth(image, renditionDimension('med'))
  const span = bentoSpanFor({ width: image.width, height: image.height }, index)
  const ratio = image.width && image.height ? `${image.width}/${image.height}` : '3/2'
  const dims = image.width && image.height ? ` width="${image.width}" height="${image.height}"` : ''
  const loadingAttrs =
    index === 0 ? 'loading="eager" fetchpriority="high"' : 'loading="lazy" decoding="async"'
  // Every tile ships the STREAM `sizes` — headScript's MutationObserver
  // repairs the other 59 lazy tiles for a stored grid/bento view before their
  // fetch even starts. Tile 0 can't take that repair: its
  // `loading="eager" fetchpriority="high"` means the preload scanner fetches
  // it straight off the raw byte stream, ahead of any script and ahead of
  // the DOM node the observer reacts to even existing. KNOWN, ACCEPTED
  // mis-sizing: a returning visitor whose stored view is `grid`/`bento` gets
  // tile 0 fetched at the STREAM candidate (1600w) instead of the narrower
  // one their layout actually needs — one wasted ~450ms sharp decode. The
  // browser never re-fetches a smaller candidate once committed, so this is
  // not even a double fetch, just a bigger single one. The only server-side
  // fix is a cookie carrying the stored view, and the public share surface
  // is deliberately cookie-free (design §7) — a link handed to a friend must
  // set nothing on their device. Not worth trading away for this.
  const sizes = SIZES_BY_VIEW.stream
  const day = captureDay(image.captureAt)
  // A screen reader announcing "DSCF4821.JPG" 84 times is noise; the filename
  // stays, but in the lightbox label where it is actually useful.
  const position = interpolate(ctx.m.photoAlt, { i: index + 1, n: ctx.total })
  const dayLabel = day
    ? new Intl.DateTimeFormat(ctx.locale, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }).format(new Date(day))
    : ''
  const alt = dayLabel ? `${dayLabel} — ${position}` : position
  return `<figure class="tile tile-ph" data-i="${index}" data-id="${image.id}" data-name="${escapeHtml(name)}" data-date="${escapeHtml(day)}" data-size="${image.fileSize}" data-raw="${image.rawPath ? 1 : 0}" style="--ratio:${ratio};--col-span:${span.colSpan};--row-span:${span.rowSpan};--row-span-narrow:${narrowRowSpan(span)}">
    <a class="tile-btn" href="${escapeHtml(link)}">
      <img class="tile-img" ${loadingAttrs}${dims}
        src="${escapeHtml(thumb)}"
        srcset="${escapeHtml(thumb)} ${thumbW}w, ${escapeHtml(small)} ${smallW}w, ${escapeHtml(med)} ${medW}w"
        sizes="${sizes}"
        alt="${escapeHtml(alt)}">
    </a>
  </figure>`
}

/**
 * The tiles for one window of a share, with no surrounding document — the
 * response body for `GET /s/:slug?frag=1&from=N`, which `mainScript` appends
 * to the gallery as the visitor scrolls.
 */
export function renderShareTiles(input: SharePageInput): string {
  const ctx: TileContext = {
    slugU: encodeURIComponent(input.share.slug),
    auth: authQuery(input.token),
    locale: input.locale,
    m: messages(input.locale),
    total: input.summary.total,
    linkSize: input.role === 'view' ? 'med' : 'full',
  }
  return input.images.map((image, i) => tileHtml(image, input.from + i, ctx)).join('\n')
}

/**
 * Inline SVG favicon as a data URI — a real icon with ZERO external requests,
 * which is the property the whole page is built around. Percent-encoded rather
 * than base64 so it stays readable and diffable.
 */
const FAVICON_SVG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%2318181b'/%3E%3Ccircle cx='16' cy='17' r='6' fill='none' stroke='%23fafafa' stroke-width='2'/%3E%3Cpath d='M10 9h5l1.5-2h3L21 9h1' fill='none' stroke='%23fafafa' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E"

/**
 * Link-preview + browser-chrome metadata. The product is delivered by pasting a
 * link into WhatsApp, so a preview card with a title and a photo count is the
 * first thing the recipient sees.
 *
 * DELIBERATELY NO `og:image`. A crawler follows the FULL tokenised URL, so any
 * `og:image` we advertise would be fetched — and then cached, indefinitely and
 * outside our control — by Meta's and Apple's infrastructure. That converts a
 * private, revocable share into a copy of the photo sitting on a third-party
 * CDN that revoking the token cannot reach. A text-only card is the whole
 * trade: slightly duller preview, no image ever leaves the origin.
 * `noindex, nofollow` stays for the same reason.
 */
function metaHtml(title: string, description: string): string {
  return `<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121212" media="(prefers-color-scheme: dark)">
<link rel="icon" href="${FAVICON_SVG}">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">`
}

/**
 * Render the full share page: sticky segmented controls (view/theme/lang),
 * a header (title/meta/note/download-all/switcher), one window of the image
 * stream in three CSS-driven views, and a `<dialog>` lightbox. Download/RAW/zip
 * affordances are gated by `role` exactly as `share/routes.ts` enforces.
 */
export function renderSharePage(input: SharePageInput): string {
  const { share, images, from, summary, token, role, locale } = input
  const m = messages(locale)
  const slugU = encodeURIComponent(share.slug)
  const auth = authQuery(token)
  const canDownload = role !== 'view'
  const canRaw = role === 'full'
  const isFull = role !== 'view'

  const days = captureDayBounds(summary)
  const meta = metaText(locale, summary.total, days)
  const noteHtml = share.note ? `<div class="note">${renderMarkdown(share.note)}</div>` : ''
  const zipUrl = `/s/${slugU}/zip?${auth}`

  const tiles = renderShareTiles(input)
  const nextFrom = from + images.length
  const hasMore = nextFrom < summary.total
  const moreHref = `/s/${slugU}?${auth}&from=${nextFrom}`

  const cfg = {
    slug: share.slug,
    token,
    title: share.title,
    total: summary.total,
    pageSize: SHARE_PAGE_SIZE,
    dates: days,
    zipBytes: summary.zipBytes,
    full: isFull,
    download: canDownload,
    raws: canRaw,
  }

  // The ZIP label carries its predicted size + count because Bun drops the
  // Content-Length on a streamed response (see share/zip.ts) — without it the
  // visitor gets no progress bar and no ETA on a multi-GB download.
  const zipMeta = `${formatBytes(locale, summary.zipBytes)} · ${photoCountLabel(locale, summary.total)}`

  return `<!doctype html>
<html lang="${locale}" data-view="stream">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${metaHtml(share.title, meta)}
<title>${escapeHtml(share.title)}</title>
<script>${headScript()}</script>
<style>
${paletteCss()}
${baseCss()}
${controlsCss()}
${headCss()}
${viewsCss()}
${lightboxCss()}
</style>
</head>
<body>
${controlsHtml(m, locale)}
<main>
  <section class="head">
    <h1>${escapeHtml(share.title)}</h1>
    <p class="meta" id="meta">${escapeHtml(meta)}</p>
    ${noteHtml}
    <div class="actions">
      ${
        canDownload && summary.total > 0
          ? `<a class="text-btn zip-btn" id="zipBtn" href="${escapeHtml(zipUrl)}"><span class="zip-label" data-i18n="downloadAll">${escapeHtml(m.downloadAll)}</span><span class="zip-meta">${escapeHtml(zipMeta)}</span></a>`
          : ''
      }
      <button type="button" id="switcherBtn" class="text-btn" hidden data-i18n="switcherLabel" data-i18n-aria="switcherLabel" aria-label="${escapeHtml(m.switcherLabel)}">${escapeHtml(m.switcherLabel)}</button>
    </div>
    <div id="switcherMenu" class="switcher-menu" hidden></div>
  </section>
  <noscript><p class="noscript-hint">${escapeHtml(m.noscriptHint)}</p></noscript>
  ${summary.total === 0 ? `<p class="empty" data-i18n="emptyState">${escapeHtml(m.emptyState)}</p>` : `<div class="gallery" id="gallery">${tiles}</div>`}
  ${
    hasMore
      ? `<div class="more" id="more" data-from="${nextFrom}"><a class="text-btn" href="${escapeHtml(moreHref)}"><span data-i18n="showMore">${escapeHtml(m.showMore)}</span></a><p class="more-error" id="moreError" role="alert" data-i18n="moreLoadFailed" hidden>${escapeHtml(m.moreLoadFailed)}</p></div>`
      : ''
  }
</main>

<dialog id="lb">
  <div class="lb-wrap" id="lbwrap">
    <div class="lb-stage" id="lbstage" data-loading="0">
      <img id="lbimg" alt="" hidden>
      <div class="lb-spin" id="lbspin" role="status" data-i18n-aria="lightboxLoading" aria-label="${escapeHtml(m.lightboxLoading)}" hidden></div>
      <div class="lb-error" id="lberror" role="alert" data-i18n="lightboxLoadFailed" hidden>${escapeHtml(m.lightboxLoadFailed)}</div>
    </div>
    <button class="lb-btn lb-close" data-i18n-aria="lightboxClose" aria-label="${escapeHtml(m.lightboxClose)}">×</button>
    <button class="lb-btn lb-prev" data-i18n-aria="lightboxPrev" aria-label="${escapeHtml(m.lightboxPrev)}">‹</button>
    <button class="lb-btn lb-next" data-i18n-aria="lightboxNext" aria-label="${escapeHtml(m.lightboxNext)}">›</button>
    <div class="lb-bar">
      <span class="lb-id">
        <span class="lb-count" id="lbcount"></span>
        <span class="name" id="lbname"></span>
        <span class="lb-date" id="lbdate"></span>
      </span>
      ${canDownload ? `<a class="text-btn" id="lbdl" download><span data-i18n="lightboxDownload">${escapeHtml(m.lightboxDownload)}</span><span class="lb-size" id="lbdlsize"></span></a>` : ''}
      ${canRaw ? `<a class="text-btn" id="lbraw" download hidden><span data-i18n="lightboxDownloadRaw">${escapeHtml(m.lightboxDownloadRaw)}</span><span class="lb-hint" data-i18n="lightboxRawHint">${escapeHtml(m.lightboxRawHint)}</span></a>` : ''}
    </div>
  </div>
</dialog>

<script>
${mainScript(jsonForScript(cfg), jsonForScript(allMessages()))}
</script>
</body>
</html>`
}

/**
 * The landing page at `/` (design §I / Stage 3). Byte-identical for every
 * visitor — no server lookup, no locale parsed from the request, no per-
 * visitor data of any kind. Every bit of behavior (0/1/N remembered shares,
 * the initial language) is resolved client-side from `localStorage`/
 * `navigator.language`, so the response can never become an oracle over
 * shares or tokens.
 */
export function renderLandingPage(): string {
  const m = messages('en')
  return `<!doctype html>
<html lang="en" data-view="stream">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${metaHtml('Image Share', m.landingHeading)}
<title>Image Share</title>
<script>${headScript()}</script>
<style>
${paletteCss()}
${baseCss()}
${landingCss()}
</style>
</head>
<body>
<main>
  <p id="landing-empty" data-i18n="landingEmpty" hidden>${escapeHtml(m.landingEmpty)}</p>
  <p id="landing-redirect" data-i18n="landingRedirect" hidden>${escapeHtml(m.landingRedirect)}</p>
  <section id="landing-section" hidden>
    <h1 data-i18n="landingHeading">${escapeHtml(m.landingHeading)}</h1>
    <ul class="share-list" id="landing-list"></ul>
  </section>
</main>
<script>${landingScript(jsonForScript(allMessages()))}</script>
</body>
</html>`
}

/**
 * The single opaque denial page (design §7). Every share failure (missing/
 * unknown slug, wrong/rolled/expired/revoked token, id outside the share, or
 * a size/route the token's role does not permit) collapses to this exact
 * response for a given locale, never distinguishing cases.
 */
export function render404Page(locale: Locale = 'en'): string {
  const m = messages(locale)
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121212" media="(prefers-color-scheme: dark)">
<link rel="icon" href="${FAVICON_SVG}">
<title>${escapeHtml(m.notFoundTitle)}</title>
<script>${headScript()}</script>
<style>
${paletteCss()}
${baseCss()}
${notFoundCss()}
</style>
</head>
<body>
  <main>
    <h1 data-i18n="notFoundTitle">${escapeHtml(m.notFoundTitle)}</h1>
    <p data-i18n="notFoundBody">${escapeHtml(m.notFoundBody)}</p>
  </main>
<script>${notFoundScript(jsonForScript(allMessages()))}</script>
</body>
</html>`
}

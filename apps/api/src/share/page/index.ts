import { basename } from 'node:path'
import type { ImageRow, ShareRow } from '../../db/schema.js'
import type { ShareTokenRole } from '../../lib/share-auth.js'
import { bentoSpanFor } from './layout.js'
import { allMessages, messages, photoCountLabel, type Locale, type Messages } from './i18n.js'
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
import { headScript, landingScript, mainScript } from './client.js'

// Server-rendered share/landing/404 pages (Stage 3 redesign — design §7). ALL
// CSS + JS is inline — zero external requests. Every user-controlled string
// (title, note, filenames, slug) is HTML-escaped; token/id are URL-encoded
// into asset URLs. See `client.ts`/`styles.ts`/`i18n.ts`/`markdown.ts`/
// `layout.ts` for the split-out pieces this module orchestrates.

export interface SharePageInput {
  share: ShareRow
  images: ImageRow[]
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

/** Distinct capture-day strings (`YYYY-MM-DD`), sorted ascending. */
function captureDayStrings(images: readonly ImageRow[]): string[] {
  const days = new Set<string>()
  for (const image of images) {
    if (!image.captureAt) continue
    const parsed = new Date(image.captureAt)
    days.add(
      Number.isNaN(parsed.getTime())
        ? image.captureAt.slice(0, 10)
        : parsed.toISOString().slice(0, 10),
    )
  }
  return [...days].toSorted()
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

function metaText(locale: Locale, images: readonly ImageRow[], days: readonly string[]): string {
  const count = photoCountLabel(locale, images.length)
  const range = formatDateRange(locale, days)
  return range ? `${range} · ${count}` : count
}

const STREAM_SIZES =
  '(min-width:1024px) min(1680px, calc(100vw - 160px)), (min-width:640px) calc(100vw - 80px), calc(100vw - 32px)'

function segmentedGroup(
  group: string,
  ariaLabelKey: keyof Messages,
  items: ReadonlyArray<{ value: string; ariaKey: keyof Messages; icon: string }>,
  m: Messages,
): string {
  const buttons = items
    .map(
      (item) => `<button type="button" data-value="${item.value}" data-i18n-aria="${item.ariaKey}"
      aria-label="${escapeHtml(m[item.ariaKey])}" aria-pressed="false">${item.icon}</button>`,
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

function controlsHtml(m: Messages): string {
  const view = segmentedGroup(
    'view',
    'viewGroupLabel',
    [
      { value: 'stream', ariaKey: 'viewStream', icon: ICON_STREAM },
      { value: 'bento', ariaKey: 'viewBento', icon: ICON_BENTO },
      { value: 'grid', ariaKey: 'viewGrid', icon: ICON_GRID },
    ],
    m,
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
  )
  return `<header class="topbar">${view}${theme}${lang}</header>`
}

function tileHtml(image: ImageRow, index: number, slugU: string, auth: string): string {
  const name = displayName(image)
  const thumb = `/s/${slugU}/img/${image.id}?size=thumb&${auth}`
  const med = `/s/${slugU}/img/${image.id}?size=med&${auth}`
  const span = bentoSpanFor({ width: image.width, height: image.height }, index)
  const ratio = image.width && image.height ? `${image.width}/${image.height}` : '3/2'
  const dims = image.width && image.height ? ` width="${image.width}" height="${image.height}"` : ''
  const loadingAttrs =
    index === 0 ? 'loading="eager" fetchpriority="high"' : 'loading="lazy" decoding="async"'
  return `<figure class="tile" data-i="${index}" style="--ratio:${ratio};--col-span:${span.colSpan};--row-span:${span.rowSpan}">
    <button type="button" class="tile-btn" aria-label="${escapeHtml(name)}">
      <img ${loadingAttrs}${dims}
        src="${escapeHtml(thumb)}"
        srcset="${escapeHtml(thumb)} 480w, ${escapeHtml(med)} 1600w"
        sizes="${STREAM_SIZES}"
        alt="${escapeHtml(name)}">
    </button>
  </figure>`
}

/**
 * Render the full share page: sticky segmented controls (view/theme/lang),
 * a header (title/meta/note/download-all/switcher), the image stream in
 * three CSS-driven views, and a `<dialog>` lightbox. Download/RAW/zip
 * affordances are gated by `role` exactly as `share/routes.ts` enforces.
 */
export function renderSharePage(input: SharePageInput): string {
  const { share, images, token, role, locale } = input
  const m = messages(locale)
  const slugU = encodeURIComponent(share.slug)
  const auth = authQuery(token)
  const canDownload = role !== 'view'
  const canRaw = role === 'full'
  const isFull = role !== 'view'

  const days = captureDayStrings(images)
  const meta = metaText(locale, images, days)
  const noteHtml = share.note ? `<div class="note">${renderMarkdown(share.note)}</div>` : ''
  const zipUrl = `/s/${slugU}/zip?${auth}`

  const tiles = images.map((image, i) => tileHtml(image, i, slugU, auth)).join('\n')

  const cfg = {
    slug: share.slug,
    token,
    title: share.title,
    count: images.length,
    dates: days,
    full: isFull,
    download: canDownload,
    raws: canRaw,
    imgs: images.map((image) => ({ id: image.id, name: displayName(image) })),
  }

  return `<!doctype html>
<html lang="${locale}" data-view="stream">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
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
${controlsHtml(m)}
<main>
  <section class="head">
    <h1>${escapeHtml(share.title)}</h1>
    <p class="meta" id="meta">${escapeHtml(meta)}</p>
    ${noteHtml}
    <div class="actions">
      ${
        canDownload && images.length > 0
          ? `<a class="text-btn" data-i18n="downloadAll" href="${escapeHtml(zipUrl)}">${escapeHtml(m.downloadAll)}</a>`
          : ''
      }
      <button type="button" id="switcherBtn" class="text-btn" hidden data-i18n="switcherLabel" data-i18n-aria="switcherLabel" aria-label="${escapeHtml(m.switcherLabel)}">${escapeHtml(m.switcherLabel)}</button>
    </div>
    <div id="switcherMenu" class="switcher-menu" hidden></div>
  </section>
  ${images.length === 0 ? `<p class="empty" data-i18n="emptyState">${escapeHtml(m.emptyState)}</p>` : `<div class="gallery" id="gallery">${tiles}</div>`}
</main>

<dialog id="lb">
  <div class="lb-wrap">
    <button class="lb-btn lb-close" data-i18n-aria="lightboxClose" aria-label="${escapeHtml(m.lightboxClose)}">×</button>
    <button class="lb-btn lb-prev" data-i18n-aria="lightboxPrev" aria-label="${escapeHtml(m.lightboxPrev)}">‹</button>
    <img id="lbimg" alt="">
    <button class="lb-btn lb-next" data-i18n-aria="lightboxNext" aria-label="${escapeHtml(m.lightboxNext)}">›</button>
    <div class="lb-bar">
      <span class="name" id="lbname"></span>
      ${canDownload ? `<a class="text-btn" id="lbdl" data-i18n="lightboxDownload" download>${escapeHtml(m.lightboxDownload)}</a>` : ''}
      ${canRaw ? `<a class="text-btn" id="lbraw" data-i18n="lightboxDownloadRaw" download>${escapeHtml(m.lightboxDownloadRaw)}</a>` : ''}
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
<meta name="robots" content="noindex, nofollow">
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
  <p id="landing-redirect" hidden></p>
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
<meta name="robots" content="noindex">
<title>${escapeHtml(m.notFoundTitle)}</title>
<style>
${paletteCss()}
${baseCss()}
${notFoundCss()}
</style>
</head>
<body>
  <main>
    <h1>${escapeHtml(m.notFoundTitle)}</h1>
    <p>${escapeHtml(m.notFoundBody)}</p>
  </main>
</body>
</html>`
}

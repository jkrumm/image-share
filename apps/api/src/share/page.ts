import { basename } from 'node:path'
import type { ImageRow, ShareRow } from '../db/schema.js'
import type { ShareTokenRole } from '../lib/share-auth.js'

// Server-rendered share HTML (design §7, role-based rework — see the Stage 3
// note below; this is a MINIMAL adaptation, not a redesign). ALL CSS + JS is
// inline — zero external requests. Dark, minimal, mobile-first. Every
// user-controlled string (title, note, filenames, slug) is HTML-escaped;
// token/id are URL-encoded into asset URLs.
//
// STAGE 3 NOTE: this file is scheduled for a full rewrite in stage 3 of the
// share rework — the changes here are the minimum to compile against the new
// role-based access model (source_type/title/note), not a design investment.
//
// NOTE ON STYLING: design §7 calls for basalt tokens via `buildPaletteCss()`
// from `basalt-ui/tokens`, but `basalt-ui` is NOT a dependency of apps/api and
// deps cannot be added here. Following the render404Page precedent, a small
// hardcoded dark (zinc) palette is inlined instead — this keeps the page fully
// self-contained (the load-bearing "zero external requests" requirement).

export interface SharePageInput {
  share: ShareRow
  images: ImageRow[]
  /** Threaded into every asset URL. */
  token: string
  role: ShareTokenRole
}

/** HTML-escape a string for use in text nodes and double-quoted attributes. */
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
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

/** YYYY-MM-DD portion of an ISO capture timestamp, or null. */
function dateOnly(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return d.toISOString().slice(0, 10)
}

const PALETTE = `
  :root {
    color-scheme: dark;
    --bg: #0a0a0a;
    --surface: #18181b;
    --surface-2: #27272a;
    --border: #3f3f46;
    --text: #e4e4e7;
    --muted: #a1a1aa;
    --accent: #e4e4e7;
  }
`

/**
 * Render the full responsive gallery page: a CSS grid of lazy `<img>` with
 * thumb/med srcset and a `<dialog>` lightbox (prev/next/keyboard/swipe, med or
 * full), a header with count + date range + "Download all (.zip)", and per-image
 * (+ RAW for full-role tokens) download links inside the lightbox. Download/
 * zip affordances are hidden entirely for view-role tokens.
 */
export function renderSharePage(input: SharePageInput): string {
  const { share, images, token, role } = input
  const slugU = encodeURIComponent(share.slug)
  const auth = authQuery(token)
  const canDownload = role !== 'view'
  const canRaw = role === 'full'
  const isFull = role !== 'view' // full-size rendition permitted in the lightbox

  const title = share.title
  const captureDates = images
    .map((i) => dateOnly(i.captureAt))
    .filter((d): d is string => d != null)
  const dateRange =
    captureDates.length === 0
      ? ''
      : captureDates[0] === captureDates[captureDates.length - 1]
        ? captureDates[0]
        : `${captureDates[0]} – ${captureDates[captureDates.length - 1]}`

  const cells = images
    .map((image, i) => {
      const name = displayName(image)
      const thumb = `/s/${slugU}/img/${image.id}?size=thumb&${auth}`
      const med = `/s/${slugU}/img/${image.id}?size=med&${auth}`
      const ratio =
        image.width && image.height ? ` style="aspect-ratio:${image.width}/${image.height}"` : ''
      return `<button class="cell" data-i="${i}" aria-label="${escapeHtml(name)}">
        <img loading="lazy" decoding="async"${ratio}
          src="${escapeHtml(thumb)}"
          srcset="${escapeHtml(thumb)} 480w, ${escapeHtml(med)} 1600w"
          sizes="(max-width: 640px) 50vw, 240px"
          alt="${escapeHtml(name)}">
      </button>`
    })
    .join('\n')

  // Client-side lightbox config. `token` is already in the visible URL — no
  // new secret is exposed. `<` is escaped so a malicious filename cannot break out.
  const cfg = {
    slug: share.slug,
    token,
    full: isFull,
    download: canDownload,
    raws: canRaw,
    imgs: images.map((image) => ({ id: image.id, name: displayName(image) })),
  }

  const zipUrl = `/s/${slugU}/zip?${auth}`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
${PALETTE}
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    background: var(--bg); color: var(--text);
    font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  header {
    position: sticky; top: 0; z-index: 5;
    display: flex; flex-wrap: wrap; align-items: center; gap: .75rem 1rem;
    padding: .9rem 1rem;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--border);
  }
  header h1 { font-size: 1rem; font-weight: 600; margin: 0; }
  header .meta { color: var(--muted); font-size: .85rem; }
  header .spacer { flex: 1 1 auto; }
  .note { color: var(--muted); font-size: .9rem; padding: 0 .75rem .5rem; white-space: pre-wrap; }
  .btn {
    display: inline-flex; align-items: center; gap: .4rem;
    padding: .5rem .85rem; border-radius: 8px; cursor: pointer;
    background: var(--surface-2); color: var(--text);
    border: 1px solid var(--border); font: inherit; font-size: .85rem;
    text-decoration: none;
  }
  .btn:hover { background: var(--border); }
  main { padding: .75rem; }
  .grid {
    display: grid; gap: .4rem;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  }
  .cell {
    padding: 0; border: 0; margin: 0; cursor: zoom-in; background: var(--surface);
    border-radius: 6px; overflow: hidden; aspect-ratio: 1 / 1;
  }
  .cell img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .empty { color: var(--muted); padding: 3rem 1rem; text-align: center; }
  dialog#lb {
    padding: 0; border: 0; max-width: 100vw; max-height: 100dvh;
    width: 100vw; height: 100dvh; background: rgba(0,0,0,.94); color: var(--text);
  }
  dialog#lb::backdrop { background: rgba(0,0,0,.9); }
  .lb-wrap { position: relative; width: 100%; height: 100%; display: grid; place-items: center; }
  #lbimg { max-width: 100vw; max-height: calc(100dvh - 3.5rem); object-fit: contain; touch-action: pan-y; }
  .lb-btn {
    position: absolute; top: 50%; transform: translateY(-50%);
    background: rgba(0,0,0,.45); color: #fff; border: 0; cursor: pointer;
    width: 3rem; height: 4rem; font-size: 2rem; line-height: 1;
  }
  .lb-btn:hover { background: rgba(0,0,0,.7); }
  .lb-prev { left: 0; } .lb-next { right: 0; }
  .lb-close { position: absolute; top: .5rem; right: .5rem; width: 2.5rem; height: 2.5rem; font-size: 1.5rem; }
  .lb-bar {
    position: absolute; left: 0; right: 0; bottom: 0;
    display: flex; align-items: center; gap: .75rem;
    padding: .5rem .75rem; background: rgba(0,0,0,.55); font-size: .85rem;
  }
  .lb-bar .name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
  @media (max-width: 640px) {
    .grid { grid-template-columns: repeat(auto-fill, minmax(46%, 1fr)); }
  }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <span class="meta">${images.length} photo${images.length === 1 ? '' : 's'}${dateRange ? ` · ${escapeHtml(dateRange)}` : ''}</span>
  <span class="spacer"></span>
  ${canDownload && images.length > 0 ? `<a class="btn" href="${escapeHtml(zipUrl)}">Download all (.zip)</a>` : ''}
</header>
${share.note ? `<p class="note">${escapeHtml(share.note)}</p>` : ''}
<main>
  ${images.length === 0 ? `<p class="empty">No photos in this share yet.</p>` : `<div class="grid">${cells}</div>`}
</main>

<dialog id="lb">
  <div class="lb-wrap">
    <button class="lb-btn lb-close" aria-label="Close">×</button>
    <button class="lb-btn lb-prev" aria-label="Previous">‹</button>
    <img id="lbimg" alt="">
    <button class="lb-btn lb-next" aria-label="Next">›</button>
    <div class="lb-bar">
      <span class="name" id="lbname"></span>
      ${canDownload ? `<a class="btn" id="lbdl" download>Download</a>` : ''}
      ${canRaw ? `<a class="btn" id="lbraw" download>RAW</a>` : ''}
    </div>
  </div>
</dialog>

<script>
const C = ${jsonForScript(cfg)};
(function () {
  const enc = encodeURIComponent;
  const auth = 'token=' + enc(C.token);
  const base = '/s/' + enc(C.slug);
  const lb = document.getElementById('lb');
  const img = document.getElementById('lbimg');
  const name = document.getElementById('lbname');
  const dl = document.getElementById('lbdl');
  const raw = document.getElementById('lbraw');
  let idx = 0;

  function viewUrl(im) {
    const size = C.full ? 'full' : 'med';
    return base + '/img/' + im.id + '?size=' + size + '&' + auth;
  }
  function show(i) {
    if (i < 0) i = C.imgs.length - 1;
    if (i >= C.imgs.length) i = 0;
    idx = i;
    const im = C.imgs[idx];
    img.src = viewUrl(im);
    img.alt = im.name;
    name.textContent = im.name;
    if (dl) dl.href = base + '/file/' + im.id + '?' + auth;
    if (raw) raw.href = base + '/file/' + im.id + '?raw=1&' + auth;
  }
  function open(i) { show(i); if (!lb.open) lb.showModal(); }
  function close() { lb.close(); img.src = ''; }

  document.querySelectorAll('.cell').forEach(function (el) {
    el.addEventListener('click', function () { open(Number(el.dataset.i)); });
  });
  lb.querySelector('.lb-close').addEventListener('click', close);
  lb.querySelector('.lb-prev').addEventListener('click', function () { show(idx - 1); });
  lb.querySelector('.lb-next').addEventListener('click', function () { show(idx + 1); });
  lb.addEventListener('cancel', function () { img.src = ''; });
  document.addEventListener('keydown', function (e) {
    if (!lb.open) return;
    if (e.key === 'ArrowLeft') show(idx - 1);
    else if (e.key === 'ArrowRight') show(idx + 1);
  });

  let sx = 0, sy = 0;
  img.addEventListener('touchstart', function (e) {
    const t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY;
  }, { passive: true });
  img.addEventListener('touchend', function (e) {
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) show(dx < 0 ? idx + 1 : idx - 1);
  }, { passive: true });
})();
</script>
</body>
</html>`
}

/**
 * The single opaque denial page (design §7). Fully implemented — every share
 * failure (missing/unknown slug, wrong/rolled/expired/revoked token, id
 * outside the share, or a size/role the token does not permit) collapses to
 * this exact response, never distinguishing cases.
 */
export function render404Page(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Not found</title>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; margin: 0; }
  body {
    display: grid; place-items: center;
    background: #0a0a0a; color: #e5e5e5;
    font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    padding: 2rem; text-align: center;
  }
  p { max-width: 32rem; color: #a3a3a3; }
</style>
</head>
<body>
  <main>
    <h1>This share does not exist or has been revoked</h1>
    <p>The link may be mistyped, the access token may have been rolled, or the share may have expired.</p>
  </main>
</body>
</html>`
}

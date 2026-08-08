// All CSS for the share + landing + 404 pages, as plain strings — inlined into
// a single `<style>` block per page (Stage 3 brief: zero external requests).
// Ported design language: no cards, no shadows, no border radius on images,
// no hover chrome — whitespace and restraint (brief §A).

/**
 * Palette + `color-scheme` (brief §A). `data-theme` on `<html>` (set by the
 * inline head script from `localStorage['image-share.theme']`) forces an
 * explicit light/dark choice; its absence means "system" (the default),
 * which falls through to the `prefers-color-scheme` media query.
 */
export function paletteCss(): string {
  return `
:root {
  color-scheme: light;
  --bg: #ffffff;
  --fg: #18181b;
  --muted: #6b7280;
  --surface: #f4f4f5;
  --border: #e4e4e7;
  --focus: #2563eb;
}
:root[data-theme='dark'] {
  color-scheme: dark;
  --bg: #121212;
  --fg: #ededed;
  --muted: #8b8b8b;
  --surface: #1e1e1e;
  --border: #2c2c2c;
  --focus: #7aa2ff;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    color-scheme: dark;
    --bg: #121212;
    --fg: #ededed;
    --muted: #8b8b8b;
    --surface: #1e1e1e;
    --border: #2c2c2c;
    --focus: #7aa2ff;
  }
}`
}

/**
 * Page geometry custom properties. These live in `baseCss` — NOT in `viewsCss`
 * — deliberately: `--pad-x`/`--pad-y` are referenced by the landing page and by
 * shared header/empty-state rules, and `renderLandingPage`/`render404Page` do
 * not emit `viewsCss`. Defining them there is what shipped the landing page
 * with `padding: var(--pad-x)` resolving to nothing, i.e. text flush against
 * the top-left corner (observed in production).
 */
const GEOMETRY = `
:root { --pad-x: 1rem; --pad-y: 1.25rem; --vh-deduct: 20px; --tap: 44px; }
@media (min-width: 640px)  { :root { --pad-x: 2.5rem; --pad-y: 2.5rem; --vh-deduct: 40px; } }
@media (min-width: 768px)  { :root { --vh-deduct: 90px; } }
@media (min-width: 1024px) { :root { --pad-x: 5rem;  --pad-y: 5rem;  --vh-deduct: 120px; } }`

/** Shared reset + typography (brief §A) + the reduced-motion kill switch. */
export function baseCss(): string {
  return `${GEOMETRY}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
/* The UA stylesheet's \`[hidden] { display: none }\` sits at specificity
   (0,1,0) — tied with any single-class author rule (\`.switcher-menu { display:
   flex }\`) and beaten outright by a two-class one (\`.actions .text-btn {
   display: inline-flex }\`). A tie goes to whichever rule is LATER in the
   cascade, which is always the author stylesheet, so \`hidden\` silently
   stopped hiding \`#switcherBtn\`/\`#switcherMenu\` the moment they picked up a
   display-setting class — confirmed live: both rendered visibly with
   \`hidden=true\` still on the element. \`!important\` here is deliberate and
   global, not a one-off: it is the only way to guarantee \`hidden\` always wins
   regardless of what display rule a future element's class happens to carry. */
[hidden] { display: none !important; }
body {
  background: var(--bg);
  color: var(--fg);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-text-size-adjust: 100%;
}
h1 {
  font-size: clamp(1.5rem, 4vw, 2.25rem);
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0 0 .5rem;
}
p { margin: 0 0 .75rem; }
.meta { font-size: .875rem; color: var(--muted); margin: 0 0 .75rem; }
.note { font-size: 1rem; line-height: 1.7; max-width: 65ch; }
.note :is(p, ul) { margin: 0 0 1rem; }
.note :last-child { margin-bottom: 0; }
.note a { color: var(--fg); }
a { color: inherit; }
button { font-family: inherit; }
.text-btn {
  appearance: none; border: 0; background: none; padding: 0;
  color: var(--muted); font: inherit; font-size: .875rem;
  text-decoration: underline; text-underline-offset: 2px; cursor: pointer;
}
.text-btn:hover { color: var(--fg); }
/* Keyboard-only focus ring. There was none anywhere before, so a keyboard or
   switch-control visitor had no idea where they were on the page. */
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.tile-btn:focus-visible { outline-offset: -3px; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}`
}

const EASE = 'cubic-bezier(0.4,0,0.2,1)'

/**
 * Sticky control bar: 3 segmented groups with a sliding pill (brief §D).
 * Buttons meet the 44px iOS minimum tap target; nine 32px buttons wrapped to
 * two rows on a 360px phone AND were below the accessible minimum.
 */
export function controlsCss(): string {
  return `
.topbar {
  position: sticky; top: 0; z-index: 10;
  display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: .5rem;
  padding: .375rem .5rem;
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border);
}
.segmented {
  position: relative; display: inline-flex; gap: .1rem;
  padding: .2rem; border-radius: 999px;
  background: var(--surface); border: 1px solid var(--border);
}
.segmented .pill {
  position: absolute; top: .2rem; bottom: .2rem; left: .2rem; width: 0;
  border-radius: 999px; background: var(--bg); border: 1px solid var(--border);
  transition: transform 220ms ${EASE}, width 220ms ${EASE};
}
/* No-JS fallback: the pill is positioned by script, so without JS it stays
   0px wide and all nine buttons look identically unselected. Give the pressed
   button its own visible chip so the current view/theme/language is legible
   with scripting off — the server now emits the true aria-pressed state. */
.segmented button[aria-pressed='true'] {
  background: var(--bg); border: 1px solid var(--border);
}
:root.js .segmented button[aria-pressed='true'] { background: transparent; border-color: transparent; }
.segmented button {
  position: relative; z-index: 1;
  display: inline-flex; align-items: center; justify-content: center;
  min-width: var(--tap); height: var(--tap); padding: 0 .5rem;
  border: 1px solid transparent; background: transparent; color: var(--muted); cursor: pointer;
  border-radius: 999px; font-size: .8125rem; font-weight: 600;
  transition: color 220ms ${EASE};
}
.segmented button[aria-pressed='true'] { color: var(--fg); }
.segmented svg { width: 1.15rem; height: 1.15rem; }
.segmented svg { fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
/* Nine 44px-wide buttons plus their gaps need 463px — so the "iOS minimum"
   wrapped the sticky bar to two rows (~126px, 15% of the viewport, pinned above
   the photos on every scroll) on EVERY iPhone, 390px and 440px alike. Below
   420px the buttons keep the full 44px HEIGHT — the axis a thumb actually
   misses — and narrow to 34px, which still clears the WCAG 2.2 target-size
   minimum by a wide margin and fits three groups on a 360px screen. */
@media (max-width: 420px) {
  .topbar { gap: .25rem; padding: .375rem .25rem; }
  .segmented { gap: 0; padding: .15rem; }
  .segmented .pill { top: .15rem; bottom: .15rem; left: .15rem; }
  .segmented button { min-width: 2.125rem; padding: 0 .25rem; }
}`
}

/** Header content (title/meta/note/actions) shared by every view (brief §B). */
export function headCss(): string {
  return `
.head { padding: var(--pad-y) var(--pad-x) 0; }
.actions { display: flex; align-items: center; gap: 1.25rem; flex-wrap: wrap; margin: .5rem 0 1rem; }
.actions .text-btn { min-height: var(--tap); display: inline-flex; align-items: center; }
/* The ZIP control carries its own size + count, because Bun drops the
   Content-Length on a streamed response and the browser therefore shows the
   visitor no progress bar and no ETA on a multi-GB download. */
.zip-btn { gap: .5rem; }
.zip-btn .zip-meta { color: var(--muted); text-decoration: none; font-variant-numeric: tabular-nums; }
.zip-btn[aria-busy='true'] { opacity: .6; cursor: progress; }
/* Replaces the ZIP control entirely when the archive exceeds
   SHARE_ZIP_MAX_BYTES (design §7) — explanatory copy, not a dead link. */
.zip-toolarge { max-width: 34rem; font-size: .875rem; }
.zip-toolarge-body { margin: 0; }
.zip-toolarge-hint { margin: .375rem 0 0; color: var(--muted); }
.switcher-menu {
  display: flex; flex-direction: column; gap: .25rem;
  padding: .75rem var(--pad-x); margin: 0 calc(var(--pad-x) * -1) 1rem;
  border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
  font-size: .875rem;
}
.switcher-menu .switcher-heading { color: var(--muted); font-size: .8125rem; }
.switcher-menu a { text-decoration: underline; text-underline-offset: 2px; min-height: var(--tap); display: flex; align-items: center; }
.empty { color: var(--muted); padding: 3rem var(--pad-x); text-align: center; }
.noscript-hint { color: var(--muted); font-size: .875rem; padding: 0 var(--pad-x) 1rem; }
.more { display: flex; flex-direction: column; align-items: center; gap: .375rem; padding: 0 var(--pad-x) var(--pad-y); }
.more a { min-height: var(--tap); display: inline-flex; align-items: center; }
.more a[aria-busy='true'] { opacity: .6; cursor: progress; }
.more-error { color: var(--muted); font-size: .8125rem; text-align: center; }`
}

/**
 * The three gallery views (brief §C). `data-view` lives on `<html>`; every
 * rule below is scoped by it so the same tile markup renders three ways.
 * Stream geometry is ported verbatim from the reference gallery.
 */
export function viewsCss(): string {
  return `
.gallery { view-transition-name: gallery; }
.tile { position: relative; margin: 0; }
.tile-btn {
  display: block; width: 100%; padding: 0; border: 0; margin: 0;
  background: none; cursor: zoom-in; text-decoration: none;
}
.tile-btn img { display: block; }
/* Placeholder + decode fade-in. A cold share on the dark theme was a wall of
   flat #121212 rectangles with nothing to indicate anything was coming.
   Gated on \`:root.js\` so a no-JS visitor never gets stuck at opacity 0 —
   \`.is-loaded\` is only ever set by script. */
.tile-ph .tile-btn { background: var(--surface); }
:root.js .tile-img { opacity: 0; transition: opacity 260ms ${EASE}; }
:root.js .tile-img.is-loaded { opacity: 1; }

/* The stream's generous padding belongs to the FIGURE, and the click target is
   the anchor inside it — the handler used to sit on \`.tile\`, so tapping up to
   5rem of empty whitespace between photos opened the lightbox. */
[data-view='stream'] .tile { padding: var(--pad-y) var(--pad-x); }
[data-view='stream'] .tile-btn img {
  width: 100%; height: auto; max-width: 1680px;
  max-height: calc(100vh - var(--vh-deduct));
  aspect-ratio: var(--ratio, 3/2);
  object-fit: contain; margin-inline: auto;
}

[data-view='grid'] .gallery, [data-view='bento'] .gallery {
  display: grid; padding: 0 var(--pad-x) var(--pad-y);
}
[data-view='grid'] .gallery { grid-template-columns: repeat(2, 1fr); gap: 4px; }
/* Two columns means a landscape tile IS the full content width, so its row
   height has to follow that width instead of a fixed 140px: the library is 3:2,
   and 140px cropped ~40% off every frame and turned the whole view into 2.5:1
   letterbox strips. (W - gap)/3 per row × 2 rows + the gap ≈ W / 1.5, i.e. an
   uncropped 3:2 — see \`narrowRowSpan\` in layout.ts, which is what gives a
   full-width tile its two rows here. */
[data-view='bento'] .gallery {
  grid-template-columns: repeat(2, 1fr); grid-auto-flow: dense; gap: 4px;
  grid-auto-rows: calc((100vw - 2 * var(--pad-x) - 4px) / 3);
}
@media (min-width: 640px) {
  [data-view='grid'] .gallery { grid-template-columns: repeat(3, 1fr); gap: 8px; }
  [data-view='bento'] .gallery { grid-template-columns: repeat(3, 1fr); grid-auto-rows: 170px; gap: 8px; }
}
@media (min-width: 1024px) {
  [data-view='grid'] .gallery { grid-template-columns: repeat(4, 1fr); }
  [data-view='bento'] .gallery { grid-template-columns: repeat(4, 1fr); grid-auto-rows: 200px; }
}
[data-view='grid'] .tile { aspect-ratio: 1/1; }
[data-view='grid'] .tile-btn, [data-view='bento'] .tile-btn { height: 100%; width: 100%; }
[data-view='grid'] .tile-btn img, [data-view='bento'] .tile-btn img {
  width: 100%; height: 100%; object-fit: cover;
}
/* Mobile-first, matching the min-width breakpoints above: the 2-column grid
   uses the narrow row span, every wider grid uses the real one. */
[data-view='bento'] .tile {
  grid-column: span var(--col-span, 1);
  grid-row: span var(--row-span-narrow, var(--row-span, 1));
}
@media (min-width: 640px) {
  [data-view='bento'] .tile { grid-row: span var(--row-span, 1); }
}

/* Non-View-Transitions fallback crossfade for a view switch (brief §D). */
main.view-fade { opacity: 0; transform: scale(0.98); transition: opacity 220ms ${EASE}, transform 220ms ${EASE}; }

::view-transition-old(gallery), ::view-transition-new(gallery) {
  animation-duration: 220ms; animation-timing-function: ${EASE};
}`
}

/** `<dialog>` lightbox (brief §G) — phone-first. */
export function lightboxCss(): string {
  return `
dialog#lb {
  padding: 0; border: 0; width: 100vw; height: 100dvh; max-width: 100vw; max-height: 100dvh;
  background: var(--bg); color: var(--fg);
}
dialog#lb::backdrop { background: rgb(0 0 0 / 0.92); }
dialog#lb[open] { animation: lb-in 240ms ${EASE}; }
@keyframes lb-in { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: scale(1); } }
.lb-wrap {
  position: relative; width: 100%; height: 100%;
  display: grid; place-items: center; background: rgb(0 0 0 / 0.92);
  /* Horizontal swipe + swipe-to-dismiss are handled in script; \`pinch-zoom\`
     keeps the browser's own pinch gesture — the single most common gesture in
     a photo gallery, which the old \`pan-y\` disabled outright. */
  touch-action: pinch-zoom;
}
.lb-stage { position: relative; display: grid; place-items: center; width: 100%; height: 100%; }
#lbimg {
  max-width: 100vw; max-height: calc(100dvh - 8rem); object-fit: contain;
  transition: opacity 160ms ${EASE};
}
.lb-stage[data-loading='1'] #lbimg { opacity: .45; }
.lb-spin {
  position: absolute; width: 2.25rem; height: 2.25rem; border-radius: 50%;
  border: 2px solid rgb(255 255 255 / 0.25); border-top-color: #fff;
  animation: lb-spin 700ms linear infinite; pointer-events: none;
}
@keyframes lb-spin { to { transform: rotate(360deg); } }
.lb-error {
  position: absolute; max-width: 80vw; padding: .6rem 1rem; border-radius: .5rem;
  background: rgb(0 0 0 / 0.72); color: #fff; font-size: .85rem; text-align: center;
  pointer-events: none;
}
.lb-btn {
  position: absolute; top: 50%; transform: translateY(-50%);
  background: rgb(255 255 255 / 0.08); color: #fff; border: 0; cursor: pointer;
  width: 3rem; height: 4rem; font-size: 2rem; line-height: 1;
}
.lb-btn:hover { background: rgb(255 255 255 / 0.18); }
.lb-prev { left: 0; } .lb-next { right: 0; }
/* Below the notch/Dynamic Island on a 100dvh dialog — the old 2.5rem × at
   top:.5rem sat underneath it on an iPhone and could not be tapped. */
.lb-close {
  position: absolute; transform: none;
  top: calc(env(safe-area-inset-top, 0px) + .5rem); right: .5rem;
  width: var(--tap); height: var(--tap); font-size: 1.5rem;
  border-radius: 999px;
}
.lb-bar {
  position: absolute; left: 0; right: 0; bottom: 0;
  display: flex; align-items: center; flex-wrap: wrap; gap: .5rem 1.25rem;
  padding: .5rem 1rem calc(env(safe-area-inset-bottom, 0px) + .5rem);
  background: rgb(0 0 0 / 0.62); font-size: .85rem; color: #fff;
}
.lb-bar .lb-id { display: flex; align-items: baseline; gap: .6rem; flex: 1 1 12rem; min-width: 0; }
.lb-bar .lb-count { font-variant-numeric: tabular-nums; color: #fff; }
.lb-bar .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgb(255 255 255 / 0.7); }
.lb-bar .lb-date { color: rgb(255 255 255 / 0.7); white-space: nowrap; }
.lb-bar a.text-btn {
  color: #fff; min-height: var(--tap); display: inline-flex; align-items: center; gap: .4rem;
}
.lb-bar .lb-size { color: rgb(255 255 255 / 0.7); text-decoration: none; font-variant-numeric: tabular-nums; }
.lb-bar .lb-hint { color: rgb(255 255 255 / 0.7); text-decoration: none; font-size: .78rem; }
.lb-bar :focus-visible { outline-color: #fff; }`
}

/** Landing page (brief §I) — deliberately minimal, no per-share knowledge server-side. */
export function landingCss(): string {
  return `
main { max-width: 40rem; margin: 0 auto; padding: var(--pad-y) var(--pad-x); }
.share-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0; }
.share-row {
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  padding: .5rem 0; border-bottom: 1px solid var(--border);
}
.share-row a { text-decoration: none; display: flex; flex-direction: column; gap: .15rem; min-height: var(--tap); justify-content: center; flex: 1 1 auto; }
.share-row a:hover { text-decoration: underline; }
.share-row .text-btn { min-height: var(--tap); }
.share-row .share-meta { font-size: .875rem; color: var(--muted); }`
}

/** Shared minimal centered layout for the opaque 404 page. */
export function notFoundCss(): string {
  return `
html, body { height: 100%; }
body { display: grid; place-items: center; padding: 2rem; text-align: center; }
main { max-width: 32rem; }
main p { color: var(--muted); }`
}

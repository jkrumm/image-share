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
}
:root[data-theme='dark'] {
  color-scheme: dark;
  --bg: #121212;
  --fg: #ededed;
  --muted: #8b8b8b;
  --surface: #1e1e1e;
  --border: #2c2c2c;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    color-scheme: dark;
    --bg: #121212;
    --fg: #ededed;
    --muted: #8b8b8b;
    --surface: #1e1e1e;
    --border: #2c2c2c;
  }
}`
}

/** Shared reset + typography (brief §A) + the reduced-motion kill switch. */
export function baseCss(): string {
  return `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
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
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}`
}

const EASE = 'cubic-bezier(0.4,0,0.2,1)'

/** Sticky control bar: 3 segmented groups with a sliding pill (brief §D). */
export function controlsCss(): string {
  return `
.topbar {
  position: sticky; top: 0; z-index: 10;
  display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: .5rem;
  padding: .5rem .75rem;
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border);
}
.segmented {
  position: relative; display: inline-flex; gap: .15rem;
  padding: .2rem; border-radius: 999px;
  background: var(--surface); border: 1px solid var(--border);
}
.segmented .pill {
  position: absolute; top: .2rem; bottom: .2rem; left: .2rem; width: 0;
  border-radius: 999px; background: var(--bg); border: 1px solid var(--border);
  transition: transform 220ms ${EASE}, width 220ms ${EASE};
}
.segmented button {
  position: relative; z-index: 1;
  display: inline-flex; align-items: center; justify-content: center;
  width: 2rem; height: 2rem; padding: 0 .5rem; min-width: 2rem;
  border: 0; background: transparent; color: var(--muted); cursor: pointer;
  border-radius: 999px; font-size: .75rem; font-weight: 600;
  transition: color 220ms ${EASE};
}
.segmented button[aria-pressed='true'] { color: var(--fg); }
.segmented svg { width: 1.1rem; height: 1.1rem; }
.segmented svg { fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }`
}

/** Header content (title/meta/note/actions) shared by every view (brief §B). */
export function headCss(): string {
  return `
.head { padding: var(--pad-y) var(--pad-x) 0; }
.actions { display: flex; align-items: center; gap: 1.25rem; flex-wrap: wrap; margin: .5rem 0 1rem; }
.switcher-menu {
  display: flex; flex-direction: column; gap: .25rem;
  padding: .75rem var(--pad-x); margin: 0 calc(var(--pad-x) * -1) 1rem;
  border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
  font-size: .875rem;
}
.switcher-menu a { text-decoration: underline; text-underline-offset: 2px; }
.empty { color: var(--muted); padding: 3rem var(--pad-x); text-align: center; }`
}

/**
 * The three gallery views (brief §C). `data-view` lives on `<html>`; every
 * rule below is scoped by it so the same tile markup renders three ways.
 * Stream geometry is ported verbatim from the reference gallery.
 */
export function viewsCss(): string {
  return `
:root { --pad-x: 1rem; --pad-y: 1.25rem; --vh-deduct: 20px; }
@media (min-width: 640px)  { :root { --pad-x: 2.5rem; --pad-y: 2.5rem; --vh-deduct: 40px; } }
@media (min-width: 768px)  { :root { --vh-deduct: 90px; } }
@media (min-width: 1024px) { :root { --pad-x: 5rem;  --pad-y: 5rem;  --vh-deduct: 120px; } }

.gallery { view-transition-name: gallery; }
.tile { position: relative; }
.tile-btn {
  display: block; width: 100%; padding: 0; border: 0; margin: 0;
  background: none; cursor: zoom-in;
}
.tile-btn img { display: block; }

[data-view='stream'] .tile { margin: 0; padding: var(--pad-y) var(--pad-x); }
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
[data-view='bento'] .gallery { grid-template-columns: repeat(2, 1fr); grid-auto-flow: dense; grid-auto-rows: 140px; gap: 4px; }
@media (min-width: 640px) {
  [data-view='grid'] .gallery { grid-template-columns: repeat(3, 1fr); gap: 8px; }
  [data-view='bento'] .gallery { grid-template-columns: repeat(3, 1fr); grid-auto-rows: 170px; gap: 8px; }
}
@media (min-width: 1024px) {
  [data-view='grid'] .gallery { grid-template-columns: repeat(4, 1fr); }
  [data-view='bento'] .gallery { grid-template-columns: repeat(4, 1fr); grid-auto-rows: 200px; }
}
[data-view='grid'] .tile, [data-view='bento'] .tile { margin: 0; }
[data-view='grid'] .tile { aspect-ratio: 1/1; }
[data-view='grid'] .tile-btn, [data-view='bento'] .tile-btn { height: 100%; }
[data-view='grid'] .tile-btn img, [data-view='bento'] .tile-btn img {
  width: 100%; height: 100%; object-fit: cover;
}
[data-view='bento'] .tile { grid-column: span var(--col-span, 1); grid-row: span var(--row-span, 1); }

/* Non-View-Transitions fallback crossfade for a view switch (brief §D). */
main.view-fade { opacity: 0; transform: scale(0.98); transition: opacity 220ms ${EASE}, transform 220ms ${EASE}; }

::view-transition-old(gallery), ::view-transition-new(gallery) {
  animation-duration: 220ms; animation-timing-function: ${EASE};
}`
}

/** `<dialog>` lightbox (brief §G). */
export function lightboxCss(): string {
  return `
dialog#lb {
  padding: 0; border: 0; width: 100vw; height: 100dvh; max-width: 100vw; max-height: 100dvh;
  background: var(--bg); color: var(--fg);
}
dialog#lb::backdrop { background: rgb(0 0 0 / 0.92); }
dialog#lb[open] { animation: lb-in 240ms ${EASE}; }
@keyframes lb-in { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: scale(1); } }
.lb-wrap { position: relative; width: 100%; height: 100%; display: grid; place-items: center; background: rgb(0 0 0 / 0.92); }
#lbimg { max-width: 100vw; max-height: calc(100dvh - 3.5rem); object-fit: contain; touch-action: pan-y; }
.lb-btn {
  position: absolute; top: 50%; transform: translateY(-50%);
  background: rgb(255 255 255 / 0.08); color: #fff; border: 0; cursor: pointer;
  width: 3rem; height: 4rem; font-size: 2rem; line-height: 1;
}
.lb-btn:hover { background: rgb(255 255 255 / 0.18); }
.lb-prev { left: 0; } .lb-next { right: 0; }
.lb-close { position: absolute; top: .5rem; right: .5rem; width: 2.5rem; height: 2.5rem; font-size: 1.5rem; }
.lb-bar {
  position: absolute; left: 0; right: 0; bottom: 0;
  display: flex; align-items: center; gap: 1.25rem;
  padding: .75rem 1rem; background: rgb(0 0 0 / 0.55); font-size: .85rem; color: #fff;
}
.lb-bar .name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgb(255 255 255 / 0.7); }
.lb-bar a.text-btn { color: #fff; }`
}

/** Landing page (brief §I) — deliberately minimal, no per-share knowledge server-side. */
export function landingCss(): string {
  return `
main { max-width: 40rem; margin: 0 auto; padding: var(--pad-y) var(--pad-x); }
.share-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0; }
.share-row {
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  padding: 1rem 0; border-bottom: 1px solid var(--border);
}
.share-row a { text-decoration: none; }
.share-row a:hover { text-decoration: underline; }
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

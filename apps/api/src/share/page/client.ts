// Inline client-side JS for the share page (Stage 3 briefs §D/§E/§G/§I).
// Shipped as two `<script>` blocks: `headScript()` — tiny, runs in `<head>`,
// applies the stored view/theme/lang before first paint — and `mainScript()`
// — the full behavior (segmented controls, lightbox, i18n swap, progressive
// reveal, remembered shares), placed at the end of `<body>`.
//
// View Transitions API note (brief §D): same-document
// `document.startViewTransition(callback)` — the plain-callback form, which
// is the stable, longest-supported shape (the newer `{ update, types }`
// options-object form adds named/typed transitions this page doesn't need).
// Feature-detected, with a CSS opacity/scale crossfade fallback for browsers
// without it: Chrome/Edge 111+, Safari 18+, Firefox 144+ (caniuse, 2026-07).
//
// The reduced-motion guard below is NOT redundant with the CSS one in
// styles.ts: the API does not consult `prefers-reduced-motion` itself, so a
// transition would otherwise still run and animate. Both layers stay.

export const LS_VIEW = 'image-share.view'
const LS_THEME = 'image-share.theme'
const LS_LANG = 'image-share.lang'
const LS_SHARES = 'image-share.shares'
// sessionStorage, not localStorage: it marks "this tab already bounced to that
// share once", which is exactly a per-visit fact (see `landingScript`).
const SS_REDIRECTED = 'image-share.redirected'

/**
 * Per-view `sizes` attribute. Shared verbatim between the server (which emits
 * the value for the DEFAULT view into the HTML) and `headScript` (which
 * rewrites it for the visitor's STORED view before the preload scanner
 * commits). Keep the two in step — a stale copy costs a wasted 1600px fetch
 * per tile on a 4-column retina grid.
 */
export const SIZES_BY_VIEW = {
  stream:
    '(min-width:1024px) min(1680px, calc(100vw - 160px)), (min-width:640px) calc(100vw - 80px), calc(100vw - 32px)',
  grid: '(min-width:1024px) 25vw, (min-width:640px) 33vw, 50vw',
  bento: '(min-width:1024px) 50vw, (min-width:640px) 66vw, 100vw',
} as const

export type ViewName = keyof typeof SIZES_BY_VIEW

const SIZES_JSON = JSON.stringify(SIZES_BY_VIEW)

/**
 * Runs in `<head>`, before body paint.
 *
 * Three jobs: mark the document as script-enabled (`:root.js` gates every
 * progressive-enhancement-only style, so a no-JS visitor never gets stuck with
 * `opacity: 0` tiles or an invisible segmented selection), apply the stored
 * view/theme/lang to `<html>`, and — the non-obvious one — fix each tile's
 * `sizes` attribute as it is parsed.
 *
 * That last part exists because the HTML always ships the STREAM `sizes`
 * (the server cannot know a client-side stored preference without becoming
 * request-dependent). A returning visitor whose stored view is `grid` would
 * otherwise have the preload scanner commit to full-viewport-width candidates
 * for a 4-column grid — the single worst possible mis-selection. `mainScript`
 * runs at end-of-body, far too late. A `MutationObserver` installed here sees
 * each `img` at parse time, ahead of the scanner's fetch for lazy images and
 * ahead of layout for the eager one — NOT ahead of the eager one's own fetch:
 * `loading="eager" fetchpriority="high"` (tile 0 only, `index.ts`) is
 * discovered by the preload scanner directly off the raw byte stream, before
 * any script runs and before the DOM node this observer reacts to even
 * exists, so no client-side repair can reach it in time for tile 0. See the
 * `sizes` comment in `page/index.ts`'s `tileHtml` for why that residual gap
 * is accepted rather than closed with a cookie.
 */
export function headScript(): string {
  return `(function () {
  try {
    var root = document.documentElement;
    root.className += (root.className ? ' ' : '') + 'js';
    var view = localStorage.getItem('${LS_VIEW}');
    view = (view === 'bento' || view === 'grid') ? view : 'stream';
    root.setAttribute('data-view', view);
    var theme = localStorage.getItem('${LS_THEME}');
    if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
    var lang = localStorage.getItem('${LS_LANG}');
    if (lang === 'de' || lang === 'en' || lang === 'es') root.setAttribute('lang', lang);

    if (view !== 'stream' && typeof MutationObserver === 'function') {
      var sizes = ${SIZES_JSON}[view];
      var fix = function (node) {
        if (!node || node.nodeType !== 1) return;
        if (node.tagName === 'IMG' && node.hasAttribute('srcset')) node.setAttribute('sizes', sizes);
        else if (node.querySelectorAll) {
          var found = node.querySelectorAll('img[srcset]');
          for (var i = 0; i < found.length; i++) found[i].setAttribute('sizes', sizes);
        }
      };
      var mo = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var added = records[i].addedNodes;
          for (var j = 0; j < added.length; j++) fix(added[j]);
        }
      });
      mo.observe(root, { childList: true, subtree: true });
      document.addEventListener('DOMContentLoaded', function () { fix(document.body); mo.disconnect(); });
    }
  } catch (e) {}
})();`
}

/**
 * The full share-page behavior. `cfgJson`/`catalogueJson` are pre-serialized
 * (via `jsonForScript` in index.ts) so this stays a pure string template —
 * no data leaves this file un-escaped.
 */
export function mainScript(cfgJson: string, catalogueJson: string): string {
  return `(function () {
  var C = ${cfgJson};
  var CATALOGUE = ${catalogueJson};
  var SIZES = ${SIZES_JSON};
  var root = document.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var lang = root.getAttribute('lang') || 'en';
  var enc = encodeURIComponent;

  // ---- i18n ----
  function t(key) {
    var forLang = CATALOGUE[lang] || CATALOGUE.en;
    return forLang[key] || CATALOGUE.en[key] || '';
  }
  function fill(template, values) {
    return String(template).replace(/\\{(\\w+)\\}/g, function (match, key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match;
    });
  }
  function photoCount(n) {
    if (lang === 'de') return n === 1 ? '1 Foto' : (n + ' Fotos');
    if (lang === 'es') return n === 1 ? '1 foto' : (n + ' fotos');
    return n === 1 ? '1 photo' : (n + ' photos');
  }
  // Mirror of formatBytes() in i18n.ts — decimal units, same rounding.
  var BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB'];
  function formatBytes(bytes) {
    if (!isFinite(bytes) || bytes <= 0) return '0 B';
    var unit = 0, value = bytes;
    while (value >= 1000 && unit < BYTE_UNITS.length - 1) { value /= 1000; unit++; }
    var digits = unit === 0 ? 0 : (value < 10 ? 1 : 0);
    try {
      return new Intl.NumberFormat(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value) + ' ' + BYTE_UNITS[unit];
    } catch (e) { return value.toFixed(digits) + ' ' + BYTE_UNITS[unit]; }
  }
  function formatDay(iso) {
    if (!iso) return '';
    try { return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso)); }
    catch (e) { return ''; }
  }
  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
    updateAlts();
    updateZipLabel();
  }
  function formatDateRange(dates) {
    if (!dates || dates.length === 0) return '';
    try {
      var long = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'long', year: 'numeric' });
      var first = new Date(dates[0]);
      var last = new Date(dates[dates.length - 1]);
      if (dates[0] === dates[dates.length - 1]) return long.format(first);
      var short = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'numeric' });
      return short.format(first) + ' – ' + long.format(last);
    } catch (e) { return ''; }
  }
  function updateMeta() {
    var el = document.getElementById('meta');
    if (!el) return;
    var range = formatDateRange(C.dates);
    var count = photoCount(C.total);
    el.textContent = range ? (range + ' · ' + count) : count;
  }

  // ---- theme ----
  function applyTheme(pref) {
    if (pref === 'dark' || pref === 'light') root.setAttribute('data-theme', pref);
    else root.removeAttribute('data-theme');
  }

  // ---- segmented controls (sliding pill, brief §D) ----
  function initGroup(name, getValue, onSelect) {
    var group = document.querySelector('.segmented[data-group="' + name + '"]');
    if (!group) return function () {};
    var pill = group.querySelector('.pill');
    var buttons = Array.prototype.slice.call(group.querySelectorAll('button'));
    function place(instant) {
      var value = getValue();
      var active = null;
      for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].dataset.value === value) { active = buttons[i]; break; }
      }
      if (!active) active = buttons[0];
      buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b === active)); });
      if (!pill || !active) return;
      if (instant || reduceMotion) pill.style.transition = 'none';
      pill.style.width = active.offsetWidth + 'px';
      pill.style.transform = 'translateX(' + (active.offsetLeft - group.clientLeft) + 'px)';
      if (instant || reduceMotion) {
        void pill.offsetWidth;
        pill.style.transition = '';
      }
    }
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        onSelect(btn.dataset.value);
        place(false);
      });
    });
    window.addEventListener('resize', function () { place(true); });
    return place;
  }

  function switchView(view) {
    try { localStorage.setItem('${LS_VIEW}', view); } catch (e) {}
    function apply() { root.setAttribute('data-view', view); updateSizes(view); }
    if (reduceMotion || typeof document.startViewTransition !== 'function') {
      if (reduceMotion) { apply(); return; }
      var main = document.querySelector('main');
      if (!main) { apply(); return; }
      main.classList.add('view-fade');
      requestAnimationFrame(function () {
        apply();
        requestAnimationFrame(function () { main.classList.remove('view-fade'); });
      });
      return;
    }
    document.startViewTransition(apply);
  }

  function currentView() { return root.getAttribute('data-view') || 'stream'; }
  function updateSizes(view) {
    var val = SIZES[view] || SIZES.stream;
    document.querySelectorAll('.tile img').forEach(function (img) { img.setAttribute('sizes', val); });
  }

  initGroup('view', currentView, switchView)(true);
  initGroup('theme', function () {
    try { return localStorage.getItem('${LS_THEME}') || 'system'; } catch (e) { return 'system'; }
  }, function (v) {
    try { localStorage.setItem('${LS_THEME}', v); } catch (e) {}
    applyTheme(v);
  })(true);
  initGroup('lang', function () { return lang; }, function (v) {
    lang = v;
    try { localStorage.setItem('${LS_LANG}', v); } catch (e) {}
    root.setAttribute('lang', v);
    applyI18n();
    updateMeta();
    renderSwitcher();
  })(true);

  updateSizes(currentView());

  // ---- tiles: placeholder fade-in + alt text + click target ----
  function tiles() { return Array.prototype.slice.call(document.querySelectorAll('#gallery .tile')); }
  function markLoaded(img) {
    img.classList.add('is-loaded');
    var fig = img.closest('.tile');
    if (fig) fig.classList.remove('tile-ph');
  }
  function altFor(el) {
    var day = formatDay(el.dataset.date);
    var pos = fill(t('photoAlt'), { i: Number(el.dataset.i) + 1, n: C.total });
    return day ? (day + ' — ' + pos) : pos;
  }
  function updateAlts() {
    tiles().forEach(function (el) {
      var img = el.querySelector('img');
      if (img) img.alt = altFor(el);
    });
  }
  function hydrateTiles() {
    tiles().forEach(function (el, position) {
      if (el.dataset.hydrated === '1') return;
      el.dataset.hydrated = '1';
      var img = el.querySelector('img');
      if (img) {
        img.setAttribute('sizes', SIZES[currentView()] || SIZES.stream);
        if (img.complete && img.naturalWidth > 0) markLoaded(img);
        else {
          img.addEventListener('load', function () { markLoaded(img); }, { once: true });
          img.addEventListener('error', function () { markLoaded(img); }, { once: true });
        }
      }
      var link = el.querySelector('.tile-btn');
      if (link) {
        link.addEventListener('click', function (e) {
          // Let modified clicks fall through to the plain href (open in a new
          // tab / save link as) — the no-JS path stays a real link.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          // Tiles are only ever APPENDED, so a tile's DOM position at hydration
          // time is its position for good.
          openLb(position, link);
        });
      }
    });
    updateAlts();
  }

  // ---- progressive reveal (brief §C / initial-document budget) ----
  var moreBox = document.getElementById('more');
  var moreLink = moreBox ? moreBox.querySelector('a') : null;
  var moreErr = document.getElementById('moreError');
  var loadingMore = false;
  // The in-flight fetch, so a second caller JOINS it instead of being told
  // "false, nothing loaded". The lightbox asks for the next window while the
  // scroll observer's fetch is still on the wire all the time on LTE, and a
  // premature \`false\` there used to bounce the visitor back to photo 1.
  var morePromise = null;
  var moreFails = 0;
  function hasMore() { return !!moreBox; }
  function moreHref(from) {
    return '/s/' + enc(C.slug) + '?token=' + enc(C.token) + '&from=' + from;
  }
  // aria-busy drives the same dimmed/cursor:progress treatment as the ZIP
  // button; a 3s LTE fetch behind "Show more photos" used to give zero
  // feedback, inviting repeat taps that just piled up more requests.
  function setMoreBusy(on) {
    if (moreLink) moreLink.setAttribute('aria-busy', on ? 'true' : 'false');
  }
  function setMoreError(on) {
    if (moreErr) moreErr.hidden = !on;
  }
  function loadMore() {
    if (!moreBox) return Promise.resolve(false);
    if (loadingMore) return morePromise || Promise.resolve(false);
    loadingMore = true;
    setMoreBusy(true);
    setMoreError(false);
    var from = Number(moreBox.dataset.from || 0);
    morePromise = fetch(moreHref(from) + '&frag=1', { credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw new Error('frag'); return r.text(); })
      .then(function (html) {
        var gallery = document.getElementById('gallery');
        if (!gallery) return false;
        gallery.insertAdjacentHTML('beforeend', html);
        var next = from + C.pageSize;
        if (next >= C.total) {
          moreBox.remove();
          moreBox = null;
        } else {
          moreBox.dataset.from = String(next);
          var a = moreBox.querySelector('a');
          if (a) a.href = moreHref(next);
        }
        hydrateTiles();
        return true;
      })
      .catch(function () { return false; })
      .then(function (ok) {
        loadingMore = false;
        morePromise = null;
        setMoreBusy(false);
        setMoreError(!ok);
        return ok;
      });
    return morePromise;
  }
  if (moreBox) {
    if (moreLink) {
      moreLink.addEventListener('click', function (e) {
        e.preventDefault();
        loadMore().then(rearmSentinel);
      });
    }
    var io = null;
    // Re-arm only after a SUCCESSFUL page: the sentinel usually stays
    // intersecting after the append, and IntersectionObserver only reports
    // threshold CROSSINGS, so without the unobserve/observe cycle the second
    // page would never load. Re-arming after a FAILED fetch is the same cycle
    // with nothing appended — observe() queues an initial observation, the
    // sentinel is still intersecting, the callback fires again — i.e. a fetch
    // loop at the observer's delivery rate for as long as the connection is
    // down. Back off instead, give up after a few tries, and leave the visible
    // "show more" link as the way back.
    function rearmSentinel(ok) {
      if (!io || !moreBox) return;
      if (ok) { moreFails = 0; io.observe(moreBox); return; }
      moreFails++;
      if (moreFails > 3) return;
      var wait = 1000 * moreFails;
      setTimeout(function () { if (io && moreBox) io.observe(moreBox); }, wait);
    }
    if (typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (!entries[i].isIntersecting) continue;
          io.unobserve(entries[i].target);
          loadMore().then(rearmSentinel);
        }
      }, { rootMargin: '800px 0px' });
      io.observe(moreBox);
    }
  }

  // ---- lightbox (brief §G) ----
  var lb = document.getElementById('lb');
  var stage = document.getElementById('lbstage');
  var wrap = document.getElementById('lbwrap');
  var img = document.getElementById('lbimg');
  var spin = document.getElementById('lbspin');
  var lbErr = document.getElementById('lberror');
  var counter = document.getElementById('lbcount');
  var name = document.getElementById('lbname');
  var dateEl = document.getElementById('lbdate');
  var dl = document.getElementById('lbdl');
  var dlSize = document.getElementById('lbdlsize');
  var raw = document.getElementById('lbraw');
  var closeBtn = lb ? lb.querySelector('.lb-close') : null;
  var idx = 0;
  var pendingUrl = null;
  var lastFocus = null;
  var pushedHistory = false;

  function viewUrl(el) {
    var size = C.full ? 'full' : 'med';
    return '/s/' + enc(C.slug) + '/img/' + el.dataset.id + '?size=' + size + '&token=' + enc(C.token);
  }
  function setLoading(on) {
    if (stage) stage.dataset.loading = on ? '1' : '0';
    if (spin) spin.hidden = !on;
  }
  function preload(el) { if (el) { var p = new Image(); p.src = viewUrl(el); } }

  function show(i) {
    var list = tiles();
    if (list.length === 0) return;
    if (i >= list.length) {
      // Walk past the loaded window: pull the next page (joining the fetch the
      // tail of this function may already have started), then land on it. On a
      // FAILED fetch stay exactly where we are — throwing a visitor who is 60
      // photos deep back to photo 1 because their signal dropped for a second
      // is worse than the tap doing nothing.
      if (hasMore()) { loadMore().then(function (ok) { if (ok) show(i); }); return; }
      i = 0;
    }
    if (i < 0) i = list.length - 1;
    idx = i;
    var el = list[idx];
    if (!img || !el) return;

    // Position is the tile's GLOBAL index, not its offset in the loaded window —
    // a deep no-JS page (?from=…) starts the DOM list part-way through.
    if (counter) counter.textContent = (Number(el.dataset.i) + 1) + ' / ' + C.total;
    if (name) name.textContent = el.dataset.name || '';
    if (dateEl) dateEl.textContent = formatDay(el.dataset.date);
    var fileBase = '/s/' + enc(C.slug) + '/file/' + el.dataset.id + '?token=' + enc(C.token);
    if (dl) dl.href = fileBase;
    if (dlSize) dlSize.textContent = el.dataset.size ? formatBytes(Number(el.dataset.size)) : '';
    if (raw) {
      var hasRaw = el.dataset.raw === '1';
      raw.hidden = !hasRaw;
      if (hasRaw) raw.href = fileBase + '&raw=1';
    }

    // Keep the CURRENT frame on screen until the next one has decoded — a cold
    // 2560px JPEG over LTE otherwise leaves a black rectangle for seconds.
    var url = viewUrl(el);
    var alt = altFor(el);
    if (lbErr) lbErr.hidden = true;
    if (img.getAttribute('src') === url) { setLoading(false); img.alt = alt; img.hidden = false; }
    else {
      pendingUrl = url;
      setLoading(true);
      var pre = new Image();
      var settle = function () {
        if (pendingUrl !== url) return;
        img.src = url;
        img.alt = alt;
        img.hidden = false;
        pendingUrl = null;
        setLoading(false);
      };
      // A rolled token, a corrupt source JPEG, or a container OOM on the
      // sharp decode all land here. The CURRENT frame is deliberately left
      // untouched — committing the failed url (the old behavior) replaced a
      // good photo with a broken-image glyph on black, spinner gone, no
      // message. Surface the failure instead; the visitor can still swipe
      // away, which retries against a fresh url.
      var fail = function () {
        if (pendingUrl !== url) return;
        pendingUrl = null;
        setLoading(false);
        if (lbErr) lbErr.hidden = false;
      };
      pre.onload = settle;
      pre.onerror = fail;
      pre.src = url;
      if (pre.complete) settle();
    }
    preload(list[idx + 1]);
    preload(list[idx - 1]);
    if (idx + 2 >= list.length && hasMore()) loadMore();
  }

  function openLb(i, origin) {
    if (!lb) return;
    // The originating tile, explicitly — Safari does not focus a clicked <a>,
    // so document.activeElement would be <body> and focus would be lost on close.
    lastFocus = origin || document.activeElement;
    show(i);
    if (!lb.open) {
      document.body.style.overflow = 'hidden';
      lb.showModal();
      // An open lightbox is its own history entry, so the iOS edge-swipe-back
      // gesture closes the photo instead of navigating off the gallery.
      try { history.pushState({ imgShareLb: 1 }, ''); pushedHistory = true; } catch (e) {}
      if (closeBtn) closeBtn.focus();
    }
  }
  function closeLb() { if (lb && lb.open) lb.close(); }

  if (lb) {
    lb.addEventListener('close', function () {
      document.body.style.overflow = '';
      // NOT \`img.src = ''\` — an empty src resolves against the document URL and
      // flashes the broken-image glyph through the close animation.
      pendingUrl = null;
      img.hidden = true;
      img.removeAttribute('src');
      setLoading(false);
      if (lbErr) lbErr.hidden = true;
      if (pushedHistory) { pushedHistory = false; try { history.back(); } catch (e) {} }
      if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
    });
    window.addEventListener('popstate', function () {
      if (lb.open) { pushedHistory = false; lb.close(); }
    });
    var prevBtn = lb.querySelector('.lb-prev');
    var nextBtn = lb.querySelector('.lb-next');
    if (closeBtn) closeBtn.addEventListener('click', closeLb);
    if (prevBtn) prevBtn.addEventListener('click', function () { show(idx - 1); });
    if (nextBtn) nextBtn.addEventListener('click', function () { show(idx + 1); });
  }
  document.addEventListener('keydown', function (e) {
    if (!lb || !lb.open) return;
    if (e.key === 'ArrowLeft') show(idx - 1);
    else if (e.key === 'ArrowRight') show(idx + 1);
  });

  if (wrap) {
    // Backdrop tap closes. Most of a portrait screen is black surround, and
    // the only other way out was a single button under the Dynamic Island.
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap || e.target === stage) closeLb();
    });
    var sx = 0, sy = 0, multi = false;
    // True while the browser's own pinch-zoom is active. Panning a zoomed photo
    // is a ONE-finger drag, i.e. a brand-new gesture with multi === false — so
    // without this the pan reads as a swipe, jumps to the next photo and throws
    // the zoom away, and \`touch-action: pinch-zoom\` means there is no other way
    // to move around the enlarged frame at all.
    function zoomed() {
      return !!(window.visualViewport && window.visualViewport.scale > 1);
    }
    wrap.addEventListener('touchstart', function (e) {
      multi = e.touches.length > 1;
      var touch = e.changedTouches[0]; sx = touch.clientX; sy = touch.clientY;
    }, { passive: true });
    wrap.addEventListener('touchmove', function (e) {
      if (e.touches.length > 1) multi = true;
    }, { passive: true });
    wrap.addEventListener('touchend', function (e) {
      if (multi) { multi = false; return; }  // a pinch-zoom, not a swipe
      if (zoomed()) return;                  // panning a zoomed photo
      var touch = e.changedTouches[0];
      var dx = touch.clientX - sx, dy = touch.clientY - sy;
      if (Math.abs(dy) > 70 && Math.abs(dy) > Math.abs(dx)) { closeLb(); return; }
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) show(dx < 0 ? idx + 1 : idx - 1);
    }, { passive: true });
  }

  // ---- download-all: immediate feedback + repeat-tap guard (brief §H) ----
  var zipBtn = document.getElementById('zipBtn');
  function updateZipLabel() {
    if (!zipBtn) return;
    var label = zipBtn.querySelector('.zip-label');
    var meta = zipBtn.querySelector('.zip-meta');
    if (label) label.textContent = t(zipBtn.getAttribute('aria-busy') === 'true' ? 'downloadAllBusy' : 'downloadAll');
    if (meta) meta.textContent = formatBytes(C.zipBytes) + ' · ' + photoCount(C.total);
  }
  if (zipBtn) {
    var zipTimer = 0;
    zipBtn.addEventListener('click', function (e) {
      // A bare <a> gave zero visible feedback on tap, which on a phone reads as
      // "nothing happened" and invites repeat taps — each one starting another
      // multi-GB transfer. The href is untouched, so the no-JS path still works.
      if (zipBtn.getAttribute('aria-busy') === 'true') { e.preventDefault(); return; }
      zipBtn.setAttribute('aria-busy', 'true');
      updateZipLabel();
      clearTimeout(zipTimer);
      zipTimer = setTimeout(function () {
        zipBtn.removeAttribute('aria-busy');
        updateZipLabel();
      }, 20000);
    });
  }

  // ---- remembered shares (brief §I) ----
  function escapeForHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function readRemembered() {
    try {
      var parsed = JSON.parse(localStorage.getItem('${LS_SHARES}') || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }
  function rememberShare() {
    try {
      var list = readRemembered().filter(function (s) { return s.slug !== C.slug; });
      list.push({ slug: C.slug, token: C.token, title: C.title, count: C.total, savedAt: new Date().toISOString() });
      localStorage.setItem('${LS_SHARES}', JSON.stringify(list));
    } catch (e) {}
  }
  function renderSwitcher() {
    var btn = document.getElementById('switcherBtn');
    var menu = document.getElementById('switcherMenu');
    if (!btn || !menu) return;
    var others = readRemembered().filter(function (s) { return s.slug !== C.slug; });
    if (others.length === 0) { btn.hidden = true; menu.hidden = true; return; }
    btn.hidden = false;
    menu.hidden = true;
    menu.innerHTML = '<span class="switcher-heading">' + escapeForHtml(t('switcherHeading')) + '</span>' +
      others.map(function (s) {
        var href = '/s/' + enc(s.slug) + '?token=' + enc(s.token);
        return '<a href="' + escapeForHtml(href) + '">' + escapeForHtml(s.title) + ' · ' + photoCount(s.count) + '</a>';
      }).join('');
    btn.onclick = function () { menu.hidden = !menu.hidden; };
  }

  hydrateTiles();
  applyI18n();
  updateMeta();
  rememberShare();
  renderSwitcher();
})();`
}

/**
 * The opaque 404 page's own tiny behavior. `headScript` already applies the
 * visitor's stored `lang` to `<html>` pre-paint (same as every other page) —
 * but the 404 has no `mainScript`, so nothing ever swapped its two strings to
 * match. Without this, a visitor who set the page to Español and then hit a
 * dead/rolled link got German copy under an `html[lang="es"]` a screen reader
 * pronounces with Spanish phonetics. Deliberately NOT `mainScript`: this page
 * has no lightbox, no controls, no tiles — just the two `[data-i18n]` strings.
 */
export function notFoundScript(catalogueJson: string): string {
  return `(function () {
  var CATALOGUE = ${catalogueJson};
  var lang = document.documentElement.lang || 'en';
  function t(key) {
    var forLang = CATALOGUE[lang] || CATALOGUE.en;
    return forLang[key] || CATALOGUE.en[key] || '';
  }
  document.querySelectorAll('[data-i18n]').forEach(function (el) {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
})();`
}

/**
 * Landing page behavior (brief §I). Fully self-contained: resolves its own
 * initial language from `localStorage`/`navigator.language` (no
 * `Accept-Language` involvement — the landing document itself never varies
 * by request, see `renderLandingPage`) and renders the 0/1/N remembered-share
 * cases purely from `localStorage['${LS_SHARES}']`. Never calls the server — so
 * the single-share auto-open is blind, and the one-shot
 * `sessionStorage['${SS_REDIRECTED}']` marker is what stops a share that has
 * since been rolled or expired from turning this page into a one-way bounce
 * into the opaque 404.
 */
export function landingScript(catalogueJson: string): string {
  return `(function () {
  var CATALOGUE = ${catalogueJson};
  var enc = encodeURIComponent;
  function detectLang() {
    try {
      var stored = localStorage.getItem('${LS_LANG}');
      if (stored === 'de' || stored === 'en' || stored === 'es') return stored;
    } catch (e) {}
    var candidates = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || 'en'];
    for (var i = 0; i < candidates.length; i++) {
      var primary = String(candidates[i] || '').toLowerCase().split('-')[0];
      if (primary === 'de' || primary === 'en' || primary === 'es') return primary;
    }
    return 'en';
  }
  var lang = detectLang();
  document.documentElement.lang = lang;

  function t(key) {
    var forLang = CATALOGUE[lang] || CATALOGUE.en;
    return forLang[key] || CATALOGUE.en[key] || '';
  }
  document.querySelectorAll('[data-i18n]').forEach(function (el) {
    el.textContent = t(el.getAttribute('data-i18n'));
  });

  function photoCount(n) {
    if (lang === 'de') return n === 1 ? '1 Foto' : (n + ' Fotos');
    if (lang === 'es') return n === 1 ? '1 foto' : (n + ' fotos');
    return n === 1 ? '1 photo' : (n + ' photos');
  }
  function escapeForHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function readList() {
    try {
      var raw = JSON.parse(localStorage.getItem('${LS_SHARES}') || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  }
  // The share page lives at /s/<slug> — a bare '/<slug>' href walked straight
  // into the static plugin's 404.
  function shareHref(s) { return '/s/' + enc(s.slug) + '?token=' + enc(s.token); }
  function formatSavedAt(iso) {
    try { return new Intl.DateTimeFormat(lang, { dateStyle: 'medium' }).format(new Date(iso)); } catch (e) { return ''; }
  }
  function redirectedTo(slug) {
    try { return sessionStorage.getItem('${SS_REDIRECTED}') === slug; } catch (e) { return false; }
  }
  function markRedirected(slug) {
    try { sessionStorage.setItem('${SS_REDIRECTED}', slug); } catch (e) {}
  }
  function removeShare(slug) {
    try {
      localStorage.setItem('${LS_SHARES}', JSON.stringify(readList().filter(function (s) { return s.slug !== slug; })));
    } catch (e) {}
    render();
  }
  function render() {
    var empty = document.getElementById('landing-empty');
    var redirect = document.getElementById('landing-redirect');
    var section = document.getElementById('landing-section');
    var list = document.getElementById('landing-list');
    if (!empty || !redirect || !section || !list) return;
    var shares = readList();
    if (shares.length === 0) {
      empty.hidden = false; redirect.hidden = true; section.hidden = true;
      return;
    }
    if (shares.length === 1 && !redirectedTo(shares[0].slug)) {
      // Unhiding an EMPTY <p> here used to show a blank screen for the whole
      // redirect; it now carries data-i18n="landingRedirect" and was already
      // localized by the catalogue pass above.
      empty.hidden = true; section.hidden = true;
      redirect.hidden = false;
      markRedirected(shares[0].slug);
      // assign, NOT replace: if that share's token was rolled (or it expired)
      // the visitor lands on the opaque 404, which by design carries no links —
      // with replace, Back could not get them off it and coming back to '/'
      // would bounce them straight into it again. The marker above makes the
      // second visit fall through to the list below, where Remove lives.
      window.location.assign(shareHref(shares[0]));
      return;
    }
    empty.hidden = true; redirect.hidden = true; section.hidden = false;
    var sorted = shares.slice().sort(function (a, b) { return String(b.savedAt || '').localeCompare(String(a.savedAt || '')); });
    list.innerHTML = sorted.map(function (s) {
      var saved = formatSavedAt(s.savedAt);
      // "Last opened" labels the date — without it the bare Intl date reads as
      // the capture date of the photos, which is a different thing entirely.
      var savedLabel = saved ? (' · ' + escapeForHtml(t('landingLastOpened')) + ' ' + escapeForHtml(saved)) : '';
      return '<li class="share-row">' +
        '<a href="' + escapeForHtml(shareHref(s)) + '" aria-label="' + escapeForHtml(t('landingOpen') + ' ' + s.title) + '">' +
          '<span>' + escapeForHtml(s.title) + '</span>' +
          '<span class="share-meta">' + photoCount(s.count) + savedLabel + '</span>' +
        '</a>' +
        '<button type="button" class="text-btn" data-slug="' + escapeForHtml(s.slug) + '">' + escapeForHtml(t('landingRemove')) + '</button>' +
      '</li>';
    }).join('');
    list.querySelectorAll('button[data-slug]').forEach(function (btn) {
      btn.addEventListener('click', function () { removeShare(btn.getAttribute('data-slug')); });
    });
  }
  render();
  // Coming BACK here from a dead share restores this page from the bfcache,
  // which does not re-run the script — without this the visitor would be left
  // staring at the frozen "redirecting…" line instead of their share list.
  window.addEventListener('pageshow', function (e) { if (e.persisted) render(); });
})();`
}

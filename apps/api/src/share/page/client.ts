// Inline client-side JS for the share page (Stage 3 briefs §D/§E/§G/§I).
// Shipped as two `<script>` blocks: `headScript()` — tiny, runs in `<head>`,
// applies the stored view/theme/lang before first paint — and `mainScript()`
// — the full behavior (segmented controls, lightbox, i18n swap, remembered
// shares), placed at the end of `<body>`.
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

const LS_VIEW = 'image-share.view'
const LS_THEME = 'image-share.theme'
const LS_LANG = 'image-share.lang'
const LS_SHARES = 'image-share.shares'

/** Runs in `<head>`, before body paint: apply stored view/theme/lang to `<html>`. */
export function headScript(): string {
  return `(function () {
  try {
    var root = document.documentElement;
    var view = localStorage.getItem('${LS_VIEW}');
    root.setAttribute('data-view', (view === 'bento' || view === 'grid') ? view : 'stream');
    var theme = localStorage.getItem('${LS_THEME}');
    if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
    var lang = localStorage.getItem('${LS_LANG}');
    if (lang === 'de' || lang === 'en' || lang === 'es') root.setAttribute('lang', lang);
  } catch (e) {}
})();`
}

const SIZES_BY_VIEW = `{
    stream: '(min-width:1024px) min(1680px, calc(100vw - 160px)), (min-width:640px) calc(100vw - 80px), calc(100vw - 32px)',
    grid: '(min-width:1024px) 25vw, (min-width:640px) 33vw, 50vw',
    bento: '(min-width:1024px) 50vw, (min-width:640px) 66vw, 100vw'
  }`

/**
 * The full share-page behavior. `cfgJson`/`catalogueJson` are pre-serialized
 * (via `jsonForScript` in index.ts) so this stays a pure string template —
 * no data leaves this file un-escaped.
 */
export function mainScript(cfgJson: string, catalogueJson: string): string {
  return `(function () {
  var C = ${cfgJson};
  var CATALOGUE = ${catalogueJson};
  var root = document.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var lang = root.getAttribute('lang') || 'en';

  // ---- i18n ----
  function t(key) {
    var forLang = CATALOGUE[lang] || CATALOGUE.en;
    return forLang[key] || CATALOGUE.en[key] || '';
  }
  function photoCount(n) {
    if (lang === 'de') return n === 1 ? '1 Foto' : (n + ' Fotos');
    if (lang === 'es') return n === 1 ? '1 foto' : (n + ' fotos');
    return n === 1 ? '1 photo' : (n + ' photos');
  }
  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
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
    var count = photoCount(C.count);
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
        buttons[i].setAttribute('aria-pressed', 'false');
      }
      if (!active) active = buttons[0];
      buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b === active)); });
      if (!pill || !active) return;
      if (instant || reduceMotion) pill.style.transition = 'none';
      pill.style.width = active.offsetWidth + 'px';
      pill.style.transform = 'translateX(' + active.offsetLeft + 'px)';
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
    localStorage.setItem('${LS_VIEW}', view);
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

  var SIZES = ${SIZES_BY_VIEW};
  function updateSizes(view) {
    var val = SIZES[view] || SIZES.stream;
    document.querySelectorAll('.tile img').forEach(function (img) { img.setAttribute('sizes', val); });
  }

  initGroup('view', function () { return root.getAttribute('data-view') || 'stream'; }, switchView)(true);
  initGroup('theme', function () { return localStorage.getItem('${LS_THEME}') || 'system'; }, function (v) {
    localStorage.setItem('${LS_THEME}', v);
    applyTheme(v);
  })(true);
  initGroup('lang', function () { return lang; }, function (v) {
    lang = v;
    localStorage.setItem('${LS_LANG}', v);
    root.setAttribute('lang', v);
    applyI18n();
    updateMeta();
    renderSwitcher();
  })(true);

  updateSizes(root.getAttribute('data-view') || 'stream');
  applyI18n();
  updateMeta();

  // ---- lightbox (brief §G) ----
  var lb = document.getElementById('lb');
  var img = document.getElementById('lbimg');
  var name = document.getElementById('lbname');
  var dl = document.getElementById('lbdl');
  var raw = document.getElementById('lbraw');
  var idx = 0;

  function viewUrl(im) {
    var size = C.full ? 'full' : 'med';
    return '/s/' + encodeURIComponent(C.slug) + '/img/' + im.id + '?size=' + size + '&token=' + encodeURIComponent(C.token);
  }
  function show(i) {
    if (i < 0) i = C.imgs.length - 1;
    if (i >= C.imgs.length) i = 0;
    idx = i;
    var im = C.imgs[idx];
    if (!img) return;
    img.src = viewUrl(im);
    img.alt = im.name;
    if (name) name.textContent = im.name;
    var fileBase = '/s/' + encodeURIComponent(C.slug) + '/file/' + im.id + '?token=' + encodeURIComponent(C.token);
    if (dl) dl.href = fileBase;
    if (raw) raw.href = fileBase + '&raw=1';
  }
  function openLb(i) { show(i); if (lb && !lb.open) { document.body.style.overflow = 'hidden'; lb.showModal(); } }
  function closeLb() { if (!lb) return; lb.close(); if (img) img.src = ''; document.body.style.overflow = ''; }

  document.querySelectorAll('.tile').forEach(function (el) {
    el.addEventListener('click', function () { openLb(Number(el.dataset.i)); });
  });
  if (lb) {
    var closeBtn = lb.querySelector('.lb-close');
    var prevBtn = lb.querySelector('.lb-prev');
    var nextBtn = lb.querySelector('.lb-next');
    if (closeBtn) closeBtn.addEventListener('click', closeLb);
    if (prevBtn) prevBtn.addEventListener('click', function () { show(idx - 1); });
    if (nextBtn) nextBtn.addEventListener('click', function () { show(idx + 1); });
    lb.addEventListener('cancel', function () { if (img) img.src = ''; document.body.style.overflow = ''; });
  }
  document.addEventListener('keydown', function (e) {
    if (!lb || !lb.open) return;
    if (e.key === 'ArrowLeft') show(idx - 1);
    else if (e.key === 'ArrowRight') show(idx + 1);
    else if (e.key === 'Escape') closeLb();
  });
  if (img) {
    var sx = 0, sy = 0;
    img.addEventListener('touchstart', function (e) {
      var touch = e.changedTouches[0]; sx = touch.clientX; sy = touch.clientY;
    }, { passive: true });
    img.addEventListener('touchend', function (e) {
      var touch = e.changedTouches[0];
      var dx = touch.clientX - sx, dy = touch.clientY - sy;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) show(dx < 0 ? idx + 1 : idx - 1);
    }, { passive: true });
  }

  // ---- remembered shares (brief §I) ----
  function escapeForHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function readRemembered() {
    try { return JSON.parse(localStorage.getItem('${LS_SHARES}') || '[]'); } catch (e) { return []; }
  }
  function rememberShare() {
    try {
      var list = readRemembered().filter(function (s) { return s.slug !== C.slug; });
      list.push({ slug: C.slug, token: C.token, title: C.title, count: C.count, savedAt: new Date().toISOString() });
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
    menu.innerHTML = others.map(function (s) {
      var href = '/' + encodeURIComponent(s.slug) + '?token=' + encodeURIComponent(s.token);
      return '<a href="' + href + '">' + escapeForHtml(s.title) + ' · ' + photoCount(s.count) + '</a>';
    }).join('');
    btn.onclick = function () { menu.hidden = !menu.hidden; };
  }

  rememberShare();
  renderSwitcher();
})();`
}

/**
 * Landing page behavior (brief §I). Fully self-contained: resolves its own
 * initial language from `localStorage`/`navigator.language` (no
 * `Accept-Language` involvement — the landing document itself never varies
 * by request, see `renderLandingPage`) and renders the 0/1/N remembered-share
 * cases purely from `localStorage['${LS_SHARES}']`. Never calls the server.
 */
export function landingScript(catalogueJson: string): string {
  return `(function () {
  var CATALOGUE = ${catalogueJson};
  function detectLang() {
    var stored = localStorage.getItem('${LS_LANG}');
    if (stored === 'de' || stored === 'en' || stored === 'es') return stored;
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
  function shareHref(s) { return '/' + encodeURIComponent(s.slug) + '?token=' + encodeURIComponent(s.token); }
  function formatSavedAt(iso) {
    try { return new Intl.DateTimeFormat(lang, { dateStyle: 'medium' }).format(new Date(iso)); } catch (e) { return ''; }
  }
  function removeShare(slug) {
    localStorage.setItem('${LS_SHARES}', JSON.stringify(readList().filter(function (s) { return s.slug !== slug; })));
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
    if (shares.length === 1) {
      empty.hidden = true; section.hidden = true; redirect.hidden = false;
      window.location.replace(shareHref(shares[0]));
      return;
    }
    empty.hidden = true; redirect.hidden = true; section.hidden = false;
    var sorted = shares.slice().sort(function (a, b) { return String(b.savedAt || '').localeCompare(String(a.savedAt || '')); });
    list.innerHTML = sorted.map(function (s) {
      return '<li class="share-row">' +
        '<a href="' + shareHref(s) + '"><span>' + escapeForHtml(s.title) + '</span>' +
        '<span class="share-meta">' + photoCount(s.count) + ' · ' + escapeForHtml(formatSavedAt(s.savedAt)) + '</span></a>' +
        '<button type="button" class="text-btn" data-slug="' + escapeForHtml(s.slug) + '">' + t('landingRemove') + '</button>' +
      '</li>';
    }).join('');
    list.querySelectorAll('button[data-slug]').forEach(function (btn) {
      btn.addEventListener('click', function () { removeShare(btn.getAttribute('data-slug')); });
    });
  }
  render();
})();`
}

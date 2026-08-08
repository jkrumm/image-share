import { describe, expect, it } from 'bun:test'
import { allMessages } from './i18n.js'
import { headScript, landingScript, mainScript, SIZES_BY_VIEW } from './client.js'

// The three inline scripts are plain STRINGS at build time — tsc never parses
// them, so a stray brace or an unescaped backtick ships a page whose entire
// behavior is dead (no lightbox, no controls, no remembered shares) with only a
// console error to show for it. `new Function` forces a real parse.

const CFG = JSON.stringify({
  slug: 's',
  token: 't',
  title: 'T',
  total: 3,
  pageSize: 60,
  dates: ['2026-01-01'],
  zipBytes: 10,
  full: true,
  download: true,
  raws: true,
})

function cfgFor(over: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(CFG), ...over })
}
const CATALOGUE = JSON.stringify(allMessages())

describe('inline scripts', () => {
  it('every emitted script is syntactically valid JavaScript', () => {
    for (const src of [headScript(), mainScript(CFG, CATALOGUE), landingScript(CATALOGUE)]) {
      expect(() => new Function(src)).not.toThrow()
    }
  })

  it('headScript fixes the tile `sizes` before the preload scanner commits', () => {
    const src = headScript()
    // The HTML always ships the STREAM sizes; a stored grid/bento view has to be
    // repaired from <head>, because mainScript runs at end-of-body — far too
    // late for the scanner.
    expect(src).toContain('MutationObserver')
    expect(src).toContain("view !== 'stream'")
    expect(src).toContain(SIZES_BY_VIEW.grid)
  })

  it('headScript marks the document as script-enabled for the no-JS CSS gates', () => {
    expect(headScript()).toContain("+ 'js'")
  })

  it('mainScript reads the gallery from the DOM, not from an inlined array', () => {
    const src = mainScript(CFG, CATALOGUE)
    expect(src).toContain("querySelectorAll('#gallery .tile')")
    expect(src).toContain('C.pageSize')
    expect(src).toContain('frag=1')
  })

  it('mainScript wires the mobile lightbox affordances', () => {
    const src = mainScript(CFG, CATALOGUE)
    // Preload ±1, retain the previous frame until decode, history entry for the
    // iOS back gesture, swipe on the wrap, and no `src = ''` on close.
    expect(src).toContain('function preload(')
    expect(src).toContain('history.pushState')
    expect(src).toContain("window.addEventListener('popstate'")
    expect(src).toContain("wrap.addEventListener('touchend'")
    expect(src).toContain("img.removeAttribute('src')")
    // …and never as a statement (the comment above it may quote the old form).
    expect(src).not.toMatch(/^\s*img\.src = '';/m)
  })

  it('landingScript links into /s/<slug>, not a bare /<slug>', () => {
    const src = landingScript(CATALOGUE)
    expect(src).toContain("'/s/' + enc(s.slug)")
    expect(src).not.toContain("'/' + enc(s.slug)")
  })

  it('every localStorage read/write is guarded — a blocked store must not kill the page', () => {
    for (const src of [headScript(), mainScript(CFG, CATALOGUE), landingScript(CATALOGUE)]) {
      // Safari private mode / third-party-storage blocking throws on access.
      expect(src.split('localStorage').length - 1).toBeGreaterThan(0)
      expect(src).toContain('try {')
    }
  })
})

// ── Executing the scripts against a hand-rolled DOM ──────────────────────────
// Parsing them proves nothing about the pagination/lightbox state machine,
// which is where the real bugs live (a mistimed `loadMore` used to teleport a
// visitor from photo 60 back to photo 1, and a failed fragment fetch used to
// spin an unbounded retry loop). The scripts' DOM surface is known statically
// and small, so it is stubbed here rather than pulling in jsdom/happy-dom for
// three test cases.

type Handler = (event: Record<string, unknown>) => void

class FakeEl {
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  attrs: Record<string, string> = {}
  handlers: Record<string, Handler[]> = {}
  /** Selector → child, for the exact selectors the scripts query. */
  q: Record<string, FakeEl> = {}
  qa: Record<string, FakeEl[]> = {}
  classList = { add: () => {}, remove: () => {} }
  textContent = ''
  innerHTML = ''
  href = ''
  src = ''
  alt = ''
  lang = ''
  hidden = false
  open = false
  complete = true
  naturalWidth = 1
  removed = false

  addEventListener(type: string, fn: Handler): void {
    ;(this.handlers[type] ??= []).push(fn)
  }
  fire(type: string, event: Record<string, unknown> = {}): void {
    for (const fn of this.handlers[type] ?? []) fn(event)
  }
  querySelector(sel: string): FakeEl | null {
    return this.q[sel] ?? null
  }
  querySelectorAll(sel: string): FakeEl[] {
    return this.qa[sel] ?? []
  }
  getAttribute(key: string): string | null {
    return this.attrs[key] ?? null
  }
  setAttribute(key: string, value: string): void {
    this.attrs[key] = value
  }
  removeAttribute(key: string): void {
    delete this.attrs[key]
  }
  closest(): FakeEl | null {
    return null
  }
  remove(): void {
    this.removed = true
  }
  focus(): void {}
  showModal(): void {
    this.open = true
  }
  close(): void {
    this.open = false
    this.fire('close')
  }
  insertAdjacentHTML(_position: string, _html: string): void {}
}

function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

/** Flush the promise chains inside `loadMore` (fetch → text → append). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

interface PendingFetch {
  url: string
  resolve: (html: string) => void
  reject: () => void
}

function mountShare(opts: { tiles: number; total: number; hasMore?: boolean }) {
  const tiles: FakeEl[] = []
  function makeTile(index: number): FakeEl {
    const tile = new FakeEl()
    tile.dataset = {
      i: String(index),
      id: String(1000 + index),
      name: `DSCF${index}.JPG`,
      date: '2026-01-01T00:00:00.000Z',
      size: '100',
      raw: '0',
    }
    tile.q = { img: new FakeEl(), '.tile-btn': new FakeEl() }
    return tile
  }
  for (let i = 0; i < opts.tiles; i++) tiles.push(makeTile(i))

  const gallery = new FakeEl()
  // One fragment = one page of tiles, appended to the live list.
  gallery.insertAdjacentHTML = (_position: string, html: string) => {
    const appended = (html.match(/<figure/g) ?? []).length
    for (let i = 0; i < appended; i++) tiles.push(makeTile(tiles.length))
  }
  const moreBox = new FakeEl()
  moreBox.dataset = { from: String(opts.tiles) }
  moreBox.q = { a: new FakeEl() }
  const moreError = new FakeEl()
  moreError.hidden = true
  const counter = new FakeEl()
  const lb = new FakeEl()
  lb.q = { '.lb-close': new FakeEl(), '.lb-prev': new FakeEl(), '.lb-next': new FakeEl() }
  const wrap = new FakeEl()
  const lbstage = new FakeEl()
  const lbimg = new FakeEl()
  const lberror = new FakeEl()
  lberror.hidden = true
  const byId: Record<string, FakeEl | null> = {
    gallery,
    more: opts.hasMore === false ? null : moreBox,
    moreError: opts.hasMore === false ? null : moreError,
    lb,
    lbstage,
    lbwrap: wrap,
    lbimg,
    lbspin: new FakeEl(),
    lberror,
    lbcount: counter,
    lbname: new FakeEl(),
    lbdate: new FakeEl(),
    lbdl: new FakeEl(),
    lbdlsize: new FakeEl(),
    lbraw: new FakeEl(),
    meta: new FakeEl(),
    zipBtn: null,
    switcherBtn: null,
    switcherMenu: null,
  }

  const docHandlers: Record<string, Handler[]> = {}
  const document = {
    documentElement: new FakeEl(),
    body: { style: {} as Record<string, string> },
    getElementById: (id: string) => byId[id] ?? null,
    querySelector: () => null,
    querySelectorAll: (sel: string) => (sel === '#gallery .tile' ? tiles.slice() : []),
    addEventListener: (type: string, fn: Handler) => void (docHandlers[type] ??= []).push(fn),
  }
  const win = {
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
    visualViewport: null as { scale: number } | null,
  }

  const fetches: PendingFetch[] = []
  const fetchStub = (url: string) =>
    new Promise((resolve, reject) => {
      fetches.push({
        url,
        resolve: (html) => resolve({ ok: true, text: () => Promise.resolve(html) }),
        reject: () => reject(new Error('offline')),
      })
    })

  const observed: FakeEl[] = []
  const unobserved: FakeEl[] = []
  let intersectCb: ((entries: Array<{ isIntersecting: boolean; target: FakeEl }>) => void) | null =
    null
  class FakeIntersectionObserver {
    constructor(cb: (entries: Array<{ isIntersecting: boolean; target: FakeEl }>) => void) {
      intersectCb = cb
    }
    observe(target: FakeEl): void {
      observed.push(target)
    }
    unobserve(target: FakeEl): void {
      unobserved.push(target)
    }
  }
  // A test queues `false` to simulate an in-flight (not-yet-decoded) image —
  // matching real `Image` behavior right after `src` is assigned, before load
  // completes. Defaults to `true` (synchronous, as every other test relies
  // on) so only tests that explicitly opt in pay for the async shape.
  const imageCompleteQueue: boolean[] = []
  const createdImages: FakeImage[] = []
  class FakeImage {
    complete: boolean
    src = ''
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor() {
      this.complete = imageCompleteQueue.length > 0 ? (imageCompleteQueue.shift() as boolean) : true
      createdImages.push(this)
    }
  }
  const timeouts: Array<{ fn: () => void; ms: number }> = []

  const run = new Function(
    'window',
    'document',
    'localStorage',
    'fetch',
    'IntersectionObserver',
    'Image',
    'history',
    'setTimeout',
    'clearTimeout',
    mainScript(cfgFor({ total: opts.total }), CATALOGUE),
  )
  run(
    win,
    document,
    fakeStorage(),
    fetchStub,
    FakeIntersectionObserver,
    FakeImage,
    { pushState: () => {}, back: () => {} },
    (fn: () => void, ms: number) => timeouts.push({ fn, ms }),
    () => {},
  )

  return {
    tiles,
    counter,
    win,
    fetches,
    observed,
    unobserved,
    timeouts,
    lbimg,
    lbstage,
    lberror,
    moreBox,
    moreError,
    images: createdImages,
    /** Simulate the NEXT `new Image()` staying in flight (not yet decoded). */
    queueImageComplete(value: boolean): void {
      imageCompleteQueue.push(value)
    },
    /** Open the lightbox on a tile, as an unmodified left click does. */
    openTile(index: number): void {
      tiles[index]!.q['.tile-btn']!.fire('click', { preventDefault: () => {}, button: 0 })
    },
    key(key: string): void {
      for (const fn of docHandlers['keydown'] ?? []) fn({ key })
    },
    swipe(dx: number): void {
      wrap.fire('touchstart', {
        touches: [{}],
        changedTouches: [{ clientX: 200, clientY: 300 }],
      })
      wrap.fire('touchend', { changedTouches: [{ clientX: 200 + dx, clientY: 300 }] })
    },
    intersect(): void {
      intersectCb?.([{ isIntersecting: true, target: moreBox }])
    },
  }
}

describe('mainScript — progressive reveal + lightbox', () => {
  it('joins an in-flight fragment fetch instead of wrapping back to the first photo', async () => {
    // 200-photo share, 60 loaded. The visitor arrows past the loaded window
    // while the prefetch triggered two tiles earlier is still on the wire.
    const dom = mountShare({ tiles: 60, total: 200 })
    dom.openTile(57)
    expect(dom.counter.textContent).toBe('58 / 200')

    dom.key('ArrowRight') // 59th tile: within two of the end → prefetch starts
    expect(dom.fetches).toHaveLength(1)
    dom.key('ArrowRight')
    dom.key('ArrowRight') // past the loaded window, fetch still pending
    expect(dom.fetches).toHaveLength(1) // joined it, did not fire a second

    dom.fetches[0]!.resolve('<figure></figure>'.repeat(60))
    await flush()

    expect(dom.tiles).toHaveLength(120)
    expect(dom.counter.textContent).toBe('61 / 200')
  })

  it('a failed fragment fetch leaves the visitor on the photo they were on', async () => {
    const dom = mountShare({ tiles: 60, total: 200 })
    dom.openTile(58)
    dom.key('ArrowRight') // 60th tile, prefetch starts
    dom.key('ArrowRight') // past the window
    expect(dom.counter.textContent).toBe('60 / 200')

    dom.fetches[0]!.reject()
    await flush()

    // NOT '1 / 200' — a dropped signal must not throw them back to the start.
    expect(dom.counter.textContent).toBe('60 / 200')
  })

  it('does not re-arm the scroll sentinel after a failed fetch (unbounded retry loop)', async () => {
    const dom = mountShare({ tiles: 60, total: 200 })
    expect(dom.observed).toHaveLength(1)

    dom.intersect()
    expect(dom.fetches).toHaveLength(1)
    dom.fetches[0]!.reject()
    await flush()

    // The sentinel is still intersecting, so observe() would fire the callback
    // again at once — that is the loop: unobserve → fetch → fail → observe.
    expect(dom.observed).toHaveLength(1)
    expect(dom.timeouts).toHaveLength(1)
    expect(dom.timeouts[0]!.ms).toBeGreaterThan(0)

    dom.timeouts[0]!.fn()
    expect(dom.observed).toHaveLength(2)
  })

  it('re-arms the sentinel immediately after a successful page', async () => {
    const dom = mountShare({ tiles: 60, total: 200 })
    dom.intersect()
    dom.fetches[0]!.resolve('<figure></figure>'.repeat(60))
    await flush()

    expect(dom.observed).toHaveLength(2)
    expect(dom.timeouts).toHaveLength(0)
  })

  it('"Show more" goes busy on tap, surfaces a failure message on reject, and clears both on a working retry', async () => {
    const dom = mountShare({ tiles: 60, total: 200 })
    const link = dom.moreBox.q['a']!
    expect(dom.moreError.hidden).toBe(true)

    link.fire('click', { preventDefault: () => {} })
    // Immediate feedback for a 3s LTE fetch — no spinner used to mean no
    // visible difference between "working" and "the tap did nothing".
    expect(link.getAttribute('aria-busy')).toBe('true')

    dom.fetches[0]!.reject()
    await flush()
    expect(link.getAttribute('aria-busy')).toBe('false')
    expect(dom.moreError.hidden).toBe(false)

    link.fire('click', { preventDefault: () => {} })
    dom.fetches[1]!.resolve('<figure></figure>'.repeat(60))
    await flush()
    expect(dom.moreError.hidden).toBe(true)
  })

  it('a failed lightbox image leaves the current frame on screen and surfaces an error, not a broken glyph', () => {
    const dom = mountShare({ tiles: 5, total: 5, hasMore: false })
    dom.openTile(1) // photo 2 — the queue is empty, so this loads synchronously
    const shownSrc = dom.lbimg.src
    expect(dom.lbimg.hidden).toBe(false)
    expect(dom.lberror.hidden).toBe(true)

    const before = dom.images.length
    dom.queueImageComplete(false) // photo 3's preload stays "in flight"
    dom.key('ArrowRight')
    expect(dom.lbstage.dataset['loading']).toBe('1')
    expect(dom.lbimg.src).toBe(shownSrc) // still photo 2 while photo 3 loads

    dom.images[before]!.onerror?.()

    // NOT the failed url — the comment above the old code said "keep the
    // current frame on screen" but the onerror path committed it anyway.
    expect(dom.lbimg.src).toBe(shownSrc)
    expect(dom.lbstage.dataset['loading']).toBe('0')
    expect(dom.lberror.hidden).toBe(false)
  })

  it('a one-finger drag on a pinch-zoomed photo pans, it does not swipe', () => {
    const dom = mountShare({ tiles: 5, total: 5, hasMore: false })
    dom.openTile(1)
    expect(dom.counter.textContent).toBe('2 / 5')

    // touch-action: pinch-zoom lets the visitor zoom in; panning the enlarged
    // frame is a NEW single-touch gesture, so the multi-touch flag is false.
    dom.win.visualViewport = { scale: 2.4 }
    dom.swipe(-120)
    expect(dom.counter.textContent).toBe('2 / 5')

    dom.win.visualViewport = { scale: 1 }
    dom.swipe(-120)
    expect(dom.counter.textContent).toBe('3 / 5')
  })
})

function mountLanding(
  shares: Array<{ slug: string; token: string; title: string; count: number }>,
  session = fakeStorage(),
) {
  const empty = new FakeEl()
  const redirect = new FakeEl()
  const section = new FakeEl()
  const list = new FakeEl()
  const byId: Record<string, FakeEl> = {
    'landing-empty': empty,
    'landing-redirect': redirect,
    'landing-section': section,
    'landing-list': list,
  }
  const document = {
    documentElement: new FakeEl(),
    getElementById: (id: string) => byId[id] ?? null,
    querySelectorAll: () => [] as FakeEl[],
  }
  const assigned: string[] = []
  const replaced: string[] = []
  const pageshow: Handler[] = []
  const win = {
    location: {
      assign: (url: string) => void assigned.push(url),
      replace: (url: string) => void replaced.push(url),
    },
    addEventListener: (type: string, fn: Handler) => {
      if (type === 'pageshow') pageshow.push(fn)
    },
  }

  const run = new Function(
    'window',
    'document',
    'localStorage',
    'sessionStorage',
    'navigator',
    landingScript(CATALOGUE),
  )
  run(win, document, fakeStorage({ 'image-share.shares': JSON.stringify(shares) }), session, {
    languages: ['en'],
    language: 'en',
  })

  return { empty, redirect, section, list, assigned, replaced, session, pageshow }
}

describe('landingScript — the single remembered share', () => {
  const one = [{ slug: 'mallorca', token: 'tok', title: 'Mallorca', count: 12 }]

  it('opens the only remembered share on the first visit', () => {
    const dom = mountLanding(one)
    expect(dom.assigned).toEqual(['/s/mallorca?token=tok'])
    // NOT replace(): the destination may be the opaque 404, which carries no
    // links, and Back has to be able to get the visitor off it.
    expect(dom.replaced).toEqual([])
    expect(dom.section.hidden).toBe(true)
  })

  it('shows the list (with Remove) instead of bouncing again on the way back', () => {
    const session = fakeStorage()
    mountLanding(one, session)
    const back = mountLanding(one, session)

    expect(back.assigned).toEqual([])
    expect(back.redirect.hidden).toBe(true)
    expect(back.section.hidden).toBe(false)
    expect(back.list.innerHTML).toContain('data-slug="mallorca"')
    expect(back.list.innerHTML).toContain('Mallorca')
  })

  it('re-renders when the page comes back from the bfcache', () => {
    const dom = mountLanding(one)
    expect(dom.pageshow).toHaveLength(1)

    dom.session.map.set('image-share.redirected', 'mallorca')
    dom.pageshow[0]!({ persisted: true })

    expect(dom.section.hidden).toBe(false)
    expect(dom.list.innerHTML).toContain('data-slug="mallorca"')
  })
})

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import sharp from 'sharp'
import { createDb, db as defaultDb, runMigrations, type Db } from '../db/index.js'
import { images, shareImages, shares, shareTokens } from '../db/schema.js'
import { setShareDb } from '../lib/share-auth.js'
import { rootBaseDir } from '../lib/paths.js'
import { render404Page } from './page/index.js'
import { shareRoutes } from './routes.js'

let db: Db
const app = new Elysia().use(shareRoutes)

const get = (path: string): Promise<Response> => app.handle(new Request(`http://localhost${path}`))

// Real fixture files under the dev-default fuji/raws roots (never a real photo
// tree — see CLAUDE.md) so the file/raw/zip byte-serving routes have
// something to actually read.
const SUB = `share-routes-test-${process.pid}-${Date.now()}`
const fujiBase = rootBaseDir('fuji')
const rawsBase = rootBaseDir('raws')

async function seedShare(over: Partial<typeof shares.$inferInsert>): Promise<number> {
  const [row] = await db
    .insert(shares)
    .values({
      slug: 'x',
      title: 'x',
      sourceType: 'folder',
      root: 'fuji',
      dir: SUB,
      createdAt: '2026-01-01T00:00:00.000Z',
      ...over,
    })
    .returning()
  return row!.id
}

async function seedToken(
  shareId: number,
  token: string,
  role: 'view' | 'download' | 'full',
  revokedAt?: string,
): Promise<void> {
  await db.insert(shareTokens).values({
    shareId,
    token,
    role,
    createdAt: '2026-01-01T00:00:00.000Z',
    revokedAt: revokedAt ?? null,
  })
}

async function seedImage(over: Partial<typeof images.$inferInsert> = {}): Promise<number> {
  const [row] = await db
    .insert(images)
    .values({
      root: 'fuji',
      relPath: `${SUB}/a.jpg`,
      dir: SUB,
      stem: 'a',
      ext: 'jpg',
      kind: 'jpeg',
      fileSize: 1,
      mtimeMs: 1,
      rating: 5,
      captureAt: '2026-06-01',
      indexedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    })
    .returning()
  return row!.id
}

let imageId: number
let pairedImageId: number
let subImageId: number
let earlyImageId: number
let rafRowId: number
const OPAQUE = render404Page()

beforeAll(async () => {
  mkdirSync(join(fujiBase, SUB), { recursive: true })
  mkdirSync(join(rawsBase, SUB), { recursive: true })
  // Real JPEGs — the img route renders through sharp, which rejects the fake
  // byte fixtures used elsewhere (zip.test.ts never decodes its payloads).
  await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .jpeg()
    .toFile(join(fujiBase, SUB, 'a.jpg'))
  await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 40, g: 50, b: 60 } },
  })
    .jpeg()
    .toFile(join(fujiBase, SUB, 'paired.jpg'))
  writeFileSync(join(rawsBase, SUB, 'paired.RAF'), Buffer.alloc(32, 0x33))
  // Sub-directory image — real bytes so the recursive `gallery` share (which
  // legitimately contains it) can still render and zip it.
  mkdirSync(join(fujiBase, SUB, 'sub'), { recursive: true })
  await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 70, g: 80, b: 90 } },
  })
    .jpeg()
    .toFile(join(fujiBase, SUB, 'sub', 'nested.jpg'))

  const created = createDb(':memory:')
  db = created.db
  runMigrations(db)
  setShareDb(db)

  imageId = await seedImage()
  pairedImageId = await seedImage({
    relPath: `${SUB}/paired.jpg`,
    stem: 'paired',
    rawPath: `${SUB}/paired.RAF`,
  })

  const galId = await seedShare({ slug: 'gallery' })
  await seedToken(galId, 'view-tk', 'view')
  await seedToken(galId, 'dl-tk', 'download')
  await seedToken(galId, 'full-tk', 'full')
  await seedToken(galId, 'rolled', 'view', '2026-02-01T00:00:00.000Z')

  const expId = await seedShare({ slug: 'expired', expiresAt: '2000-01-01T00:00:00.000Z' })
  await seedToken(expId, 'et', 'full')

  // A non-recursive folder share over the same dir: the sub-directory image
  // below must be neither listed nor reachable by id.
  subImageId = await seedImage({
    relPath: `${SUB}/sub/nested.jpg`,
    dir: `${SUB}/sub`,
    stem: 'nested',
  })
  const flatId = await seedShare({ slug: 'flat', recursive: false })
  await seedToken(flatId, 'flat-tk', 'full')

  // A selection share, written the way the admin used to write one: newest
  // first (the grid's default captureAt/desc browse sort), plus a `.RAF` row of
  // the kind that could enter `share_images` before POST/PATCH vetted the ids.
  await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })
    .jpeg()
    .toFile(join(fujiBase, SUB, 'early.jpg'))
  earlyImageId = await seedImage({
    relPath: `${SUB}/early.jpg`,
    stem: 'early',
    captureAt: '2026-05-01T00:00:00.000Z',
  })
  rafRowId = await seedImage({
    root: 'raws',
    relPath: `${SUB}/paired.RAF`,
    dir: SUB,
    stem: 'paired',
    ext: 'raf',
    kind: 'raw',
    captureAt: '2026-04-01T00:00:00.000Z',
  })
  const picksId = await seedShare({ slug: 'picks', sourceType: 'selection', root: null, dir: null })
  await seedToken(picksId, 'picks-tk', 'full')
  await db.insert(shareImages).values([
    { shareId: picksId, imageId: rafRowId, position: 0 },
    { shareId: picksId, imageId, position: 1 },
    { shareId: picksId, imageId: earlyImageId, position: 2 },
  ])
})

afterAll(() => {
  setShareDb(defaultDb)
  rmSync(join(fujiBase, SUB), { recursive: true, force: true })
  rmSync(join(rawsBase, SUB), { recursive: true, force: true })
})

describe('GET /s/:slug (page)', () => {
  it('renders the gallery with token threaded into asset URLs', async () => {
    const res = await get('/s/gallery?token=view-tk')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain(`/s/gallery/img/${imageId}?size=thumb&amp;token=view-tk`)
  })

  it('hides download/zip affordances for a view-role token', async () => {
    const html = await (await get('/s/gallery?token=view-tk')).text()
    // Note: the localized string catalogue (for client-side language
    // switching) is always embedded — the actual gating is whether the
    // download-all element itself is rendered.
    expect(html).not.toContain('data-i18n="downloadAll"')
    expect(html).not.toContain('id="lbdl"')
  })

  it('shows download but not RAW for a download-role token', async () => {
    const html = await (await get('/s/gallery?token=dl-tk')).text()
    expect(html).toContain('data-i18n="downloadAll"')
    expect(html).toContain('id="lbdl"')
    expect(html).not.toContain('id="lbraw"')
  })

  it('shows RAW for a full-role token', async () => {
    const html = await (await get('/s/gallery?token=full-tk')).text()
    expect(html).toContain('id="lbraw"')
  })

  it('collapses every denial cause to the identical opaque 404 body', async () => {
    const cases = [
      '/s/unknown?token=view-tk', // unknown slug
      '/s/gallery', // missing token
      '/s/gallery?token=rolled', // revoked/rolled token
      '/s/expired?token=et', // expired share
    ]
    for (const path of cases) {
      const res = await get(path)
      expect(res.status).toBe(404)
      expect(await res.text()).toBe(OPAQUE)
    }
  })
})

describe('non-recursive folder share', () => {
  it('omits sub-directory images from the page', async () => {
    const html = await (await get('/s/flat?token=flat-tk')).text()
    expect(html).toContain(`/s/flat/img/${imageId}?size=thumb&amp;token=flat-tk`)
    expect(html).not.toContain(`/s/flat/img/${subImageId}?`)
  })

  it('404s a sub-directory image by id — the asset routes agree with the page', async () => {
    for (const path of [
      `/s/flat/img/${subImageId}?token=flat-tk&size=med`,
      `/s/flat/file/${subImageId}?token=flat-tk`,
    ]) {
      const res = await get(path)
      expect(res.status).toBe(404)
      expect(await res.text()).toBe(OPAQUE)
    }
    // Control: the same token reaches an image that IS in the share.
    expect((await get(`/s/flat/img/${imageId}?token=flat-tk&size=med`)).status).toBe(200)
  })
})

// ── What the friend actually receives from a selection share ─────────────────
describe('selection share on the public surface', () => {
  it('ships oldest-first, whatever order the tiles were written in', async () => {
    const html = await (await get('/s/picks?token=picks-tk')).text()
    const early = html.indexOf(`/s/picks/img/${earlyImageId}?`)
    const later = html.indexOf(`/s/picks/img/${imageId}?`)
    expect(early).toBeGreaterThan(-1)
    expect(later).toBeGreaterThan(-1)
    // The share was written newest-first; the gallery must still read forwards.
    expect(early).toBeLessThan(later)
  })

  it('never renders — or serves — a RAF tile, so no tile can 500', async () => {
    const html = await (await get('/s/picks?token=picks-tk')).text()
    expect(html).not.toContain(`/s/picks/img/${rafRowId}?`)
    // sharp cannot decode a .RAF: without the fail-closed filter this is a 500
    // on the friend's page rather than the surface's single opaque 404.
    for (const path of [
      `/s/picks/img/${rafRowId}?token=picks-tk&size=thumb`,
      `/s/picks/img/${rafRowId}?token=picks-tk&size=med`,
      `/s/picks/file/${rafRowId}?token=picks-tk`,
    ]) {
      const res = await get(path)
      expect(res.status).toBe(404)
      expect(await res.text()).toBe(OPAQUE)
    }
    // Control: the JPEGs in the same share are reachable with the same token.
    expect((await get(`/s/picks/img/${imageId}?token=picks-tk&size=med`)).status).toBe(200)
  })
})

describe('GET /s/:slug/img/:id (role-gated sizes)', () => {
  it('404s an id that does not belong to the share', async () => {
    const res = await get(`/s/gallery/img/999999?token=full-tk&size=med`)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe(OPAQUE)
  })

  it('view: thumb/small/med ok, full denied', async () => {
    for (const size of ['thumb', 'small', 'med']) {
      expect((await get(`/s/gallery/img/${imageId}?token=view-tk&size=${size}`)).status).toBe(200)
    }
    const full = await get(`/s/gallery/img/${imageId}?token=view-tk&size=full`)
    expect(full.status).toBe(404)
    expect(await full.text()).toBe(OPAQUE)
  })

  it('download and full: thumb/small/med/full all ok', async () => {
    for (const token of ['dl-tk', 'full-tk']) {
      for (const size of ['thumb', 'small', 'med', 'full']) {
        const res = await get(`/s/gallery/img/${imageId}?token=${token}&size=${size}`)
        expect(res.status).toBe(200)
      }
    }
  })

  // The full role/size permission table, asserted as one grid so a new size can
  // never be silently added to the wrong role.
  it('the whole role × size table collapses every denial to the SAME 404 body', async () => {
    const allowed: Record<string, ReadonlySet<string>> = {
      'view-tk': new Set(['thumb', 'small', 'med']),
      'dl-tk': new Set(['thumb', 'small', 'med', 'full']),
      'full-tk': new Set(['thumb', 'small', 'med', 'full']),
    }
    for (const [token, sizes] of Object.entries(allowed)) {
      for (const size of ['thumb', 'small', 'med', 'full']) {
        const res = await get(`/s/gallery/img/${imageId}?token=${token}&size=${size}`)
        if (sizes.has(size)) {
          expect(res.status).toBe(200)
        } else {
          expect(res.status).toBe(404)
          expect(await res.text()).toBe(OPAQUE)
        }
      }
      // A size that does not exist at all is the same opaque 404 — never a
      // validation error that would distinguish it from a role denial.
      const bogus = await get(`/s/gallery/img/${imageId}?token=${token}&size=huge`)
      expect(bogus.status).toBe(404)
      expect(await bogus.text()).toBe(OPAQUE)
    }
  })
})

describe('share response headers', () => {
  it('sets Referrer-Policy: no-referrer on every share route, denials included', async () => {
    const paths = [
      '/s/gallery?token=view-tk',
      `/s/gallery/img/${imageId}?token=view-tk&size=thumb`,
      `/s/gallery/file/${imageId}?token=dl-tk`,
      '/s/gallery/zip?token=dl-tk',
      '/s/unknown?token=nope',
      `/s/gallery/img/${imageId}?token=view-tk&size=full`,
    ]
    for (const path of paths) {
      const res = await get(path)
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    }
  })

  it('never lets a shared cache keep the tokenised share HTML', async () => {
    const res = await get('/s/gallery?token=view-tk')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })
})

describe('GET /s/:slug — progressive reveal window', () => {
  it('serves only tiles for frag=1, and the full document otherwise', async () => {
    const full = await (await get('/s/gallery?token=view-tk')).text()
    expect(full).toContain('<!doctype html>')

    const frag = await get('/s/gallery?token=view-tk&frag=1')
    expect(frag.status).toBe(200)
    const body = await frag.text()
    expect(body).not.toContain('<!doctype html>')
    expect(body).toContain('<figure class="tile')
  })

  it('an out-of-range `from` falls back to the first window instead of an empty gallery', async () => {
    const html = await (await get('/s/gallery?token=view-tk&from=9999')).text()
    expect(html).toContain(`/s/gallery/img/${imageId}?size=thumb&amp;token=view-tk`)
  })

  it('an out-of-range `from` on a fragment request returns an empty window, not the first one again', async () => {
    // Repro: the client cached a stale (larger) `total` and keeps walking
    // `loadMore()` forward past a share that shrank mid-session. Falling back
    // to window 0 here would re-serve already-appended tiles forever.
    const res = await get('/s/gallery?token=view-tk&frag=1&from=9999')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('<figure class="tile')
  })

  it('a denied token gets the opaque 404 on the fragment route too', async () => {
    const res = await get('/s/gallery?token=rolled&frag=1')
    expect(res.status).toBe(404)
    expect(await res.text()).toBe(OPAQUE)
  })
})

describe('no-JS reachability', () => {
  it('every tile is a plain <a href> to a rendition the role may open', async () => {
    const viewHtml = await (await get('/s/gallery?token=view-tk')).text()
    expect(viewHtml).toContain(
      `<a class="tile-btn" href="/s/gallery/img/${imageId}?size=med&amp;token=view-tk"`,
    )
    const dlHtml = await (await get('/s/gallery?token=dl-tk')).text()
    expect(dlHtml).toContain(
      `<a class="tile-btn" href="/s/gallery/img/${imageId}?size=full&amp;token=dl-tk"`,
    )
    // …and that href actually resolves for that role.
    expect((await get(`/s/gallery/img/${imageId}?size=med&token=view-tk`)).status).toBe(200)
    expect((await get(`/s/gallery/img/${imageId}?size=full&token=dl-tk`)).status).toBe(200)
  })
})

describe('the ZIP size label', () => {
  it('renders the predicted byte total and photo count into the control', async () => {
    const html = await (await get('/s/gallery?token=dl-tk')).text()
    // Two 40x30 JPEG fixtures — small, but the label must be present and real.
    expect(html).toMatch(/class="zip-meta">[\d.,]+ (B|kB|MB|GB) · \d+ photos</)
    expect(html).toMatch(/"zipBytes":[1-9]\d*/)
  })

  it('a view-role page has no ZIP control at all', async () => {
    const html = await (await get('/s/gallery?token=view-tk')).text()
    expect(html).not.toContain('id="zipBtn"')
    expect(html).toContain('"zipBytes":0')
  })
})

describe('GET /s/:slug/file/:id (role-gated download)', () => {
  it('view: denied entirely', async () => {
    const res = await get(`/s/gallery/file/${imageId}?token=view-tk`)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe(OPAQUE)
  })

  it('download: original bytes ok, raw=1 denied', async () => {
    const res = await get(`/s/gallery/file/${pairedImageId}?token=dl-tk`)
    expect(res.status).toBe(200)
    const raw = await get(`/s/gallery/file/${pairedImageId}?token=dl-tk&raw=1`)
    expect(raw.status).toBe(404)
    expect(await raw.text()).toBe(OPAQUE)
  })

  it('full: original bytes ok, raw=1 serves the paired RAF', async () => {
    const res = await get(`/s/gallery/file/${pairedImageId}?token=full-tk`)
    expect(res.status).toBe(200)
    const raw = await get(`/s/gallery/file/${pairedImageId}?token=full-tk&raw=1`)
    expect(raw.status).toBe(200)
    expect(raw.headers.get('content-type')).toBe('application/octet-stream')
  })

  it('full: raw=1 404s when the image has no paired RAF', async () => {
    const res = await get(`/s/gallery/file/${imageId}?token=full-tk&raw=1`)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe(OPAQUE)
  })
})

describe('GET /s/:slug/zip (role-gated)', () => {
  it('view: denied', async () => {
    const res = await get('/s/gallery/zip?token=view-tk')
    expect(res.status).toBe(404)
    expect(await res.text()).toBe(OPAQUE)
  })

  it('download and full: streams a zip', async () => {
    for (const token of ['dl-tk', 'full-tk']) {
      const res = await get(`/s/gallery/zip?token=${token}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/zip')
    }
  })
})

describe('the removed unlock route', () => {
  it('POST /s/:slug/unlock 404s like everything else (no such route anymore)', async () => {
    const res = await app.handle(
      new Request('http://localhost/s/gallery/unlock?token=view-tk', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'password=x',
      }),
    )
    expect(res.status).toBe(404)
  })
})

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import sharp from 'sharp'
import { createDb, db as defaultDb, runMigrations, type Db } from '../db/index.js'
import { images, shares, shareTokens } from '../db/schema.js'
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

describe('GET /s/:slug/img/:id (role-gated sizes)', () => {
  it('404s an id that does not belong to the share', async () => {
    const res = await get(`/s/gallery/img/999999?token=full-tk&size=med`)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe(OPAQUE)
  })

  it('view: thumb/med ok, full denied', async () => {
    expect((await get(`/s/gallery/img/${imageId}?token=view-tk&size=thumb`)).status).toBe(200)
    expect((await get(`/s/gallery/img/${imageId}?token=view-tk&size=med`)).status).toBe(200)
    const full = await get(`/s/gallery/img/${imageId}?token=view-tk&size=full`)
    expect(full.status).toBe(404)
    expect(await full.text()).toBe(OPAQUE)
  })

  it('download and full: thumb/med/full all ok', async () => {
    for (const token of ['dl-tk', 'full-tk']) {
      for (const size of ['thumb', 'med', 'full']) {
        const res = await get(`/s/gallery/img/${imageId}?token=${token}&size=${size}`)
        expect(res.status).toBe(200)
      }
    }
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

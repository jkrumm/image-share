import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { dirname, join } from 'node:path'
import { rmSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { Elysia } from 'elysia'
import * as schema from '../db/schema.js'
import { env } from '../env.js'
import { renditionCacheKey, renditionCachePath } from '../renditions/cache.js'

// Isolated :memory: db — see the note in shares.test.ts (same `--isolate`
// caveat for combined multi-file runs; this file is validated standalone).
const sqlite = new Database(':memory:')
sqlite.exec('PRAGMA foreign_keys = ON;')
const testDb = drizzle(sqlite, { schema })
migrate(testDb, { migrationsFolder: join(import.meta.dir, '../../drizzle') })

mock.module('../db/index.js', () => ({
  db: testDb,
  sqlite,
  createDb: () => ({ db: testDb, sqlite }),
  runMigrations: () => {},
}))

const { libraryRoutes, libraryFileRoutes } = await import('./library.js')
const { authGuard } = await import('../lib/auth-guard.js')

const fixtureDir = join(env.SHARE_ROOT, 'library-test-fixtures')

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true })
})

// Mirrors index.ts's real order: public routes first, THEN the scoped guard,
// THEN the bearer-guarded admin routes — so the guard covers libraryRoutes but
// not libraryFileRoutes, exactly like production.
function buildApp() {
  return new Elysia().use(libraryFileRoutes).use(authGuard).use(libraryRoutes)
}

describe('bearer guard boundary', () => {
  it('rejects /api/library/dirs without a bearer header, even with an asset token', async () => {
    const app = buildApp()
    const mintRes = await app.handle(
      new Request('http://localhost/api/library/asset-token', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.API_SECRET}` },
      }),
    )
    const { token } = (await mintRes.json()) as { token: string }

    const res = await app.handle(
      new Request(`http://localhost/api/library/dirs?assetToken=${token}`),
    )
    expect(res.status).toBe(401)
  })

  it('accepts /api/library/dirs with the bearer header', async () => {
    const app = buildApp()
    const res = await app.handle(
      new Request('http://localhost/api/library/dirs', {
        headers: { authorization: `Bearer ${env.API_SECRET}` },
      }),
    )
    expect(res.status).toBe(200)
  })
})

describe('GET /api/library/images/:id/file', () => {
  it('rejects with neither bearer nor assetToken', async () => {
    const app = buildApp()
    const res = await app.handle(new Request('http://localhost/api/library/images/1/file'))
    expect(res.status).toBe(401)
  })

  it('rejects ?assetToken=<API_SECRET> (the raw bearer must never work as a query value)', async () => {
    const now = new Date().toISOString()
    const relPath = 'library-test-fixtures/reject-raw-bearer.jpg'
    await Bun.write(join(env.SHARE_ROOT, relPath), new Uint8Array([1, 2, 3, 4]))
    const [row] = await testDb
      .insert(schema.images)
      .values({
        root: 'share',
        relPath,
        dir: 'library-test-fixtures',
        stem: 'reject-raw-bearer',
        ext: 'jpg',
        kind: 'jpeg',
        fileSize: 4,
        mtimeMs: Date.now(),
        captureAt: null,
        orientation: null,
        rating: null,
        width: null,
        height: null,
        rawPath: null,
        indexedAt: now,
      })
      .returning({ id: schema.images.id })
    if (!row) throw new Error('seed failed')

    const app = buildApp()
    const res = await app.handle(
      new Request(
        `http://localhost/api/library/images/${row.id}/file?size=orig&assetToken=${env.API_SECRET}`,
      ),
    )
    expect(res.status).toBe(401)
  })

  it('accepts a minted ?assetToken=… (the only route allowed to)', async () => {
    const now = new Date().toISOString()
    const relPath = 'library-test-fixtures/orig.jpg'
    await Bun.write(join(env.SHARE_ROOT, relPath), new Uint8Array([1, 2, 3, 4]))
    const [row] = await testDb
      .insert(schema.images)
      .values({
        root: 'share',
        relPath,
        dir: 'library-test-fixtures',
        stem: 'orig',
        ext: 'jpg',
        kind: 'jpeg',
        fileSize: 4,
        mtimeMs: Date.now(),
        captureAt: null,
        orientation: null,
        rating: null,
        width: null,
        height: null,
        rawPath: null,
        indexedAt: now,
      })
      .returning({ id: schema.images.id })
    if (!row) throw new Error('seed failed')

    const app = buildApp()
    const mintRes = await app.handle(
      new Request('http://localhost/api/library/asset-token', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.API_SECRET}` },
      }),
    )
    expect(mintRes.status).toBe(200)
    const { token } = (await mintRes.json()) as { token: string }

    const res = await app.handle(
      new Request(
        `http://localhost/api/library/images/${row.id}/file?size=orig&assetToken=${token}`,
      ),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  it('answers 415 (not an unhandled 500) for a rendition size on a RAF row', async () => {
    // The regression: renderRendition rejects every .raf input, so a grid
    // browsing the raws root turned 60 tiles into 60 unhandled 500s.
    const now = new Date().toISOString()
    const relPath = 'library-test-fixtures/no-rendition.raf'
    await Bun.write(join(env.SHARE_ROOT, relPath), new Uint8Array([1, 2, 3, 4]))
    const [row] = await testDb
      .insert(schema.images)
      .values({
        root: 'share',
        relPath,
        dir: 'library-test-fixtures',
        stem: 'no-rendition',
        ext: 'raf',
        kind: 'raw',
        fileSize: 4,
        mtimeMs: Date.now(),
        captureAt: null,
        orientation: null,
        rating: null,
        width: null,
        height: null,
        rawPath: null,
        indexedAt: now,
      })
      .returning({ id: schema.images.id })
    if (!row) throw new Error('seed failed')

    const app = buildApp()
    for (const size of ['thumb', 'med', 'full'] as const) {
      const res = await app.handle(
        new Request(`http://localhost/api/library/images/${row.id}/file?size=${size}`, {
          headers: { authorization: `Bearer ${env.API_SECRET}` },
        }),
      )
      expect(res.status).toBe(415)
    }

    const orig = await app.handle(
      new Request(`http://localhost/api/library/images/${row.id}/file?size=orig`, {
        headers: { authorization: `Bearer ${env.API_SECRET}` },
      }),
    )
    expect(orig.status).toBe(200)
  })
})

describe('GET /api/library/images ?recursive', () => {
  // `z.coerce.boolean()` made `?recursive=false` recursive (Boolean('false') is
  // true), so the Library grid and the create-share count preview were always
  // recursive regardless of the toggle.
  async function seedDir(root: string, dir: string, stem: string): Promise<number> {
    const now = new Date().toISOString()
    const [row] = await testDb
      .insert(schema.images)
      .values({
        root,
        relPath: `${dir}/${stem}.jpg`,
        dir,
        stem,
        ext: 'jpg',
        kind: 'jpeg',
        fileSize: 1,
        mtimeMs: 1,
        captureAt: null,
        orientation: null,
        rating: null,
        width: null,
        height: null,
        rawPath: null,
        indexedAt: now,
      })
      .returning({ id: schema.images.id })
    if (!row) throw new Error('seed failed')
    return row.id
  }

  async function list(qs: string) {
    const res = await buildApp().handle(
      new Request(`http://localhost/api/library/images?${qs}`, {
        headers: { authorization: `Bearer ${env.API_SECRET}` },
      }),
    )
    expect(res.status).toBe(200)
    return (await res.json()) as { data: { id: number }[]; total: number }
  }

  it('honours recursive=false and recursive=true', async () => {
    const top = await seedDir('raws', 'rec-test', 'top')
    const sub = await seedDir('raws', 'rec-test/day1', 'sub')

    const flat = await list('root=raws&dir=rec-test&recursive=false')
    expect(flat.data.map((r) => r.id)).toEqual([top])
    expect(flat.total).toBe(1)

    const deep = await list('root=raws&dir=rec-test&recursive=true')
    expect(deep.total).toBe(2)
    expect(deep.data.map((r) => r.id).toSorted()).toEqual([top, sub].toSorted())
  })

  // Regression: this route is the create-share count preview, and POST
  // /api/shares resolves an omitted `source.recursive` to TRUE. A `?? false`
  // here made the preview of a parent folder report only its own images while
  // the share it previewed contained the whole subtree.
  it('defaults to recursive when the flag is omitted, matching the folder-share default', async () => {
    const top = await seedDir('raws', 'default-rec', 'dr-top')
    const sub = await seedDir('raws', 'default-rec/day1', 'dr-sub')

    const defaulted = await list('root=raws&dir=default-rec')
    const explicit = await list('root=raws&dir=default-rec&recursive=true')
    expect(defaulted.total).toBe(2)
    expect(defaulted.total).toBe(explicit.total)
    expect(defaulted.data.map((r) => r.id).toSorted((a, b) => a - b)).toEqual(
      [top, sub].toSorted((a, b) => a - b),
    )
  })

  it('matches the folder-share dir scope: no case-variant or wildcard siblings', async () => {
    const mine = await seedDir('raws', 'Scope_1/sub', 'mine')
    await seedDir('raws', 'scope_1/sub', 'othercase')
    await seedDir('raws', 'ScopeX1/sub', 'wildcard')

    const res = await list('root=raws&dir=Scope_1&recursive=true')
    expect(res.data.map((r) => r.id)).toEqual([mine])
    expect(res.total).toBe(1)
  })
})

describe('GET /api/library/images ?stem', () => {
  async function seedStem(stem: string): Promise<number> {
    const now = new Date().toISOString()
    const [row] = await testDb
      .insert(schema.images)
      .values({
        root: 'raws',
        relPath: `stem-test/${stem}.raf`,
        dir: 'stem-test',
        stem,
        ext: 'raf',
        kind: 'raw',
        fileSize: 1,
        mtimeMs: 1,
        captureAt: null,
        orientation: null,
        rating: null,
        width: null,
        height: null,
        rawPath: null,
        indexedAt: now,
      })
      .returning({ id: schema.images.id })
    if (!row) throw new Error('seed failed')
    return row.id
  }

  async function list(qs: string) {
    const res = await buildApp().handle(
      new Request(`http://localhost/api/library/images?${qs}`, {
        headers: { authorization: `Bearer ${env.API_SECRET}` },
      }),
    )
    expect(res.status).toBe(200)
    return (await res.json()) as { data: { id: number }[]; total: number }
  }

  it('matches a case-insensitive substring of the stem', async () => {
    const match = await seedStem('DSCF-Sunset-1234')
    await seedStem('DSCF-Rainy-5678')

    const res = await list('root=raws&dir=stem-test&stem=sunset')
    expect(res.data.map((r) => r.id)).toEqual([match])
    expect(res.total).toBe(1)
  })
})

describe('DELETE /api/images/:id', () => {
  async function seedImage(root: 'fuji' | 'raws' | 'share', relPath: string): Promise<number> {
    const now = new Date().toISOString()
    const [row] = await testDb
      .insert(schema.images)
      .values({
        root,
        relPath,
        dir: 'library-test-fixtures',
        stem: 'delete-me',
        ext: 'jpg',
        kind: 'jpeg',
        fileSize: 4,
        mtimeMs: 1000,
        captureAt: null,
        orientation: null,
        rating: null,
        width: null,
        height: null,
        rawPath: null,
        indexedAt: now,
      })
      .returning({ id: schema.images.id })
    if (!row) throw new Error('seed failed')
    return row.id
  }

  it('rejects fuji/raws images with 403 and does not touch the row', async () => {
    const id = await seedImage('fuji', 'library-test-fixtures/fuji-image.jpg')

    const res = await buildApp().handle(
      new Request(`http://localhost/api/images/${id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${env.API_SECRET}` },
      }),
    )
    expect(res.status).toBe(403)

    const [row] = await testDb.select().from(schema.images).where(eq(schema.images.id, id))
    expect(row).toBeDefined()
  })

  it('404s on an unknown id', async () => {
    const res = await buildApp().handle(
      new Request('http://localhost/api/images/999999999', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${env.API_SECRET}` },
      }),
    )
    expect(res.status).toBe(404)
  })

  it('deletes a share-root image: file, rendition cache entries, and row; nulls a b2_objects link instead of deleting it', async () => {
    const relPath = 'library-test-fixtures/delete-me.jpg'
    const absPath = join(env.SHARE_ROOT, relPath)
    await Bun.write(absPath, new Uint8Array([1, 2, 3, 4]))

    const id = await seedImage('share', relPath)

    // EVERY size that can exist on disk, not just the ones the admin byte route
    // exposes: the share page's srcset generates `small`, so a delete that skips
    // it orphans a 900px webp of a photo that is gone.
    const cachePaths = (['thumb', 'small', 'med', 'full'] as const).map((size) =>
      renditionCachePath(
        renditionCacheKey({ root: 'share', relPath, mtimeMs: 1000, fileSize: 4, size }),
        size,
      ),
    )
    for (const cachePath of cachePaths) {
      await mkdir(dirname(cachePath), { recursive: true })
      await Bun.write(cachePath, new Uint8Array([9, 9]))
    }

    const publishedNow = new Date().toISOString()
    await testDb.insert(schema.b2Objects).values({
      key: 'img/misc/delete-me-published.jpg',
      size: 4,
      lastModified: publishedNow,
      publishedImageId: id,
      firstSeenAt: publishedNow,
    })

    const res = await buildApp().handle(
      new Request(`http://localhost/api/images/${id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${env.API_SECRET}` },
      }),
    )
    expect(res.status).toBe(200)
    expect((await res.json()) as { deleted: boolean }).toEqual({ deleted: true })

    expect(await Bun.file(absPath).exists()).toBe(false)
    for (const cachePath of cachePaths) {
      expect(await Bun.file(cachePath).exists()).toBe(false)
    }

    const [row] = await testDb.select().from(schema.images).where(eq(schema.images.id, id))
    expect(row).toBeUndefined()

    const [b2Row] = await testDb
      .select()
      .from(schema.b2Objects)
      .where(eq(schema.b2Objects.key, 'img/misc/delete-me-published.jpg'))
    expect(b2Row).toBeDefined()
    expect(b2Row?.publishedImageId).toBeNull()
  })
})

// ── Album / capture-date browse axes ─────────────────────────────────────────
// The Fuji tree is one flat directory, so these two axes — not `dir` — are how
// the library is actually browsed. One shared fixture mirroring the real
// library's tag shape ('Ereignisse|Segeln 25' with siblings, a couple of Insta
// posts, and a large untagged remainder), nested under one describe so its
// beforeAll runs AFTER the describes above have finished seeding.
describe('album and capture-date browse axes', () => {
  type AlbumNode = {
    path: string
    leaf: string
    depth: number
    imageCount: number
    ratedCounts: { r4plus: number; r5: number }
    minCaptureAt: string | null
    maxCaptureAt: string | null
  }

  const fujiIds: Record<string, number> = {}

  async function seedFuji(opts: {
    stem: string
    keywords: string[]
    kind?: 'jpeg' | 'raw'
    rating?: number | null
    captureAt?: string | null
  }): Promise<number> {
    const now = new Date().toISOString()
    const [row] = await testDb
      .insert(schema.images)
      .values({
        root: 'fuji',
        relPath: `${opts.stem}.JPG`,
        dir: '',
        stem: opts.stem,
        ext: 'jpg',
        kind: opts.kind ?? 'jpeg',
        fileSize: 1,
        mtimeMs: 1,
        captureAt: opts.captureAt ?? null,
        orientation: null,
        rating: opts.rating ?? null,
        width: null,
        height: null,
        rawPath: null,
        indexedAt: now,
      })
      .returning({ id: schema.images.id })
    if (!row) throw new Error('seed failed')
    if (opts.keywords.length > 0) {
      await testDb.insert(schema.imageKeywords).values(
        opts.keywords.map((path) => ({
          imageId: row.id,
          path,
          leaf: path.split('|').at(-1) ?? path,
        })),
      )
    }
    return row.id
  }

  async function get(path: string) {
    return buildApp().handle(
      new Request(`http://localhost${path}`, {
        headers: { authorization: `Bearer ${env.API_SECRET}` },
      }),
    )
  }

  async function listImages(qs: string) {
    const res = await get(`/api/library/images?${qs}`)
    expect(res.status).toBe(200)
    return (await res.json()) as { data: { id: number }[]; total: number }
  }

  /** Fixture stems of the returned images, sorted — order-independent sets. */
  function stemsOf(result: { data: { id: number }[] }): string[] {
    const byId = new Map(Object.entries(fujiIds).map(([stem, id]) => [id, stem]))
    return result.data.map((r) => byId.get(r.id) ?? `unknown:${r.id}`).toSorted()
  }

  beforeAll(async () => {
    // Own the whole 'fuji' root so the untagged count is exact regardless of
    // what the describes above seeded (image_keywords cascades).
    await testDb.delete(schema.images).where(eq(schema.images.root, 'fuji'))

    fujiIds['segeln-a'] = await seedFuji({
      stem: 'segeln-a',
      keywords: ['Ereignisse|Segeln 25', 'Insta Post Segel 25'],
      rating: 5,
      captureAt: '2026-07-04T08:00:00.000Z',
    })
    fujiIds['segeln-b'] = await seedFuji({
      stem: 'segeln-b',
      keywords: ['Ereignisse|Segeln 25'],
      rating: 4,
      captureAt: '2026-07-11T22:00:00.000Z',
    })
    // Two paths under the SAME parent — 'Ereignisse' must still count it once.
    fujiIds['both-c'] = await seedFuji({
      stem: 'both-c',
      keywords: ['Ereignisse|Segeln 25', 'Ereignisse|Marokko 25'],
      captureAt: '2026-07-06T12:00:00.000Z',
    })
    fujiIds['marokko'] = await seedFuji({
      stem: 'marokko',
      keywords: ['Insta Post Marokko'],
      captureAt: '2026-07-12T00:00:00.000Z',
    })
    // Case-variant sibling: a genuinely different album under BINARY collation.
    fujiIds['casevariant'] = await seedFuji({
      stem: 'casevariant',
      keywords: ['ereignisse|Segeln 25'],
      captureAt: '2026-01-01T00:00:00.000Z',
    })
    fujiIds['untagged-1'] = await seedFuji({
      stem: 'untagged-1',
      keywords: [],
      captureAt: '2026-07-04T00:00:00.000Z',
    })
    fujiIds['untagged-2'] = await seedFuji({ stem: 'untagged-2', keywords: [] })
    // kind='raw' rows carry no keywords and must stay out of the album tree.
    fujiIds['raw-1'] = await seedFuji({ stem: 'raw-1', keywords: [], kind: 'raw' })
  })

  describe('GET /api/library/albums', () => {
    it('synthesizes ancestor nodes, dedupes per image, and emits the untagged node', async () => {
      const res = await get('/api/library/albums?root=fuji')
      expect(res.status).toBe(200)
      const { data } = (await res.json()) as { data: AlbumNode[] }

      expect(data.map((n) => n.path)).toEqual([
        '',
        'Ereignisse',
        'Ereignisse|Marokko 25',
        'Ereignisse|Segeln 25',
        'Insta Post Marokko',
        'Insta Post Segel 25',
        'ereignisse',
        'ereignisse|Segeln 25',
      ])

      const byPath = new Map(data.map((n) => [n.path, n]))

      // The untagged node: both untagged JPEGs, and NOT the raw row.
      expect(byPath.get('')).toEqual({
        path: '',
        leaf: '(untagged)',
        depth: 0,
        imageCount: 2,
        ratedCounts: { r4plus: 0, r5: 0 },
        minCaptureAt: '2026-07-04T00:00:00.000Z',
        maxCaptureAt: '2026-07-04T00:00:00.000Z',
      })

      // 'Ereignisse' is never stored — it exists only as a synthesized prefix,
      // and both-c (tagged under two of its children) counts once.
      expect(byPath.get('Ereignisse')).toEqual({
        path: 'Ereignisse',
        leaf: 'Ereignisse',
        depth: 0,
        imageCount: 3,
        ratedCounts: { r4plus: 2, r5: 1 },
        minCaptureAt: '2026-07-04T08:00:00.000Z',
        maxCaptureAt: '2026-07-11T22:00:00.000Z',
      })

      expect(byPath.get('Ereignisse|Segeln 25')).toMatchObject({
        leaf: 'Segeln 25',
        depth: 1,
        imageCount: 3,
      })
      expect(byPath.get('Ereignisse|Marokko 25')).toMatchObject({ depth: 1, imageCount: 1 })
      expect(byPath.get('Insta Post Marokko')).toMatchObject({ depth: 0, imageCount: 1 })
      // segeln-a is tagged in two unrelated trees — once in each, not twice.
      expect(byPath.get('Insta Post Segel 25')).toMatchObject({ depth: 0, imageCount: 1 })
      // The case-variant sibling is its own album, not part of 'Ereignisse'.
      expect(byPath.get('ereignisse')).toMatchObject({ imageCount: 1 })
    })

    it('defaults to root=fuji and still emits the untagged node for a keyword-free root', async () => {
      const defaulted = await get('/api/library/albums')
      const explicit = await get('/api/library/albums?root=fuji')
      expect(await defaulted.json()).toEqual(await explicit.json())

      const res = await get('/api/library/albums?root=raws')
      expect(res.status).toBe(200)
      const { data } = (await res.json()) as { data: AlbumNode[] }
      expect(data.map((n) => n.path)).toEqual([''])
      expect(data[0]?.leaf).toBe('(untagged)')
    })
  })

  describe('GET /api/library/images ?album', () => {
    it('matches a whole subtree with recursive=true, only the exact album without', async () => {
      const deep = await listImages('root=fuji&album=Ereignisse&recursive=true')
      expect(stemsOf(deep)).toEqual(['both-c', 'segeln-a', 'segeln-b'])
      expect(deep.total).toBe(3)

      // Nothing is tagged with the bare parent path, so a non-recursive query
      // on a synthesized node is legitimately empty.
      const flat = await listImages('root=fuji&album=Ereignisse&recursive=false')
      expect(flat.total).toBe(0)

      const leaf = await listImages(
        `root=fuji&album=${encodeURIComponent('Ereignisse|Segeln 25')}&recursive=false`,
      )
      expect(stemsOf(leaf)).toEqual(['both-c', 'segeln-a', 'segeln-b'])
    })

    // Regression + the documented workflow of GET /library/albums: feed a
    // node's `path` straight back in as the count preview. The node's
    // `imageCount` is recursive and POST /api/shares defaults an album source
    // to recursive, so an omitted `recursive` here must be recursive too —
    // otherwise an interior node ('Ereignisse' holds nothing directly) previews
    // as 0 while the share it previews holds the whole subtree.
    it("defaults to recursive when the flag is omitted, so a node's imageCount is the preview", async () => {
      const defaulted = await listImages('root=fuji&kind=jpeg&album=Ereignisse')
      const explicit = await listImages('root=fuji&kind=jpeg&album=Ereignisse&recursive=true')
      expect(stemsOf(defaulted)).toEqual(['both-c', 'segeln-a', 'segeln-b'])
      expect(defaulted.total).toBe(explicit.total)

      const res = await get('/api/library/albums?root=fuji')
      const { data } = (await res.json()) as { data: AlbumNode[] }
      const node = data.find((n) => n.path === 'Ereignisse')
      expect(node?.imageCount).toBe(defaulted.total)
    })

    it('does not bleed into a case-variant sibling album', async () => {
      const lower = await listImages('root=fuji&album=ereignisse&recursive=true')
      expect(stemsOf(lower)).toEqual(['casevariant'])
      expect(lower.total).toBe(1)
    })

    it('counts an image tagged twice in the same subtree once', async () => {
      // both-c holds 'Ereignisse|Segeln 25' AND 'Ereignisse|Marokko 25'; a join
      // instead of an EXISTS subquery would return it twice and inflate `total`.
      const res = await listImages('root=fuji&album=Ereignisse&recursive=true&limit=200')
      expect(res.data.filter((r) => r.id === fujiIds['both-c']).length).toBe(1)
      expect(res.total).toBe(3)
    })

    it("treats album='' as 'in any album'", async () => {
      const res = await listImages('root=fuji&album=&recursive=true')
      expect(stemsOf(res)).toEqual(['both-c', 'casevariant', 'marokko', 'segeln-a', 'segeln-b'])
    })

    it('composes with minRating and kind', async () => {
      const res = await listImages(
        'root=fuji&album=Ereignisse&recursive=true&minRating=5&kind=jpeg',
      )
      expect(stemsOf(res)).toEqual(['segeln-a'])
    })
  })

  describe('GET /api/library/images ?untagged', () => {
    it('returns only images with no keyword rows', async () => {
      const res = await listImages('root=fuji&untagged=true')
      expect(stemsOf(res)).toEqual(['raw-1', 'untagged-1', 'untagged-2'])
      expect(res.total).toBe(3)
    })

    it('composes with kind', async () => {
      const res = await listImages('root=fuji&untagged=true&kind=jpeg')
      expect(stemsOf(res)).toEqual(['untagged-1', 'untagged-2'])
    })

    it('untagged=false is a string boolean, not Boolean("false")', async () => {
      const res = await listImages('root=fuji&untagged=false')
      expect(stemsOf(res)).toEqual([
        'both-c',
        'casevariant',
        'marokko',
        'raw-1',
        'segeln-a',
        'segeln-b',
        'untagged-1',
        'untagged-2',
      ])
    })

    it('400s when album and untagged are both given', async () => {
      const conflicts = [
        'root=fuji&album=Ereignisse&untagged=true',
        'root=fuji&album=&untagged=false',
      ]
      for (const qs of conflicts) {
        const res = await get(`/api/library/images?${qs}`)
        expect(res.status).toBe(400)
      }
    })
  })

  describe('GET /api/library/images ?captureFrom/?captureTo', () => {
    it('treats a bare YYYY-MM-DD as an inclusive whole day at both bounds', async () => {
      // untagged-1 sits exactly on 2026-07-04T00:00:00.000Z (lower edge) and
      // segeln-b on 2026-07-11T22:00:00.000Z — dropped if the upper bound were
      // read as that day's midnight rather than its last millisecond.
      const res = await listImages('root=fuji&captureFrom=2026-07-04&captureTo=2026-07-11')
      expect(stemsOf(res)).toEqual(['both-c', 'segeln-a', 'segeln-b', 'untagged-1'])
      expect(res.total).toBe(4)
    })

    it('excludes everything outside a single-day range', async () => {
      const res = await listImages('root=fuji&captureFrom=2026-07-12&captureTo=2026-07-12')
      expect(stemsOf(res)).toEqual(['marokko'])
    })

    it('accepts full ISO instants and is inclusive at both ends', async () => {
      const from = await listImages('root=fuji&captureFrom=2026-07-11T22:00:00.000Z')
      expect(stemsOf(from)).toEqual(['marokko', 'segeln-b'])

      const to = await listImages('root=fuji&captureTo=2026-07-04T08:00:00.000Z')
      expect(stemsOf(to)).toEqual(['casevariant', 'segeln-a', 'untagged-1'])
    })

    it('normalizes an offset instant instead of comparing it byte-wise', async () => {
      // 2026-07-12T02:00:00+02:00 === 2026-07-12T00:00:00.000Z, landing exactly
      // on marokko. A raw string compare would sort '2026-07-12T02:00:00+02:00'
      // AFTER every stored 'Z' value on that day and drop it.
      const res = await listImages(
        `root=fuji&captureFrom=${encodeURIComponent('2026-07-12T02:00:00+02:00')}`,
      )
      expect(stemsOf(res)).toEqual(['marokko'])
    })

    it('rejects a non-ISO date', async () => {
      const res = await get('/api/library/images?root=fuji&captureFrom=12.07.2026')
      expect(res.status).toBe(422)
    })

    it('composes with an album scope', async () => {
      const res = await listImages(
        'root=fuji&album=Ereignisse&recursive=true&captureFrom=2026-07-05&captureTo=2026-07-11',
      )
      expect(stemsOf(res)).toEqual(['both-c', 'segeln-b'])
    })
  })
})

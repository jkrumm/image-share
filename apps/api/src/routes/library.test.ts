import { afterAll, describe, expect, it, mock } from 'bun:test'
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

    const cacheKey = renditionCacheKey({
      root: 'share',
      relPath,
      mtimeMs: 1000,
      fileSize: 4,
      size: 'thumb',
    })
    const cachePath = renditionCachePath(cacheKey, 'thumb')
    await mkdir(dirname(cachePath), { recursive: true })
    await Bun.write(cachePath, new Uint8Array([9, 9]))

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
    expect(await Bun.file(cachePath).exists()).toBe(false)

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

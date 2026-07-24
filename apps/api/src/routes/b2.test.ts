import { describe, expect, it, afterAll, mock } from 'bun:test'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { Elysia } from 'elysia'
import * as schema from '../db/schema.js'
import { env } from '../env.js'

// Isolated :memory: db — see the note in shares.test.ts (same `--isolate`
// caveat). This file only exercises the GET/DELETE/upload b2 route handlers —
// the POST reconcile/reverse-backup 202 routes wrap cron/b2-reconcile.js and
// cron/reverse-backup.js, which have their OWN dedicated direct-import unit
// tests (cron/b2-reconcile.test.ts, cron/reverse-backup.test.ts) precisely to
// avoid a second, competing `mock.module('../db/index.js', …)` binding for
// those already-cached modules in a combined run.
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

const { b2Routes } = await import('./b2.js')
const { setS3 } = await import('../lib/s3.js')

afterAll(() => {
  setS3(null)
})

interface B2Dto {
  key: string
  size: number
  mirrored: boolean
  publishedImageId: number | null
  cdnUrl: string
  thumbUrl: string
}

interface B2ListResponse {
  data: B2Dto[]
  total: number
  totalBytes: number
  unmirroredCount: number
  lastReconcileAt: string | null
}

describe('GET /api/b2', () => {
  it('lists objects with mirrored flag + cdn/thumb URLs + prefix grouping + pagination total', async () => {
    const now = new Date().toISOString()
    await testDb.insert(schema.b2Objects).values([
      {
        key: 'img/fuji/a.jpg',
        size: 1,
        lastModified: now,
        mirroredAt: now,
        firstSeenAt: now,
      },
      {
        key: 'img/blog/b.jpg',
        size: 2,
        lastModified: now,
        mirroredAt: null,
        firstSeenAt: now,
      },
    ])

    const app = new Elysia().use(b2Routes)

    const all = (await (
      await app.handle(new Request('http://localhost/api/b2'))
    ).json()) as B2ListResponse
    expect(all.total).toBe(2)
    expect(all.totalBytes).toBe(3)
    expect(all.unmirroredCount).toBe(1)
    const a = all.data.find((r) => r.key === 'img/fuji/a.jpg')
    const b = all.data.find((r) => r.key === 'img/blog/b.jpg')
    expect(a?.mirrored).toBe(true)
    expect(b?.mirrored).toBe(false)
    expect(a?.cdnUrl).toBe(`${env.CDN_BASE}/fuji/a.jpg`)
    expect(a?.thumbUrl).toBe(`${env.CDN_BASE}/rs:fit:480/fuji/a.jpg`)

    const filtered = (await (
      await app.handle(new Request('http://localhost/api/b2?prefix=fuji'))
    ).json()) as B2ListResponse
    expect(filtered.total).toBe(1)
    expect(filtered.data[0]?.key).toBe('img/fuji/a.jpg')
    // Aggregates stay bucket-wide regardless of the prefix filter.
    expect(filtered.totalBytes).toBe(3)
    expect(filtered.unmirroredCount).toBe(1)

    const allExplicit = (await (
      await app.handle(new Request('http://localhost/api/b2?prefix=all'))
    ).json()) as B2ListResponse
    expect(allExplicit.total).toBe(2)
  })

  it('filters by a case-insensitive substring of the key via ?q=', async () => {
    const app = new Elysia().use(b2Routes)

    const res = (await (
      await app.handle(new Request('http://localhost/api/b2?q=BLOG'))
    ).json()) as B2ListResponse
    expect(res.data.map((r) => r.key)).toEqual(['img/blog/b.jpg'])
    expect(res.total).toBe(1)
    // Aggregates stay bucket-wide regardless of the q filter.
    expect(res.totalBytes).toBe(3)
  })

  it('sorts by size ascending/descending', async () => {
    const app = new Elysia().use(b2Routes)

    const asc = (await (
      await app.handle(new Request('http://localhost/api/b2?sort=size&order=asc'))
    ).json()) as B2ListResponse
    expect(asc.data.map((r) => r.size)).toEqual([1, 2])

    const desc = (await (
      await app.handle(new Request('http://localhost/api/b2?sort=size&order=desc'))
    ).json()) as B2ListResponse
    expect(desc.data.map((r) => r.size)).toEqual([2, 1])
  })
})

describe('DELETE /api/b2/:key', () => {
  it('deletes a valid key via the S3 port and removes its row', async () => {
    const now = new Date().toISOString()
    await testDb.insert(schema.b2Objects).values({
      key: 'img/misc/deleteme.jpg',
      size: 5,
      lastModified: now,
      firstSeenAt: now,
    })

    const deletedKeys: string[] = []
    setS3({
      list: async () => [],
      exists: async () => false,
      put: async () => {},
      get: async () => new Uint8Array(),
      head: async () => null,
      delete: async (key) => {
        deletedKeys.push(key)
      },
    })

    const app = new Elysia().use(b2Routes)
    const res = await app.handle(
      new Request(`http://localhost/api/b2/${encodeURIComponent('img/misc/deleteme.jpg')}`, {
        method: 'DELETE',
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { deleted: boolean }
    expect(body.deleted).toBe(true)
    expect(deletedKeys).toEqual(['img/misc/deleteme.jpg'])

    const rows = await testDb
      .select()
      .from(schema.b2Objects)
      .where(eq(schema.b2Objects.key, 'img/misc/deleteme.jpg'))
    expect(rows).toHaveLength(0)
  })

  it('rejects a key outside the managed B2_PREFIX', async () => {
    let deleteCalled = false
    setS3({
      list: async () => [],
      exists: async () => false,
      put: async () => {},
      get: async () => new Uint8Array(),
      head: async () => null,
      delete: async () => {
        deleteCalled = true
      },
    })

    const app = new Elysia().use(b2Routes)
    const res = await app.handle(
      new Request(
        `http://localhost/api/b2/${encodeURIComponent('backups/vps/postgres/dump.sql')}`,
        { method: 'DELETE' },
      ),
    )
    expect(res.status).toBe(400)
    expect(deleteCalled).toBe(false)
  })

  it('rejects a traversal attempt even when prefixed with img/', async () => {
    let deleteCalled = false
    setS3({
      list: async () => [],
      exists: async () => false,
      put: async () => {},
      get: async () => new Uint8Array(),
      head: async () => null,
      delete: async () => {
        deleteCalled = true
      },
    })

    const app = new Elysia().use(b2Routes)
    const res = await app.handle(
      new Request(
        `http://localhost/api/b2/${encodeURIComponent('img/../backups/vps/postgres/dump.sql')}`,
        { method: 'DELETE' },
      ),
    )
    expect(res.status).toBe(400)
    expect(deleteCalled).toBe(false)
  })
})

describe('POST /api/b2/upload', () => {
  it('uploads a new file straight to B2 and upserts b2_objects (readable prefix keeps the sanitized name)', async () => {
    const written: Record<string, Uint8Array> = {}
    setS3({
      list: async () => [],
      exists: async (key) => key in written,
      put: async (key, data) => {
        written[key] = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
      },
      get: async (key) => {
        const v = written[key]
        if (!v) throw new Error('not found')
        return v
      },
      head: async () => null,
      delete: async () => {},
    })

    const app = new Elysia().use(b2Routes)
    const form = new FormData()
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'weird name!.jpg'))
    form.set('prefix', 'fuji')

    const res = await app.handle(
      new Request('http://localhost/api/b2/upload', { method: 'POST', body: form }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { uploaded: boolean; key: string; cdnUrl: string }
    expect(body.uploaded).toBe(true)
    expect(body.key).toBe('img/fuji/weird_name_.jpg')
    expect(body.cdnUrl).toBe(`${env.CDN_BASE}/fuji/weird_name_.jpg`)
    expect(written['img/fuji/weird_name_.jpg']).toBeDefined()

    const rows = await testDb
      .select()
      .from(schema.b2Objects)
      .where(eq(schema.b2Objects.key, 'img/fuji/weird_name_.jpg'))
    expect(rows).toHaveLength(1)
  })

  it('uploads under an opaque prefix (misc) with a random 16-char [a-z0-9] key, preserving the extension', async () => {
    const written: Record<string, Uint8Array> = {}
    setS3({
      list: async () => [],
      exists: async (key) => key in written,
      put: async (key, data) => {
        written[key] = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
      },
      get: async (key) => {
        const v = written[key]
        if (!v) throw new Error('not found')
        return v
      },
      head: async () => null,
      delete: async () => {},
    })

    const app = new Elysia().use(b2Routes)
    const form = new FormData()
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'secret-plan.png'))
    form.set('prefix', 'misc')

    const res = await app.handle(
      new Request('http://localhost/api/b2/upload', { method: 'POST', body: form }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { uploaded: boolean; key: string; cdnUrl: string }
    expect(body.uploaded).toBe(true)
    expect(body.key).toMatch(/^img\/misc\/[a-z0-9]{16}\.png$/)
    expect(body.key).not.toContain('secret')
    expect(written[body.key]).toBeDefined()
  })

  it('skips (does not overwrite) a key that already exists on B2', async () => {
    const putCalls: string[] = []
    setS3({
      list: async () => [],
      exists: async () => true, // pretend the key is already published
      put: async (key) => {
        putCalls.push(key)
      },
      get: async () => new Uint8Array(),
      head: async () => null,
      delete: async () => {},
    })

    const app = new Elysia().use(b2Routes)
    const form = new FormData()
    form.set('file', new File([new Uint8Array([9])], 'already.jpg'))
    form.set('prefix', 'misc')

    const res = await app.handle(
      new Request('http://localhost/api/b2/upload', { method: 'POST', body: form }),
    )
    const body = (await res.json()) as { uploaded: boolean; reason?: string }
    expect(body.uploaded).toBe(false)
    expect(body.reason).toBe('key already exists')
    expect(putCalls).toHaveLength(0)
  })

  it('rejects an unsupported file extension with 400', async () => {
    const putCalls: string[] = []
    setS3({
      list: async () => [],
      exists: async () => false,
      put: async (key) => {
        putCalls.push(key)
      },
      get: async () => new Uint8Array(),
      head: async () => null,
      delete: async () => {},
    })

    const app = new Elysia().use(b2Routes)
    const form = new FormData()
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'notes.txt', { type: 'text/plain' }))
    form.set('prefix', 'misc')

    const res = await app.handle(
      new Request('http://localhost/api/b2/upload', { method: 'POST', body: form }),
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('txt')
    expect(putCalls).toHaveLength(0)
  })

  it('rejects a file over the 50 MB cap', async () => {
    const putCalls: string[] = []
    setS3({
      list: async () => [],
      exists: async () => false,
      put: async (key) => {
        putCalls.push(key)
      },
      get: async () => new Uint8Array(),
      head: async () => null,
      delete: async () => {},
    })

    const app = new Elysia().use(b2Routes)
    const form = new FormData()
    const oversized = new Uint8Array(50 * 1024 * 1024 + 1)
    form.set('file', new File([oversized], 'huge.jpg', { type: 'image/jpeg' }))
    form.set('prefix', 'misc')

    const res = await app.handle(
      new Request('http://localhost/api/b2/upload', { method: 'POST', body: form }),
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('too large')
    expect(putCalls).toHaveLength(0)
  })

  it('upserts over a stale mirror row (S3 object deleted out-of-band) instead of 500ing on the UNIQUE key', async () => {
    const staleKey = 'img/fuji/stale.jpg'
    const oldNow = new Date(Date.now() - 86_400_000).toISOString()
    await testDb.insert(schema.b2Objects).values({
      key: staleKey,
      size: 1,
      lastModified: oldNow,
      mirroredAt: oldNow,
      publishedImageId: null,
      firstSeenAt: oldNow,
    })

    const written: Record<string, Uint8Array> = {}
    setS3({
      list: async () => [],
      exists: async (key) => key in written, // the stale row's key was never actually re-uploaded to S3
      put: async (key, data) => {
        written[key] = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
      },
      get: async (key) => {
        const v = written[key]
        if (!v) throw new Error('not found')
        return v
      },
      head: async () => null,
      delete: async () => {},
    })

    const app = new Elysia().use(b2Routes)
    const form = new FormData()
    form.set('file', new File([new Uint8Array([1, 2, 3, 4])], 'stale.jpg', { type: 'image/jpeg' }))
    form.set('prefix', 'fuji')

    const res = await app.handle(
      new Request('http://localhost/api/b2/upload', { method: 'POST', body: form }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { uploaded: boolean; key: string }
    expect(body.uploaded).toBe(true)
    expect(body.key).toBe(staleKey)

    const rows = await testDb
      .select()
      .from(schema.b2Objects)
      .where(eq(schema.b2Objects.key, staleKey))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.size).toBe(4)
    expect(rows[0]?.mirroredAt).toBeNull()
    // firstSeenAt is preserved from the original (stale) row, not overwritten.
    expect(rows[0]?.firstSeenAt).toBe(oldNow)
  })
})

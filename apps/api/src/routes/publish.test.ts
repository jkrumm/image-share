import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { Elysia } from 'elysia'
import * as schema from '../db/schema.js'
import { env } from '../env.js'
import { cdnOriginalUrl } from '../lib/cdn.js'

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

const { publishRoutes } = await import('./publish.js')
const { setS3 } = await import('../lib/s3.js')

interface PublishResponse {
  published: { id: number; key: string; cdnUrl: string }[]
  skipped: { id: number; key: string; reason: string; cdnUrl?: string }[]
}

const fixtureDir = join(env.SHARE_ROOT, 'publish-fixtures')

afterAll(() => {
  setS3(null)
  rmSync(fixtureDir, { recursive: true, force: true })
})

async function seedImage(relPath: string): Promise<number> {
  const now = new Date().toISOString()
  const [row] = await testDb
    .insert(schema.images)
    .values({
      root: 'share',
      relPath,
      dir: 'publish-fixtures',
      stem: relPath
        .split('/')
        .pop()!
        .replace(/\.jpg$/, ''),
      ext: 'jpg',
      kind: 'jpeg',
      fileSize: 3,
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
  return row.id
}

describe('POST /api/publish', () => {
  beforeEach(() => {
    mkdirSync(fixtureDir, { recursive: true })
  })

  it('publishes a new key and mints a CDN URL with img/ stripped', async () => {
    await Bun.write(join(fixtureDir, 'sunset.jpg'), new Uint8Array([1, 2, 3]))
    const id = await seedImage('publish-fixtures/sunset.jpg')

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
      delete: async (key) => {
        delete written[key]
      },
    })

    const app = new Elysia().use(publishRoutes)
    const res = await app.handle(
      new Request('http://localhost/api/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageIds: [id], prefix: 'fuji' }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as PublishResponse
    expect(body.skipped).toHaveLength(0)
    expect(body.published).toHaveLength(1)
    expect(body.published[0]?.key).toBe('img/fuji/sunset.jpg')
    expect(body.published[0]?.cdnUrl).toBe(`${env.CDN_BASE}/fuji/sunset.jpg`)
    expect(written['img/fuji/sunset.jpg']).toBeDefined()

    const [b2Row] = await testDb
      .select()
      .from(schema.b2Objects)
      .where(eq(schema.b2Objects.key, 'img/fuji/sunset.jpg'))
    expect(b2Row?.publishedImageId).toBe(id)
  })

  it('skips a key that already exists on B2', async () => {
    await Bun.write(join(fixtureDir, 'already.jpg'), new Uint8Array([9, 9, 9]))
    const id = await seedImage('publish-fixtures/already.jpg')

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

    const app = new Elysia().use(publishRoutes)
    const res = await app.handle(
      new Request('http://localhost/api/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageIds: [id], prefix: 'fuji' }),
      }),
    )
    const body = (await res.json()) as PublishResponse
    expect(body.published).toHaveLength(0)
    expect(body.skipped).toHaveLength(1)
    expect(body.skipped[0]?.reason).toBe('key already exists')
    expect(putCalls).toHaveLength(0)
  })

  it('mints a random 16-char [a-z0-9] key for an opaque prefix (gen), preserving the extension', async () => {
    await Bun.write(join(fixtureDir, 'secret.jpg'), new Uint8Array([1, 2, 3]))
    const id = await seedImage('publish-fixtures/secret.jpg')

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
      delete: async (key) => {
        delete written[key]
      },
    })

    const app = new Elysia().use(publishRoutes)
    const res = await app.handle(
      new Request('http://localhost/api/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageIds: [id], prefix: 'gen' }),
      }),
    )
    const body = (await res.json()) as PublishResponse
    expect(body.published).toHaveLength(1)
    const key = body.published[0]?.key ?? ''
    expect(key).toMatch(/^img\/gen\/[a-z0-9]{16}\.jpg$/)
    expect(key).not.toContain('secret')
  })

  it('republishing the same image under the same opaque prefix returns skipped without a duplicate object', async () => {
    await Bun.write(join(fixtureDir, 'again.jpg'), new Uint8Array([4, 5, 6]))
    const id = await seedImage('publish-fixtures/again.jpg')

    const written: Record<string, Uint8Array> = {}
    const putCalls: string[] = []
    setS3({
      list: async () => [],
      exists: async (key) => key in written,
      put: async (key, data) => {
        putCalls.push(key)
        written[key] = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
      },
      get: async (key) => {
        const v = written[key]
        if (!v) throw new Error('not found')
        return v
      },
      head: async () => null,
      delete: async (key) => {
        delete written[key]
      },
    })

    const app = new Elysia().use(publishRoutes)
    const request = () =>
      app.handle(
        new Request('http://localhost/api/publish', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ imageIds: [id], prefix: 'misc' }),
        }),
      )

    const firstBody = (await (await request()).json()) as PublishResponse
    expect(firstBody.published).toHaveLength(1)
    const firstKey = firstBody.published[0]?.key
    expect(putCalls).toHaveLength(1)

    const secondBody = (await (await request()).json()) as PublishResponse
    expect(secondBody.published).toHaveLength(0)
    expect(secondBody.skipped).toHaveLength(1)
    expect(secondBody.skipped[0]?.key).toBe(firstKey)
    expect(secondBody.skipped[0]?.reason).toBe('already published under this prefix')
    expect(secondBody.skipped[0]?.cdnUrl).toBe(cdnOriginalUrl(firstKey ?? ''))
    // No second B2 write for the republish attempt.
    expect(putCalls).toHaveLength(1)
  })
})

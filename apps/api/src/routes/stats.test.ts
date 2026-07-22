import { describe, expect, it, mock } from 'bun:test'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { Elysia } from 'elysia'
import * as schema from '../db/schema.js'

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

const { statsRoutes } = await import('./stats.js')

interface StatsDto {
  images: number
  jpegs: number
  raws: number
  share: number
  shares: number
  activeTokens: number
  b2Objects: number
  b2Unmirrored: number
  renditionCacheBytes: number
  dbSizeBytes: number
  lastIndexAt: string | null
  version: string
}

describe('GET /api/stats', () => {
  it('returns the full stats shape with correct counts', async () => {
    const now = new Date().toISOString()
    await testDb.insert(schema.images).values([
      {
        root: 'fuji',
        relPath: 'a.jpg',
        dir: '',
        stem: 'a',
        ext: 'jpg',
        kind: 'jpeg',
        fileSize: 1,
        mtimeMs: 1,
        indexedAt: now,
      },
      {
        root: 'raws',
        relPath: 'a.RAF',
        dir: '',
        stem: 'a',
        ext: 'raf',
        kind: 'raw',
        fileSize: 1,
        mtimeMs: 1,
        indexedAt: now,
      },
      {
        root: 'share',
        relPath: '2026/01/b.jpg',
        dir: '2026/01',
        stem: 'b',
        ext: 'jpg',
        kind: 'jpeg',
        fileSize: 1,
        mtimeMs: 1,
        indexedAt: now,
      },
    ])
    await testDb.insert(schema.shares).values({
      slug: 's1',
      title: 'S1',
      sourceType: 'folder',
      root: 'fuji',
      dir: '',
      createdAt: now,
    })
    await testDb
      .insert(schema.shareTokens)
      .values({ shareId: 1, token: 't1', role: 'view', createdAt: now })
    await testDb.insert(schema.b2Objects).values([
      { key: 'img/a.jpg', size: 1, lastModified: now, mirroredAt: now, firstSeenAt: now },
      { key: 'img/b.jpg', size: 1, lastModified: now, mirroredAt: null, firstSeenAt: now },
    ])

    const app = new Elysia().use(statsRoutes)
    const res = await app.handle(new Request('http://localhost/api/stats'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as StatsDto

    expect(body.images).toBe(3)
    expect(body.jpegs).toBe(2)
    expect(body.raws).toBe(1)
    expect(body.share).toBe(1)
    expect(body.shares).toBe(1)
    expect(body.activeTokens).toBe(1)
    expect(body.b2Objects).toBe(2)
    expect(body.b2Unmirrored).toBe(1)
    expect(typeof body.dbSizeBytes).toBe('number')
    expect(body.dbSizeBytes).toBeGreaterThan(0)
    expect(typeof body.version).toBe('string')
    expect(body.lastIndexAt).toBeNull()
  })
})

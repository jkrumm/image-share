import { describe, expect, it, mock } from 'bun:test'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { Elysia } from 'elysia'
import * as schema from '../db/schema.js'

// Isolated :memory: db — see the note in shares.test.ts (same `--isolate`
// caveat). This file only exercises the GET /api/b2 listing handler — the
// POST reconcile/reverse-backup 202 routes wrap cron/b2-reconcile.js and
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

interface B2Dto {
  key: string
  size: number
  mirrored: boolean
  publishedImageId: number | null
}

describe('GET /api/b2', () => {
  it('lists objects with mirrored flag + prefix filter + pagination total', async () => {
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

    const all = (await (await app.handle(new Request('http://localhost/api/b2'))).json()) as {
      data: B2Dto[]
      total: number
    }
    expect(all.total).toBe(2)
    const a = all.data.find((r) => r.key === 'img/fuji/a.jpg')
    const b = all.data.find((r) => r.key === 'img/blog/b.jpg')
    expect(a?.mirrored).toBe(true)
    expect(b?.mirrored).toBe(false)

    const filtered = (await (
      await app.handle(new Request('http://localhost/api/b2?prefix=img/fuji'))
    ).json()) as { data: B2Dto[]; total: number }
    expect(filtered.total).toBe(1)
    expect(filtered.data[0]?.key).toBe('img/fuji/a.jpg')
  })
})

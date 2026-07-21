import { afterAll, describe, expect, it, mock } from 'bun:test'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import * as schema from '../db/schema.js'

// Isolated :memory: db — see the note in routes/shares.test.ts (same
// `--isolate` caveat for combined multi-file runs; this file is validated
// standalone). This test imports cron/b2-reconcile.js DIRECTLY (never via
// routes/b2.ts) so it owns the first — and only — evaluation of that module
// in this process.
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

const { runB2Reconcile } = await import('./b2-reconcile.js')
const { setS3 } = await import('../lib/s3.js')

afterAll(() => {
  setS3(null)
})

describe('runB2Reconcile', () => {
  it('adds new keys and removes stale ones', async () => {
    // Pre-existing row that the bucket no longer has → should be removed.
    await testDb.insert(schema.b2Objects).values({
      key: 'img/fuji/stale.jpg',
      size: 10,
      lastModified: new Date(0).toISOString(),
      etag: 'old-etag',
      firstSeenAt: new Date(0).toISOString(),
    })

    setS3({
      list: async () => [
        {
          key: 'img/fuji/new.jpg',
          size: 42,
          lastModified: '2026-01-01T00:00:00.000Z',
          etag: 'abc123',
        },
      ],
      exists: async () => false,
      put: async () => {},
      get: async () => new Uint8Array(),
      head: async () => null,
    })

    const result = await runB2Reconcile()
    expect(result.listed).toBe(1)
    expect(result.upserted).toBe(1)
    expect(result.removed).toBe(1)

    const rows = await testDb.select().from(schema.b2Objects)
    expect(rows.map((r) => r.key)).toEqual(['img/fuji/new.jpg'])
    expect(rows[0]?.size).toBe(42)
  })
})

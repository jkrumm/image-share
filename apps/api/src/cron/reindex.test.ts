import { describe, expect, it, mock } from 'bun:test'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import * as schema from '../db/schema.js'

// Isolated :memory: db — same pattern (and same `--isolate` caveat) as
// cron/b2-reconcile.test.ts. The indexer module itself is NOT mocked: the boot
// check must agree with the scanner's own backfill clause, so it runs the real
// `keywordBackfillPending`. Only the walk is stubbed, by injection.
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

const { bootScanReason, runBootScanIfNeeded } = await import('./reindex.js')

let scanCalls = 0
const fakeScan = async () => {
  scanCalls += 1
  return { scanned: 0, added: 0, updated: 0, removed: 0 }
}

async function seedImage(over: Partial<typeof schema.images.$inferInsert>): Promise<void> {
  await testDb.insert(schema.images).values({
    root: 'fuji',
    relPath: `${over.stem ?? 'x'}.JPG`,
    dir: '',
    stem: String(over.stem ?? 'x'),
    ext: 'jpg',
    kind: 'jpeg',
    fileSize: 1,
    mtimeMs: 1,
    indexedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  })
}

async function reset(): Promise<void> {
  await testDb.delete(schema.images)
  scanCalls = 0
}

describe('bootScanReason (design §9)', () => {
  it('scans an empty index — first boot or a rebuild from scratch', async () => {
    await reset()
    expect(await bootScanReason()).toBe('empty-index')
    expect(await runBootScanIfNeeded(fakeScan)).toBe('empty-index')
    expect(scanCalls).toBe(1)
  })

  it('scans a POPULATED index whose keyword backfill never ran — the deploy case', async () => {
    // Exactly what the album migration leaves behind: every row is still there,
    // `image_keywords` is empty and every marker is NULL. Counting rows alone
    // found 6028 and did nothing, so the album tree — the headline browse axis —
    // shipped empty until the 05:15 cron fired, up to a day later.
    await reset()
    await seedImage({ stem: 'pre-existing-a', keywordsIndexedAt: null })
    await seedImage({ stem: 'pre-existing-b', keywordsIndexedAt: null })

    expect(await bootScanReason()).toBe('keyword-backfill')
    expect(await runBootScanIfNeeded(fakeScan)).toBe('keyword-backfill')
    expect(scanCalls).toBe(1)
  })

  it('does nothing once every non-RAW row is backfilled', async () => {
    await reset()
    await seedImage({ stem: 'done', keywordsIndexedAt: '2026-01-01T00:00:00.000Z' })
    // A RAF never carries album keywords, so its marker stays NULL forever — it
    // must not drag every restart into a full metadata re-read.
    await seedImage({ stem: 'raf', kind: 'raw', ext: 'raf', keywordsIndexedAt: null })

    expect(await bootScanReason()).toBeNull()
    expect(await runBootScanIfNeeded(fakeScan)).toBeNull()
    expect(scanCalls).toBe(0)
  })
})

import { afterAll, describe, expect, it, mock } from 'bun:test'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import * as schema from '../db/schema.js'
import { env } from '../env.js'

// Isolated file-backed db (VACUUM INTO needs a real sqlite file, not
// ':memory:', to exercise meaningfully) — see the note in
// routes/shares.test.ts (same `--isolate` caveat). Imports cron/db-snapshot.js
// DIRECTLY so it owns the module's only evaluation in this process.
const dbPath = join(env.DATA_DIR, 'db-snapshot-test.sqlite')
rmSync(dbPath, { force: true })
const sqlite = new Database(dbPath, { create: true })
sqlite.exec('PRAGMA journal_mode = WAL;')
sqlite.exec('PRAGMA foreign_keys = ON;')
const testDb = drizzle(sqlite, { schema })
migrate(testDb, { migrationsFolder: join(import.meta.dir, '../../drizzle') })

mock.module('../db/index.js', () => ({
  db: testDb,
  sqlite,
  createDb: () => ({ db: testDb, sqlite }),
  runMigrations: () => {},
}))

const { runDbSnapshot } = await import('./db-snapshot.js')

afterAll(() => {
  rmSync(dbPath, { force: true })
  rmSync(`${dbPath}-wal`, { force: true })
  rmSync(`${dbPath}-shm`, { force: true })
})

describe('runDbSnapshot', () => {
  it('VACUUM INTOs a non-empty file named after the weekday', async () => {
    await testDb.insert(schema.shares).values({
      slug: 'snapshot-test',
      title: 'Snapshot test',
      sourceType: 'folder',
      root: 'fuji',
      dir: 'x',
      createdAt: new Date().toISOString(),
    })

    const result = await runDbSnapshot()
    const weekday = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getDay()]
    expect(result.path).toBe(join(env.SNAPSHOT_DIR, `image-share-${weekday}.sqlite`))
    expect(result.bytes).toBeGreaterThan(0)
    expect(await Bun.file(result.path).exists()).toBe(true)

    rmSync(result.path, { force: true })
  })
})

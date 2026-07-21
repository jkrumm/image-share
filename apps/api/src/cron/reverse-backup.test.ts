import { afterAll, describe, expect, it, mock } from 'bun:test'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import * as schema from '../db/schema.js'
import { env } from '../env.js'

// Isolated :memory: db — see the note in routes/shares.test.ts (same
// `--isolate` caveat). This file imports cron/reverse-backup.js DIRECTLY
// (never via routes/b2.ts) so it owns the module's only evaluation here.
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

const { runReverseBackup } = await import('./reverse-backup.js')
const { setS3 } = await import('../lib/s3.js')

const mirrorRoot = join(env.B2_MIRROR_DIR, 'reverse-backup-test')

afterAll(() => {
  setS3(null)
  rmSync(mirrorRoot, { recursive: true, force: true })
})

describe('runReverseBackup', () => {
  it('mirrors unmirrored keys and sets mirrored_at', async () => {
    const key = 'img/reverse-backup-test/photo.jpg'
    await testDb.insert(schema.b2Objects).values({
      key,
      size: 5,
      lastModified: new Date().toISOString(),
      etag: 'e1',
      mirroredAt: null,
      firstSeenAt: new Date().toISOString(),
    })

    setS3({
      list: async () => [],
      exists: async () => true,
      put: async () => {},
      get: async () => new Uint8Array([1, 2, 3, 4, 5]),
      head: async () => null,
    })

    const result = await runReverseBackup()
    expect(result.mirrored).toBe(1)
    expect(result.errors).toBe(0)
    expect(result.bytes).toBe(5)

    const mirroredPath = join(env.B2_MIRROR_DIR, 'reverse-backup-test/photo.jpg')
    expect(await Bun.file(mirroredPath).exists()).toBe(true)

    const [row] = await testDb.select().from(schema.b2Objects).where(eq(schema.b2Objects.key, key))
    expect(row?.mirroredAt).not.toBeNull()
  })

  it('skips a key whose local mirror already matches the recorded size', async () => {
    const key = 'img/reverse-backup-test/already-good.jpg'
    const localPath = join(env.B2_MIRROR_DIR, 'reverse-backup-test/already-good.jpg')
    await Bun.write(localPath, new Uint8Array([1, 2, 3]))

    await testDb.insert(schema.b2Objects).values({
      key,
      size: 3,
      lastModified: new Date().toISOString(),
      etag: 'e2',
      mirroredAt: new Date().toISOString(),
      firstSeenAt: new Date().toISOString(),
    })

    let getCalls = 0
    setS3({
      list: async () => [],
      exists: async () => true,
      put: async () => {},
      get: async () => {
        getCalls++
        return new Uint8Array([1, 2, 3])
      },
      head: async () => null,
    })

    await runReverseBackup()
    expect(getCalls).toBe(0)
  })
})

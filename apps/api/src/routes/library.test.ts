import { afterAll, describe, expect, it, mock } from 'bun:test'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { Elysia } from 'elysia'
import * as schema from '../db/schema.js'
import { env } from '../env.js'

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
  it('rejects /api/library/dirs without a bearer header, even with ?access_token', async () => {
    const app = buildApp()
    const res = await app.handle(
      new Request(`http://localhost/api/library/dirs?access_token=${env.API_SECRET}`),
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
  it('rejects with neither bearer nor access_token', async () => {
    const app = buildApp()
    const res = await app.handle(new Request('http://localhost/api/library/images/1/file'))
    expect(res.status).toBe(401)
  })

  it('accepts ?access_token=<API_SECRET> (the only route allowed to)', async () => {
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
    const res = await app.handle(
      new Request(
        `http://localhost/api/library/images/${row.id}/file?size=orig&access_token=${env.API_SECRET}`,
      ),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4]))
  })
})

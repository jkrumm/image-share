import { afterAll, describe, expect, it, mock } from 'bun:test'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
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

const { ingestRoutes } = await import('./ingest.js')

interface IngestResponse {
  id: number
  root: 'share'
  relPath: string
  adminFileUrl: string
}

// The ingest handler writes real bytes under SHARE_ROOT (the local-dev sandbox
// under .dev/, never a real photo tree — design §3 / hard rule). Track every
// yyyy/mm dir it creates so this test cleans up after itself.
const createdDirs = new Set<string>()

afterAll(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true })
})

describe('POST /api/images (ingest)', () => {
  it('writes the file to SHARE_ROOT and indexes it, returning the 201 shape', async () => {
    const now = new Date()
    const yyyyMm = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`
    createdDirs.add(join(env.SHARE_ROOT, String(now.getFullYear())))

    const app = new Elysia().use(ingestRoutes)
    const form = new FormData()
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'test-photo.jpg', {
      type: 'image/jpeg',
    })
    form.append('file', file)

    const res = await app.handle(
      new Request('http://localhost/api/images', { method: 'POST', body: form }),
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as IngestResponse

    expect(body.root).toBe('share')
    expect(typeof body.id).toBe('number')
    expect(body.relPath).toStartWith(`${yyyyMm}/`)
    expect(body.relPath).toEndWith('test-photo.jpg')
    expect(body.adminFileUrl).toBe(`/api/library/images/${body.id}/file`)

    const written = Bun.file(join(env.SHARE_ROOT, body.relPath))
    expect(await written.exists()).toBe(true)

    const [row] = await testDb.select().from(schema.images).where(eq(schema.images.id, body.id))
    expect(row?.root).toBe('share')
    expect(row?.relPath).toBe(body.relPath)
    expect(row?.kind).toBe('jpeg')
  })

  it('uses a collision-safe name on a repeated upload', async () => {
    const app = new Elysia().use(ingestRoutes)
    const form1 = new FormData()
    form1.append('file', new File([new Uint8Array([1, 2, 3])], 'dup.jpg', { type: 'image/jpeg' }))
    const res1 = await app.handle(
      new Request('http://localhost/api/images', { method: 'POST', body: form1 }),
    )
    const body1 = (await res1.json()) as IngestResponse

    const form2 = new FormData()
    form2.append('file', new File([new Uint8Array([4, 5, 6])], 'dup.jpg', { type: 'image/jpeg' }))
    const res2 = await app.handle(
      new Request('http://localhost/api/images', { method: 'POST', body: form2 }),
    )
    const body2 = (await res2.json()) as IngestResponse

    expect(body1.relPath).not.toBe(body2.relPath)
    expect(body2.relPath).toContain('dup-2')
  })
})

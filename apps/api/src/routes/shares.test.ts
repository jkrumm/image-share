import { describe, expect, it, mock } from 'bun:test'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { Elysia } from 'elysia'
import * as schema from '../db/schema.js'

// Isolated :memory: db (design §13). NOTE: this relies on `mock.module`
// replacing `../db/index.js` before the route module under test is imported —
// safe when this file runs alone (`bun test src/routes/shares.test.ts`, per
// this repo's validation convention). Running the WHOLE apps/api suite in one
// process without `bun test --isolate` (root `test` script does not currently
// pass it) can leak this module's cached instances into sibling test files
// that also touch `../db/index.js` — flagged as a blocker, not fixed here
// (db/index.ts's singleton pattern is outside this task's file ownership).
// Deliberately never `sqlite.close()`d: this in-memory db can be transitively
// cached and reused by another test file's import of `./shares.js` in a
// combined run, and closing it here would break that file underneath it.
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

const { sharesRoutes } = await import('./shares.js')

function buildApp() {
  return new Elysia().use(sharesRoutes)
}

// share_images.image_id is a real FK to images.id (foreign_keys=ON) — a
// selection share's imageIds must reference actual rows.
async function seedImage(relPath: string): Promise<number> {
  const now = new Date().toISOString()
  const [row] = await testDb
    .insert(schema.images)
    .values({
      root: 'fuji',
      relPath,
      dir: '',
      stem: relPath.replace(/\.jpg$/, ''),
      ext: 'jpg',
      kind: 'jpeg',
      fileSize: 1,
      mtimeMs: 1,
      indexedAt: now,
    })
    .returning({ id: schema.images.id })
  if (!row) throw new Error('seed failed')
  return row.id
}

interface TokenDto {
  id: number
  role: string
  label: string | null
  createdAt: string
  revokedAt: string | null
  url: string
}

interface ShareDto {
  id: number
  slug: string
  title: string
  sourceType: string
  root: string | null
  dir: string | null
  imageCount: number
  tokens: TokenDto[]
}

function post(payload: Record<string, unknown>): Promise<Response> {
  return buildApp().handle(
    new Request('http://localhost/api/shares', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

const folderSource = { type: 'folder', root: 'fuji', dir: 'x' } as const

describe('POST /api/shares — folder + selection creation', () => {
  it('creates a folder share with an explicit slug and a minted view token', async () => {
    const res = await post({ slug: 'mallorca-2026', title: 'Mallorca 2026', source: folderSource })
    expect(res.status).toBe(201)
    const body = (await res.json()) as ShareDto
    expect(body.slug).toBe('mallorca-2026')
    expect(body.sourceType).toBe('folder')
    expect(body.root).toBe('fuji')
    expect(body.tokens).toHaveLength(1)
    expect(body.tokens[0]?.role).toBe('view')
    expect(body.tokens[0]?.url).toContain(`token=`)
  })

  it('rejects a duplicate explicit slug', async () => {
    const res = await post({ slug: 'mallorca-2026', title: 'Again', source: folderSource })
    expect(res.status).toBe(400)
  })

  it('auto-derives a slug from the title when slug is omitted', async () => {
    const res = await post({ title: 'Summer Trip!! 2026', source: folderSource })
    expect(res.status).toBe(201)
    const body = (await res.json()) as ShareDto
    expect(body.slug).toBe('summer-trip-2026')
  })

  it('appends -2 on a title-derived collision', async () => {
    const res = await post({ title: 'Summer Trip!! 2026', source: folderSource })
    expect(res.status).toBe(201)
    const body = (await res.json()) as ShareDto
    expect(body.slug).toBe('summer-trip-2026-2')
  })

  it('creates a selection share and populates share_images', async () => {
    const a = await seedImage('picks-a.jpg')
    const b = await seedImage('picks-b.jpg')
    const c = await seedImage('picks-c.jpg')

    const res = await post({
      title: 'Picks',
      source: { type: 'selection', imageIds: [a, b, c] },
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as ShareDto
    expect(body.sourceType).toBe('selection')
    expect(body.root).toBeNull()
    expect(body.dir).toBeNull()
    expect(body.imageCount).toBe(3)
  })
})

describe('shares input validation (boundary rejects)', () => {
  it('rejects a malformed expiresAt so it can never fail open at the read path', async () => {
    for (const expiresAt of [
      'not-a-date',
      '31.12.2026',
      '31/12/2026',
      '2026-12-31 18:00 CET',
      '1767225600',
    ]) {
      const res = await post({
        title: `bad-${Math.random().toString(36).slice(2)}`,
        source: folderSource,
        expiresAt,
      })
      expect(res.status).toBe(422)
    }
  })

  it('accepts a valid ISO date and datetime expiry', async () => {
    const dateRes = await post({ title: 'exp-date', source: folderSource, expiresAt: '2026-12-31' })
    expect(dateRes.status).toBe(201)
    const dtRes = await post({
      title: 'exp-datetime',
      source: folderSource,
      expiresAt: '2026-12-31T18:00:00Z',
    })
    expect(dtRes.status).toBe(201)
  })

  it('rejects a raws-rooted folder share (would be permanently empty)', async () => {
    const res = await post({
      title: 'raws share',
      source: { type: 'folder', root: 'raws', dir: 'x' },
    })
    expect(res.status).toBe(422)
  })

  it('rejects reserved explicit slugs that would collide with the Caddy passthroughs', async () => {
    for (const slug of ['health', 's', 'api', 'admin', 'openapi']) {
      const res = await post({ slug, title: 'reserved test', source: folderSource })
      expect(res.status).toBe(400)
    }
  })
})

describe('PATCH /api/shares/:id', () => {
  it('updates title/note/expiresAt/minRating on a folder share', async () => {
    const created = (await (
      await post({ title: 'patch-me', source: folderSource })
    ).json()) as ShareDto

    const app = buildApp()
    const res = await app.handle(
      new Request(`http://localhost/api/shares/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: 'friends album', minRating: 4 }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ShareDto & { note: string | null; minRating: number | null }
    expect(body.note).toBe('friends album')
    expect(body.minRating).toBe(4)
    expect(body.title).toBe('patch-me') // unchanged field survives partial update
  })

  it('rejects imageIds on a folder share', async () => {
    const created = (await (
      await post({ title: 'folder-not-selection', source: folderSource })
    ).json()) as ShareDto
    const app = buildApp()
    const res = await app.handle(
      new Request(`http://localhost/api/shares/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageIds: [1, 2] }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('replaces a selection share’s image set with imageIds', async () => {
    const a = await seedImage('patch-a.jpg')
    const b = await seedImage('patch-b.jpg')
    const c = await seedImage('patch-c.jpg')
    const created = (await (
      await post({ title: 'selection-patch', source: { type: 'selection', imageIds: [a, b] } })
    ).json()) as ShareDto
    expect(created.imageCount).toBe(2)

    const app = buildApp()
    const res = await app.handle(
      new Request(`http://localhost/api/shares/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageIds: [c] }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ShareDto
    expect(body.imageCount).toBe(1)
  })

  it('404s PATCH/DELETE on an unknown id', async () => {
    const app = buildApp()
    const patchRes = await app.handle(
      new Request('http://localhost/api/shares/999999', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: 'x' }),
      }),
    )
    expect(patchRes.status).toBe(404)

    const deleteRes = await app.handle(
      new Request('http://localhost/api/shares/999999', { method: 'DELETE' }),
    )
    expect(deleteRes.status).toBe(404)
  })
})

describe('token lifecycle: roll / add / revoke', () => {
  it('rolls every active token, preserving each one’s role', async () => {
    const created = (await (
      await post({ title: 'roll-me', source: folderSource })
    ).json()) as ShareDto
    const viewToken = created.tokens[0]
    expect(viewToken?.role).toBe('view')

    // Add a second, differently-scoped token so roll must handle >1 token.
    const addApp = buildApp()
    const addRes = await addApp.handle(
      new Request(`http://localhost/api/shares/${created.id}/tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'full', label: 'grandma' }),
      }),
    )
    expect(addRes.status).toBe(201)

    const rollApp = buildApp()
    const rollRes = await rollApp.handle(
      new Request(`http://localhost/api/shares/${created.id}/roll`, { method: 'POST' }),
    )
    expect(rollRes.status).toBe(200)
    const rolled = (await rollRes.json()) as { tokens: TokenDto[] }
    expect(rolled.tokens).toHaveLength(2)
    expect(rolled.tokens.map((t) => t.role).toSorted()).toEqual(['full', 'view'])
    expect(rolled.tokens.find((t) => t.role === 'full')?.label).toBe('grandma')

    const listApp = buildApp()
    const listed = (await (
      await listApp.handle(new Request(`http://localhost/api/shares`))
    ).json()) as { data: ShareDto[] }
    const share = listed.data.find((s) => s.id === created.id)
    expect(share?.tokens).toHaveLength(4) // 2 originals (revoked) + 2 replacements
    const activeCount = share?.tokens.filter((t) => t.revokedAt === null).length
    expect(activeCount).toBe(2)
  })

  it('adds a parallel token without revoking the existing one', async () => {
    const created = (await (
      await post({ title: 'add-token', source: folderSource })
    ).json()) as ShareDto
    const firstToken = created.tokens[0]?.id

    const addApp = buildApp()
    const addRes = await addApp.handle(
      new Request(`http://localhost/api/shares/${created.id}/tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'download' }),
      }),
    )
    expect(addRes.status).toBe(201)
    const added = (await addRes.json()) as TokenDto
    expect(added.role).toBe('download')

    const listApp = buildApp()
    const listed = (await (
      await listApp.handle(new Request(`http://localhost/api/shares`))
    ).json()) as { data: ShareDto[] }
    const share = listed.data.find((s) => s.id === created.id)
    expect(share?.tokens).toHaveLength(2)
    expect(share?.tokens.find((t) => t.id === firstToken)?.revokedAt).toBeNull()
    expect(share?.tokens.find((t) => t.id === added.id)?.revokedAt).toBeNull()
  })

  it('revokes a single token, leaving siblings untouched', async () => {
    const created = (await (
      await post({ title: 'revoke-one', source: folderSource })
    ).json()) as ShareDto
    const addApp = buildApp()
    const added = (await (
      await addApp.handle(
        new Request(`http://localhost/api/shares/${created.id}/tokens`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'full' }),
        }),
      )
    ).json()) as TokenDto

    const revokeApp = buildApp()
    const revokeRes = await revokeApp.handle(
      new Request(`http://localhost/api/shares/${created.id}/tokens/${added.id}/revoke`, {
        method: 'POST',
      }),
    )
    expect(revokeRes.status).toBe(200)
    const revoked = (await revokeRes.json()) as TokenDto
    expect(revoked.revokedAt).not.toBeNull()

    const listApp = buildApp()
    const listed = (await (
      await listApp.handle(new Request(`http://localhost/api/shares`))
    ).json()) as { data: ShareDto[] }
    const share = listed.data.find((s) => s.id === created.id)
    expect(share?.tokens.find((t) => t.id === created.tokens[0]?.id)?.revokedAt).toBeNull()
    expect(share?.tokens.find((t) => t.id === added.id)?.revokedAt).not.toBeNull()
  })

  it('404s revoking an unknown token id', async () => {
    const created = (await (
      await post({ title: 'revoke-404', source: folderSource })
    ).json()) as ShareDto
    const app = buildApp()
    const res = await app.handle(
      new Request(`http://localhost/api/shares/${created.id}/tokens/999999/revoke`, {
        method: 'POST',
      }),
    )
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/shares/:id', () => {
  it('deletes a share and its tokens', async () => {
    const created = (await (
      await post({ title: 'delete-me', source: folderSource })
    ).json()) as ShareDto

    const deleteApp = buildApp()
    const deleteRes = await deleteApp.handle(
      new Request(`http://localhost/api/shares/${created.id}`, { method: 'DELETE' }),
    )
    expect(deleteRes.status).toBe(200)
    expect((await deleteRes.json()) as { deleted: boolean }).toEqual({ deleted: true })

    const listApp = buildApp()
    const listed = (await (
      await listApp.handle(new Request(`http://localhost/api/shares`))
    ).json()) as { data: ShareDto[] }
    expect(listed.data.some((s) => s.id === created.id)).toBe(false)
  })
})

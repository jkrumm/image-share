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

interface TokenDto {
  id: number
  token: string
  createdAt: string
  revokedAt: string | null
  url: string
}

interface ShareDto {
  id: number
  slug: string
  root: string
  dir: string
  sizeLimit: string
  includeRaws: boolean
  hasPassword: boolean
  tokens: TokenDto[]
}

describe('shares CRUD + roll lifecycle', () => {
  it('creates a share with a minted first token', async () => {
    const app = buildApp()
    const res = await app.handle(
      new Request('http://localhost/api/shares', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: 'mallorca-2026',
          root: 'library',
          dir: 'mallorca-2026',
          sizeLimit: 'medium',
          includeRaws: false,
        }),
      }),
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as ShareDto
    expect(body.slug).toBe('mallorca-2026')
    expect(body.hasPassword).toBe(false)
    expect(body.tokens).toHaveLength(1)
    expect(body.tokens[0]?.url).toContain(`token=${body.tokens[0]?.token}`)
  })

  it('rejects a duplicate slug', async () => {
    const app = buildApp()
    const res = await app.handle(
      new Request('http://localhost/api/shares', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: 'mallorca-2026',
          root: 'library',
          dir: 'mallorca-2026',
          sizeLimit: 'medium',
          includeRaws: false,
        }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('lists shares with tokens + minted URLs', async () => {
    const app = buildApp()
    const res = await app.handle(new Request('http://localhost/api/shares'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: ShareDto[] }
    expect(body.data.some((s) => s.slug === 'mallorca-2026')).toBe(true)
  })

  it('updates a share via PATCH (partial)', async () => {
    const createApp = buildApp()
    const created = await (
      await createApp.handle(
        new Request('http://localhost/api/shares', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            slug: 'patch-me',
            root: 'library',
            dir: 'foo',
            sizeLimit: 'medium',
            includeRaws: false,
          }),
        }),
      )
    ).json()
    const shareId = (created as ShareDto).id

    const app = buildApp()
    const res = await app.handle(
      new Request(`http://localhost/api/shares/${shareId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: 'friends album', sizeLimit: 'full' }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ShareDto & { note: string | null; sizeLimit: string }
    expect(body.note).toBe('friends album')
    expect(body.sizeLimit).toBe('full')
    expect(body.slug).toBe('patch-me') // unchanged field survives partial update
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

  it('rolls the token: old token revoked, new token minted', async () => {
    const createApp = buildApp()
    const created = (await (
      await createApp.handle(
        new Request('http://localhost/api/shares', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            slug: 'roll-me',
            root: 'library',
            dir: 'roll',
            sizeLimit: 'medium',
            includeRaws: false,
          }),
        }),
      )
    ).json()) as ShareDto
    const oldToken = created.tokens[0]?.token
    expect(oldToken).toBeTruthy()

    const rollApp = buildApp()
    const rollRes = await rollApp.handle(
      new Request(`http://localhost/api/shares/${created.id}/roll`, { method: 'POST' }),
    )
    expect(rollRes.status).toBe(200)
    const rolled = (await rollRes.json()) as { token: string; url: string }
    expect(rolled.token).not.toBe(oldToken)

    const listApp = buildApp()
    const listed = (await (
      await listApp.handle(new Request(`http://localhost/api/shares`))
    ).json()) as { data: ShareDto[] }
    const share = listed.data.find((s) => s.id === created.id)
    expect(share).toBeDefined()
    const oldTokenRow = share?.tokens.find((t) => t.token === oldToken)
    const newTokenRow = share?.tokens.find((t) => t.token === rolled.token)
    expect(oldTokenRow?.revokedAt).not.toBeNull()
    expect(newTokenRow?.revokedAt).toBeNull()
  })

  it('adds a parallel token without revoking the existing one', async () => {
    const createApp = buildApp()
    const created = (await (
      await createApp.handle(
        new Request('http://localhost/api/shares', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            slug: 'add-token',
            root: 'library',
            dir: 'add',
            sizeLimit: 'medium',
            includeRaws: false,
          }),
        }),
      )
    ).json()) as ShareDto
    const firstToken = created.tokens[0]?.token

    const addApp = buildApp()
    const addRes = await addApp.handle(
      new Request(`http://localhost/api/shares/${created.id}/tokens`, { method: 'POST' }),
    )
    expect(addRes.status).toBe(201)
    const added = (await addRes.json()) as { token: string; url: string }

    const listApp = buildApp()
    const listed = (await (
      await listApp.handle(new Request(`http://localhost/api/shares`))
    ).json()) as { data: ShareDto[] }
    const share = listed.data.find((s) => s.id === created.id)
    expect(share?.tokens).toHaveLength(2)
    const firstRow = share?.tokens.find((t) => t.token === firstToken)
    const secondRow = share?.tokens.find((t) => t.token === added.token)
    expect(firstRow?.revokedAt).toBeNull()
    expect(secondRow?.revokedAt).toBeNull()
  })

  it('deletes a share and its tokens', async () => {
    const createApp = buildApp()
    const created = (await (
      await createApp.handle(
        new Request('http://localhost/api/shares', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            slug: 'delete-me',
            root: 'library',
            dir: 'x',
            sizeLimit: 'medium',
            includeRaws: false,
          }),
        }),
      )
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

  it('password-protected share hashes the password (never echoed)', async () => {
    const app = buildApp()
    const res = await app.handle(
      new Request('http://localhost/api/shares', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: 'secret-album',
          root: 'library',
          dir: 'secret',
          sizeLimit: 'full',
          includeRaws: true,
          password: 'correct-horse-battery-staple',
        }),
      }),
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as ShareDto
    expect(body.hasPassword).toBe(true)
    expect(JSON.stringify(body)).not.toContain('correct-horse-battery-staple')
  })
})

describe('shares input validation (boundary rejects)', () => {
  function post(payload: Record<string, unknown>): Promise<Response> {
    return buildApp().handle(
      new Request('http://localhost/api/shares', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    )
  }

  const base = { root: 'library', dir: 'x', sizeLimit: 'medium', includeRaws: false } as const

  it('rejects a malformed expiresAt so it can never fail open at the read path', async () => {
    // Every one of these Date.parse-es to NaN in the Bun runtime; NaN <= now is
    // false, which is exactly why the read gate would otherwise never expire them.
    for (const expiresAt of [
      'not-a-date',
      '31.12.2026',
      '31/12/2026',
      '2026-12-31 18:00 CET',
      '1767225600',
    ]) {
      const res = await post({
        ...base,
        slug: `bad-${Math.random().toString(36).slice(2)}`,
        expiresAt,
      })
      expect(res.status).toBe(422)
    }
  })

  it('accepts a valid ISO date and datetime expiry', async () => {
    const dateRes = await post({ ...base, slug: 'exp-date', expiresAt: '2026-12-31' })
    expect(dateRes.status).toBe(201)
    const dtRes = await post({ ...base, slug: 'exp-datetime', expiresAt: '2026-12-31T18:00:00Z' })
    expect(dtRes.status).toBe(201)
  })

  it('rejects a raws-rooted share (would be permanently empty)', async () => {
    const res = await post({ ...base, root: 'raws', slug: 'raws-share' })
    expect(res.status).toBe(422)
  })

  it('rejects reserved slugs that would collide with the Caddy passthroughs', async () => {
    for (const slug of ['health', 's', 'api', 'admin', 'openapi']) {
      const res = await post({ ...base, slug })
      expect(res.status).toBe(400)
    }
  })
})

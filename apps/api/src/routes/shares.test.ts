import { describe, expect, it, mock } from 'bun:test'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { and, eq, gte } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { Elysia } from 'elysia'
import * as schema from '../db/schema.js'
// Pure SQL builder over `images` — no db/index.js in its import graph, so a
// static import cannot race the `mock.module` call below.
import { dirAtOrBelow } from '../lib/dir-scope.js'

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
// Imported AFTER the mock so it resolves the same in-memory db the routes use.
// `--isolate` (root `test` script) gives this file its own module registry, so
// share-auth.test.ts's `setShareDb` cannot leak in here.
const { getShareImageById } = await import('../lib/share-auth.js')
// The browse route, so preview-vs-share parity can be asserted end-to-end
// against ONE db — the whole point of the shared `recursive` default.
const { libraryRoutes } = await import('./library.js')

function buildApp() {
  return new Elysia().use(sharesRoutes)
}

// share_images.image_id is a real FK to images.id (foreign_keys=ON) — a
// selection share's imageIds must reference actual rows.
async function seedImage(relPath: string, dir = ''): Promise<number> {
  const now = new Date().toISOString()
  const [row] = await testDb
    .insert(schema.images)
    .values({
      root: 'fuji',
      relPath,
      dir,
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

/** Seed a JPEG carrying the given hierarchical keyword paths (image_keywords). */
async function seedAlbumImage(
  stem: string,
  albumPaths: string[],
  over: { rating?: number | null; captureAt?: string | null; root?: 'fuji' | 'share' } = {},
): Promise<number> {
  const now = new Date().toISOString()
  const [row] = await testDb
    .insert(schema.images)
    .values({
      root: over.root ?? 'fuji',
      relPath: `${stem}.JPG`,
      dir: '',
      stem,
      ext: 'jpg',
      kind: 'jpeg',
      fileSize: 1,
      mtimeMs: 1,
      rating: over.rating ?? null,
      captureAt: over.captureAt ?? null,
      indexedAt: now,
    })
    .returning({ id: schema.images.id })
  if (!row) throw new Error('seed failed')
  for (const path of albumPaths) {
    await testDb
      .insert(schema.imageKeywords)
      .values({ imageId: row.id, path, leaf: path.slice(path.lastIndexOf('|') + 1) })
  }
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
  album: string | null
  recursive: boolean
  minRating: number | null
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

  it('defaults recursive to true and persists an explicit recursive/minRating', async () => {
    const def = (await (
      await post({ title: 'Default scope', source: folderSource })
    ).json()) as ShareDto
    expect(def.recursive).toBe(true)
    expect(def.minRating).toBeNull()

    const res = await post({
      title: 'Flat scope',
      source: { ...folderSource, recursive: false, minRating: 3 },
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as ShareDto
    expect(body.recursive).toBe(false)
    expect(body.minRating).toBe(3)
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

// ── A share's images must be renderable ──────────────────────────────────────
//
// The RAWs root is a first-class browse axis in the admin (3661 `.RAF` files
// that exist nowhere else) and "Select all N matching" selects every row of it,
// so a `kind='raw'` id reaching this route is one click — or one agent call
// against `GET /api/library/images?root=raws` — away. A RAF has no rendition
// (design §6), so each one becomes a 500 tile on the friend's page. Rejected
// here rather than silently filtered: a share is a promise about a specific
// set, and quietly shipping fewer photos than asked for is as wrong as quietly
// shipping more.
describe('selection shares reject non-renderable and unknown image ids', () => {
  async function seedRawImage(relPath: string): Promise<number> {
    const now = new Date().toISOString()
    const [row] = await testDb
      .insert(schema.images)
      .values({
        root: 'raws',
        relPath,
        dir: '',
        stem: relPath.replace(/\.RAF$/, ''),
        ext: 'raf',
        kind: 'raw',
        fileSize: 1,
        mtimeMs: 1,
        indexedAt: now,
      })
      .returning({ id: schema.images.id })
    if (!row) throw new Error('seed failed')
    return row.id
  }

  it('400s a create whose ids include a RAF, naming the offending id', async () => {
    const jpeg = await seedImage('raf-guard-a.jpg')
    const raf = await seedRawImage('raf-guard-a.RAF')

    const res = await post({
      title: 'raf picks',
      source: { type: 'selection', imageIds: [jpeg, raf] },
    })
    expect(res.status).toBe(400)
    const message = await res.text()
    expect(message).toContain('RAW')
    expect(message).toContain(String(raf))

    // And nothing was created — no half-built share with a live token.
    const listed = (await (
      await buildApp().handle(new Request('http://localhost/api/shares'))
    ).json()) as {
      data: ShareDto[]
    }
    expect(listed.data.some((share) => share.title === 'raf picks')).toBe(false)
  })

  it('400s a create referencing an id that does not exist', async () => {
    const res = await post({
      title: 'ghost picks',
      source: { type: 'selection', imageIds: [987_654] },
    })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('987654')
  })

  it('400s a PATCH that would swap a RAF into an existing selection share', async () => {
    const jpeg = await seedImage('raf-guard-b.jpg')
    const raf = await seedRawImage('raf-guard-b.RAF')
    const created = (await (
      await post({ title: 'patch raf', source: { type: 'selection', imageIds: [jpeg] } })
    ).json()) as ShareDto

    const res = await buildApp().handle(
      new Request(`http://localhost/api/shares/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageIds: [raf] }),
      }),
    )
    expect(res.status).toBe(400)

    // The existing set is untouched — a rejected PATCH must not empty a share.
    const after = (await (
      await buildApp().handle(new Request(`http://localhost/api/shares/${created.id}`))
    ).json()) as ShareDto
    expect(after.imageCount).toBe(1)
  })
})

describe('GET /api/shares/:id', () => {
  it('404s for an unknown id', async () => {
    const app = buildApp()
    const res = await app.handle(new Request('http://localhost/api/shares/999999'))
    expect(res.status).toBe(404)
  })

  it('returns a folder share with its live-filtered images', async () => {
    await seedImage('detail-folder-a.jpg', 'detail-x')
    await seedImage('detail-folder-b.jpg', 'detail-x')
    const created = (await (
      await post({
        title: 'detail-folder',
        source: { type: 'folder', root: 'fuji', dir: 'detail-x' },
      })
    ).json()) as ShareDto

    const app = buildApp()
    const res = await app.handle(new Request(`http://localhost/api/shares/${created.id}`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as ShareDto & { images: { id: number }[] }
    expect(body.id).toBe(created.id)
    expect(body.images).toHaveLength(2)
  })

  it('returns a selection share capture-ascending, not in the posted order', async () => {
    const older = await seedAlbumImage('detail-sel-a', [], {
      captureAt: '2026-07-04T09:00:00.000Z',
    })
    const newer = await seedAlbumImage('detail-sel-b', [], {
      captureAt: '2026-07-11T09:00:00.000Z',
    })
    // Posted newest-first, which is what the admin grid's default browse sort
    // (captureAt/desc) produces — the share must not inherit it.
    const created = (await (
      await post({
        title: 'detail-selection',
        source: { type: 'selection', imageIds: [newer, older] },
      })
    ).json()) as ShareDto

    const app = buildApp()
    const res = await app.handle(new Request(`http://localhost/api/shares/${created.id}`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as ShareDto & { images: { id: number }[] }
    expect(body.images.map((i) => i.id)).toEqual([older, newer])
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

  it('toggles recursive on a folder share', async () => {
    const created = (await (
      await post({ title: 'toggle-scope', source: folderSource })
    ).json()) as ShareDto
    expect(created.recursive).toBe(true)

    const res = await buildApp().handle(
      new Request(`http://localhost/api/shares/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recursive: false }),
      }),
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as ShareDto).recursive).toBe(false)
  })

  it('rejects recursive on a selection share', async () => {
    const a = await seedImage('scope-a.jpg')
    const created = (await (
      await post({ title: 'selection-not-folder', source: { type: 'selection', imageIds: [a] } })
    ).json()) as ShareDto

    const res = await buildApp().handle(
      new Request(`http://localhost/api/shares/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recursive: false }),
      }),
    )
    expect(res.status).toBe(400)
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

// ── album shares ────────────────────────────────────────────────────────────
// The Fuji tree is completely flat, so the Lightroom keyword hierarchy (in
// image_keywords) is the real browse/share axis. These tests pin the invariant
// that matters on a public surface: the page listing, the by-id membership
// check and the admin count must all resolve through ONE predicate.

function getDetail(id: number): Promise<Response> {
  return buildApp().handle(new Request(`http://localhost/api/shares/${id}`))
}

function patch(id: number, payload: Record<string, unknown>): Promise<Response> {
  return buildApp().handle(
    new Request(`http://localhost/api/shares/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

/** Re-read a share row so lib-level assertions run against the stored source. */
async function shareRow(id: number) {
  const [row] = await testDb.select().from(schema.shares).where(eq(schema.shares.id, id)).limit(1)
  if (!row) throw new Error('share not found')
  return row
}

describe('album shares', () => {
  it('creates an album share scoped to a hierarchical keyword path', async () => {
    const res = await post({
      title: 'Segeln 25',
      source: { type: 'album', album: 'Ereignisse|Segeln 25' },
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as ShareDto
    expect(body.sourceType).toBe('album')
    expect(body.album).toBe('Ereignisse|Segeln 25')
    // An album share is scoped to ONE root, like a folder share — defaulting to
    // 'fuji', the only root the operator browses albums in.
    expect(body.root).toBe('fuji')
    expect(body.dir).toBeNull()
    expect(body.recursive).toBe(true)
    expect(body.tokens).toHaveLength(1)
    expect(body.tokens[0]?.role).toBe('view')
  })

  it('never crosses roots: a SHARE_ROOT ingest with the same keyword stays out', async () => {
    // SHARE_ROOT is the only agent-writable root, and GET /library/albums shows
    // one root at a time — a cross-root album share would publish an ingested
    // file carrying a matching keyword to the recipient with no preview surface
    // that could ever have shown it.
    const owned = await seedAlbumImage('root-scope-fuji', ['Ereignisse|Root Scope'], {
      captureAt: '2025-09-01T00:00:00.000Z',
    })
    const ingested = await seedAlbumImage('root-scope-share', ['Ereignisse|Root Scope'], {
      root: 'share',
      captureAt: '2025-09-02T00:00:00.000Z',
    })

    const created = (await (
      await post({ title: 'root scope', source: { type: 'album', album: 'Ereignisse|Root Scope' } })
    ).json()) as ShareDto
    const detail = (await (await getDetail(created.id)).json()) as ShareDto & {
      images: { id: number }[]
    }
    expect(detail.images.map((i) => i.id)).toEqual([owned])
    expect(detail.imageCount).toBe(1)
    expect(await getShareImageById(await shareRow(created.id), ingested)).toBeNull()

    // …and an album share explicitly targeting the share root sees only that
    // root, so the ingest axis stays usable on purpose.
    const onShare = (await (
      await post({
        title: 'root scope share',
        source: { type: 'album', root: 'share', album: 'Ereignisse|Root Scope' },
      })
    ).json()) as ShareDto
    expect(onShare.root).toBe('share')
    const shareDetail = (await (await getDetail(onShare.id)).json()) as ShareDto & {
      images: { id: number }[]
    }
    expect(shareDetail.images.map((i) => i.id)).toEqual([ingested])
  })

  it('rejects an empty album path (would mean “every tagged image”)', async () => {
    const res = await post({ title: 'empty album', source: { type: 'album', album: '' } })
    expect(res.status).toBe(422)
  })

  it('page listing, by-id membership and admin count all agree for the same share', async () => {
    const own = await seedAlbumImage('agree-own', ['Ereignisse|Segeln 25'], {
      captureAt: '2025-07-01T00:00:00.000Z',
    })
    const sub = await seedAlbumImage('agree-sub', ['Ereignisse|Segeln 25|Tag 1'], {
      captureAt: '2025-07-02T00:00:00.000Z',
    })
    // Tagged with BOTH the album and one of its sub-albums: an INNER JOIN would
    // list and count this photo twice; the EXISTS semi-join must not.
    const both = await seedAlbumImage(
      'agree-both',
      ['Ereignisse|Segeln 25', 'Ereignisse|Segeln 25|Tag 1'],
      { captureAt: '2025-07-03T00:00:00.000Z' },
    )
    // A sibling album whose name is a prefix of the shared one, plus an
    // unrelated album and an entirely untagged image — none may leak in.
    const sibling = await seedAlbumImage('agree-sibling', ['Ereignisse|Segeln 2'], {
      captureAt: '2025-07-04T00:00:00.000Z',
    })
    const unrelated = await seedAlbumImage('agree-unrelated', ['Insta Post Marokko'], {
      captureAt: '2025-07-05T00:00:00.000Z',
    })
    const untagged = await seedAlbumImage('agree-untagged', [], {
      captureAt: '2025-07-06T00:00:00.000Z',
    })

    const created = (await (
      await post({ title: 'agree', source: { type: 'album', album: 'Ereignisse|Segeln 25' } })
    ).json()) as ShareDto

    const detail = (await (await getDetail(created.id)).json()) as ShareDto & {
      images: { id: number }[]
    }
    // (a) the page listing — capture_at ascending, matching folder shares.
    expect(detail.images.map((i) => i.id)).toEqual([own, sub, both])
    // (c) the admin count — same predicate, so same cardinality.
    expect(detail.imageCount).toBe(detail.images.length)
    expect(detail.imageCount).toBe(3)

    // (b) the by-id membership check the asset routes use.
    const share = await shareRow(created.id)
    for (const id of [own, sub, both]) {
      expect((await getShareImageById(share, id))?.id).toBe(id)
    }
    for (const id of [sibling, unrelated, untagged]) {
      expect(await getShareImageById(share, id)).toBeNull()
    }
  })

  it('recursive=false scopes to the album itself, excluding sub-albums', async () => {
    const own = await seedAlbumImage('flat-own', ['Ereignisse|Marokko'], {
      captureAt: '2025-08-01T00:00:00.000Z',
    })
    const sub = await seedAlbumImage('flat-sub', ['Ereignisse|Marokko|Tag 1'], {
      captureAt: '2025-08-02T00:00:00.000Z',
    })

    const flat = (await (
      await post({
        title: 'marokko flat',
        source: { type: 'album', album: 'Ereignisse|Marokko', recursive: false },
      })
    ).json()) as ShareDto
    expect(flat.recursive).toBe(false)

    const flatDetail = (await (await getDetail(flat.id)).json()) as ShareDto & {
      images: { id: number }[]
    }
    expect(flatDetail.images.map((i) => i.id)).toEqual([own])
    expect(flatDetail.imageCount).toBe(1)
    // The by-id check must agree, or the sub-album's bytes stay fetchable.
    expect(await getShareImageById(await shareRow(flat.id), sub)).toBeNull()

    const deep = (await (
      await post({
        title: 'marokko deep',
        source: { type: 'album', album: 'Ereignisse|Marokko', recursive: true },
      })
    ).json()) as ShareDto
    const deepDetail = (await (await getDetail(deep.id)).json()) as ShareDto & {
      images: { id: number }[]
    }
    expect(deepDetail.images.map((i) => i.id)).toEqual([own, sub])
    expect(deepDetail.imageCount).toBe(2)
  })

  it('treats minRating 0 as “no filter”, keeping unrated images', async () => {
    const unrated = await seedAlbumImage('zero-unrated', ['Rating Probe'], {
      rating: null,
      captureAt: '2025-09-01T00:00:00.000Z',
    })
    const rated = await seedAlbumImage('zero-rated', ['Rating Probe'], {
      rating: 3,
      captureAt: '2025-09-02T00:00:00.000Z',
    })

    const created = (await (
      await post({
        title: 'rating probe',
        source: { type: 'album', album: 'Rating Probe', minRating: 0 },
      })
    ).json()) as ShareDto
    // A literal 0 is stored as-is (same as on a folder share); it is the SHARE
    // PREDICATE that reads 0 as "no filter" — `rating >= 0` is NULL for an
    // unrated image and would silently drop every untagged-rating photo.
    expect(created.minRating).toBe(0)

    const detail = (await (await getDetail(created.id)).json()) as ShareDto & {
      images: { id: number }[]
    }
    expect(detail.images.map((i) => i.id)).toEqual([unrated, rated])
    expect(detail.imageCount).toBe(2)
    expect((await getShareImageById(await shareRow(created.id), unrated))?.id).toBe(unrated)
  })

  it('applies a non-zero minRating to an album share', async () => {
    const low = await seedAlbumImage('min-low', ['Rating Gate'], {
      rating: 2,
      captureAt: '2025-09-03T00:00:00.000Z',
    })
    const high = await seedAlbumImage('min-high', ['Rating Gate'], {
      rating: 5,
      captureAt: '2025-09-04T00:00:00.000Z',
    })

    const created = (await (
      await post({
        title: 'rating gate',
        source: { type: 'album', album: 'Rating Gate', minRating: 4 },
      })
    ).json()) as ShareDto
    const detail = (await (await getDetail(created.id)).json()) as ShareDto & {
      images: { id: number }[]
    }
    expect(detail.images.map((i) => i.id)).toEqual([high])
    expect(detail.imageCount).toBe(1)
    expect(await getShareImageById(await shareRow(created.id), low)).toBeNull()
  })

  it('patches album/recursive/minRating on an album share and re-resolves membership', async () => {
    const inFirst = await seedAlbumImage('patch-first', ['Album One'], {
      captureAt: '2025-10-01T00:00:00.000Z',
    })
    const inSecond = await seedAlbumImage('patch-second', ['Album Two'], {
      captureAt: '2025-10-02T00:00:00.000Z',
    })

    const created = (await (
      await post({ title: 'album patch', source: { type: 'album', album: 'Album One' } })
    ).json()) as ShareDto

    const res = await patch(created.id, { album: 'Album Two', recursive: false, minRating: 0 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as ShareDto
    expect(body.album).toBe('Album Two')
    expect(body.recursive).toBe(false)
    expect(body.imageCount).toBe(1)

    const share = await shareRow(created.id)
    expect((await getShareImageById(share, inSecond))?.id).toBe(inSecond)
    expect(await getShareImageById(share, inFirst)).toBeNull()
  })

  it('rejects album on a folder share and on a selection share', async () => {
    const folder = (await (
      await post({ title: 'folder-not-album', source: folderSource })
    ).json()) as ShareDto
    expect((await patch(folder.id, { album: 'Ereignisse' })).status).toBe(400)

    const a = await seedImage('album-reject.jpg')
    const selection = (await (
      await post({ title: 'selection-not-album', source: { type: 'selection', imageIds: [a] } })
    ).json()) as ShareDto
    expect((await patch(selection.id, { album: 'Ereignisse' })).status).toBe(400)
  })

  it('rejects imageIds on an album share, and minRating/recursive on a selection share', async () => {
    const album = (await (
      await post({ title: 'album-not-selection', source: { type: 'album', album: 'Ereignisse' } })
    ).json()) as ShareDto
    expect((await patch(album.id, { imageIds: [1] })).status).toBe(400)

    const a = await seedImage('scope-reject.jpg')
    const selection = (await (
      await post({ title: 'selection-scope', source: { type: 'selection', imageIds: [a] } })
    ).json()) as ShareDto
    expect((await patch(selection.id, { minRating: 3 })).status).toBe(400)
    expect((await patch(selection.id, { recursive: false })).status).toBe(400)
  })

  it('deletes an album share and its tokens', async () => {
    const created = (await (
      await post({ title: 'album delete', source: { type: 'album', album: 'Ereignisse' } })
    ).json()) as ShareDto

    const res = await buildApp().handle(
      new Request(`http://localhost/api/shares/${created.id}`, { method: 'DELETE' }),
    )
    expect(res.status).toBe(200)
    expect(await getDetail(created.id).then((r) => r.status)).toBe(404)

    const remaining = await testDb
      .select({ id: schema.shareTokens.id })
      .from(schema.shareTokens)
      .where(eq(schema.shareTokens.shareId, created.id))
    expect(remaining).toHaveLength(0)
  })
})

// ── Rollback safety (design §11) ─────────────────────────────────────────────
// Rolling the container back to the previous image is the normal recovery move,
// and the DB is NOT rolled back with it. A pre-album binary has no `album`
// branch at all — it reads every non-selection share through one folder filter —
// so the album row it finds must resolve to NOTHING there. It fails closed
// because `shares.dir` carries ALBUM_SHARE_LEGACY_DIR instead of NULL.
/**
 * Frozen copy of the ONLY scope branch that binary had (git 2c4ca85,
 * lib/share-auth.ts `folderShareImageFilter`). Do not "modernise" it — its
 * value is that it is the old code, verbatim.
 */
function legacyFolderFilter(share: typeof schema.shares.$inferSelect) {
  const conds = [eq(schema.images.root, share.root as string), eq(schema.images.kind, 'jpeg')]
  if (!share.recursive) {
    conds.push(eq(schema.images.dir, share.dir ?? ''))
  } else if (share.dir) {
    conds.push(dirAtOrBelow(share.dir))
  }
  if (share.minRating) conds.push(gte(schema.images.rating, share.minRating))
  return and(...conds)
}

describe('an album share is inert to a rolled-back, pre-album binary', () => {
  async function legacyMembers(share: typeof schema.shares.$inferSelect): Promise<number[]> {
    const rows = await testDb
      .select({ id: schema.images.id })
      .from(schema.images)
      .where(legacyFolderFilter(share))
    return rows.map((r) => r.id)
  }

  it.each([
    ['recursive', true],
    ['non-recursive', false],
  ] as const)('serves an empty share, not the whole root (%s)', async (name, recursive) => {
    // The real production shape: the fuji tree is ONE flat directory, so every
    // image sits at dir='' — exactly the rows a missing dir predicate returns.
    const album = `Ereignisse|Rollback ${name}`
    await seedAlbumImage(`rollback-in-${name}`, [album])
    await seedAlbumImage(`rollback-out-${name}`, [])

    const created = (await (
      await post({
        title: `rollback probe ${name}`,
        source: { type: 'album', album, recursive },
      })
    ).json()) as ShareDto
    // The API contract is unchanged — `dir` stays a folder-share property.
    expect(created.dir).toBeNull()
    expect(created.imageCount).toBe(1)

    const row = await shareRow(created.id)
    expect(row.dir).toBe(schema.ALBUM_SHARE_LEGACY_DIR)
    expect(await legacyMembers(row)).toEqual([])

    // The counterfactual, and the whole reason the sentinel exists: the honest
    // NULL this column used to hold degrades to "no dir predicate at all"
    // (recursive) / "the root dir" (non-recursive) and leaks the flat library.
    expect((await legacyMembers({ ...row, dir: null })).length).toBeGreaterThan(1)
  })
})

describe('POST /api/shares — initial token role', () => {
  it('mints exactly one token with the requested role and no view token', async () => {
    const res = await post({
      title: 'full at creation',
      role: 'full',
      source: { type: 'album', album: 'Ereignisse' },
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as ShareDto
    expect(body.tokens).toHaveLength(1)
    expect(body.tokens[0]?.role).toBe('full')
    expect(body.tokens.some((t) => t.role === 'view')).toBe(false)

    const stored = await testDb
      .select({ role: schema.shareTokens.role })
      .from(schema.shareTokens)
      .where(eq(schema.shareTokens.shareId, body.id))
    expect(stored.map((t) => t.role)).toEqual(['full'])
  })

  it('defaults the initial token to view and rejects an unknown role', async () => {
    const def = (await (
      await post({ title: 'default role', source: folderSource })
    ).json()) as ShareDto
    expect(def.tokens[0]?.role).toBe('view')

    const bad = await post({ title: 'bad role', role: 'admin', source: folderSource })
    expect(bad.status).toBe(422)
  })
})

// ── Preview / share parity ───────────────────────────────────────────────────
// GET /api/library/images IS the create-share count preview (design §12), and
// GET /api/library/albums tells the caller to feed a node's path straight into
// it. The browse route used to resolve an omitted `recursive` to false while
// POST /api/shares resolves it to true, so previewing an interior album node
// showed ~0 while the share minted from it contained the whole subtree — the
// operator approving 0 and shipping hundreds. Both sides now default to true;
// these tests follow the documented workflow literally, sending no `recursive`
// anywhere, and assert the two numbers are equal.
describe('browse preview count equals share membership (no explicit recursive)', () => {
  async function previewTotal(qs: string): Promise<number> {
    const res = await new Elysia()
      .use(libraryRoutes)
      .handle(new Request(`http://localhost/api/library/images?${qs}`))
    expect(res.status).toBe(200)
    return ((await res.json()) as { total: number }).total
  }

  it('album: the previewed total is the album share’s imageCount', async () => {
    await seedAlbumImage('parity-a', ['Parity|Segeln 25'])
    // Tagged twice inside the same subtree — must count once on both sides.
    await seedAlbumImage('parity-b', ['Parity|Segeln 25', 'Parity|Marokko 25'])
    await seedAlbumImage('parity-c', ['Parity|Marokko 25'])
    // A case-variant sibling that must stay out of both numbers.
    await seedAlbumImage('parity-out', ['parity|Segeln 25'])

    const preview = await previewTotal('root=fuji&kind=jpeg&album=Parity')
    const share = (await (
      await post({ title: 'Parity album', source: { type: 'album', album: 'Parity' } })
    ).json()) as ShareDto

    // 'Parity' is a synthesized node holding nothing directly: a non-recursive
    // preview would have reported 0 for this exact three-image share.
    expect(preview).toBe(3)
    expect(share.imageCount).toBe(preview)
  })

  it('dir: the previewed total is the folder share’s imageCount', async () => {
    await seedImage('parity-dir-top.jpg', 'parity-dir')
    await seedImage('parity-dir-sub.jpg', 'parity-dir/day1')

    const preview = await previewTotal('root=fuji&kind=jpeg&dir=parity-dir')
    const share = (await (
      await post({
        title: 'Parity folder',
        source: { type: 'folder', root: 'fuji', dir: 'parity-dir' },
      })
    ).json()) as ShareDto

    expect(preview).toBe(2)
    expect(share.imageCount).toBe(preview)
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

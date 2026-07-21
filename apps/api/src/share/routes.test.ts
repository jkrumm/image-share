import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createDb, db as defaultDb, runMigrations, type Db } from '../db/index.js'
import { images, shares, shareTokens } from '../db/schema.js'
import { computeK, setShareDb } from '../lib/share-auth.js'
import { render404Page } from './page.js'
import { shareRoutes } from './routes.js'

let db: Db
const app = new Elysia().use(shareRoutes)

const get = (path: string): Promise<Response> => app.handle(new Request(`http://localhost${path}`))

async function seedShare(over: Partial<typeof shares.$inferInsert>): Promise<number> {
  const [row] = await db
    .insert(shares)
    .values({
      slug: 'x',
      root: 'library',
      dir: 'gal',
      sizeLimit: 'medium',
      includeRaws: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      ...over,
    })
    .returning()
  return row!.id
}

async function seedToken(shareId: number, token: string, revokedAt?: string): Promise<void> {
  await db
    .insert(shareTokens)
    .values({ shareId, token, createdAt: '2026-01-01T00:00:00.000Z', revokedAt: revokedAt ?? null })
}

async function seedImage(): Promise<number> {
  const [row] = await db
    .insert(images)
    .values({
      root: 'library',
      relPath: 'gal/a.jpg',
      dir: 'gal',
      stem: 'a',
      ext: 'jpg',
      kind: 'jpeg',
      fileSize: 1,
      mtimeMs: 1,
      rating: 5,
      captureAt: '2026-06-01',
      indexedAt: '2026-01-01T00:00:00.000Z',
    })
    .returning()
  return row!.id
}

let imageId: number
const OPAQUE = render404Page()
const PW_HASH = await Bun.password.hash('secret')

beforeAll(async () => {
  const created = createDb(':memory:')
  db = created.db
  runMigrations(db)
  setShareDb(db)

  imageId = await seedImage()
  const galId = await seedShare({ slug: 'gallery', dir: 'gal' })
  await seedToken(galId, 'tk')
  await seedToken(galId, 'rolled', '2026-02-01T00:00:00.000Z')

  const expId = await seedShare({
    slug: 'expired',
    dir: 'gal',
    expiresAt: '2000-01-01T00:00:00.000Z',
  })
  await seedToken(expId, 'et')

  const lockId = await seedShare({ slug: 'locked', dir: 'gal', passwordHash: PW_HASH })
  await seedToken(lockId, 'lt')
})

afterAll(() => {
  setShareDb(defaultDb)
})

describe('GET /s/:slug', () => {
  it('renders the gallery with token threaded into asset URLs', async () => {
    const res = await get('/s/gallery?token=tk')
    expect(res.status).toBe(200)
    const html = await res.text()
    // `&` is entity-escaped to `&amp;` in the HTML attribute (browsers decode it).
    expect(html).toContain(`/s/gallery/img/${imageId}?size=thumb&amp;token=tk`)
    expect(html).toContain('Download all')
  })

  it('collapses every denial cause to the identical opaque 404 body', async () => {
    const cases = [
      '/s/unknown?token=tk', // unknown slug
      '/s/gallery', // missing token
      '/s/gallery?token=rolled', // revoked/rolled token
      '/s/expired?token=et', // expired share
      '/s/locked?token=lt&k=deadbeef', // valid token, WRONG k
    ]
    for (const path of cases) {
      const res = await get(path)
      expect(res.status).toBe(404)
      expect(await res.text()).toBe(OPAQUE)
    }
  })

  it('serves the unlock form for a valid token on a password share (no k)', async () => {
    const res = await get('/s/locked?token=lt')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('password protected')
  })
})

describe('POST /s/:slug/unlock (roundtrip)', () => {
  const post = (path: string, body: string): Promise<Response> =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      }),
    )

  it('rejects a wrong password by re-rendering the form', async () => {
    const res = await post('/s/locked/unlock?token=lt', 'password=nope')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Incorrect password')
  })

  it('verifies the password, 302s with a working k, then renders the gallery', async () => {
    const res = await post('/s/locked/unlock?token=lt', 'password=secret')
    expect(res.status).toBe(302)
    const location = res.headers.get('location')!
    expect(location).toContain('token=lt')
    expect(location).toContain(`k=${computeK(PW_HASH, 'lt')}`)

    const gallery = await get(location)
    expect(gallery.status).toBe(200)
    expect(await gallery.text()).toContain(`/s/locked/img/${imageId}`)
  })
})

describe('GET /s/:slug/img/:id (membership + size enforcement)', () => {
  it('404s an id that does not belong to the share', async () => {
    const res = await get(`/s/gallery/img/999999?token=tk&size=med`)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe(OPAQUE)
  })

  it('404s size=full on a medium share even for a valid id', async () => {
    const res = await get(`/s/gallery/img/${imageId}?token=tk&size=full`)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe(OPAQUE)
  })
})

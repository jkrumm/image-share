import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createDb, db as defaultDb, runMigrations, type Db } from '../db/index.js'
import { images, shares, shareTokens } from '../db/schema.js'
import {
  getShareImageById,
  listShareImages,
  resolveShareAccess,
  setShareDb,
  setShareImages,
  shareImageCount,
} from './share-auth.js'

let db: Db

async function seedShare(over: Partial<typeof shares.$inferInsert> = {}): Promise<number> {
  const [row] = await db
    .insert(shares)
    .values({
      slug: 'mallorca-2026',
      title: 'Mallorca 2026',
      sourceType: 'folder',
      root: 'fuji',
      dir: 'mallorca-2026',
      createdAt: '2026-01-01T00:00:00.000Z',
      ...over,
    })
    .returning()
  return row!.id
}

async function seedToken(
  shareId: number,
  token: string,
  over: Partial<typeof shareTokens.$inferInsert> = {},
): Promise<void> {
  await db.insert(shareTokens).values({
    shareId,
    token,
    role: 'view',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  })
}

async function seedImage(over: Partial<typeof images.$inferInsert>): Promise<number> {
  const [row] = await db
    .insert(images)
    .values({
      root: 'fuji',
      relPath: 'mallorca-2026/DSCF0001.JPG',
      dir: 'mallorca-2026',
      stem: 'DSCF0001',
      ext: 'jpg',
      kind: 'jpeg',
      fileSize: 100,
      mtimeMs: 1,
      indexedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    })
    .returning()
  return row!.id
}

beforeAll(() => {
  const created = createDb(':memory:')
  db = created.db
  runMigrations(db)
  setShareDb(db)
})

afterAll(() => {
  setShareDb(defaultDb)
})

describe('resolveShareAccess', () => {
  it('accepts a valid token and resolves its role', async () => {
    const id = await seedShare({ slug: 'ok' })
    await seedToken(id, 'good-token', { role: 'download' })
    const access = await resolveShareAccess({ slug: 'ok', token: 'good-token' })
    expect(access?.share.id).toBe(id)
    expect(access?.role).toBe('download')
  })

  it('returns null for unknown slug, missing/revoked token, and expired share', async () => {
    const id = await seedShare({ slug: 'checks' })
    await seedToken(id, 'live')
    await seedToken(id, 'rolled', { revokedAt: '2026-02-01T00:00:00.000Z' })
    const expiredId = await seedShare({ slug: 'expired', expiresAt: '2000-01-01T00:00:00.000Z' })
    await seedToken(expiredId, 'exp-token')

    expect(await resolveShareAccess({ slug: 'nope', token: 'live' })).toBeNull()
    expect(await resolveShareAccess({ slug: 'checks', token: undefined })).toBeNull()
    expect(await resolveShareAccess({ slug: 'checks', token: 'rolled' })).toBeNull()
    expect(await resolveShareAccess({ slug: 'expired', token: 'exp-token' })).toBeNull()
    // A valid token cannot be replayed against a different share's slug.
    expect(await resolveShareAccess({ slug: 'expired', token: 'live' })).toBeNull()
  })

  it('fails CLOSED on an unparseable expires_at (never exposes it as non-expiring)', async () => {
    // A malformed date reaches the read path only via a pre-existing bad row (the
    // admin schema now rejects it on write). Date.parse('not-a-date') is NaN and
    // `NaN <= Date.now()` is false, so a naive gate would treat it as NOT expired
    // and keep the share public forever. The fail-closed gate treats it as expired.
    const badId = await seedShare({ slug: 'bad-expiry', expiresAt: 'not-a-date' })
    await seedToken(badId, 'bad-token')
    expect(await resolveShareAccess({ slug: 'bad-expiry', token: 'bad-token' })).toBeNull()
  })
})

describe('listShareImages + getShareImageById (folder source)', () => {
  it('scopes to the share dir recursively, kind jpeg, and min rating', async () => {
    const id = await seedShare({ slug: 'content', dir: 'trip', minRating: 4 })
    await seedToken(id, 'ct')
    const inTop = await seedImage({
      root: 'fuji',
      relPath: 'trip/a.jpg',
      dir: 'trip',
      rating: 5,
      captureAt: '2026-06-01',
    })
    const inSub = await seedImage({
      root: 'fuji',
      relPath: 'trip/day1/b.jpg',
      dir: 'trip/day1',
      rating: 4,
      captureAt: '2026-06-02',
    })
    // Excluded: low rating, wrong kind, sibling dir, other root.
    await seedImage({
      root: 'fuji',
      relPath: 'trip/c.jpg',
      dir: 'trip',
      rating: 2,
      captureAt: '2026-06-03',
    })
    await seedImage({
      root: 'fuji',
      relPath: 'trip/d.raf',
      dir: 'trip',
      kind: 'raw',
      rating: 5,
      captureAt: '2026-06-04',
    })
    const siblingId = await seedImage({
      root: 'fuji',
      relPath: 'trip-other/e.jpg',
      dir: 'trip-other',
      rating: 5,
      captureAt: '2026-06-05',
    })

    const access = await resolveShareAccess({ slug: 'content', token: 'ct' })
    const share = access!.share
    const list = await listShareImages(share)
    const ids = list.map((r) => r.id)
    expect(ids).toEqual([inTop, inSub]) // sorted by capture_at asc, filters applied
    expect(ids).not.toContain(siblingId)

    // getShareImageById mirrors the same membership filter.
    expect((await getShareImageById(share, inSub))?.id).toBe(inSub)
    expect(await getShareImageById(share, siblingId)).toBeNull()
    expect(await shareImageCount(share)).toBe(2)
  })

  it('excludes sub-directory images when recursive=false', async () => {
    const id = await seedShare({ slug: 'flat', dir: 'flat-trip', recursive: false })
    await seedToken(id, 'ft')
    const inTop = await seedImage({
      root: 'fuji',
      relPath: 'flat-trip/a.jpg',
      dir: 'flat-trip',
      rating: 5,
      captureAt: '2026-07-01',
    })
    const inSub = await seedImage({
      root: 'fuji',
      relPath: 'flat-trip/day1/b.jpg',
      dir: 'flat-trip/day1',
      rating: 5,
      captureAt: '2026-07-02',
    })

    const access = await resolveShareAccess({ slug: 'flat', token: 'ft' })
    const share = access!.share
    expect((await listShareImages(share)).map((r) => r.id)).toEqual([inTop])
    expect(await shareImageCount(share)).toBe(1)
    // The id-membership check MUST agree with the listing, or an image the page
    // never renders would still be fetchable by id.
    expect((await getShareImageById(share, inTop))?.id).toBe(inTop)
    expect(await getShareImageById(share, inSub)).toBeNull()
  })

  it('does not reach into a case-variant or wildcard-matching sibling directory', async () => {
    // The subtree match used to be `dir LIKE 'Case/%'`. SQLite's LIKE is
    // case-insensitive for ASCII (and COLLATE has no effect on it), so on the
    // case-sensitive Linux filesystem the share silently swallowed `case/...`.
    // `_` was also a LIKE wildcard, so `Case_1/` over-matched `CaseX1/`.
    const id = await seedShare({ slug: 'case', dir: 'Case_1', recursive: true })
    await seedToken(id, 'cs')
    const mine = await seedImage({
      root: 'fuji',
      relPath: 'Case_1/sub/a.jpg',
      dir: 'Case_1/sub',
      captureAt: '2026-09-01',
    })
    const otherCase = await seedImage({
      root: 'fuji',
      relPath: 'case_1/sub/private.jpg',
      dir: 'case_1/sub',
      captureAt: '2026-09-02',
    })
    const wildcard = await seedImage({
      root: 'fuji',
      relPath: 'CaseX1/sub/private.jpg',
      dir: 'CaseX1/sub',
      captureAt: '2026-09-03',
    })

    const share = (await resolveShareAccess({ slug: 'case', token: 'cs' }))!.share
    expect((await listShareImages(share)).map((r) => r.id)).toEqual([mine])
    expect(await shareImageCount(share)).toBe(1)
    // The id-membership check must agree, or the bytes stay fetchable by id.
    expect(await getShareImageById(share, otherCase)).toBeNull()
    expect(await getShareImageById(share, wildcard)).toBeNull()
  })

  it('treats minRating 0 as "no filter", keeping unrated (NULL) images', async () => {
    // `rating >= 0` is NULL for an unrated image, so a stored 0 would silently
    // drop every unrated photo from the share.
    const id = await seedShare({ slug: 'zero-rating', dir: 'zr', minRating: 0 })
    await seedToken(id, 'zr')
    const unrated = await seedImage({
      root: 'fuji',
      relPath: 'zr/a.jpg',
      dir: 'zr',
      rating: null,
      captureAt: '2026-10-01',
    })
    const rated = await seedImage({
      root: 'fuji',
      relPath: 'zr/b.jpg',
      dir: 'zr',
      rating: 3,
      captureAt: '2026-10-02',
    })

    const share = (await resolveShareAccess({ slug: 'zero-rating', token: 'zr' }))!.share
    expect((await listShareImages(share)).map((r) => r.id)).toEqual([unrated, rated])
    expect(await shareImageCount(share)).toBe(2)
    expect((await getShareImageById(share, unrated))?.id).toBe(unrated)
  })

  it('recursive=false with an empty dir scopes to the root’s immediate children', async () => {
    const id = await seedShare({ slug: 'root-flat', dir: '', recursive: false })
    await seedToken(id, 'rft')
    const atRoot = await seedImage({
      root: 'fuji',
      relPath: 'root-a.jpg',
      dir: '',
      rating: 5,
      captureAt: '2026-08-01',
    })
    const nested = await seedImage({
      root: 'fuji',
      relPath: 'nested/root-b.jpg',
      dir: 'nested',
      rating: 5,
      captureAt: '2026-08-02',
    })

    const access = await resolveShareAccess({ slug: 'root-flat', token: 'rft' })
    const share = access!.share
    const ids = (await listShareImages(share)).map((r) => r.id)
    expect(ids).toContain(atRoot)
    expect(ids).not.toContain(nested)
    expect(await getShareImageById(share, nested)).toBeNull()
  })
})

describe('listShareImages + getShareImageById (selection source)', () => {
  it('returns exactly the selected images, ordered by position', async () => {
    const id = await seedShare({
      slug: 'picks',
      sourceType: 'selection',
      root: null,
      dir: null,
    })
    await seedToken(id, 'pt')
    const a = await seedImage({ root: 'fuji', relPath: 'a.jpg', dir: '', rating: 1 })
    const b = await seedImage({ root: 'fuji', relPath: 'b.jpg', dir: '', rating: 5 })
    const notPicked = await seedImage({ root: 'fuji', relPath: 'c.jpg', dir: '', rating: 5 })

    // Deliberately reversed order vs insertion, to prove position wins over id/rating.
    await setShareImages(id, [b, a])

    const access = await resolveShareAccess({ slug: 'picks', token: 'pt' })
    const share = access!.share
    const list = await listShareImages(share)
    expect(list.map((r) => r.id)).toEqual([b, a])
    expect(await getShareImageById(share, notPicked)).toBeNull()
    expect(await shareImageCount(share)).toBe(2)

    // Replacing the set drops anything not re-included.
    await setShareImages(id, [a])
    const after = await listShareImages(share)
    expect(after.map((r) => r.id)).toEqual([a])
  })
})

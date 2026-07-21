import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createDb, db as defaultDb, runMigrations, type Db } from '../db/index.js'
import { images, shares, shareTokens } from '../db/schema.js'
import {
  computeK,
  getShareImageById,
  listShareImages,
  resolveShareAccess,
  resolveShareForPage,
  resolveShareToken,
  setShareDb,
  timingSafeEqualHex,
  verifySharePassword,
} from './share-auth.js'

let db: Db

async function seedShare(over: Partial<typeof shares.$inferInsert> = {}): Promise<number> {
  const [row] = await db
    .insert(shares)
    .values({
      slug: 'mallorca-2026',
      root: 'library',
      dir: 'mallorca-2026',
      sizeLimit: 'medium',
      includeRaws: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      ...over,
    })
    .returning()
  return row!.id
}

async function seedToken(shareId: number, token: string, revokedAt?: string): Promise<void> {
  await db.insert(shareTokens).values({
    shareId,
    token,
    createdAt: '2026-01-01T00:00:00.000Z',
    revokedAt: revokedAt ?? null,
  })
}

async function seedImage(over: Partial<typeof images.$inferInsert>): Promise<number> {
  const [row] = await db
    .insert(images)
    .values({
      root: 'library',
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

describe('computeK / timingSafeEqualHex', () => {
  it('derives a stable 32-hex-char capability keyed on hash + token', () => {
    const k = computeK('hash-a', 'token-1')
    expect(k).toHaveLength(32)
    expect(k).toMatch(/^[0-9a-f]{32}$/)
    expect(computeK('hash-a', 'token-1')).toBe(k)
    // Rolling the token (or the hash) mints a different k.
    expect(computeK('hash-a', 'token-2')).not.toBe(k)
    expect(computeK('hash-b', 'token-1')).not.toBe(k)
  })

  it('compares hex constant-time and rejects mismatched length/garbage', () => {
    expect(timingSafeEqualHex('abcd', 'abcd')).toBe(true)
    expect(timingSafeEqualHex('abcd', 'abce')).toBe(false)
    expect(timingSafeEqualHex('abcd', 'ab')).toBe(false) // length mismatch
    // Garbage of the same length as a real (valid-hex) capability fails: the
    // valid side decodes to N bytes, the garbage to fewer → length-throw → false.
    expect(timingSafeEqualHex('abcd', 'zzzz')).toBe(false)
  })
})

describe('resolveShareAccess (asset surface)', () => {
  it('accepts a valid token on a non-password share', async () => {
    const id = await seedShare({ slug: 'ok' })
    await seedToken(id, 'good-token')
    const access = await resolveShareAccess({ slug: 'ok', token: 'good-token', k: undefined })
    expect(access?.share.id).toBe(id)
    expect(access?.k).toBe('')
  })

  it('returns null for unknown slug, missing/revoked token, and expired share', async () => {
    const id = await seedShare({ slug: 'checks' })
    await seedToken(id, 'live')
    await seedToken(id, 'rolled', '2026-02-01T00:00:00.000Z')
    const expiredId = await seedShare({ slug: 'expired', expiresAt: '2000-01-01T00:00:00.000Z' })
    await seedToken(expiredId, 'exp-token')

    expect(await resolveShareAccess({ slug: 'nope', token: 'live', k: undefined })).toBeNull()
    expect(await resolveShareAccess({ slug: 'checks', token: undefined, k: undefined })).toBeNull()
    expect(await resolveShareAccess({ slug: 'checks', token: 'rolled', k: undefined })).toBeNull()
    expect(
      await resolveShareAccess({ slug: 'expired', token: 'exp-token', k: undefined }),
    ).toBeNull()
    // A valid token cannot be replayed against a different share's slug.
    expect(await resolveShareAccess({ slug: 'expired', token: 'live', k: undefined })).toBeNull()
  })

  it('fails CLOSED on an unparseable expires_at (never exposes it as non-expiring)', async () => {
    // A malformed date reaches the read path only via a pre-existing bad row (the
    // admin schema now rejects it on write). Date.parse('not-a-date') is NaN and
    // `NaN <= Date.now()` is false, so a naive gate would treat it as NOT expired
    // and keep the share public forever. The fail-closed gate treats it as expired.
    const badId = await seedShare({ slug: 'bad-expiry', expiresAt: 'not-a-date' })
    await seedToken(badId, 'bad-token')
    expect(
      await resolveShareAccess({ slug: 'bad-expiry', token: 'bad-token', k: undefined }),
    ).toBeNull()
    expect(
      await resolveShareForPage({ slug: 'bad-expiry', token: 'bad-token', k: undefined }),
    ).toBeNull()
    expect(await resolveShareToken({ slug: 'bad-expiry', token: 'bad-token' })).toBeNull()
  })

  it('enforces the timing-safe k check for password shares', async () => {
    const hash = await Bun.password.hash('hunter2')
    const id = await seedShare({ slug: 'locked', passwordHash: hash })
    await seedToken(id, 'ptoken')
    const goodK = computeK(hash, 'ptoken')

    expect(await resolveShareAccess({ slug: 'locked', token: 'ptoken', k: undefined })).toBeNull()
    expect(await resolveShareAccess({ slug: 'locked', token: 'ptoken', k: 'deadbeef' })).toBeNull()
    const ok = await resolveShareAccess({ slug: 'locked', token: 'ptoken', k: goodK })
    expect(ok?.k).toBe(goodK)
  })
})

describe('resolveShareForPage (page surface)', () => {
  it('offers the unlock form when k is absent but 404s on a wrong k', async () => {
    const hash = await Bun.password.hash('pw')
    const id = await seedShare({ slug: 'page-locked', passwordHash: hash })
    await seedToken(id, 'pt')
    const goodK = computeK(hash, 'pt')

    const noK = await resolveShareForPage({ slug: 'page-locked', token: 'pt', k: undefined })
    expect(noK?.needsUnlock).toBe(true)
    // Wrong k → null (opaque 404), never distinguished from a bad link.
    expect(await resolveShareForPage({ slug: 'page-locked', token: 'pt', k: 'ffff' })).toBeNull()
    const okK = await resolveShareForPage({ slug: 'page-locked', token: 'pt', k: goodK })
    expect(okK?.needsUnlock).toBe(false)
    expect(okK?.k).toBe(goodK)
  })

  it('renders directly for non-password shares', async () => {
    const id = await seedShare({ slug: 'page-open' })
    await seedToken(id, 'pot')
    const res = await resolveShareForPage({ slug: 'page-open', token: 'pot', k: undefined })
    expect(res?.needsUnlock).toBe(false)
  })
})

describe('verifySharePassword + resolveShareToken (unlock roundtrip)', () => {
  it('verifies the password and mints a k that unlocks the asset surface', async () => {
    const hash = await Bun.password.hash('correct horse')
    const id = await seedShare({ slug: 'unlock-me', passwordHash: hash })
    await seedToken(id, 'utoken')

    const tokenOnly = await resolveShareToken({ slug: 'unlock-me', token: 'utoken' })
    expect(tokenOnly?.share.id).toBe(id)

    expect(
      await verifySharePassword({ share: tokenOnly!.share, token: 'utoken', password: 'wrong' }),
    ).toBeNull()
    const k = await verifySharePassword({
      share: tokenOnly!.share,
      token: 'utoken',
      password: 'correct horse',
    })
    expect(k).not.toBeNull()
    // The minted k unlocks the gallery + assets.
    const access = await resolveShareAccess({ slug: 'unlock-me', token: 'utoken', k: k! })
    expect(access?.share.id).toBe(id)
  })
})

describe('listShareImages + getShareImageById (content query)', () => {
  it('scopes to the share dir recursively, kind jpeg, and min rating', async () => {
    const id = await seedShare({ slug: 'content', dir: 'trip', minRating: 4 })
    await seedToken(id, 'ct')
    const inTop = await seedImage({
      root: 'library',
      relPath: 'trip/a.jpg',
      dir: 'trip',
      rating: 5,
      captureAt: '2026-06-01',
    })
    const inSub = await seedImage({
      root: 'library',
      relPath: 'trip/day1/b.jpg',
      dir: 'trip/day1',
      rating: 4,
      captureAt: '2026-06-02',
    })
    // Excluded: low rating, wrong kind, sibling dir, other root.
    await seedImage({
      root: 'library',
      relPath: 'trip/c.jpg',
      dir: 'trip',
      rating: 2,
      captureAt: '2026-06-03',
    })
    await seedImage({
      root: 'library',
      relPath: 'trip/d.raf',
      dir: 'trip',
      kind: 'raw',
      rating: 5,
      captureAt: '2026-06-04',
    })
    const siblingId = await seedImage({
      root: 'library',
      relPath: 'trip-other/e.jpg',
      dir: 'trip-other',
      rating: 5,
      captureAt: '2026-06-05',
    })

    const share = (await resolveShareToken({ slug: 'content', token: 'ct' }))!.share
    const list = await listShareImages(share)
    const ids = list.map((r) => r.id)
    expect(ids).toEqual([inTop, inSub]) // sorted by capture_at asc, filters applied
    expect(ids).not.toContain(siblingId)

    // getShareImageById mirrors the same membership filter.
    expect((await getShareImageById(share, inSub))?.id).toBe(inSub)
    expect(await getShareImageById(share, siblingId)).toBeNull()
  })
})

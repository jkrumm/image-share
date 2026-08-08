import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createDb, db as defaultDb, runMigrations, type Db } from '../db/index.js'
import { imageKeywords, images, shares, shareTokens } from '../db/schema.js'
import {
  getShareImageById,
  listShareImages,
  resolveShareAccess,
  setShareDb,
  setShareImages,
  shareImageCount,
  shareImageSummary,
  shareRawPaths,
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

/** The image ids a share resolves to, in the order it ships them. */
async function listOf(slug: string, token: string): Promise<number[]> {
  const access = await resolveShareAccess({ slug, token })
  return (await listShareImages(access!.share)).map((row) => row.id)
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

describe('listShareImages + getShareImageById (album source)', () => {
  async function seedKeyworded(
    stem: string,
    paths: string[],
    over: Partial<typeof images.$inferInsert> = {},
  ): Promise<number> {
    const id = await seedImage({ relPath: `${stem}.JPG`, dir: '', stem, ...over })
    for (const path of paths) {
      await db
        .insert(imageKeywords)
        .values({ imageId: id, path, leaf: path.slice(path.lastIndexOf('|') + 1) })
    }
    return id
  }

  it('scopes to the keyword subtree, kind jpeg, and counts each image once', async () => {
    const id = await seedShare({
      slug: 'album',
      sourceType: 'album',
      root: null,
      dir: null,
      album: 'Ereignisse|Segeln 25',
    })
    await seedToken(id, 'al')

    const own = await seedKeyworded('al-own', ['Ereignisse|Segeln 25'], {
      captureAt: '2026-11-01',
    })
    const sub = await seedKeyworded('al-sub', ['Ereignisse|Segeln 25|Tag 1'], {
      captureAt: '2026-11-02',
    })
    // Two matching keyword rows for ONE image — an INNER JOIN would list and
    // count it twice; the EXISTS semi-join must yield exactly one row.
    const both = await seedKeyworded(
      'al-both',
      ['Ereignisse|Segeln 25', 'Ereignisse|Segeln 25|Tag 1'],
      { captureAt: '2026-11-03' },
    )
    // A raw file carrying the same tag is excluded by kind='jpeg', same as on a
    // folder share — RAFs ride along only through a full-role token.
    const raw = await seedKeyworded('al-raw', ['Ereignisse|Segeln 25'], {
      kind: 'raw',
      ext: 'raf',
      captureAt: '2026-11-04',
    })
    const sibling = await seedKeyworded('al-sibling', ['Ereignisse|Segeln 2'], {
      captureAt: '2026-11-05',
    })
    const parent = await seedKeyworded('al-parent', ['Ereignisse'], { captureAt: '2026-11-06' })
    const caseVariant = await seedKeyworded('al-case', ['ereignisse|Segeln 25'], {
      captureAt: '2026-11-07',
    })
    const untagged = await seedKeyworded('al-untagged', [], { captureAt: '2026-11-08' })

    const share = (await resolveShareAccess({ slug: 'album', token: 'al' }))!.share
    expect((await listShareImages(share)).map((r) => r.id)).toEqual([own, sub, both])
    expect(await shareImageCount(share)).toBe(3)
    for (const outside of [raw, sibling, parent, caseVariant, untagged]) {
      expect(await getShareImageById(share, outside)).toBeNull()
    }
    expect((await getShareImageById(share, both))?.id).toBe(both)
  })

  it('excludes sub-albums when recursive=false', async () => {
    const id = await seedShare({
      slug: 'album-flat',
      sourceType: 'album',
      root: null,
      dir: null,
      album: 'Insta Post Marokko',
      recursive: false,
    })
    await seedToken(id, 'af')
    const own = await seedKeyworded('af-own', ['Insta Post Marokko'], { captureAt: '2026-12-01' })
    const sub = await seedKeyworded('af-sub', ['Insta Post Marokko|Tag 1'], {
      captureAt: '2026-12-02',
    })

    const share = (await resolveShareAccess({ slug: 'album-flat', token: 'af' }))!.share
    expect((await listShareImages(share)).map((r) => r.id)).toEqual([own])
    expect(await shareImageCount(share)).toBe(1)
    expect(await getShareImageById(share, sub)).toBeNull()
  })

  it('is root-scoped: an agent ingest carrying the same keyword never joins the share', async () => {
    // SHARE_ROOT is the only agent-WRITABLE root (POST /api/images writes the
    // uploaded bytes verbatim and indexes them immediately). A cross-root album
    // predicate would therefore publish anything ingested there that happens to
    // carry — or was crafted to carry — a matching XMP-lr:HierarchicalSubject to
    // the friend the link was sent to, and GET /api/library/albums (one root at
    // a time) would never show it in the preview.
    const id = await seedShare({
      slug: 'album-root',
      sourceType: 'album',
      root: 'fuji',
      dir: null,
      album: 'Ereignisse|Root Probe',
    })
    await seedToken(id, 'ar')
    const owned = await seedKeyworded('ar-fuji', ['Ereignisse|Root Probe'], {
      captureAt: '2027-02-01',
    })
    const ingested = await seedKeyworded('ar-share', ['Ereignisse|Root Probe'], {
      root: 'share',
      relPath: 'agent/secret.JPG',
      captureAt: '2027-02-02',
    })

    const share = (await resolveShareAccess({ slug: 'album-root', token: 'ar' }))!.share
    expect((await listShareImages(share)).map((r) => r.id)).toEqual([owned])
    expect(await shareImageCount(share)).toBe(1)
    expect((await shareImageSummary(share)).total).toBe(1)
    expect(await getShareImageById(share, ingested)).toBeNull()
  })

  it('a null root on an album share falls back to fuji, never to every root', async () => {
    const id = await seedShare({
      slug: 'album-root-null',
      sourceType: 'album',
      root: null,
      dir: null,
      album: 'Ereignisse|Root Probe',
    })
    await seedToken(id, 'arn')

    const share = (await resolveShareAccess({ slug: 'album-root-null', token: 'arn' }))!.share
    expect((await listShareImages(share)).map((r) => r.relPath)).toEqual(['ar-fuji.JPG'])
  })

  it('fails CLOSED on an album share with no album stored', async () => {
    // The admin schema requires a non-empty album, so a NULL here means a
    // corrupt row. It must resolve to an EMPTY share, never to "every tagged
    // image" — the same fail-closed reasoning as the expiry gate above.
    const id = await seedShare({
      slug: 'album-null',
      sourceType: 'album',
      root: null,
      dir: null,
      album: null,
    })
    await seedToken(id, 'an')
    const tagged = await seedKeyworded('an-tagged', ['Ereignisse|Segeln 25'], {
      captureAt: '2027-01-01',
    })

    const share = (await resolveShareAccess({ slug: 'album-null', token: 'an' }))!.share
    expect(await listShareImages(share)).toEqual([])
    expect(await shareImageCount(share)).toBe(0)
    expect(await getShareImageById(share, tagged)).toBeNull()
  })
})

describe('listShareImages + getShareImageById (selection source)', () => {
  it('returns exactly the selected images, capture-ascending whatever order they were written in', async () => {
    const id = await seedShare({
      slug: 'picks',
      sourceType: 'selection',
      root: null,
      dir: null,
    })
    await seedToken(id, 'pt')
    const a = await seedImage({
      root: 'fuji',
      relPath: 'a.jpg',
      dir: '',
      rating: 1,
      captureAt: '2026-06-01T00:00:00.000Z',
    })
    const b = await seedImage({
      root: 'fuji',
      relPath: 'b.jpg',
      dir: '',
      rating: 5,
      captureAt: '2026-06-09T00:00:00.000Z',
    })
    const notPicked = await seedImage({ root: 'fuji', relPath: 'c.jpg', dir: '', rating: 5 })

    // Written newest-first — exactly what the admin grid's default
    // captureAt/desc browse sort used to hand this function.
    await setShareImages(id, [b, a])

    const access = await resolveShareAccess({ slug: 'picks', token: 'pt' })
    const share = access!.share
    const list = await listShareImages(share)
    expect(list.map((r) => r.id)).toEqual([a, b])
    expect(await getShareImageById(share, notPicked)).toBeNull()
    expect(await shareImageCount(share)).toBe(2)

    // Replacing the set drops anything not re-included.
    await setShareImages(id, [a])
    const after = await listShareImages(share)
    expect(after.map((r) => r.id)).toEqual([a])
  })

  it('a RAW row written before the id check existed is dropped, not 500-served', async () => {
    const id = await seedShare({
      slug: 'legacy-raf',
      sourceType: 'selection',
      root: null,
      dir: null,
    })
    await seedToken(id, 'lr')
    const jpeg = await seedImage({
      root: 'fuji',
      relPath: 'legacy/a.jpg',
      dir: 'legacy',
      captureAt: '2026-06-01T00:00:00.000Z',
    })
    const raf = await seedImage({
      root: 'raws',
      relPath: 'legacy/a.RAF',
      dir: 'legacy',
      stem: 'a',
      ext: 'raf',
      kind: 'raw',
      captureAt: '2026-05-01T00:00:00.000Z',
    })
    // Bypasses the route's `checkShareImageIds` on purpose: this is the row
    // shape that already exists in a deployed db.
    await setShareImages(id, [raf, jpeg])

    const access = await resolveShareAccess({ slug: 'legacy-raf', token: 'lr' })
    const share = access!.share
    // Listing, by-id membership and the count agree that the RAF is not there —
    // so the public page never asks for a rendition sharp cannot produce.
    expect((await listShareImages(share)).map((r) => r.id)).toEqual([jpeg])
    expect(await getShareImageById(share, raf)).toBeNull()
    expect(await shareImageCount(share)).toBe(1)
    expect((await shareImageSummary(share)).total).toBe(1)
  })
})

describe('listShareImages — rawFileSize', () => {
  // The lightbox's RAW download control needs the RAF's byte size (design
  // §7/§8 follow-up: it used to show only the "can't open on a phone" hint,
  // never the size, even though a RAF is 30-60 MB — the one download where
  // the size matters most). The paired RAF is its own indexed `images` row
  // (root='raws'), so this is a join against an already-indexed column, never
  // a filesystem stat on the page-render path.
  it('joins the paired RAF row by (root, rel_path) and surfaces its indexed fileSize', async () => {
    const id = await seedShare({ slug: 'raw-size', dir: 'raw-size' })
    await seedToken(id, 'rs', { role: 'full' })
    const jpeg = await seedImage({
      root: 'fuji',
      relPath: 'raw-size/a.jpg',
      dir: 'raw-size',
      rawPath: 'raw-size/a.RAF',
    })
    await seedImage({
      root: 'raws',
      relPath: 'raw-size/a.RAF',
      dir: 'raw-size',
      stem: 'a',
      ext: 'raf',
      kind: 'raw',
      fileSize: 42_000_000,
    })

    const access = await resolveShareAccess({ slug: 'raw-size', token: 'rs' })
    const list = await listShareImages(access!.share)
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe(jpeg)
    expect(list[0]!.rawFileSize).toBe(42_000_000)
  })

  it('is null when the image has no paired RAF', async () => {
    const id = await seedShare({ slug: 'no-raw', dir: 'no-raw' })
    await seedToken(id, 'nr')
    await seedImage({ root: 'fuji', relPath: 'no-raw/a.jpg', dir: 'no-raw' })

    const access = await resolveShareAccess({ slug: 'no-raw', token: 'nr' })
    const list = await listShareImages(access!.share)
    expect(list[0]!.rawFileSize).toBeNull()
  })

  it('is null when raw_path names a row the RAWS_ROOT scan never indexed (dangling pointer)', async () => {
    const id = await seedShare({ slug: 'dangling-raw', dir: 'dangling-raw' })
    await seedToken(id, 'dr')
    await seedImage({
      root: 'fuji',
      relPath: 'dangling-raw/a.jpg',
      dir: 'dangling-raw',
      rawPath: 'dangling-raw/missing.RAF',
    })

    const access = await resolveShareAccess({ slug: 'dangling-raw', token: 'dr' })
    const list = await listShareImages(access!.share)
    expect(list[0]!.rawFileSize).toBeNull()
  })
})

// ── The order a friend actually scrolls ──────────────────────────────────────
//
// The Library grid defaults to captureAt/DESC, and a selection share used to
// ship in `share_images.position` — i.e. in the admin's browse order — so the
// recipient scrolled the trip BACKWARDS, and switching the admin sort to Name
// silently re-ordered a friend-facing gallery. The browse sort is a browse
// preference; it is not a property of the share.
describe('all three source types ship the same set in the same order', () => {
  it('folder, album and selection over one set agree, capture-ascending', async () => {
    const seedTrio = async (stem: string, captureAt: string): Promise<number> => {
      const imageId = await seedImage({
        root: 'fuji',
        relPath: `trio/${stem}.JPG`,
        dir: 'trio',
        stem,
        captureAt,
      })
      await db.insert(imageKeywords).values({ imageId, path: 'Trio', leaf: 'Trio' })
      return imageId
    }
    // Ids ascend while capture dates descend, so id order, insertion order and
    // capture order are three different answers — nothing can pass by accident.
    const newest = await seedTrio('DSCF0001', '2026-07-11T09:00:00.000Z')
    const middle = await seedTrio('DSCF0002', '2026-07-07T09:00:00.000Z')
    const oldest = await seedTrio('DSCF0003', '2026-07-04T09:00:00.000Z')
    const captureOrder = [oldest, middle, newest]

    const folderId = await seedShare({ slug: 'trio-folder', dir: 'trio' })
    await seedToken(folderId, 'trio-f')
    const albumId = await seedShare({
      slug: 'trio-album',
      sourceType: 'album',
      dir: null,
      album: 'Trio',
    })
    await seedToken(albumId, 'trio-a')
    const selectionId = await seedShare({
      slug: 'trio-selection',
      sourceType: 'selection',
      root: null,
      dir: null,
    })
    await seedToken(selectionId, 'trio-s')
    // The admin's default browse sort (captureAt/desc) — the exact array the
    // old code turned into `position` and shipped verbatim.
    await setShareImages(selectionId, [newest, middle, oldest])

    const folder = await listOf('trio-folder', 'trio-f')
    const album = await listOf('trio-album', 'trio-a')
    const selection = await listOf('trio-selection', 'trio-s')

    expect(folder).toEqual(captureOrder)
    expect(album).toEqual(captureOrder)
    expect(selection).toEqual(captureOrder)

    // Re-saving in filename order (the admin's other sort) changes nothing.
    await setShareImages(
      selectionId,
      [newest, middle, oldest].toSorted((x, y) => x - y),
    )
    expect(await listOf('trio-selection', 'trio-s')).toEqual(captureOrder)
  })
})

describe('listShareImages — windowing', () => {
  it('returns a stable, non-overlapping window across pages', async () => {
    const id = await seedShare({ slug: 'paged', dir: 'paged' })
    await seedToken(id, 'pg')
    const ids: number[] = []
    for (let i = 0; i < 7; i++) {
      ids.push(
        await seedImage({
          root: 'fuji',
          relPath: `paged/p${i}.jpg`,
          dir: 'paged',
          // Every row shares one capture timestamp: without the `id` tie-break
          // the sort is not total and an OFFSET window could show the same row
          // twice (or skip one) between page 1 and page 2.
          captureAt: '2026-06-01T00:00:00.000Z',
          fileSize: 10,
        }),
      )
    }
    const access = await resolveShareAccess({ slug: 'paged', token: 'pg' })
    const share = access!.share

    const all = (await listShareImages(share)).map((r) => r.id)
    expect(all).toEqual(ids)

    const first = (await listShareImages(share, { limit: 3 })).map((r) => r.id)
    const second = (await listShareImages(share, { limit: 3, offset: 3 })).map((r) => r.id)
    const third = (await listShareImages(share, { limit: 3, offset: 6 })).map((r) => r.id)
    expect(first).toEqual(ids.slice(0, 3))
    expect(second).toEqual(ids.slice(3, 6))
    expect(third).toEqual(ids.slice(6))
    expect([...first, ...second, ...third]).toEqual(all)

    // Past the end is empty, not an error.
    expect(await listShareImages(share, { limit: 3, offset: 99 })).toEqual([])
  })

  it('windows a selection share in the same capture order it lists in', async () => {
    const id = await seedShare({
      slug: 'picks-paged',
      sourceType: 'selection',
      root: null,
      dir: null,
    })
    await seedToken(id, 'pp')
    const a = await seedImage({
      root: 'fuji',
      relPath: 'pp-a.jpg',
      dir: '',
      captureAt: '2026-02-01T00:00:00.000Z',
    })
    const b = await seedImage({
      root: 'fuji',
      relPath: 'pp-b.jpg',
      dir: '',
      captureAt: '2026-02-02T00:00:00.000Z',
    })
    const c = await seedImage({
      root: 'fuji',
      relPath: 'pp-c.jpg',
      dir: '',
      captureAt: '2026-02-03T00:00:00.000Z',
    })
    await setShareImages(id, [c, a, b])

    const access = await resolveShareAccess({ slug: 'picks-paged', token: 'pp' })
    const share = access!.share
    // Windowing must not be able to disagree with the unwindowed list — the
    // progressive-reveal page stitches these windows into one gallery.
    expect((await listShareImages(share, { limit: 2 })).map((r) => r.id)).toEqual([a, b])
    expect((await listShareImages(share, { limit: 2, offset: 2 })).map((r) => r.id)).toEqual([c])
  })
})

describe('shareImageSummary + shareRawPaths', () => {
  it('agrees with listShareImages on count, bounds and byte total', async () => {
    const id = await seedShare({ slug: 'summed', dir: 'summed', minRating: 3 })
    await seedToken(id, 'sm')
    await seedImage({
      root: 'fuji',
      relPath: 'summed/a.jpg',
      dir: 'summed',
      rating: 5,
      fileSize: 1000,
      captureAt: '2026-06-01T00:00:00.000Z',
      rawPath: 'summed/a.RAF',
    })
    await seedImage({
      root: 'fuji',
      relPath: 'summed/b.jpg',
      dir: 'summed',
      rating: 4,
      fileSize: 2500,
      captureAt: '2026-06-09T00:00:00.000Z',
    })
    // Filtered out by minRating — must not reach the count, bounds or bytes.
    await seedImage({
      root: 'fuji',
      relPath: 'summed/c.jpg',
      dir: 'summed',
      rating: 1,
      fileSize: 9_000_000,
      captureAt: '2026-12-31T00:00:00.000Z',
    })

    const access = await resolveShareAccess({ slug: 'summed', token: 'sm' })
    const share = access!.share
    const summary = await shareImageSummary(share)
    expect(summary.total).toBe((await listShareImages(share)).length)
    expect(summary.total).toBe(2)
    expect(summary.firstCaptureAt).toBe('2026-06-01T00:00:00.000Z')
    expect(summary.lastCaptureAt).toBe('2026-06-09T00:00:00.000Z')
    expect(summary.totalFileSize).toBe(3500)
    expect(await shareRawPaths(share)).toEqual(['summed/a.RAF'])
  })

  it('returns a zeroed summary for an empty share rather than NaN/null bytes', async () => {
    const id = await seedShare({ slug: 'nothing', dir: 'nothing-here' })
    await seedToken(id, 'nt')
    const access = await resolveShareAccess({ slug: 'nothing', token: 'nt' })
    const summary = await shareImageSummary(access!.share)
    expect(summary).toEqual({
      total: 0,
      firstCaptureAt: null,
      lastCaptureAt: null,
      totalFileSize: 0,
    })
    expect(await shareRawPaths(access!.share)).toEqual([])
  })

  it('summarises a selection share through the same join listShareImages uses', async () => {
    const id = await seedShare({ slug: 'sel-sum', sourceType: 'selection', root: null, dir: null })
    await seedToken(id, 'ss')
    const a = await seedImage({
      root: 'fuji',
      relPath: 'ss-a.jpg',
      dir: '',
      fileSize: 11,
      captureAt: '2026-01-02T00:00:00.000Z',
      rawPath: 'ss-a.RAF',
    })
    const b = await seedImage({
      root: 'fuji',
      relPath: 'ss-b.jpg',
      dir: '',
      fileSize: 22,
      captureAt: '2026-01-01T00:00:00.000Z',
    })
    await seedImage({ root: 'fuji', relPath: 'ss-c.jpg', dir: '', fileSize: 9999 })
    await setShareImages(id, [a, b])

    const access = await resolveShareAccess({ slug: 'sel-sum', token: 'ss' })
    const share = access!.share
    const summary = await shareImageSummary(share)
    expect(summary.total).toBe(2)
    expect(summary.totalFileSize).toBe(33)
    expect(summary.firstCaptureAt).toBe('2026-01-01T00:00:00.000Z')
    expect(await shareRawPaths(share)).toEqual(['ss-a.RAF'])
  })
})

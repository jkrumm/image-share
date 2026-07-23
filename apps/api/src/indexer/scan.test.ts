import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import sharp from 'sharp'
import { exiftool } from 'exiftool-vendored'
import { createDb, runMigrations, type Db } from '../db/index.js'
import { b2Objects, images } from '../db/schema.js'
import { endExiftool, parseFilenameDate } from './metadata.js'
import * as metadataModule from './metadata.js'
import { getIndexStatus, indexSinglePath, runScan, setScanDb, setScanRoots } from './scan.js'

// Fully isolated from real photo trees and from every other test file's DB
// (design §13): a fresh temp dir tree + an in-memory drizzle db, injected via
// setScanDb/setScanRoots rather than mutating process.env. env.ts parses
// process.env exactly once at import time — module-load ordering across a
// multi-file `bun test` run isn't deterministic enough for env-var overrides
// to reliably win, so scan.ts exposes these setters instead (mirrors
// lib/share-auth.ts's setShareDb / lib/s3.ts's setS3).
const testRoot = mkdtempSync(join(tmpdir(), 'image-share-indexer-'))
const fujiRoot = join(testRoot, 'fuji')
const rawsRoot = join(testRoot, 'raws')
const shareDir = join(testRoot, 'share')

let testDb: Db

beforeAll(async () => {
  const created = createDb(':memory:')
  testDb = created.db
  runMigrations(testDb)
  setScanDb(testDb)
  setScanRoots({
    fuji: fujiRoot,
    raws: rawsRoot,
    share: shareDir,
  })

  await mkdir(fujiRoot, { recursive: true })
  await mkdir(rawsRoot, { recursive: true })
  await mkdir(shareDir, { recursive: true })
})

afterAll(async () => {
  setScanRoots(null)
  await endExiftool()
  rmSync(testRoot, { recursive: true, force: true })
})

// ── Fixture helpers ─────────────────────────────────────────────────────────

async function writeJpegFixture(
  absPath: string,
  opts: { rating?: number; captureAt?: string; orientation?: number } = {},
): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true })
  await sharp({
    create: { width: 60, height: 40, channels: 3, background: { r: 180, g: 90, b: 40 } },
  })
    .jpeg()
    .withMetadata({ orientation: opts.orientation ?? 1 })
    .toFile(absPath)

  if (opts.rating !== undefined || opts.captureAt !== undefined) {
    const tags: Record<string, unknown> = {}
    if (opts.rating !== undefined) tags['Rating'] = opts.rating
    if (opts.captureAt !== undefined) tags['DateTimeOriginal'] = opts.captureAt
    await exiftool.write(absPath, tags, { writeArgs: ['-overwrite_original'] })
  }
}

/** A RAF fixture is just bytes with a `.RAF` extension — exiftool tolerates
 * unparseable content (returns generic file tags, no error), which is all the
 * pairing + sidecar-rating tests need. */
async function writeRafFixture(absPath: string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true })
  await writeFile(absPath, `not a real raf: ${absPath}`)
}

async function writeXmpSidecar(absPath: string, rating: number): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true })
  await exiftool.write(absPath, { Rating: rating }, { writeArgs: ['-overwrite_original'] })
}

async function rowFor(root: string, relPath: string) {
  const rows = await testDb
    .select()
    .from(images)
    .where(and(eq(images.root, root), eq(images.relPath, relPath)))
  return rows[0] ?? null
}

describe('indexer scan', () => {
  it('indexes a tree: JPEG (rated, dated) + paired RAF + share upload', async () => {
    await writeJpegFixture(join(fujiRoot, 'mallorca-2026/DSCF0001.JPG'), {
      rating: 4,
      captureAt: '2026:03:15 10:20:30',
      orientation: 6,
    })
    await writeRafFixture(join(rawsRoot, 'DSCF0001.RAF'))
    await writeJpegFixture(join(shareDir, '2026/07/upload.jpg'))

    const counts = await runScan()

    expect(counts.added).toBe(3) // fuji jpeg + raf + share upload
    expect(counts.updated).toBe(0)
    expect(counts.removed).toBe(0)
    expect(counts.scanned).toBe(3)

    const jpegRow = await rowFor('fuji', 'mallorca-2026/DSCF0001.JPG')
    expect(jpegRow).not.toBeNull()
    expect(jpegRow?.dir).toBe('mallorca-2026')
    expect(jpegRow?.stem).toBe('DSCF0001')
    expect(jpegRow?.ext).toBe('jpg')
    expect(jpegRow?.kind).toBe('jpeg')
    expect(jpegRow?.rating).toBe(4)
    expect(jpegRow?.orientation).toBe(6)
    expect(jpegRow?.width).toBe(60)
    expect(jpegRow?.height).toBe(40)
    // exifr treats the naive EXIF datetime as local wall-clock time, so the
    // expected ISO string is computed the same way (TZ-agnostic assertion).
    expect(jpegRow?.captureAt).toBe(new Date(2026, 2, 15, 10, 20, 30).toISOString())
    // RAW pairing (design §5): fuji jpeg stem matches a raws row stem.
    expect(jpegRow?.rawPath).toBe('DSCF0001.RAF')

    const rawRow = await rowFor('raws', 'DSCF0001.RAF')
    expect(rawRow).not.toBeNull()
    expect(rawRow?.kind).toBe('raw')
    expect(rawRow?.ext).toBe('raf')

    const uploadRow = await rowFor('share', '2026/07/upload.jpg')
    expect(uploadRow).not.toBeNull()

    const finalStatus = getIndexStatus()
    expect(finalStatus.running).toBe(false)
    expect(finalStatus.lastError).toBeNull()
    expect(finalStatus.lastCounts).toEqual(counts)
  })

  it('re-indexing unchanged files does not re-read metadata', async () => {
    const spy = spyOn(metadataModule, 'extractMetadata')
    spy.mockClear()

    const counts = await runScan()

    expect(counts.added).toBe(0)
    expect(counts.updated).toBe(0)
    expect(counts.removed).toBe(0)
    expect(spy).toHaveBeenCalledTimes(0)

    spy.mockRestore()
  })

  it('a newer sidecar triggers a rating update via a targeted rescan', async () => {
    const sidecarPath = join(rawsRoot, 'DSCF0002.xmp')
    await writeRafFixture(join(rawsRoot, 'DSCF0002.RAF'))
    await writeXmpSidecar(sidecarPath, 2)

    let counts = await runScan()
    expect(counts.added).toBe(1)

    let row = await rowFor('raws', 'DSCF0002.RAF')
    expect(row?.rating).toBe(2)
    const firstIndexedAtMs = new Date(row?.indexedAt as string).getTime()

    // Mutate the sidecar rating and force its mtime strictly after the
    // previous indexedAt so the "newer sidecar" staleness check (design §5)
    // fires regardless of filesystem mtime resolution.
    await writeXmpSidecar(sidecarPath, 5)
    const future = new Date(firstIndexedAtMs + 5000)
    await utimes(sidecarPath, future, future)

    counts = await runScan()
    expect(counts.updated).toBe(1)
    expect(counts.added).toBe(0)

    row = await rowFor('raws', 'DSCF0002.RAF')
    expect(row?.rating).toBe(5)
  })

  it('recognizes the X.RAF.xmp sidecar naming convention too', async () => {
    await writeRafFixture(join(rawsRoot, 'DSCF0003.RAF'))
    await writeXmpSidecar(join(rawsRoot, 'DSCF0003.RAF.xmp'), 3)

    await runScan()

    const row = await rowFor('raws', 'DSCF0003.RAF')
    expect(row?.rating).toBe(3)
  })

  it('removes rows for vanished files and clears stale RAW pairing', async () => {
    // DSCF0001.RAF pairs with the library jpeg indexed in the first test.
    await rm(join(rawsRoot, 'DSCF0001.RAF'))

    const counts = await runScan()
    expect(counts.removed).toBe(1)

    const rawRow = await rowFor('raws', 'DSCF0001.RAF')
    expect(rawRow).toBeNull()

    const jpegRow = await rowFor('fuji', 'mallorca-2026/DSCF0001.JPG')
    expect(jpegRow?.rawPath).toBeNull()
  })

  it('prunes a vanished published image without aborting the scan (FK detach)', async () => {
    // Publish an image: index it, then reference it from b2_objects like
    // POST /api/publish does. b2_objects.published_image_id is an FK to images.id
    // with ON DELETE NO ACTION and foreign_keys=ON — deleting the still-referenced
    // image would throw 'FOREIGN KEY constraint failed' and abort the whole scan.
    const rel = 'published/DSCF9000.JPG'
    const abs = join(fujiRoot, rel)
    await writeJpegFixture(abs)
    await runScan()
    const published = await rowFor('fuji', rel)
    expect(published).not.toBeNull()

    await testDb.insert(b2Objects).values({
      key: 'img/fuji/DSCF9000.jpg',
      size: 123,
      lastModified: '2026-07-01T00:00:00.000Z',
      publishedImageId: published!.id,
      firstSeenAt: '2026-07-01T00:00:00.000Z',
    })

    // The file is moved/renamed while organizing photos → its rel_path vanishes.
    await rm(abs)

    // Must NOT throw, must prune the image, and must complete (lastError null).
    const counts = await runScan()
    expect(counts.removed).toBeGreaterThanOrEqual(1)
    expect(getIndexStatus().lastError).toBeNull()
    expect(await rowFor('fuji', rel)).toBeNull()

    // The mirror row survives as an out-of-band object with the link nulled.
    const b2Row = await testDb
      .select()
      .from(b2Objects)
      .where(eq(b2Objects.key, 'img/fuji/DSCF9000.jpg'))
    expect(b2Row[0]).toBeDefined()
    expect(b2Row[0]?.publishedImageId).toBeNull()
  })

  it('purges rows from a retired root (pre-rework library) and nulls their b2 link', async () => {
    // Simulate the state a root rename leaves behind: rows written under a root
    // no scanRoot pass visits. scanRoot only prunes within fuji/raws/share, so
    // without pruneRetiredRoots these would survive forever and their invalid
    // `root` would break response-schema validation on the library reads.
    const staleRow = {
      root: 'library',
      relPath: 'legacy/OLD0001.JPG',
      dir: 'legacy',
      stem: 'OLD0001',
      ext: 'jpg',
      kind: 'jpeg',
      fileSize: 10,
      mtimeMs: 1,
      captureAt: null,
      orientation: null,
      rating: null,
      width: null,
      height: null,
      rawPath: null,
      indexedAt: '2026-01-01T00:00:00.000Z',
    }
    const [inserted] = await testDb
      .insert(images)
      .values(staleRow as unknown as typeof images.$inferInsert)
      .returning({ id: images.id })
    await testDb.insert(b2Objects).values({
      key: 'img/misc/legacy-old0001.jpg',
      size: 1,
      lastModified: '2026-01-01T00:00:00.000Z',
      publishedImageId: inserted!.id,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
    })

    const counts = await runScan()
    expect(counts.removed).toBeGreaterThanOrEqual(1)
    expect(getIndexStatus().lastError).toBeNull()

    // The orphaned row is gone...
    const remaining = await testDb.select().from(images).where(eq(images.id, inserted!.id))
    expect(remaining[0]).toBeUndefined()
    // ...and its b2 mirror survives as an out-of-band object, link nulled.
    const b2Row = await testDb
      .select()
      .from(b2Objects)
      .where(eq(b2Objects.key, 'img/misc/legacy-old0001.jpg'))
    expect(b2Row[0]).toBeDefined()
    expect(b2Row[0]?.publishedImageId).toBeNull()
  })

  it('falls back to the filename date pattern when no EXIF/XMP capture date exists', async () => {
    const name = '2025-11-02_08-15-00_hike.jpg'
    await writeJpegFixture(join(fujiRoot, name)) // no captureAt/rating

    await runScan()

    const row = await rowFor('fuji', name)
    expect(row?.captureAt).toBe(parseFilenameDate(name))
  })
})

describe('indexSinglePath', () => {
  it('indexes an uploaded file and returns its id; re-indexing upserts the same row', async () => {
    const relPath = '2026/07/ingested.jpg'
    await writeJpegFixture(join(shareDir, relPath), { rating: 5 })

    const id = await indexSinglePath({ root: 'share', relPath })
    expect(typeof id).toBe('number')

    let row = await rowFor('share', relPath)
    expect(row?.id).toBe(id)
    expect(row?.rating).toBe(5)
    expect(row?.dir).toBe('2026/07')

    // Re-uploading the same relPath (e.g. a re-ingest) upserts rather than
    // duplicating the (root, rel_path) unique row.
    await writeJpegFixture(join(shareDir, relPath), { rating: 1 })
    const secondId = await indexSinglePath({ root: 'share', relPath })
    expect(secondId).toBe(id)

    row = await rowFor('share', relPath)
    expect(row?.rating).toBe(1)
  })

  it('rejects a relPath that escapes SHARE_ROOT', async () => {
    await expect(indexSinglePath({ root: 'share', relPath: '../../etc/passwd' })).rejects.toThrow()
  })
})

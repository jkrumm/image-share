import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ImageRow, ShareRow } from '../db/schema.js'
import { rootBaseDir } from '../lib/paths.js'
import { attachment } from './attachment.js'
import { buildShareZip, estimateShareZipBytes } from './zip.js'

// Unique temp subtree under the real (dev-default) roots so buildShareZip's
// env-based path resolution finds the fixtures. Never touches real photo trees.
const SUB = `ziptest-${process.pid}-${Date.now()}`
const fujiBase = rootBaseDir('fuji')
const rawsBase = rootBaseDir('raws')

function shareOf(over: Partial<ShareRow> = {}): ShareRow {
  return {
    id: 1,
    slug: 'trip',
    title: 'Trip',
    sourceType: 'folder',
    root: 'fuji',
    dir: SUB,
    album: null,
    recursive: true,
    minRating: null,
    expiresAt: null,
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function imageOf(over: Partial<ImageRow> = {}): ImageRow {
  return {
    id: 10,
    root: 'fuji',
    relPath: `${SUB}/DSCF0001.JPG`,
    dir: SUB,
    stem: 'DSCF0001',
    ext: 'jpg',
    kind: 'jpeg',
    fileSize: 0,
    mtimeMs: 1,
    captureAt: '2026-06-01T00:00:00.000Z',
    orientation: 1,
    rating: 5,
    width: 4000,
    height: 3000,
    rawPath: null,
    indexedAt: '2026-06-02T00:00:00.000Z',
    keywordsIndexedAt: '2026-06-02T00:00:00.000Z',
    ...over,
  }
}

beforeAll(() => {
  mkdirSync(join(fujiBase, SUB), { recursive: true })
  mkdirSync(join(rawsBase, SUB), { recursive: true })
  // Non-trivial JPEG-ish payloads (content is irrelevant to the zip container).
  writeFileSync(join(fujiBase, SUB, 'DSCF0001.JPG'), Buffer.alloc(2048, 0x11))
  writeFileSync(join(fujiBase, SUB, 'DSCF0002.JPG'), Buffer.alloc(3072, 0x22))
  writeFileSync(join(rawsBase, SUB, 'DSCF0001.RAF'), Buffer.alloc(4096, 0x33))
})

afterAll(() => {
  rmSync(join(fujiBase, SUB), { recursive: true, force: true })
  rmSync(join(rawsBase, SUB), { recursive: true, force: true })
})

async function bytesOf(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer())
}

/** Latin1 view so ASCII filenames stored in zip headers are searchable. */
function asLatin1(buf: Uint8Array): string {
  let s = ''
  for (const b of buf) s += String.fromCharCode(b)
  return s
}

describe('buildShareZip (download/full roles)', () => {
  it('streams a valid non-trivial zip with a local-file-header signature', async () => {
    const share = shareOf()
    const images = [
      imageOf({ id: 10 }),
      imageOf({ id: 11, relPath: `${SUB}/DSCF0002.JPG`, stem: 'DSCF0002' }),
    ]
    const res = await buildShareZip({ share, images, role: 'download' })
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toContain('trip.zip')
    // Content-Length is predicted up front (files on disk, sizes known).
    expect(Number(res.headers.get('content-length'))).toBeGreaterThan(0)

    const buf = await bytesOf(res)
    // PK\x03\x04 local file header.
    expect([buf[0], buf[1], buf[2], buf[3]]).toEqual([0x50, 0x4b, 0x03, 0x04])
    // Larger than the two payloads → real container overhead present.
    expect(buf.length).toBeGreaterThan(2048 + 3072)
    // Both entry names (relative to the share dir) appear in the archive.
    const text = asLatin1(buf)
    expect(text).toContain('DSCF0001.JPG')
    expect(text).toContain('DSCF0002.JPG')
    // The predicted Content-Length matches the produced byte length.
    expect(buf.length).toBe(Number(res.headers.get('content-length')))
  })

  it('includes the paired RAF only for a full-role token', async () => {
    const image = imageOf({ id: 10, rawPath: `${SUB}/DSCF0001.RAF` })

    const withoutRaw = await bytesOf(
      await buildShareZip({ share: shareOf(), images: [image], role: 'download' }),
    )
    expect(asLatin1(withoutRaw)).not.toContain('DSCF0001.RAF')

    const withRaw = await bytesOf(
      await buildShareZip({ share: shareOf(), images: [image], role: 'full' }),
    )
    expect(asLatin1(withRaw)).toContain('DSCF0001.RAF')
    expect(withRaw.length).toBeGreaterThan(withoutRaw.length)
  })

  it('skips a file that is indexed but missing on disk, keeping the rest', async () => {
    // The visitor-facing failure must stay "the other photos still download",
    // never an error page — a single stale row would otherwise kill the share.
    const images = [
      imageOf({ id: 10 }),
      imageOf({ id: 12, relPath: `${SUB}/GONE.JPG`, stem: 'GONE' }),
      imageOf({ id: 11, relPath: `${SUB}/DSCF0002.JPG`, stem: 'DSCF0002' }),
    ]
    const res = await buildShareZip({ share: shareOf(), images, role: 'download' })
    expect(res.status).toBe(200)
    const text = asLatin1(await bytesOf(res))
    expect(text).toContain('DSCF0001.JPG')
    expect(text).toContain('DSCF0002.JPG')
    expect(text).not.toContain('GONE.JPG')
  })

  it('escapes the slug in Content-Disposition via the shared RFC 5987 helper', async () => {
    const res = await buildShareZip({
      share: shareOf({ slug: 'sömmer "24"' }),
      images: [imageOf()],
      role: 'download',
    })
    const cd = res.headers.get('content-disposition') ?? ''
    // The quoted-string fallback must not be terminable by the slug itself.
    expect(cd).toBe(attachment('sömmer "24".zip'))
    expect(cd).toContain('filename="s_mmer _24_.zip"')
    expect(cd).toContain("filename*=UTF-8''s%C3%B6mmer%20%2224%22.zip")
  })

  it('produces a byte length equal to the predicted content-length for a full-role zip', async () => {
    const image = imageOf({ id: 10, rawPath: `${SUB}/DSCF0001.RAF` })
    const res = await buildShareZip({ share: shareOf(), images: [image], role: 'full' })
    const buf = await bytesOf(res)
    expect(buf.length).toBe(Number(res.headers.get('content-length')))
  })
})

describe('estimateShareZipBytes', () => {
  it('uses the indexed file-size sum for a download-role share (no syscalls)', async () => {
    const bytes = await estimateShareZipBytes({
      totalFileSize: 1_900_000_000,
      role: 'download',
      // Ignored for a download role — RAFs are not in that archive.
      rawPaths: [`${SUB}/DSCF0001.RAF`],
    })
    expect(bytes).toBe(1_900_000_000)
  })

  it('adds the on-disk RAF sizes for a full-role share', async () => {
    const bytes = await estimateShareZipBytes({
      totalFileSize: 2048,
      role: 'full',
      rawPaths: [`${SUB}/DSCF0001.RAF`],
    })
    expect(bytes).toBe(2048 + 4096)
  })

  it('ignores a missing RAF rather than throwing', async () => {
    const bytes = await estimateShareZipBytes({
      totalFileSize: 2048,
      role: 'full',
      rawPaths: [`${SUB}/DSCF0001.RAF`, `${SUB}/NOPE.RAF`],
    })
    expect(bytes).toBe(2048 + 4096)
  })
})

describe('attachment', () => {
  it('sanitizes the ASCII fallback and percent-encodes the UTF-8 variant', () => {
    expect(attachment('a/b/DSCF "1".JPG')).toBe(
      `attachment; filename="DSCF _1_.JPG"; filename*=UTF-8''DSCF%20%221%22.JPG`,
    )
  })

  it('strips a directory component and any newline injection attempt', () => {
    const value = attachment('x/\r\nX-Evil: 1\r\n.jpg')
    expect(value).not.toContain('\r')
    expect(value).not.toContain('\n')
  })
})

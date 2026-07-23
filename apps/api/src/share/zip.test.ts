import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ImageRow, ShareRow } from '../db/schema.js'
import { rootBaseDir } from '../lib/paths.js'
import { buildShareZip } from './zip.js'

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
    const res = buildShareZip({ share, images, role: 'download' })
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
      buildShareZip({ share: shareOf(), images: [image], role: 'download' }),
    )
    expect(asLatin1(withoutRaw)).not.toContain('DSCF0001.RAF')

    const withRaw = await bytesOf(
      buildShareZip({ share: shareOf(), images: [image], role: 'full' }),
    )
    expect(asLatin1(withRaw)).toContain('DSCF0001.RAF')
    expect(withRaw.length).toBeGreaterThan(withoutRaw.length)
  })
})

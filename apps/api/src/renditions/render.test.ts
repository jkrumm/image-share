import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, stat, unlink, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { env } from '../env.js'
import { renderRendition } from './render.js'

// Isolate this whole file behind a throwaway DATA_DIR + a throwaway source-file
// dir so rendered cache files never collide with, or get swept by, any other
// test file (design §13 — tests never touch real trees).
const originalDataDir = env.DATA_DIR

let dataDir: string
let sourceDir: string

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'image-share-render-test-data-'))
  sourceDir = await mkdtemp(join(tmpdir(), 'image-share-render-test-src-'))
  env.DATA_DIR = dataDir
})

afterAll(async () => {
  env.DATA_DIR = originalDataDir
  await rm(dataDir, { recursive: true, force: true })
  await rm(sourceDir, { recursive: true, force: true })
})

let fixtureCounter = 0
function nextRelPath(name: string): string {
  fixtureCounter += 1
  return `fixture-${fixtureCounter}/${name}`
}

/** Writes a flat-color JPEG fixture, optionally tagging an EXIF orientation
 * without physically rotating the raw pixel data (sharp `withMetadata`). */
async function makeFixture(opts: {
  width: number
  height: number
  orientation?: number
}): Promise<string> {
  const path = join(sourceDir, `${crypto.randomUUID()}.jpg`)
  let pipeline = sharp({
    create: {
      width: opts.width,
      height: opts.height,
      channels: 3,
      background: { r: 200, g: 120, b: 40 },
    },
  }).jpeg()
  if (opts.orientation !== undefined) {
    pipeline = pipeline.withMetadata({ orientation: opts.orientation })
  }
  await pipeline.toFile(path)
  return path
}

describe('renderRendition', () => {
  it('rejects RAF inputs at this layer', async () => {
    await expect(
      renderRendition({
        absPath: '/photos/raws/DSCF0001.RAF',
        size: 'thumb',
        root: 'raws',
        relPath: nextRelPath('DSCF0001.RAF'),
        mtimeMs: 1,
        fileSize: 1,
      }),
    ).rejects.toThrow(/RAF/)
  })

  it('produces an upright rendition for a source tagged with EXIF orientation 6', async () => {
    // Raw pixel data is landscape (200x100); orientation=6 ("rotate 90 CW to
    // display correctly") means the true displayed image is portrait
    // (100x200). autoOrient() must apply that rotation before resizing.
    const absPath = await makeFixture({ width: 200, height: 100, orientation: 6 })
    const relPath = nextRelPath('rotated.jpg')

    const result = await renderRendition({
      absPath,
      size: 'thumb',
      root: 'fuji',
      relPath,
      mtimeMs: 1,
      fileSize: 1,
    })

    expect(result.contentType).toBe('image/webp')
    const meta = await sharp(result.path).metadata()
    expect(meta.height).toBeGreaterThan(meta.width ?? 0)
  })

  it('does not swap dimensions for a source with no orientation tag', async () => {
    const absPath = await makeFixture({ width: 200, height: 100 })
    const result = await renderRendition({
      absPath,
      size: 'thumb',
      root: 'fuji',
      relPath: nextRelPath('landscape.jpg'),
      mtimeMs: 1,
      fileSize: 1,
    })
    const meta = await sharp(result.path).metadata()
    expect((meta.width ?? 0) > (meta.height ?? 0)).toBe(true)
  })

  it('serves size-specific content types and stays within the fit:inside bound', async () => {
    const absPath = await makeFixture({ width: 4000, height: 2000 })
    const relPath = nextRelPath('full-size.jpg')
    const mtimeMs = 1
    const fileSize = 1

    const full = await renderRendition({
      absPath,
      size: 'full',
      root: 'fuji',
      relPath,
      mtimeMs,
      fileSize,
    })
    expect(full.contentType).toBe('image/jpeg')
    const fullMeta = await sharp(full.path).metadata()
    expect(fullMeta.width).toBeLessThanOrEqual(2560)
    expect(fullMeta.height).toBeLessThanOrEqual(2560)

    const med = await renderRendition({
      absPath,
      size: 'med',
      root: 'fuji',
      relPath,
      mtimeMs,
      fileSize,
    })
    expect(med.contentType).toBe('image/webp')
    const medMeta = await sharp(med.path).metadata()
    expect(medMeta.width).toBeLessThanOrEqual(1600)
  })

  it('does not re-render on a cache hit (source removed after first render still resolves)', async () => {
    const absPath = await makeFixture({ width: 300, height: 200 })
    const identity = {
      root: 'fuji',
      relPath: nextRelPath('hit.jpg'),
      mtimeMs: 42,
      fileSize: 999,
    }

    const first = await renderRendition({ absPath, size: 'thumb', ...identity })
    expect(await Bun.file(first.path).exists()).toBe(true)

    // Backdate the cache file so a real touch is observable, then delete the
    // source. If the second call tried to re-render, sharp would fail reading
    // the now-missing source and the promise would reject.
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    await utimes(first.path, old, old)
    await unlink(absPath)

    const second = await renderRendition({ absPath, size: 'thumb', ...identity })
    expect(second.path).toBe(first.path)

    const info = await stat(first.path)
    expect(info.mtimeMs).toBeGreaterThan(Date.now() - 5000) // LRU-touched on hit
  })

  it('dedupes concurrent duplicate calls into a single in-flight render', async () => {
    const absPath = await makeFixture({ width: 300, height: 200 })
    const identity = {
      root: 'fuji',
      relPath: nextRelPath('concurrent.jpg'),
      mtimeMs: 7,
      fileSize: 123,
    }

    const p1 = renderRendition({ absPath, size: 'med', ...identity })
    const p2 = renderRendition({ absPath, size: 'med', ...identity })

    // Single-flight guarantees both callers receive the exact same in-flight
    // promise for an identical cache key — proof it renders (at most) once.
    expect(p1).toBe(p2)

    const [a, b] = await Promise.all([p1, p2])
    expect(a.path).toBe(b.path)
    expect(await Bun.file(a.path).exists()).toBe(true)
  })
})

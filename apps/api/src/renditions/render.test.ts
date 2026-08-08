import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, stat, unlink, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { env } from '../env.js'
import { renderRendition, renditionSlotStats, withRenditionSlot } from './render.js'

// Isolate this whole file behind a throwaway DATA_DIR + a throwaway source-file
// dir so rendered cache files never collide with, or get swept by, any other
// test file (design §13 — tests never touch real trees).
const originalDataDir = env.DATA_DIR
const originalConcurrency = env.RENDITION_CONCURRENCY

let dataDir: string
let sourceDir: string

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'image-share-render-test-data-'))
  sourceDir = await mkdtemp(join(tmpdir(), 'image-share-render-test-src-'))
  env.DATA_DIR = dataDir
})

afterAll(async () => {
  env.DATA_DIR = originalDataDir
  env.RENDITION_CONCURRENCY = originalConcurrency
  await rm(dataDir, { recursive: true, force: true })
  await rm(sourceDir, { recursive: true, force: true })
})

/** Yields to the macrotask queue so gated tasks can actually enter the gate. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1))
}

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

  it("renders the 'small' tier at 900px webp", async () => {
    const absPath = await makeFixture({ width: 4000, height: 2000 })

    const small = await renderRendition({
      absPath,
      size: 'small',
      root: 'fuji',
      relPath: nextRelPath('small.jpg'),
      mtimeMs: 1,
      fileSize: 1,
    })

    expect(small.contentType).toBe('image/webp')
    expect(small.path.endsWith('.webp')).toBe(true)
    const meta = await sharp(small.path).metadata()
    expect(meta.width).toBe(900) // 4000x2000 fit:inside 900 → exactly 900 wide
    expect(meta.height).toBe(450)
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

describe('rendition concurrency gate', () => {
  it('never runs more than RENDITION_CONCURRENCY tasks at once under a burst', async () => {
    env.RENDITION_CONCURRENCY = 3

    let running = 0
    let observedMax = 0
    const gates: Array<() => void> = []

    const tasks = Array.from({ length: 12 }, () =>
      withRenditionSlot(async () => {
        running += 1
        observedMax = Math.max(observedMax, running)
        await new Promise<void>((resolve) => gates.push(resolve))
        running -= 1
      }),
    )

    // Release one task at a time: every release immediately hands the permit to
    // a queued waiter, which is exactly when an off-by-one gate would let a 4th
    // task in.
    let released = 0
    while (released < tasks.length) {
      await tick()
      const gate = gates.shift()
      if (gate) {
        gate()
        released += 1
      }
    }

    await Promise.all(tasks)
    expect(observedMax).toBe(3)
    expect(renditionSlotStats()).toMatchObject({ inUse: 0, queued: 0 })
  })

  it('releases a permit when the gated work throws, and to a queued waiter', async () => {
    env.RENDITION_CONCURRENCY = 1

    let secondRan = false
    const failing = withRenditionSlot(async () => {
      await tick()
      throw new Error('boom')
    })
    const queued = withRenditionSlot(async () => {
      secondRan = true
    })

    await expect(failing).rejects.toThrow('boom')
    await queued

    expect(secondRan).toBe(true)
    expect(renditionSlotStats()).toMatchObject({ inUse: 0, queued: 0 })
  })

  it('a failing render leaks no permit — the next render still succeeds', async () => {
    env.RENDITION_CONCURRENCY = 1
    const before = renditionSlotStats().acquired

    await expect(
      renderRendition({
        absPath: join(sourceDir, 'does-not-exist.jpg'),
        size: 'thumb',
        root: 'fuji',
        relPath: nextRelPath('missing.jpg'),
        mtimeMs: 1,
        fileSize: 1,
      }),
    ).rejects.toThrow()
    expect(renditionSlotStats()).toMatchObject({ inUse: 0, queued: 0 })

    const absPath = await makeFixture({ width: 600, height: 400 })
    const ok = await renderRendition({
      absPath,
      size: 'thumb',
      root: 'fuji',
      relPath: nextRelPath('after-failure.jpg'),
      mtimeMs: 1,
      fileSize: 1,
    })

    expect(await Bun.file(ok.path).exists()).toBe(true)
    expect(renditionSlotStats().acquired - before).toBe(2) // one per render attempt
  })

  it('a duplicate key under a saturated gate joins the in-flight render without a second permit', async () => {
    env.RENDITION_CONCURRENCY = 1

    const absPath = await makeFixture({ width: 800, height: 600 })
    const dupIdentity = {
      root: 'fuji',
      relPath: nextRelPath('gated-dup.jpg'),
      mtimeMs: 5,
      fileSize: 55,
    }
    const otherIdentity = {
      root: 'fuji',
      relPath: nextRelPath('gated-other.jpg'),
      mtimeMs: 5,
      fileSize: 55,
    }

    const before = renditionSlotStats().acquired

    const first = renderRendition({ absPath, size: 'med', ...dupIdentity })
    const duplicate = renderRendition({ absPath, size: 'med', ...dupIdentity })
    const other = renderRendition({ absPath, size: 'med', ...otherIdentity })

    expect(first).toBe(duplicate) // same in-flight promise, not a second render

    const [a, b, c] = await Promise.all([first, duplicate, other])
    expect(a.path).toBe(b.path)
    expect(c.path).not.toBe(a.path)

    // Three calls, two distinct keys → exactly two permits taken.
    expect(renditionSlotStats().acquired - before).toBe(2)
    expect(renditionSlotStats()).toMatchObject({ inUse: 0, queued: 0 })
  })

  it('bounds real renditions across a burst of distinct keys', async () => {
    env.RENDITION_CONCURRENCY = 2

    const sources = await Promise.all(
      Array.from({ length: 8 }, () => makeFixture({ width: 1200, height: 900 })),
    )

    let observedMax = 0
    const sampler = setInterval(() => {
      observedMax = Math.max(observedMax, renditionSlotStats().inUse)
    }, 1)

    try {
      const results = await Promise.all(
        sources.map((absPath) =>
          renderRendition({
            absPath,
            size: 'small',
            root: 'fuji',
            relPath: nextRelPath('burst.jpg'),
            mtimeMs: 3,
            fileSize: 33,
          }),
        ),
      )
      expect(results).toHaveLength(8)
      for (const result of results) {
        expect(await Bun.file(result.path).exists()).toBe(true)
      }
    } finally {
      clearInterval(sampler)
    }

    expect(observedMax).toBeGreaterThan(0) // the gate was actually exercised
    expect(observedMax).toBeLessThanOrEqual(2)
    expect(renditionSlotStats()).toMatchObject({ inUse: 0, queued: 0 })
  })
})

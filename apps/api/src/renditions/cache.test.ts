import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { env } from '../env.js'
import {
  renditionCacheKey,
  renditionCachePath,
  renditionExt,
  sweepRenditionCache,
  touchCache,
} from './cache.js'

// Isolate every test in this file behind a throwaway DATA_DIR so sweep
// assertions never see files left over by other test files that also render
// (or will render) into the shared rendition cache (design §6, §13).
const originalDataDir = env.DATA_DIR
const originalMaxAgeDays = env.RENDITION_MAX_AGE_DAYS
const originalMaxGb = env.RENDITION_CACHE_MAX_GB

let dataDir: string
let renditionsDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'image-share-cache-test-'))
  renditionsDir = join(dataDir, 'renditions')
  env.DATA_DIR = dataDir
})

afterEach(async () => {
  env.DATA_DIR = originalDataDir
  env.RENDITION_MAX_AGE_DAYS = originalMaxAgeDays
  env.RENDITION_CACHE_MAX_GB = originalMaxGb
  await rm(dataDir, { recursive: true, force: true })
})

describe('renditionCacheKey', () => {
  it('is deterministic for identical identity parts', () => {
    const parts = {
      root: 'fuji',
      relPath: 'a/b.jpg',
      mtimeMs: 123,
      fileSize: 456,
      size: 'thumb',
    } as const
    expect(renditionCacheKey(parts)).toBe(renditionCacheKey(parts))
  })

  it('changes when any identity part changes', () => {
    const base = {
      root: 'fuji',
      relPath: 'a/b.jpg',
      mtimeMs: 123,
      fileSize: 456,
      size: 'thumb',
    } as const
    const key = renditionCacheKey(base)
    expect(renditionCacheKey({ ...base, mtimeMs: 124 })).not.toBe(key)
    expect(renditionCacheKey({ ...base, size: 'med' })).not.toBe(key)
    expect(renditionCacheKey({ ...base, relPath: 'a/c.jpg' })).not.toBe(key)
  })

  it('yields a distinct key per size tier for one source (no cross-tier collisions)', () => {
    const source = {
      root: 'fuji',
      relPath: '2025-04-14_14-20-54_DSCF0430.JPG',
      mtimeMs: 1_700_000_000_000,
      fileSize: 12_345_678,
    } as const
    const sizes = ['thumb', 'small', 'med', 'full'] as const
    const keys = sizes.map((size) => renditionCacheKey({ ...source, size }))
    expect(new Set(keys).size).toBe(sizes.length)
  })
})

describe('renditionCachePath / renditionExt', () => {
  it('places thumb/small/med under webp and full under jpg, inside DATA_DIR/renditions', () => {
    const key = 'deadbeef'
    expect(renditionExt('thumb')).toBe('webp')
    expect(renditionExt('small')).toBe('webp')
    expect(renditionExt('med')).toBe('webp')
    expect(renditionExt('full')).toBe('jpg')
    expect(renditionCachePath(key, 'thumb')).toBe(join(dataDir, 'renditions', `${key}.webp`))
    expect(renditionCachePath(key, 'small')).toBe(join(dataDir, 'renditions', `${key}.webp`))
    expect(renditionCachePath(key, 'full')).toBe(join(dataDir, 'renditions', `${key}.jpg`))
  })
})

describe('touchCache', () => {
  it('bumps mtime to now', async () => {
    await mkdir(renditionsDir, { recursive: true })
    const path = join(renditionsDir, 'x.webp')
    await writeFile(path, 'bytes')
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) // 10 days ago
    await utimes(path, old, old)

    const before = await stat(path)
    expect(before.mtimeMs).toBeLessThan(Date.now() - 1000)

    await touchCache(path)

    const after = await stat(path)
    expect(after.mtimeMs).toBeGreaterThan(Date.now() - 5000)
  })
})

describe('sweepRenditionCache', () => {
  async function writeCacheFile(name: string, ageMs: number, bytes: number): Promise<string> {
    const path = join(renditionsDir, name)
    await writeFile(path, Buffer.alloc(bytes, 1))
    const mtime = new Date(Date.now() - ageMs)
    await utimes(path, mtime, mtime)
    return path
  }

  it('returns a zero result when the cache directory does not exist yet', async () => {
    const result = await sweepRenditionCache()
    expect(result).toEqual({ deleted: 0, freedBytes: 0 })
  })

  it('deletes files older than RENDITION_MAX_AGE_DAYS and keeps fresh ones', async () => {
    env.RENDITION_MAX_AGE_DAYS = 1
    env.RENDITION_CACHE_MAX_GB = 1000 // effectively disable the size cap for this case
    await mkdir(renditionsDir, { recursive: true })

    const oldOne = await writeCacheFile('old.webp', 2 * 24 * 60 * 60 * 1000, 100) // 2 days old
    const freshOne = await writeCacheFile('fresh.webp', 60 * 1000, 100) // 1 minute old

    const result = await sweepRenditionCache()

    expect(result.deleted).toBe(1)
    expect(result.freedBytes).toBe(100)
    expect(await Bun.file(oldOne).exists()).toBe(false)
    expect(await Bun.file(freshOne).exists()).toBe(true)
  })

  it('enforces the size cap oldest-first once under the age threshold', async () => {
    env.RENDITION_MAX_AGE_DAYS = 90 // nothing ages out in this case
    env.RENDITION_CACHE_MAX_GB = 250 / 1024 ** 3 // 250 bytes cap

    await mkdir(renditionsDir, { recursive: true })
    const oldest = await writeCacheFile('oldest.webp', 3 * 60 * 1000, 100)
    const middle = await writeCacheFile('middle.webp', 2 * 60 * 1000, 100)
    const newest = await writeCacheFile('newest.webp', 60 * 1000, 100)

    const result = await sweepRenditionCache()

    // 300 bytes total > 250 cap: evict oldest-first until <= cap (drops the
    // single oldest file, leaving 200 <= 250).
    expect(result.deleted).toBe(1)
    expect(result.freedBytes).toBe(100)
    expect(await Bun.file(oldest).exists()).toBe(false)
    expect(await Bun.file(middle).exists()).toBe(true)
    expect(await Bun.file(newest).exists()).toBe(true)
  })

  it('is a no-op when nothing is old and the cache is under the size cap', async () => {
    env.RENDITION_MAX_AGE_DAYS = 90
    env.RENDITION_CACHE_MAX_GB = 1000
    await mkdir(renditionsDir, { recursive: true })
    const kept = await writeCacheFile('kept.webp', 60 * 1000, 100)

    const result = await sweepRenditionCache()

    expect(result).toEqual({ deleted: 0, freedBytes: 0 })
    expect(await Bun.file(kept).exists()).toBe(true)
  })
})

// Guard against a future refactor accidentally reading path separators from
// the platform in a way that breaks the DATA_DIR/renditions convention.
describe('renditionCachePath convention', () => {
  it('always nests under a literal "renditions" directory', () => {
    const path = renditionCachePath('abc123', 'med')
    expect(path.split(sep)).toContain('renditions')
  })
})

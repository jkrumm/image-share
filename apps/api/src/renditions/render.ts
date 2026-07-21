import { mkdir } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import {
  renditionCacheKey,
  renditionCachePath,
  renditionExt,
  touchCache,
  type RenditionSize,
} from './cache.js'

// sharp rendition pipeline (design §6). sharp is dynamically imported inside the
// render function so module load never spawns the native binding at boot.
//
// Pipeline: sharp(abs).autoOrient().resize({ ...fit:'inside' }).webp()/jpeg().
// Sizes: thumb=480px webp q75 · med=1600px webp q82 · full=2560px jpeg q88.
// RAF inputs are NEVER rendered — renditions come from the paired JPEG.

export interface RenditionResult {
  /** Absolute path to the cached rendition file. */
  path: string
  contentType: string // 'image/webp' | 'image/jpeg'
}

const CONTENT_TYPE: Record<'webp' | 'jpg', string> = {
  webp: 'image/webp',
  jpg: 'image/jpeg',
}

const SIZE_CONFIG: Record<RenditionSize, { dimension: number; quality: number }> = {
  thumb: { dimension: 480, quality: 75 },
  med: { dimension: 1600, quality: 82 },
  full: { dimension: 2560, quality: 88 },
}

export interface RenderRenditionInput {
  absPath: string
  size: RenditionSize
  /** Cache identity — forwarded to renditionCacheKey. */
  root: string
  relPath: string
  mtimeMs: number
  fileSize: number
}

// In-process per-key single-flight (design §6): concurrent requests for the
// same cache key share the one in-flight render instead of racing sharp on the
// same output file. Keyed by the same content-addressed cache key used on disk.
const inflight = new Map<string, Promise<RenditionResult>>()

/**
 * Return a cached rendition for `(absPath, size)`, generating + caching it on
 * miss. RAF inputs are rejected here — renditions only ever come from a paired
 * JPEG (design §6).
 *
 * Deliberately NOT `async`: the body up to `inflight.set` runs fully
 * synchronously, and returning `task` directly (rather than an `async`
 * function's auto-wrapped promise) means two calls racing on the same cache
 * key receive the exact same promise instance — the single-flight guarantee.
 */
export function renderRendition(input: RenderRenditionInput): Promise<RenditionResult> {
  if (extname(input.absPath).toLowerCase() === '.raf') {
    return Promise.reject(
      new Error(
        `RAF inputs are never rendered (renditions come from the paired JPEG): ${input.absPath}`,
      ),
    )
  }

  const key = renditionCacheKey({
    root: input.root,
    relPath: input.relPath,
    mtimeMs: input.mtimeMs,
    fileSize: input.fileSize,
    size: input.size,
  })

  const existing = inflight.get(key)
  if (existing) return existing

  const path = renditionCachePath(key, input.size)
  const contentType = CONTENT_TYPE[renditionExt(input.size)]

  const task = renderOnce({ absPath: input.absPath, size: input.size, path, contentType }).finally(
    () => {
      inflight.delete(key)
    },
  )
  inflight.set(key, task)
  return task
}

async function renderOnce(input: {
  absPath: string
  size: RenditionSize
  path: string
  contentType: string
}): Promise<RenditionResult> {
  const cached = Bun.file(input.path)
  if (await cached.exists()) {
    await touchCache(input.path)
    return { path: input.path, contentType: input.contentType }
  }

  const sharp = (await import('sharp')).default
  const config = SIZE_CONFIG[input.size]
  const pipeline = sharp(input.absPath).autoOrient().resize({
    width: config.dimension,
    height: config.dimension,
    fit: 'inside',
    withoutEnlargement: true,
  })
  const encoded =
    input.size === 'full'
      ? pipeline.jpeg({ quality: config.quality })
      : pipeline.webp({ quality: config.quality })

  await mkdir(dirname(input.path), { recursive: true })
  await encoded.toFile(input.path)

  return { path: input.path, contentType: input.contentType }
}

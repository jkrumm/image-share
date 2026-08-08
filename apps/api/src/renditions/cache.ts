import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readdir, stat, unlink, utimes } from 'node:fs/promises'
import { env } from '../env.js'

// On-disk rendition cache (design §6). Keyed by the source identity + size so a
// re-edited file (new mtime/size) misses and regenerates. Cache files live
// under DATA_DIR/renditions and use their own mtime as an LRU clock.

export type RenditionSize = 'thumb' | 'small' | 'med' | 'full'

/** File extension a size renders to: webp for thumb/small/med, jpg for full (§6). */
export function renditionExt(size: RenditionSize): 'webp' | 'jpg' {
  return size === 'full' ? 'jpg' : 'webp'
}

export interface RenditionCacheKeyParts {
  root: string
  relPath: string
  mtimeMs: number
  fileSize: number
  size: RenditionSize
}

/**
 * Content-addressed cache key: `sha256(root|rel_path|mtime_ms|size|renditionSize)`,
 * first 32 hex chars (design §6). Pure — unit-tested.
 */
export function renditionCacheKey(parts: RenditionCacheKeyParts): string {
  const material = `${parts.root}|${parts.relPath}|${parts.mtimeMs}|${parts.fileSize}|${parts.size}`
  return createHash('sha256').update(material).digest('hex').slice(0, 32)
}

/** Absolute cache path for a key + size: `DATA_DIR/renditions/<key>.<ext>`. */
export function renditionCachePath(key: string, size: RenditionSize): string {
  return join(env.DATA_DIR, 'renditions', `${key}.${renditionExt(size)}`)
}

/**
 * Bump a cache file's mtime to now (LRU clock) on a cache hit.
 */
export async function touchCache(path: string): Promise<void> {
  const now = new Date()
  await utimes(path, now, now)
}

export interface SweepResult {
  deleted: number
  freedBytes: number
}

/**
 * Evict cache files older than RENDITION_MAX_AGE_DAYS, then oldest-first until
 * under RENDITION_CACHE_MAX_GB (design §6). Reads the age/size caps from `env`
 * on every call (not module-load time) so tests can override them per-case.
 */
export async function sweepRenditionCache(): Promise<SweepResult> {
  const dir = join(env.DATA_DIR, 'renditions')

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    // No cache directory yet (nothing rendered so far) — nothing to sweep.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { deleted: 0, freedBytes: 0 }
    throw err
  }

  const maxAgeMs = env.RENDITION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  const maxCacheBytes = env.RENDITION_CACHE_MAX_GB * 1024 ** 3
  const now = Date.now()

  const files: Array<{ path: string; mtimeMs: number; size: number }> = []
  for (const name of entries) {
    const path = join(dir, name)
    const info = await stat(path)
    if (!info.isFile()) continue
    files.push({ path, mtimeMs: info.mtimeMs, size: info.size })
  }

  let deleted = 0
  let freedBytes = 0
  const kept: typeof files = []

  for (const file of files) {
    if (now - file.mtimeMs > maxAgeMs) {
      await unlink(file.path)
      deleted++
      freedBytes += file.size
    } else {
      kept.push(file)
    }
  }

  let totalBytes = kept.reduce((sum, f) => sum + f.size, 0)
  if (totalBytes > maxCacheBytes) {
    kept.sort((a, b) => a.mtimeMs - b.mtimeMs) // oldest first
    for (const file of kept) {
      if (totalBytes <= maxCacheBytes) break
      await unlink(file.path)
      deleted++
      freedBytes += file.size
      totalBytes -= file.size
    }
  }

  return { deleted, freedBytes }
}

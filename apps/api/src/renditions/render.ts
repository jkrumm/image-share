import { mkdir } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { env } from '../env.js'
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
// Sizes: thumb=480px webp q75 · small=900px webp q80 · med=1600px webp q82 ·
// full=2560px jpeg q88. `small` closes the 480→1600 srcset gap: a retina phone
// rendering a 2-column grid needs ~585w and otherwise pays for the 1600px
// candidate.
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
  small: { dimension: 900, quality: 80 },
  med: { dimension: 1600, quality: 82 },
  full: { dimension: 2560, quality: 88 },
}

/**
 * The target long-edge dimension `sharp`'s `fit:'inside'` resize (below) uses
 * for `size` — the single source of truth for both the actual render AND the
 * share page's srcset `Nw` descriptors, which must say what sharp actually
 * produced (see `renderedWidth` in `share/page/index.ts`), not this target:
 * a portrait's HEIGHT hits this dimension first, so its rendered WIDTH is
 * proportionally smaller.
 */
export function renditionDimension(size: RenditionSize): number {
  return SIZE_CONFIG[size].dimension
}

// ── Global sharp concurrency gate ───────────────────────────────────────────
// The per-key single-flight below dedupes *identical* requests, but nothing
// bounded the total: the first visitor to a cold 100-photo share fires ~100
// distinct keys at once, i.e. ~100 concurrent sharp decodes on a 4-core box
// inside a 1 GB container — an OOM-kill at exactly the worst moment. This
// semaphore caps decodes in flight process-wide (RENDITION_CONCURRENCY,
// default 3); everything past the cap queues instead of allocating a decode
// buffer. The limit is read per acquisition (not at module load) so tests can
// override it, matching how cache.ts reads its sweep knobs.
let slotsInUse = 0
let slotsAcquired = 0
const slotWaiters: Array<() => void> = []

function releaseSlot(): void {
  const next = slotWaiters.shift()
  if (next) {
    // Hand the permit straight to the next waiter — `slotsInUse` stays put, so
    // the cap can never be transiently exceeded between release and acquire.
    next()
    return
  }
  slotsInUse -= 1
}

/**
 * Run `work` holding one of the RENDITION_CONCURRENCY sharp permits, releasing
 * it on success *and* on throw (a failing render must not leak a permit, or the
 * gate silently narrows to zero over time).
 */
export async function withRenditionSlot<T>(work: () => Promise<T>): Promise<T> {
  if (slotsInUse < env.RENDITION_CONCURRENCY) {
    slotsInUse += 1
  } else {
    await new Promise<void>((resolve) => slotWaiters.push(resolve))
  }
  slotsAcquired += 1
  try {
    return await work()
  } finally {
    releaseSlot()
  }
}

/** Gate observability: live permits, queue depth, and a monotonic acquire count. */
export function renditionSlotStats(): { inUse: number; queued: number; acquired: number } {
  return { inUse: slotsInUse, queued: slotWaiters.length, acquired: slotsAcquired }
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

  // Only the decode/encode is gated — a cache hit above costs no sharp memory
  // and must never queue behind cold renders.
  return withRenditionSlot(async () => {
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
  })
}

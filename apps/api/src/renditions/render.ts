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

// ── sharp global configuration (design §6) ──────────────────────────────────
// Two knobs, tuned once — the first time sharp's native binding is actually
// loaded (see `loadSharp` below), never at module scope, so importing this
// file still never spawns the native binding at process boot.
//
// 1. `sharp.concurrency(1)`. libvips defaults its own worker-thread pool to
//    the physical core count (4 on the HomeLab container). We ALREADY gate
//    concurrent decodes process-wide via `withRenditionSlot`
//    (RENDITION_CONCURRENCY, default 3) — so libvips' pool is redundant
//    multiplication on top of our own gate, not extra throughput: worst case
//    was 3 gated renders x 4 libvips threads = up to 12 worker threads, each
//    potentially holding tile buffers for a 6240x4160 (26 MP) source, on a
//    4-core box with a 1 GiB cgroup limit. Measured on the HomeLab: idle anon
//    sits at 897-911 MiB of that 1 GiB limit (~89%), and a 40-concurrent
//    cold-render burst pegged memory at exactly 1024.0 MiB. The box never
//    OOM-killed during that burst (all 88 requests returned 200) because our
//    own gate already caps decodes at 3 — CPU during a burst plateaus around
//    2.7-3.0 cores, i.e. the box is already CPU-bound at the width of our OWN
//    gate, so a wider libvips pool buys no extra throughput, only more
//    concurrent buffers. One libvips thread per gated render (1 x 3 = 3
//    worst-case threads, not 3 x 4 = 12) should hold throughput while cutting
//    peak decode-buffer count roughly 4x.
//
// 2. `sharp.cache(false)`. libvips' operation cache defaults to 50 MB / 20
//    files / 100 cached operations — built for workloads that repeat the same
//    operation graph against the same source. Ours never does: every
//    rendition is content-addressed and cached FOREVER on our own disk
//    (renditions/cache.ts) the first time it's rendered, so a given source
//    file is decoded at most 4 times ever (thumb/small/med/full) before every
//    future request for it is served straight off disk without touching
//    sharp again. libvips' in-memory cache is real RSS bought for a
//    structurally near-zero hit rate in this workload — disable it outright
//    rather than tune its limits down.
//
// Both are hardcoded, not env-tunable: they follow directly from facts that
// don't vary by deployment ("we already gate concurrency ourselves", "we
// already cache renditions on disk forever") rather than from anything about
// the HomeLab box's specific core/memory shape that a future deployment might
// need to override. RENDITION_CONCURRENCY (env.ts) remains the one exposed
// knob for the actual pressure point — how many decodes run at once.
let sharpModule: Promise<typeof import('sharp').default> | undefined

/**
 * Dynamically import sharp and configure it exactly once, no matter how many
 * callers race to load it first. `sharpModule` is assigned synchronously (no
 * `await` before the assignment), so concurrent first-callers all observe the
 * same in-flight promise and only one of them ever runs the IIFE body.
 */
function loadSharp(): Promise<typeof import('sharp').default> {
  if (!sharpModule) {
    sharpModule = (async () => {
      const sharp = (await import('sharp')).default
      sharp.concurrency(1)
      sharp.cache(false)
      return sharp
    })()
  }
  return sharpModule
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
    const sharp = await loadSharp()
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

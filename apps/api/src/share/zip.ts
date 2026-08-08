import { createHash } from 'node:crypto'
import { mkdir, readdir, rename, stat, unlink, utimes } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { makeZip, predictLength } from 'client-zip'
import { env } from '../env.js'
import { rootBaseDir, safeJoin } from '../lib/paths.js'
import { log } from '../telemetry.js'
import type { ShareTokenRole } from '../lib/share-auth.js'
import type { ImageRow, ShareRow } from '../db/schema.js'
import { attachment } from './attachment.js'

// ZIP download of a share (design §7), built with `client-zip` (`makeZip`) over
// a generator, SPOOLED TO DISK, and served as a `Bun.file`.
//
// - role='download'|'full': original JPEG files (+ RAFs when role='full').
// - role='view': zip is denied entirely (share/routes.ts 404s before calling in).
//
// ── WHY THE ARCHIVE IS WRITTEN TO DISK FIRST ──────────────────────────────────
//
// It used to be `new Response(makeZip(...))` — a `ReadableStream` body. On Bun
// 1.3.14 that is unbounded: `readStreamIntoSink` drains the body into uWS's
// "infinite memory buffer" and discards `sink.write()`'s result, so a slow
// client never slows the producer down (oven-sh/bun#32469, fixed by PR #32553
// but merged 434 commits AFTER the v1.3.14 tag — no released Bun contains it).
//
// This took the container down in production: pulling the 550-image `segeln-25`
// full-role archive (~19 GB) at ~5 MB/s grew RSS to the 2 GiB cgroup ceiling
// after only ~227 MB had actually reached the client, and the container
// restarted. Raising the limit from 1 GiB only moved the wall.
//
// Every in-process alternative was measured on this exact runtime, with a raw
// TCP client that sends the request and then reads nothing at all. All of them
// ran the producer free to the 512 MiB cap instead of applying backpressure:
//
//   default ReadableStream (highWaterMark 1)   512 MiB produced, RSS +1318 MiB
//   type:'bytes' (BYOB)                        512 MiB produced, RSS  +512 MiB
//   async-generator body                       512 MiB produced, RSS  +514 MiB
//   type:'direct' + await flush(true)         2048 MiB produced, RSS  4.4 GiB
//
// `type:'direct'` deserves the explicit note: `controller.write()` returned the
// full positive chunk length (1048576) on every single call and never the
// negative backpressure sentinel, because Bun's `HTTPServerWritable::write*`
// reports success unconditionally — so there is nothing to await. There is no
// `desiredSize`, `drain`, or buffered-bytes signal for HTTP responses either
// (`backpressureLimit`/`getBufferedAmount()` are WebSocket-only). Wrapping
// client-zip is pointless for the same reason: it is already strictly
// pull-driven with a one-chunk lookahead, and the layer ignoring backpressure
// sits ABOVE whatever stream we hand it. Any zip library would hit this wall.
//
// What IS bounded on 1.3.14, measured the same way: `new Response(Bun.file(p))`.
// Bun serves it with `sendfile(2)`, so the kernel paces it against the socket
// and no JS sink is involved — a 3 GiB file to a fully stalled client moved RSS
// by 8 MiB. So the archive is materialized on disk first and served from there.
// Memory is then bounded by construction, at any archive size and any client
// speed, because no part of the response is ever produced by JavaScript.
//
// Three things fall out of this for free, and two have to be paid for:
//   + `Content-Length` is real again. Bun used to drop the predicted one and
//     fall back to `Transfer-Encoding: chunked` (measured at the origin inside
//     the container), which is why the browser showed no progress bar and no
//     ETA on a multi-GB download. A file response keeps it.
//   + Re-downloading a share costs one `sendfile`, not a second archive build.
//   - Time-to-first-byte is now the spool time (measured ~430 MB/s locally),
//     paid once per (share, role, file-set). See design §7 for the deployment
//     consequence at ~19 GB.
//   - The response is silent for that whole window, which two things notice: the
//     event loop (the loop below hands it back every SPOOL_YIELD_INTERVAL_MS —
//     see `yieldToEventLoop`) and uWS's idle timer (`keepRequestAlive`).
//
// The spool is a content-addressed, LRU-evicted cache under DATA_DIR, exactly
// like the rendition cache (renditions/cache.ts) — same key shape, same mtime
// clock, same eviction story. It is rebuildable: deleting it costs a rebuild.
//
// ── `Range` HAND-PARSING WAS ATTEMPTED TWICE AND REMOVED — DO NOT RE-ADD IT ──
//
// This route used to hand-parse `Range` (`parseRangeHeader` + 206/416 branches
// below) specifically to route around Bun's own automatic dispatch, which is
// unconditional for a raw, un-sliced `Bun.file()` response and cannot be
// suppressed from JS. That fix ALSO took the production container down.
//
// The decisive measurement, taken AT THE ORIGIN inside the container (so
// Cloudflare and Caddy are both ruled out — Cloudflare was confirmed to return
// byte-identical numbers):
//
//   curl -r 100-200 http://localhost:7720/s/<slug>/zip?token=...
//     HTTP/1.1 206 Partial Content
//     Accept-Ranges: bytes
//     Content-Range: bytes 100-200/191797795      <- our header, correct
//     (NO Content-Length header at all)
//     actual bytes transferred: 191,797,695       <- start -> EOF, not start -> end
//
// Our own `Content-Range` end was correct; the actual body streamed to EOF
// regardless — the slice's upper bound was silently ignored somewhere inside
// Elysia's response mapping (the missing `Content-Length` is the tell: the
// body was being streamed, not served as a bounded file, once it reached that
// mapping). On the 191 MB archive that EOF-streaming was a survivable 14 s; on
// the 19 GB `segeln-25` archive, a 100-byte range request became a 19 GB
// transfer to a client that had already gone away — that was the wedge, twice,
// on two independent mechanisms (Bun's own automatic dispatch the first time,
// this route's own hand-computed per-request slice the second, since it was
// itself just handed straight back into that same response mapping).
//
// So the hand-parsing (`parseRangeHeader`, the per-request `.slice(start,
// end+1)`, and the 206/416 branches) is gone, and this route sends no
// `Accept-Ranges` of its own. **This does NOT mean every `Range` request now
// gets a literal 200** — and re-adding a hand-rolled 200-forcing branch would
// be reintroducing exactly the divergent, per-request slice this file exists
// to avoid. Verified directly against this route (`buildShareZip` behind a
// real `Bun.serve`, both with and without Elysia in front of it, on Bun
// 1.3.14): for a syntactically valid single-range header (`N-M`, `-N`, `N-`)
// Bun's OWN native dispatch still answers 206 (or 416 out-of-bounds) — status,
// `Content-Range` and `Content-Length` are entirely Bun's, not ours, and this
// CANNOT be suppressed from JS for a `Bun.file`/`Blob`-backed response body no
// matter how it is sliced: an explicit `status: 200` is silently overridden
// back to 206, deleting the incoming `Range` header first changes nothing, and
// — contrary to an earlier version of this comment — an EXPLICIT full-span
// `Bun.file(path).slice(0, file.size)` is renegotiated exactly like a bare
// `Bun.file(path)` (verified: identical status/headers either way, both
// outside Elysia and through it). A malformed, multi-range, or reversed
// `first > last` header — everything RFC 7233 requires a server to ignore —
// still falls through to the ordinary whole-archive 200, matching this
// route's old hand-rolled `full` case, because Bun's own parser ignores those
// too. `parseRangeHeader`'s tests pinned this exact RFC 7233 grammar; nothing
// about it changed, only which parser is applying it.
//
// **What actually changed, and why it is safe now:** the previous per-request
// slice's declared bounds (`Content-Range: bytes 100-200/…`) could diverge
// from what actually streamed (`start -> EOF`), because that slice was
// recomputed from the incoming header on every request and handed through
// Elysia's response mapping, which was where the bound got lost. The
// full-span slice below can never diverge like that: whatever sub-range Bun's
// own dispatch decides to serve out of it is always a true, in-bounds slice
// of the real, complete archive — there is no separately-computed "declared
// end" for it to disagree with. A 206/416 from this route is therefore Bun's
// own correctly-bounded native behavior, not the wedge. The wedge — a
// declared-vs-actual mismatch turning a small range request into a
// multi-gigabyte transfer to a vanished client — is what is actually gone.
//
// **The cost, paid deliberately:** a download that dies partway restarts from
// zero rather than resuming (no route here can promise otherwise on this Bun
// version). That is exactly why the spool cache above matters — the retry is
// a `sendfile` of an already-built archive, not a rebuild, so a dropped
// connection costs a re-download, not a re-pack. If a literal 200 on every
// `Range` shape is ever required (rather than "no longer wedges"), the fix is
// NOT more JS on this route — the two ways to actually get there are
// stripping `Range` at the edge (Caddy/Cloudflare, before it ever reaches this
// origin) or a Bun upgrade that changes this dispatch.
//
// The body below is still an EXPLICIT `Bun.file(path).slice(0, file.size)`,
// NOT the bare `Bun.file(path)` object — not because it changes what Bun
// answers to a `Range` header (it doesn't, see above), but because it is the
// same `sendfile`-backed, memory-flat body as every other response on this
// route, and an explicit slice keeps that property visibly load-bearing
// rather than incidental.

/** Max concurrent `stat()` calls when sizing a share's files. */
const STAT_CONCURRENCY = 32

/** Spool cache directory under DATA_DIR (rebuildable, like renditions/). */
const SPOOL_DIR_NAME = 'zip-spool'

/**
 * Bumped whenever the archive bytes for an unchanged file set would change
 * (a client-zip upgrade, an entry-naming change), so old spools miss instead of
 * being served as a stale archive.
 */
const SPOOL_KEY_VERSION = 'v1'

/** Write buffer for the spool sink. One of these exists at a time. */
const SPOOL_HIGH_WATER = 4 * 1024 * 1024

/**
 * Retained spool budget. Not an env knob: DATA_DIR headroom is a deployment
 * property (123 GB free on the HomeLab SSD at the time of writing) and this
 * cache is rebuildable, so the only thing the number has to guarantee is that
 * the largest share's archive plus one more fits comfortably.
 *
 * Brought down from 40 GiB now that `SHARE_ZIP_MAX_BYTES` (env.ts, design §7)
 * bounds every archive this route will ever build at 5 GiB — the old number
 * was sized to fit the 19 GB `segeln-25` full-role archive that route no
 * longer serves at all. 20 GiB is 4x the largest single archive possible now:
 * comfortable room for several distinct (share, role) archives cached at
 * once (this is a single-user service, not a fleet), a fraction of the 123 GB
 * free, and a real ceiling — not just a lower one — on how much of that disk
 * a misbehaving or misconfigured build could ever occupy.
 */
const SPOOL_MAX_BYTES = 20 * 1024 ** 3

/** A crashed spool leaves a `.part` behind; reap it rather than leak disk. */
const SPOOL_PART_MAX_AGE_MS = 6 * 60 * 60 * 1000

/**
 * How long the spool loop may run before it hands the event loop back.
 *
 * Nothing in that loop is a real suspension point: a `Bun.file` read served from
 * the page cache and a `FileSink.flush()` both settle as microtasks, and the
 * CRC32 pass over every byte is pure CPU regardless. So the loop drains the
 * microtask queue for its whole duration and the macrotask queue — timers,
 * sockets, `/health` — never gets a turn. Measured over 400 MiB of real files:
 * 967 ms of spool, a 50 ms `setInterval` ticked ZERO times. That is the shape
 * that starves the Docker HEALTHCHECK (Dockerfile: 10 s interval, 5 s timeout,
 * 3 retries) into restarting the container mid-build, and it queues every other
 * visitor's page and rendition behind the archive.
 *
 * A macrotask yield fixes it and costs nothing measurable: same 400 MiB with a
 * 20 ms budget spooled in 975 ms (430 vs 434 MB/s, inside the noise) and the
 * interval ticked 15 of an ideal 20 times. Everything that has to run while an
 * archive is building — the idle-timer heartbeat below, abort delivery, other
 * requests — depends on this yield existing.
 */
const SPOOL_YIELD_INTERVAL_MS = 20

/**
 * Idle-timeout heartbeat for a request parked on a spool (`keepRequestAlive`).
 * 255 is Bun's hard maximum — `Bun.serve` throws above it — and is what
 * index.ts sets globally; re-arming well inside that window keeps the socket
 * from ever reaching it.
 */
const KEEPALIVE_SECONDS = 255
const KEEPALIVE_INTERVAL_MS = 30_000

/** Minimal structural view of `Bun.serve`'s per-request idle-timeout control. */
export interface RequestTimeoutServer {
  timeout(request: Request, seconds: number): void
}

/**
 * Hold a request's socket open while its archive spools, and stop on release.
 *
 * `Bun.serve({ idleTimeout })` is a time-to-NEXT-BYTE cap, and a spooling
 * request emits nothing at all until the archive is complete — the old streamed
 * body reset that timer continuously, a spool never does. So the origin itself
 * caps the build at the idle timeout, and raising the tunnel's origin timeout
 * (design §7's prescription for Cloudflare's ~100 s) cannot lift it: Bun refuses
 * any `idleTimeout` above 255 (`Bun.serve expects idleTimeout to be 255 or
 * less`, measured), and the 19 GB `segeln-25` archive reads ~16.5 GB of RAFs off
 * spinning disk — minutes, not seconds. Without this the socket dies mid-build
 * and the visitor gets the opaque 404.
 *
 * `server.timeout(request, s)` re-arms that timer for ONE request, leaving every
 * other route on the global 255. Measured on Bun 1.3.14 against `idleTimeout: 2`:
 * a request that produced nothing for 20 s was still served when re-armed every
 * 500 ms, and died at 4.1 s without. `timeout(request, 0)` would disable the
 * timer outright instead, but then a stalled client in the `sendfile` phase
 * would hold a socket forever; re-arming keeps the cap in place and only refuses
 * to let it expire while we are still working.
 *
 * One measured trap, harmless at 255 but the reason the test uses 5 s: uWS's
 * timer has a ~4 s granularity, so a re-arm of 4 s or less can still be swept
 * away at the next tick (constant 4 s died at 4.1 s, constant 6 s survived 20 s).
 *
 * The heartbeat is a timer, so it only fires because the spool loop yields
 * (`SPOOL_YIELD_INTERVAL_MS`). `server` is null under `app.handle()` in tests —
 * there is no socket then, so there is nothing to keep alive.
 */
export function keepRequestAlive(input: {
  server: RequestTimeoutServer | null | undefined
  request: Request
  intervalMs?: number
  seconds?: number
}): () => void {
  const { server, request } = input
  if (!server) return () => {}
  const seconds = input.seconds ?? KEEPALIVE_SECONDS
  const timer = setInterval(() => {
    try {
      server.timeout(request, seconds)
    } catch {
      /* the request is already finished — nothing left to keep alive */
    }
  }, input.intervalMs ?? KEEPALIVE_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}

/**
 * Thrown when the visitor hangs up while their archive is still being spooled.
 * Not an error condition — nobody is listening — so share/routes.ts maps it to
 * the same opaque 404 as every other non-answer instead of bubbling it into the
 * unhandled-error log.
 */
export class ZipSpoolAbortedError extends Error {
  constructor() {
    super('share zip spool aborted: client disconnected')
    this.name = 'ZipSpoolAbortedError'
  }
}

export function isZipSpoolAborted(err: unknown): boolean {
  return err instanceof ZipSpoolAbortedError
}

/**
 * Thrown when a share's predicted archive exceeds `SHARE_ZIP_MAX_BYTES`
 * (design §7) — `buildShareZip` refuses BEFORE ever touching the spool.
 *
 * Deliberately not the same signal as `ZipSpoolAbortedError`: this is not a
 * denial (the token and role are both valid, the visitor is entitled to every
 * byte), it is a capacity limit. `share/routes.ts` renders a dedicated 413
 * page instead of the opaque 404 — conflating the two would tell a legitimate
 * visitor with a real link that it is dead.
 */
export class ZipTooLargeError extends Error {
  readonly predictedBytes: number
  constructor(predictedBytes: number) {
    super(`share zip exceeds SHARE_ZIP_MAX_BYTES: ${predictedBytes} > ${env.SHARE_ZIP_MAX_BYTES}`)
    this.name = 'ZipTooLargeError'
    this.predictedBytes = predictedBytes
  }
}

export function isZipTooLarge(err: unknown): err is ZipTooLargeError {
  return err instanceof ZipTooLargeError
}

/**
 * Zip entry name for an image: path relative to the share dir (keeps structure).
 * `dir` is read only on a FOLDER share — an album row's column holds the
 * rollback poison pill (ALBUM_SHARE_LEGACY_DIR), never a real prefix.
 */
function entryName(share: ShareRow, relPath: string): string {
  if (share.sourceType === 'folder' && share.dir && relPath.startsWith(share.dir + '/')) {
    return relPath.slice(share.dir.length + 1)
  }
  return relPath
}

interface FullEntry {
  absPath: string
  name: string
  size: number
  lastModified: Date
}

interface StatResult {
  size: number
  mtime: Date
}

async function tryStat(path: string): Promise<StatResult | null> {
  try {
    const st = await stat(path)
    return { size: st.size, mtime: st.mtime }
  } catch {
    return null
  }
}

/**
 * `stat` every path with a bounded number of in-flight calls, preserving input
 * order. Deliberately NOT `statSync` in a loop: a 2000-file share would block
 * the event loop for 2000 syscalls before the first ZIP byte is written, which
 * stalls every concurrent rendition request from every other visitor. It is
 * also not an unbounded `Promise.all` — that would open 2000 file descriptors
 * at once inside a 1 GB container.
 */
async function statAll(paths: readonly string[]): Promise<(StatResult | null)[]> {
  const results: (StatResult | null)[] = Array.from({ length: paths.length }, () => null)
  let next = 0
  const workers = Array.from({ length: Math.min(STAT_CONCURRENCY, paths.length) }, async () => {
    for (let i = next++; i < paths.length; i = next++) {
      results[i] = await tryStat(paths[i]!)
    }
  })
  await Promise.all(workers)
  return results
}

/** The absolute paths a share's ZIP would contain, in archive order. */
function zipPathsFor(input: {
  share: ShareRow
  images: readonly ImageRow[]
  role: ShareTokenRole
}): {
  absPath: string
  name: string
  relPath: string
  isRaw: boolean
}[] {
  const out: { absPath: string; name: string; relPath: string; isRaw: boolean }[] = []
  for (const image of input.images) {
    out.push({
      absPath: safeJoin(rootBaseDir(image.root), image.relPath),
      name: entryName(input.share, image.relPath),
      relPath: image.relPath,
      isRaw: false,
    })
    if (input.role === 'full' && image.rawPath) {
      out.push({
        absPath: safeJoin(rootBaseDir('raws'), image.rawPath),
        name: basename(image.rawPath),
        relPath: image.rawPath,
        isRaw: true,
      })
    }
  }
  return out
}

/** Spool cache directory (read from `env` per call so tests can relocate it). */
function spoolDir(): string {
  return join(env.DATA_DIR, SPOOL_DIR_NAME)
}

/**
 * Content-addressed spool key: `sha256(version|slug|role|<name|size|mtime>…)`,
 * first 32 hex chars. Every input that changes a single archive byte is in the
 * material, so a re-edited or re-ordered share misses and rebuilds rather than
 * serving a stale archive. Pure — unit-tested.
 */
export function zipSpoolKey(input: {
  share: ShareRow
  role: ShareTokenRole
  entries: readonly { name: string; size: number; lastModified: Date }[]
}): string {
  const hash = createHash('sha256')
  hash.update(`${SPOOL_KEY_VERSION}|${input.share.slug}|${input.role}`)
  for (const e of input.entries) {
    hash.update(`\n${e.name}|${e.size}|${e.lastModified.getTime()}`)
  }
  return hash.digest('hex').slice(0, 32)
}

/** Absolute spool path for a key: `DATA_DIR/zip-spool/<key>.zip`. */
export function zipSpoolPath(key: string): string {
  return join(spoolDir(), `${key}.zip`)
}

/**
 * Evict oldest-first until the retained spools plus `headroomBytes` fit the
 * budget, and reap `.part` files orphaned by a crash. Runs before a spool so
 * the new archive has somewhere to go; a failure here must never deny the
 * download, so it is logged and swallowed.
 */
async function sweepSpool(headroomBytes: number): Promise<void> {
  const dir = spoolDir()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }

  const now = Date.now()
  const files: { path: string; mtimeMs: number; size: number }[] = []
  for (const name of names) {
    const path = join(dir, name)
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) continue
    if (name.endsWith('.part')) {
      if (now - info.mtimeMs > SPOOL_PART_MAX_AGE_MS) await unlink(path).catch(() => {})
      continue
    }
    if (!name.endsWith('.zip')) continue
    files.push({ path, mtimeMs: info.mtimeMs, size: info.size })
  }

  let total = files.reduce((sum, f) => sum + f.size, 0)
  if (total + headroomBytes <= SPOOL_MAX_BYTES) return

  files.sort((a, b) => a.mtimeMs - b.mtimeMs)
  for (const file of files) {
    if (total + headroomBytes <= SPOOL_MAX_BYTES) break
    await unlink(file.path).catch(() => {})
    total -= file.size
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ZipSpoolAbortedError()
}

/**
 * Hand control back to the event loop for one turn.
 *
 * A macrotask, deliberately: `await Promise.resolve()` or a microtask-only
 * `queueMicrotask` stays inside the same drain and changes nothing. A 0 ms timer
 * makes the loop go around, which is where ready sockets and due timers are.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

/**
 * Build the archive into `target` and publish it with an atomic `rename(2)`, so
 * a reader can only ever observe a complete archive.
 *
 * The bounded-memory invariant lives in this loop: exactly one client-zip chunk
 * is resident at a time, because the sink is flushed before the next `read()`.
 * client-zip's own lookahead is one chunk (`CountQueuingStrategy`,
 * highWaterMark 1), and each source file is read through a `Bun.file` stream one
 * `read()` at a time — so peak usage is a function of the chunk size, not of the
 * archive size. Measured at 51 MiB RSS delta spooling 500 MiB at ~400 MiB/s.
 *
 * The loop is also the service's only long CPU-bound stretch, so it yields on a
 * time budget (`SPOOL_YIELD_INTERVAL_MS`) rather than running to completion —
 * without that, everything else on this process stops until the archive is done.
 */
async function writeSpool(input: { entries: readonly FullEntry[]; target: string }): Promise<void> {
  const partPath = `${input.target}.${crypto.randomUUID()}.part`
  await mkdir(spoolDir(), { recursive: true })

  const stream = makeZip(
    (function* () {
      for (const e of input.entries) {
        yield {
          input: Bun.file(e.absPath),
          name: e.name,
          size: e.size,
          lastModified: e.lastModified,
        }
      }
    })(),
  )

  const reader = stream.getReader()
  const sink = Bun.file(partPath).writer({ highWaterMark: SPOOL_HIGH_WATER })
  try {
    let lastYield = performance.now()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      sink.write(value)
      await sink.flush()
      if (performance.now() - lastYield >= SPOOL_YIELD_INTERVAL_MS) {
        await yieldToEventLoop()
        lastYield = performance.now()
      }
    }
    await sink.end()
    await rename(partPath, input.target)
  } catch (err) {
    // Release the source-file readers (client-zip's `cancel` throws into its own
    // generator, which closes the `Bun.file` stream it was mid-way through),
    // close the sink, and leave no partial archive behind.
    await reader.cancel(err).catch(() => {})
    try {
      await sink.end()
    } catch {
      /* sink already torn down */
    }
    await unlink(partPath).catch(() => {})
    throw err
  }
}

/**
 * Spools in flight, keyed by spool key. Two visitors asking for the same
 * archive at the same time join one build instead of racing two.
 */
const inFlight = new Map<string, Promise<void>>()

/**
 * Ensure a complete spool exists at `path`, joining an in-flight build for the
 * same key if there is one.
 *
 * ── A DISCONNECT DETACHES THE VISITOR, IT DOES NOT KILL THE BUILD ────────────
 *
 * This used to be refcounted: the last waiter to leave aborted the build, whose
 * error path unlinks the `.part`. That turns every timeout into an unrecoverable
 * loop instead of a slow first attempt. The 19 GB `segeln-25` archive can outrun
 * Cloudflare's ~100 s origin-response timeout (design §7); when cloudflared drops
 * the connection, minutes of completed work were deleted, and the retry started
 * from zero and 524'd again — forever, because nothing ever got far enough to be
 * cached. Whether it self-healed depended on whether the abort happened to be
 * delivered, which is not a property to build a download on.
 *
 * So a build, once started, runs to completion and publishes. It is bounded work
 * (a fixed file set), deduped by key, swept under the same LRU budget as every
 * other spool, and it is the ONLY thing that makes a retry cheap: attempt two
 * hits `tryStat` and becomes one `sendfile`. The request still returns promptly
 * on disconnect — that is the race below — it just stops taking the archive down
 * with it.
 */
async function ensureSpool(input: {
  key: string
  path: string
  entries: readonly FullEntry[]
  predictedLength: number
  signal: AbortSignal | undefined
}): Promise<void> {
  let job = inFlight.get(input.key)
  if (!job) {
    const started = Bun.nanoseconds()
    const created: Promise<void> = (async () => {
      try {
        await sweepSpool(input.predictedLength)
        await writeSpool({ entries: input.entries, target: input.path })
      } catch (err) {
        // A build that outlives its visitors can fail with nobody left to
        // report to (a full disk, a vanishing source file), and the retry only
        // rebuilds and fails again. Logged here so the first failure is visible.
        log.error('share.zip.spool_failed', err, {
          'share.zip.entry_count': input.entries.length,
          'share.zip.bytes': input.predictedLength,
        })
        throw err
      }
      log.info('share.zip.spooled', {
        'share.zip.entry_count': input.entries.length,
        'share.zip.bytes': input.predictedLength,
        'share.zip.spool_ms': Math.round(Number(Bun.nanoseconds() - started) / 1e6),
      })
    })().finally(() => {
      if (inFlight.get(input.key) === created) inFlight.delete(input.key)
    })
    // A detached build has no waiter at all, so its rejection would otherwise
    // surface as an unhandled one; it is logged above either way.
    created.catch(() => {})
    inFlight.set(input.key, created)
    job = created
  }

  const signal = input.signal
  if (!signal) {
    await job
    return
  }

  // Race the build against the disconnect so a visitor who hangs up returns
  // immediately. `job` already has a no-op catch attached, so losing the race
  // cannot surface as an unhandled rejection; the listener is `once` on a
  // per-request signal, so it dies with the request either way.
  let onAbort: (() => void) | undefined
  const disconnected = new Promise<never>((_, reject) => {
    onAbort = (): void => reject(new ZipSpoolAbortedError())
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    await Promise.race([job, disconnected])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Build the ZIP `Response` for a share (filename `<slug>.zip`).
 * `role` must be 'download' or 'full' — the caller (share/routes.ts) 404s a
 * 'view' role before ever calling in here.
 *
 * This route's own hand-rolled `Range` parsing/branching was attempted twice
 * and removed (see the header comment above) — it adds none of its own and
 * never sends `Accept-Ranges`. That does NOT make every `Range` request a
 * literal 200: Bun 1.3.14's native dispatch still answers a syntactically
 * valid single-range header with a 206/416 for ANY `Bun.file`/`Blob`-backed
 * response body, including the full-span `.slice(0, file.size)` used below —
 * verified un-suppressible from JS. What changed is that this can no longer
 * diverge from its own bounds (the actual production wedge): a full-span
 * slice has no separately-computed "declared end" to disagree with the bytes
 * actually sent, unlike the removed per-request slice.
 *
 * Rejects with `ZipSpoolAbortedError` if the visitor disconnects while their
 * archive is still spooling — the build itself carries on, so their retry is a
 * cache hit rather than a second full rebuild (see `ensureSpool`).
 *
 * Rejects with `ZipTooLargeError` if the predicted archive exceeds
 * `SHARE_ZIP_MAX_BYTES` — refused before the spool is ever touched, cold or
 * warm request alike (design §7).
 */
export async function buildShareZip(input: {
  share: ShareRow
  images: ImageRow[]
  role: ShareTokenRole
  signal?: AbortSignal
}): Promise<Response> {
  const { share } = input
  const candidates = zipPathsFor(input)
  const stats = await statAll(candidates.map((c) => c.absPath))

  const entries: FullEntry[] = []
  const missing: string[] = []
  for (const [i, candidate] of candidates.entries()) {
    const st = stats[i]
    if (!st) {
      missing.push(candidate.relPath)
      continue
    }
    entries.push({
      absPath: candidate.absPath,
      name: candidate.name,
      size: st.size,
      lastModified: st.mtime,
    })
  }

  // A file indexed in the DB but gone from disk is silently skipped so the
  // visitor still gets the rest of their photos — but it MUST be visible to the
  // operator, because the page's photo count and the archive's entry count now
  // disagree with no other signal anywhere. Deliberately not an error page: a
  // single stale row would otherwise deny the whole share its download.
  if (missing.length > 0) {
    log.warn('share.zip.missing_files', {
      'share.slug': share.slug,
      'share.zip.missing_count': missing.length,
      'share.zip.entry_count': entries.length,
      // Bounded — a fully stale share must not write 2000 paths per request.
      'share.zip.missing_sample': missing.slice(0, 10).join(', '),
    })
  }

  // `predictLength` returns a bigint (Zip64 sizes outrun a safe integer in
  // principle); every caller below only needs it as a headroom/cap figure.
  // Computed unconditionally, BEFORE the cache check: it costs nothing extra
  // (pure arithmetic over the stat pass already done above) and it is what
  // lets the cap below refuse an oversized share before a single spool byte
  // is written, on a cold OR a warm request alike.
  const predictedLength = Number(
    predictLength(entries.map((e) => ({ name: e.name, size: e.size }))),
  )

  // Refuse before ever touching the spool (design §7, `SHARE_ZIP_MAX_BYTES`).
  // Measured on the live box: the 19 GB full-role `segeln-25` archive (JPEGs +
  // paired RAFs) wedges the event loop hard enough that `/health` stops
  // answering and the Docker healthcheck restarts the container — reproduced
  // repeatedly — while the 3.78 GB download-role archive on the SAME share
  // serves fine. `share/routes.ts` turns this into a 413, never the opaque
  // 404: the token and role are both valid, this is a capacity limit, not a
  // denial.
  if (predictedLength > env.SHARE_ZIP_MAX_BYTES) {
    throw new ZipTooLargeError(predictedLength)
  }

  const key = zipSpoolKey({ share, role: input.role, entries })
  const path = zipSpoolPath(key)
  const cached = await tryStat(path)
  if (cached) {
    // LRU clock, same convention as the rendition cache.
    const now = new Date()
    await utimes(path, now, now).catch(() => {})
  } else {
    throwIfAborted(input.signal)
    await ensureSpool({
      key,
      path,
      entries,
      predictedLength,
      signal: input.signal,
    })
  }

  const file = Bun.file(path)
  const headers: Record<string, string> = {
    'content-type': 'application/zip',
    // The slug is user-controlled; the shared RFC 5987 builder is the only
    // sanctioned way to put it in a header (see share/attachment.ts).
    'content-disposition': attachment(`${share.slug}.zip`),
    'content-length': String(file.size),
  }

  // No `Range` handling of our own, no `Accept-Ranges` (see the header
  // comment above for why the previous per-request `.slice()` was removed —
  // and why Bun's OWN native dispatch may still turn this into a 206/416 for
  // a syntactically valid single-range header, unsuppressibly, regardless of
  // what this code does). The full-span slice is still deliberate: it is the
  // same `sendfile`-backed, memory-flat body as every other response here.
  return new Response(file.slice(0, file.size), { headers })
}

/**
 * Predicted total byte size of a share's ZIP, for the download control's label.
 *
 * The JPEG payload comes from the indexed `file_size` sum — zero syscalls, so
 * every share page render is free regardless of share size. RAF sizes are NOT
 * indexed (the raws root is read-only and RAFs are never rendered), so a
 * `full`-role share pays one bounded-concurrency `stat` pass over its paired
 * RAFs; that is the owner's own link, never a friend's.
 *
 * The ZIP container overhead (~100 bytes per entry) is deliberately ignored:
 * the number is rendered as "1.9 GB", where 0.01% is invisible.
 */
export async function estimateShareZipBytes(input: {
  totalFileSize: number
  role: ShareTokenRole
  rawPaths: readonly string[]
}): Promise<number> {
  if (input.role !== 'full' || input.rawPaths.length === 0) return input.totalFileSize
  const stats = await statAll(input.rawPaths.map((p) => safeJoin(rootBaseDir('raws'), p)))
  let total = input.totalFileSize
  for (const st of stats) total += st?.size ?? 0
  return total
}

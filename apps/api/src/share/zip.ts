import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { makeZip, predictLength } from 'client-zip'
import { rootBaseDir, safeJoin } from '../lib/paths.js'
import { log } from '../telemetry.js'
import type { ShareTokenRole } from '../lib/share-auth.js'
import type { ImageRow, ShareRow } from '../db/schema.js'
import { attachment } from './attachment.js'

// Streaming ZIP download of a share (design §7, role-based rework), built with
// `client-zip` (`makeZip`) over a generator.
//
// - role='download'|'full': original JPEG files (+ RAFs when role='full'), with
//   `predictLength` so a Content-Length header can be set (files are on disk,
//   sizes known up front).
// - role='view': zip is denied entirely (share/routes.ts 404s before calling in).
//
// KNOWN CAVEAT (oven-sh/bun#32469): Bun.serve ReadableStream responses may
// ignore TCP backpressure, so a slow client can make the whole ZIP buffer in
// memory. Acceptable single-user risk — re-check at Bun upgrade time. Also
// documented in the README.
//
// SECOND KNOWN CAVEAT (measured live, 2026-08): Bun DROPS the Content-Length we
// set here on a `ReadableStream` response and sends `Transfer-Encoding: chunked`
// instead — verified with curl from INSIDE the container, so it is not a
// Cloudflare rewrite. The browser therefore shows no progress bar and no ETA on
// a multi-GB download. Nothing in this file can fix that; the share page instead
// renders the predicted size into the ZIP control's own label (see
// `estimateShareZipBytes`) so the visitor at least knows what they started.

/** Max concurrent `stat()` calls when sizing a share's files. */
const STAT_CONCURRENCY = 32

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

/**
 * Build the streaming ZIP `Response` for a share (filename `<slug>.zip`).
 * `role` must be 'download' or 'full' — the caller (share/routes.ts) 404s a
 * 'view' role before ever calling in here.
 */
export async function buildShareZip(input: {
  share: ShareRow
  images: ImageRow[]
  role: ShareTokenRole
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

  const length = predictLength(entries.map((e) => ({ name: e.name, size: e.size })))
  const stream = makeZip(
    (function* () {
      for (const e of entries) {
        yield {
          input: Bun.file(e.absPath),
          name: e.name,
          size: e.size,
          lastModified: e.lastModified,
        }
      }
    })(),
    { length },
  )
  return new Response(stream, {
    headers: {
      'content-type': 'application/zip',
      'content-length': String(length),
      // The slug is user-controlled; the shared RFC 5987 builder is the only
      // sanctioned way to put it in a header (see share/attachment.ts).
      'content-disposition': attachment(`${share.slug}.zip`),
    },
  })
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

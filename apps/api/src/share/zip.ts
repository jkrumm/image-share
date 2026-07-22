import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { makeZip, predictLength } from 'client-zip'
import { rootBaseDir, safeJoin } from '../lib/paths.js'
import type { ShareTokenRole } from '../lib/share-auth.js'
import type { ImageRow, ShareRow } from '../db/schema.js'

// Streaming ZIP download of a share (design §7, role-based rework), built with
// `client-zip` (`makeZip`) over an async/sync generator.
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

/** Zip entry name for an image: path relative to the share dir (keeps structure). */
function entryName(share: ShareRow, relPath: string): string {
  if (share.dir && relPath.startsWith(share.dir + '/')) {
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

/**
 * Build the streaming ZIP `Response` for a share (filename `<slug>.zip`).
 * `role` must be 'download' or 'full' — the caller (share/routes.ts) 404s a
 * 'view' role before ever calling in here.
 */
export function buildShareZip(input: {
  share: ShareRow
  images: ImageRow[]
  role: ShareTokenRole
}): Response {
  const { share, images, role } = input
  const filename = `${share.slug}.zip`
  const disposition = `attachment; filename="${filename}"`

  // Collect on-disk entries + exact sizes so the length can be predicted.
  const entries: FullEntry[] = []
  for (const image of images) {
    const abs = safeJoin(rootBaseDir(image.root), image.relPath)
    const st = tryStat(abs)
    if (!st) continue
    entries.push({
      absPath: abs,
      name: entryName(share, image.relPath),
      size: st.size,
      lastModified: st.mtime,
    })
    if (role === 'full' && image.rawPath) {
      const rawAbs = safeJoin(rootBaseDir('raws'), image.rawPath)
      const rawSt = tryStat(rawAbs)
      if (rawSt) {
        entries.push({
          absPath: rawAbs,
          name: basename(image.rawPath),
          size: rawSt.size,
          lastModified: rawSt.mtime,
        })
      }
    }
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
      'content-disposition': disposition,
    },
  })
}

function tryStat(path: string): { size: number; mtime: Date } | null {
  try {
    const st = statSync(path)
    return { size: st.size, mtime: st.mtime }
  } catch {
    return null
  }
}

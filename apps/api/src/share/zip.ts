import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { makeZip, predictLength } from 'client-zip'
import { safeJoin } from '../lib/paths.js'
import { rootBaseDir } from '../lib/share-auth.js'
import { renderRendition } from '../renditions/render.js'
import type { ImageRow, ShareRow } from '../db/schema.js'

// Streaming ZIP download of a share (design §7), built with `client-zip`
// (`makeZip`) over an async/sync generator.
//
// - size_limit='full': original JPEG files (+ RAFs when include_raws), with
//   `predictLength` so a Content-Length header can be set (files are on disk,
//   sizes known up front).
// - size_limit='medium': `med` renditions generated lazily inside the generator
//   (no Content-Length — sizes aren't known until each is rendered).
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

/** Swap a path's extension (used for `med` rendition entries → `.webp`). */
function withExt(name: string, ext: string): string {
  const dot = name.lastIndexOf('.')
  return (dot === -1 ? name : name.slice(0, dot)) + '.' + ext
}

interface FullEntry {
  absPath: string
  name: string
  size: number
  lastModified: Date
}

/**
 * Build the streaming ZIP `Response` for a share (filename `<slug>.zip`).
 */
export function buildShareZip(input: { share: ShareRow; images: ImageRow[] }): Response {
  const { share, images } = input
  const filename = `${share.slug}.zip`
  const disposition = `attachment; filename="${filename}"`

  if (share.sizeLimit === 'full') {
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
      if (share.includeRaws === 1 && image.rawPath) {
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

  // medium: lazily render `med` renditions inside the generator — no Content-Length.
  const stream = makeZip(
    (async function* () {
      for (const image of images) {
        const abs = safeJoin(rootBaseDir(image.root), image.relPath)
        let renditionPath: string
        try {
          const rendition = await renderRendition({
            absPath: abs,
            size: 'med',
            root: image.root,
            relPath: image.relPath,
            mtimeMs: image.mtimeMs,
            fileSize: image.fileSize,
          })
          renditionPath = rendition.path
        } catch {
          continue
        }
        const st = tryStat(renditionPath)
        if (!st) continue
        yield {
          input: Bun.file(renditionPath),
          name: withExt(entryName(share, image.relPath), 'webp'),
          size: st.size,
          lastModified: st.mtime,
        }
      }
    })(),
  )
  return new Response(stream, {
    headers: { 'content-type': 'application/zip', 'content-disposition': disposition },
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

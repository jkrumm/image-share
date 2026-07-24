import { mkdirSync } from 'node:fs'
import { basename, extname, join, posix } from 'node:path'
import { Elysia } from 'elysia'
import { z } from 'zod'
import { EXT_KIND, indexSinglePath } from '../indexer/scan.js'
import { env } from '../env.js'
import { CONTENT_TYPE_BY_EXT } from './library.js'

// Agent ingest (design §8). Multipart upload lands in the service-owned
// SHARE_ROOT area (SHARE_ROOT/<yyyy>/<mm>/, collision-safe name), is indexed
// immediately, and returns the canonical admin serving URL.

// Same extension set the indexer recognizes (EXT_KIND, indexer/scan.ts) —
// anything else would be written to SHARE_ROOT and then rejected by
// indexSinglePath, orphaning the file on disk. Rejecting up front avoids that.
const ALLOWED_EXTENSIONS = new Set(Object.keys(EXT_KIND))
// Same ext→mime mapping library.ts uses to serve bytes back out.
const ALLOWED_MIME_TYPES = new Set(Object.values(CONTENT_TYPE_BY_EXT))
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 // 50 MB

function sanitizeSubDir(dir: string): string {
  return dir
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..')
    .join('/')
}

/** Find a filename that doesn't already exist in `dirAbs`, appending `-2`,
 * `-3`, … before the extension on collision. */
async function collisionSafeName(dirAbs: string, originalName: string): Promise<string> {
  const ext = extname(originalName)
  const rawStem = basename(originalName, ext) || 'upload'
  const stem = rawStem.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'upload'

  let candidate = `${stem}${ext}`
  let i = 2
  while (await Bun.file(join(dirAbs, candidate)).exists()) {
    candidate = `${stem}-${i}${ext}`
    i++
  }
  return candidate
}

export const ingestRoutes = new Elysia({ name: 'ingest' }).post(
  '/api/images',
  async ({ body, set, status }) => {
    const ext = extname(body.file.name).slice(1).toLowerCase()
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return status(
        400,
        `Unsupported file extension "${ext || '(none)'}" — allowed: ${[...ALLOWED_EXTENSIONS].toSorted().join(', ')}`,
      )
    }
    // Bun's multipart parser re-derives File#type from the filename extension
    // rather than trusting the wire Content-Type of the part (verified against
    // this exact runtime: a raw multipart body declaring "Content-Type:
    // application/pdf" on a `sneaky.jpg` part still yields `type: "image/jpeg"`
    // — the client's declared MIME never actually reaches the handler for a
    // recognized extension). This check is therefore a defense-in-depth no-op
    // today, guarding only against a future parser change; the extension check
    // above is the real gate. `.raf` has no known mime and yields `''`, which
    // skips this check entirely.
    if (body.file.type && !ALLOWED_MIME_TYPES.has(body.file.type)) {
      return status(400, `Unsupported MIME type "${body.file.type}" for extension ".${ext}"`)
    }
    if (body.file.size > MAX_UPLOAD_BYTES) {
      return status(
        400,
        `File too large (${body.file.size} bytes) — max ${MAX_UPLOAD_BYTES} bytes (50 MB)`,
      )
    }

    const now = new Date()
    const yyyy = String(now.getFullYear())
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const subDir = body.dir ? sanitizeSubDir(body.dir) : ''
    const dirRel = subDir ? posix.join(yyyy, mm, subDir) : posix.join(yyyy, mm)
    const dirAbs = join(env.SHARE_ROOT, dirRel)
    mkdirSync(dirAbs, { recursive: true })

    const filename = await collisionSafeName(dirAbs, body.file.name)
    const relPath = posix.join(dirRel, filename)
    const absPath = join(dirAbs, filename)
    await Bun.write(absPath, body.file)

    const id = await indexSinglePath({ root: 'share', relPath })

    set.status = 201
    return {
      id,
      root: 'share' as const,
      relPath,
      adminFileUrl: `/api/library/images/${id}/file`,
    }
  },
  {
    body: z.object({
      file: z.file().describe('The image file to upload'),
      dir: z.string().optional().describe('Optional sub-directory hint under the share area'),
    }),
    response: {
      201: z.object({
        id: z.number().int(),
        root: z.literal('share'),
        relPath: z.string(),
        adminFileUrl: z.string().describe('GET /api/library/images/{id}/file URL'),
      }),
      400: z.string(),
    },
    detail: {
      tags: ['Ingest'],
      summary: 'Upload an image (agent ingest)',
      description:
        'Multipart upload of a single image into the service-owned SHARE_ROOT area (SHARE_ROOT/<yyyy>/<mm>/ with a collision-safe name). Rejects (400) an extension/MIME type the indexer would not recognize (jpg/jpeg/png/webp/avif/heic/raf) or a file over 50 MB. Indexes the file immediately and returns its id, relPath, and the admin serving URL. This is the private ingest path — public publishing is POST /api/publish.',
      security: [{ BearerAuth: [] }],
    },
  },
)

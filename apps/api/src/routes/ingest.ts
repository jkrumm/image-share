import { mkdirSync } from 'node:fs'
import { basename, extname, join, posix } from 'node:path'
import { Elysia } from 'elysia'
import { z } from 'zod'
import { indexSinglePath } from '../indexer/scan.js'
import { env } from '../env.js'

// Agent ingest (design §8). Multipart upload lands in the service-owned
// SHARE_ROOT area (SHARE_ROOT/<yyyy>/<mm>/, collision-safe name), is indexed
// immediately, and returns the canonical admin serving URL.

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
  async ({ body, set }) => {
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
    },
    detail: {
      tags: ['Ingest'],
      summary: 'Upload an image (agent ingest)',
      description:
        'Multipart upload of a single image into the service-owned SHARE_ROOT area (SHARE_ROOT/<yyyy>/<mm>/ with a collision-safe name). Indexes the file immediately and returns its id, relPath, and the admin serving URL. This is the private ingest path — public publishing is POST /api/publish.',
      security: [{ BearerAuth: [] }],
    },
  },
)

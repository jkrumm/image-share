import { unlink } from 'node:fs/promises'
import { Elysia } from 'elysia'
import { z } from 'zod'
import { and, asc, count, desc, eq, gte, like, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { b2Objects, images, type ImageRow } from '../db/schema.js'
import { env } from '../env.js'
import { dirAtOrBelow } from '../lib/dir-scope.js'
import { rootBaseDir, safeJoin } from '../lib/paths.js'
import { renditionCacheKey, renditionCachePath, type RenditionSize } from '../renditions/cache.js'
import { renderRendition } from '../renditions/render.js'

const RENDITION_SIZES: readonly RenditionSize[] = ['thumb', 'med', 'full']

/** Delete a file if present; a missing file is not an error (already gone). */
async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

// Library reads (design §8). `libraryRoutes` mounts INSIDE the bearer-guarded
// /api group; `libraryFileRoutes` mounts OUTSIDE it (public) because browser
// `<img>` tags can't send an Authorization header — it accepts the bearer OR
// `?access_token=<API_SECRET>` and does its own check (mirrors argo's
// audioFileRoutes precedent).

// Exported so ingest.ts can validate uploaded MIME types against the exact
// same ext→mime mapping this route uses to serve bytes back out.
export const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  raf: 'application/octet-stream',
}

function contentTypeForExt(ext: string): string {
  return CONTENT_TYPE_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream'
}

// ── Shared DTO ───────────────────────────────────────────────────────────────

export const ImageDto = z.object({
  id: z.number().int(),
  root: z.enum(['fuji', 'raws', 'share']),
  relPath: z.string(),
  dir: z.string(),
  stem: z.string(),
  ext: z.string(),
  kind: z.enum(['jpeg', 'raw', 'image', 'other']),
  fileSize: z.number().int(),
  mtimeMs: z.number().int(),
  captureAt: z.string().nullable().describe('ISO 8601 capture timestamp'),
  orientation: z.number().int().nullable(),
  rating: z.number().int().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  rawPath: z.string().nullable().describe('rel_path of the paired RAF (jpeg rows only)'),
  indexedAt: z.string(),
})

export function toImageDto(row: ImageRow): z.infer<typeof ImageDto> {
  return {
    id: row.id,
    root: row.root as z.infer<typeof ImageDto>['root'],
    relPath: row.relPath,
    dir: row.dir,
    stem: row.stem,
    ext: row.ext,
    kind: row.kind as z.infer<typeof ImageDto>['kind'],
    fileSize: row.fileSize,
    mtimeMs: row.mtimeMs,
    captureAt: row.captureAt,
    orientation: row.orientation,
    rating: row.rating,
    width: row.width,
    height: row.height,
    rawPath: row.rawPath,
    indexedAt: row.indexedAt,
  }
}

const DirDto = z.object({
  root: z.enum(['fuji', 'raws', 'share']),
  dir: z.string(),
  imageCount: z.number().int(),
  ratedCounts: z
    .object({ r4plus: z.number().int(), r5: z.number().int() })
    .describe('Counts of images at rating thresholds'),
  rawPairedCount: z.number().int(),
  minCaptureAt: z.string().nullable(),
  maxCaptureAt: z.string().nullable(),
})

export const libraryRoutes = new Elysia({ name: 'library' })
  .get(
    '/api/library/dirs',
    async () => {
      const rows = await db
        .select({
          root: images.root,
          dir: images.dir,
          imageCount: count(),
          r4plus: sql<number>`sum(case when ${images.rating} >= 4 then 1 else 0 end)`,
          r5: sql<number>`sum(case when ${images.rating} = 5 then 1 else 0 end)`,
          rawPairedCount: sql<number>`sum(case when ${images.rawPath} is not null then 1 else 0 end)`,
          minCaptureAt: sql<string | null>`min(${images.captureAt})`,
          maxCaptureAt: sql<string | null>`max(${images.captureAt})`,
        })
        .from(images)
        .groupBy(images.root, images.dir)
        .orderBy(images.root, images.dir)

      const data = rows.map((row) => ({
        root: row.root as z.infer<typeof DirDto>['root'],
        dir: row.dir,
        imageCount: Number(row.imageCount),
        ratedCounts: { r4plus: Number(row.r4plus), r5: Number(row.r5) },
        rawPairedCount: Number(row.rawPairedCount),
        minCaptureAt: row.minCaptureAt,
        maxCaptureAt: row.maxCaptureAt,
      }))

      return { data }
    },
    {
      response: { 200: z.object({ data: z.array(DirDto) }) },
      detail: {
        tags: ['Library'],
        summary: 'List indexed directories with per-folder counts',
        description:
          'Returns every directory the indexer knows about across all roots, each with image counts, rated-image counts, RAW-paired count, and the capture-date range. Powers the admin left-hand dir tree. Use GET /library/images to list a folder’s images.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .get(
    '/api/library/images',
    async ({ query }) => {
      const page = query.page ?? 1
      const limit = query.limit ?? 50
      const sort = query.sort ?? 'captureAt'
      const order = query.order ?? 'desc'
      const offset = (page - 1) * limit

      const conditions = []
      if (query.root) conditions.push(eq(images.root, query.root))
      if (query.kind) conditions.push(eq(images.kind, query.kind))
      if (query.dir !== undefined) {
        if (query.recursive) {
          // Same byte-exact scope builder the folder-share filter uses, so the
          // create-share count preview matches the share's real membership.
          if (query.dir !== '') conditions.push(dirAtOrBelow(query.dir))
        } else {
          conditions.push(eq(images.dir, query.dir))
        }
      }
      // 0 means "no filter" (see folderShareImageFilter — NULL ratings).
      if (query.minRating) conditions.push(gte(images.rating, query.minRating))
      // SQLite's LIKE is case-insensitive for ASCII by default (design §7), so
      // a plain substring pattern already satisfies "case-insensitive".
      if (query.stem) conditions.push(like(images.stem, `%${query.stem}%`))
      const where = conditions.length > 0 ? and(...conditions) : undefined

      const sortCol = sort === 'name' ? images.stem : images.captureAt

      const [rows, countResult] = await Promise.all([
        db
          .select()
          .from(images)
          .where(where)
          .orderBy(order === 'asc' ? asc(sortCol) : desc(sortCol))
          .limit(limit)
          .offset(offset),
        db.select({ count: count() }).from(images).where(where),
      ])

      return { data: rows.map(toImageDto), total: Number(countResult[0]?.count ?? 0) }
    },
    {
      query: z.object({
        root: z.enum(['fuji', 'raws', 'share']).optional(),
        dir: z.string().optional(),
        kind: z.enum(['jpeg', 'raw', 'image', 'other']).optional(),
        // NOT z.coerce.boolean(): query params arrive as strings and
        // `Boolean('false')` is true, which made `?recursive=false` recursive.
        recursive: z.stringbool().default(false).optional(),
        minRating: z.coerce.number().int().min(0).max(5).optional(),
        stem: z
          .string()
          .optional()
          .describe('Case-insensitive substring match against the filename stem'),
        page: z.coerce.number().int().min(1).default(1).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50).optional(),
        sort: z.enum(['captureAt', 'name']).default('captureAt').optional(),
        order: z.enum(['asc', 'desc']).default('desc').optional(),
      }),
      response: { 200: z.object({ data: z.array(ImageDto), total: z.number().int() }) },
      detail: {
        tags: ['Library'],
        summary: 'List images in a folder',
        description:
          'Paginated image list filtered by root/dir (optionally recursive), kind, minimum rating (0 = no filter) and a case-insensitive filename-stem substring. `total` is the unfiltered-by-pagination count. Fetch bytes via GET /library/images/{id}/file.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .delete(
    '/api/images/:id',
    async ({ params, status }) => {
      const [row] = await db.select().from(images).where(eq(images.id, params.id)).limit(1)
      if (!row) return status(404, 'Image not found')
      if (row.root !== 'share') {
        return status(
          403,
          `Only root='share' images can be deleted (this image is root='${row.root}', a read-only source tree)`,
        )
      }

      const absPath = safeJoin(rootBaseDir(row.root), row.relPath)
      await unlinkIfExists(absPath)

      for (const size of RENDITION_SIZES) {
        const key = renditionCacheKey({
          root: row.root,
          relPath: row.relPath,
          mtimeMs: row.mtimeMs,
          fileSize: row.fileSize,
          size,
        })
        await unlinkIfExists(renditionCachePath(key, size))
      }

      // b2_objects.published_image_id has no cascading FK (design §4) — a
      // published copy stays on B2/the CDN forever, so null the back-link
      // instead of touching the object.
      await db
        .update(b2Objects)
        .set({ publishedImageId: null })
        .where(eq(b2Objects.publishedImageId, row.id))

      // share_images rows cascade automatically (schema onDelete: 'cascade').
      await db.delete(images).where(eq(images.id, row.id))

      return { deleted: true }
    },
    {
      params: z.object({ id: z.coerce.number().int() }),
      response: {
        200: z.object({ deleted: z.boolean() }),
        403: z.string(),
        404: z.string(),
      },
      detail: {
        tags: ['Library'],
        summary: 'Delete a share-root image',
        description:
          "Deletes an image by id: only root='share' images may be deleted (fuji/raws are read-only source trees, rejected with 403). Removes the file under SHARE_ROOT, its cached renditions, and the images row. If the image was published to B2, the b2_objects row is kept but its published_image_id link is cleared — the CDN object itself is never deleted here. 404 on an unknown id.",
        security: [{ BearerAuth: [] }],
      },
    },
  )

// Public byte-serving route — bearer header OR ?access_token=<API_SECRET>.
export const libraryFileRoutes = new Elysia({ name: 'library-file' }).get(
  '/api/library/images/:id/file',
  async ({ params, query, request, status, set }) => {
    const header = request.headers.get('authorization')
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null
    const ok = bearer === env.API_SECRET || query.access_token === env.API_SECRET
    if (!ok) return status(401, 'Unauthorized')

    const [row] = await db.select().from(images).where(eq(images.id, params.id)).limit(1)
    if (!row) return status(404, 'Image not found')

    const absPath = safeJoin(rootBaseDir(row.root), row.relPath)

    set.headers['cache-control'] = 'private, max-age=31536000, immutable'

    if (query.size === 'orig') {
      set.headers['content-type'] = contentTypeForExt(row.ext)
      return Bun.file(absPath)
    }

    const rendition = await renderRendition({
      absPath,
      size: query.size,
      root: row.root,
      relPath: row.relPath,
      mtimeMs: row.mtimeMs,
      fileSize: row.fileSize,
    })
    set.headers['content-type'] = rendition.contentType
    return Bun.file(rendition.path)
  },
  {
    params: z.object({ id: z.coerce.number().int() }),
    query: z.object({
      size: z.enum(['thumb', 'med', 'full', 'orig']).default('thumb'),
      access_token: z.string().optional().describe('API_SECRET, for browser <img> tags only'),
    }),
    detail: {
      tags: ['Library'],
      summary: 'Serve image bytes (rendition or original)',
      description:
        'Returns bytes for a library image by id: size=thumb|med|full renders a cached rendition; size=orig serves the original file. Accepts the bearer header OR `?access_token=<API_SECRET>` so browser `<img>` tags can load thumbnails. This is the ONLY route accepting access_token.',
      security: [{ BearerAuth: [] }],
    },
  },
)

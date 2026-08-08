import { unlink } from 'node:fs/promises'
import { Elysia } from 'elysia'
import { z } from 'zod'
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  like,
  lte,
  notExists,
  sql,
  type SQL,
} from 'drizzle-orm'
import { db } from '../db/index.js'
import { b2Objects, imageKeywords, images, type ImageRow } from '../db/schema.js'
import { env } from '../env.js'
import { albumAtOrBelow } from '../lib/album-scope.js'
import { mintAssetToken, verifyAssetToken } from '../lib/asset-token.js'
import { dirAtOrBelow } from '../lib/dir-scope.js'
import { rootBaseDir, safeJoin } from '../lib/paths.js'
import { renditionCacheKey, renditionCachePath, type RenditionSize } from '../renditions/cache.js'
import { renderRendition } from '../renditions/render.js'

// Every size that can end up in DATA_DIR/renditions, so DELETE /api/images/:id
// leaves nothing behind. `small` is not addressable on the admin byte route but
// IS generated in production — the share page puts `?size=small` in every tile's
// srcset (share/page/index.ts) — so omitting it orphaned a 900px webp of a
// deleted photo until the age/size sweep ran.
const RENDITION_SIZES: readonly RenditionSize[] = ['thumb', 'small', 'med', 'full']

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
// a short-lived `?assetToken=…` minted by POST /api/library/asset-token (see
// lib/asset-token.ts) and does its own check (mirrors argo's audioFileRoutes
// precedent). The raw API_SECRET is never accepted as a query value — only
// the asset token, which is scoped to this one route and expires in an hour.

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

// ── Albums (the virtual folder tree) ─────────────────────────────────────────
// The Fuji tree is one flat directory, so `images.dir` carries no structure —
// the hierarchy lives in the Lightroom keywords mirrored into `image_keywords`
// (design §4). This DTO is deliberately DirDto-shaped so the admin can render
// either tree with one component; `rawPairedCount` is dropped because an album
// is a JPEG-only concept (RAFs carry no keywords).
const AlbumNodeDto = z.object({
  path: z.string().describe("Full hierarchical path, e.g. 'Ereignisse|Segeln 25'; '' = untagged"),
  leaf: z.string().describe("Last path segment; '(untagged)' for the synthetic untagged node"),
  depth: z.number().int().describe('Zero-based nesting level (number of `|` separators)'),
  imageCount: z.number().int().describe('Recursive, per-image deduped count of kind=jpeg images'),
  ratedCounts: z
    .object({ r4plus: z.number().int(), r5: z.number().int() })
    .describe('Counts of images at rating thresholds'),
  minCaptureAt: z.string().nullable(),
  maxCaptureAt: z.string().nullable(),
})

/**
 * Correlated "this image has a keyword row (optionally inside `scope`)"
 * subquery, for wrapping in `exists` / `notExists`. A subquery rather than a
 * join: an image tagged with two paths in the same subtree would otherwise be
 * returned — and counted in `total` — twice.
 */
function keywordExistsFor(scope?: SQL) {
  return db
    .select({ one: sql`1` })
    .from(imageKeywords)
    .where(
      scope
        ? and(eq(imageKeywords.imageId, images.id), scope)
        : eq(imageKeywords.imageId, images.id),
    )
}

// `capture_at` is stored as a UTC `toISOString()` string (indexer/metadata.ts),
// so a range filter is a lexicographic compare on the same normalized shape —
// which is also what keeps `images_capture_at_idx` sargable.
const CaptureBoundSchema = z.union([z.iso.datetime({ offset: true }), z.iso.date()])
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Normalize a capture bound to the stored UTC-instant shape. A bare
 * `YYYY-MM-DD` is a whole UTC day, inclusive at BOTH ends (the friend-facing
 * ask is "the Mallorca week", not "midnight to midnight"), so the upper bound
 * lands on `…T23:59:59.999Z`. A full datetime — offset form included — is
 * round-tripped through `Date` so `+02:00` compares correctly against the
 * stored `Z` strings instead of being compared byte-wise.
 */
function toCaptureInstant(value: string, edge: 'start' | 'end'): string {
  if (DATE_ONLY_RE.test(value)) {
    return `${value}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}Z`
  }
  return new Date(value).toISOString()
}

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
          'Returns every directory the indexer knows about across all roots, each with image counts, rated-image counts, RAW-paired count, and the capture-date range. Powers the admin left-hand dir tree. Note `imageCount` here is that directory ALONE (rows are grouped by exact `dir`), unlike the recursive counts of GET /library/albums. Use GET /library/images?root=…&dir=… to list a folder’s images — it is recursive by default (matching a folder share), so pass `recursive=false` to see exactly the count this route reports.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .get(
    '/api/library/albums',
    async ({ query }) => {
      const root = query.root ?? 'fuji'
      const scope = and(eq(images.root, root), eq(images.kind, 'jpeg'))

      // One pass over (keyword × image) for the whole root and aggregate in
      // memory: the tree needs a per-node DISTINCT image count over an
      // ancestor-expanded path set, which SQL can only do with one recursive
      // CTE per node. The real library is ~600 keyword rows against 2.4k
      // images — a single indexed scan, far cheaper than the query it replaces.
      const rows = await db
        .select({
          imageId: imageKeywords.imageId,
          path: imageKeywords.path,
          rating: images.rating,
          captureAt: images.captureAt,
        })
        .from(imageKeywords)
        .innerJoin(images, eq(imageKeywords.imageId, images.id))
        .where(scope)

      const meta = new Map<number, { rating: number | null; captureAt: string | null }>()
      // path → the set of images at or below it. Ancestors are synthesized
      // here, not in the table (schema.ts): a stored 'Ereignisse|Segeln 25'
      // yields both an 'Ereignisse' and an 'Ereignisse|Segeln 25' node. The Set
      // is what makes an image tagged with two sibling paths count once in
      // their shared parent.
      const members = new Map<string, Set<number>>()

      for (const row of rows) {
        meta.set(row.imageId, { rating: row.rating, captureAt: row.captureAt })
        // '' is the untagged node's reserved path — a malformed empty keyword
        // must never merge into it.
        if (row.path === '') continue
        let prefix = ''
        for (const segment of row.path.split('|')) {
          prefix = prefix === '' ? segment : `${prefix}|${segment}`
          let set = members.get(prefix)
          if (!set) {
            set = new Set<number>()
            members.set(prefix, set)
          }
          set.add(row.imageId)
        }
      }

      const [untagged] = await db
        .select({
          imageCount: count(),
          r4plus: sql<number>`sum(case when ${images.rating} >= 4 then 1 else 0 end)`,
          r5: sql<number>`sum(case when ${images.rating} = 5 then 1 else 0 end)`,
          minCaptureAt: sql<string | null>`min(${images.captureAt})`,
          maxCaptureAt: sql<string | null>`max(${images.captureAt})`,
        })
        .from(images)
        .where(and(scope, notExists(keywordExistsFor())))

      const data: z.infer<typeof AlbumNodeDto>[] = [
        {
          path: '',
          leaf: '(untagged)',
          depth: 0,
          imageCount: Number(untagged?.imageCount ?? 0),
          ratedCounts: { r4plus: Number(untagged?.r4plus ?? 0), r5: Number(untagged?.r5 ?? 0) },
          minCaptureAt: untagged?.minCaptureAt ?? null,
          maxCaptureAt: untagged?.maxCaptureAt ?? null,
        },
      ]

      // Code-unit sort, matching the BINARY collation lib/album-scope.ts ranges
      // over — so the emitted order is the order its subtree bounds assume.
      for (const path of [...members.keys()].toSorted()) {
        const ids = members.get(path)!
        let r4plus = 0
        let r5 = 0
        let minCaptureAt: string | null = null
        let maxCaptureAt: string | null = null
        for (const id of ids) {
          const m = meta.get(id)
          if (!m) continue
          if (m.rating !== null && m.rating >= 4) r4plus++
          if (m.rating === 5) r5++
          if (m.captureAt !== null) {
            if (minCaptureAt === null || m.captureAt < minCaptureAt) minCaptureAt = m.captureAt
            if (maxCaptureAt === null || m.captureAt > maxCaptureAt) maxCaptureAt = m.captureAt
          }
        }
        const segments = path.split('|')
        data.push({
          path,
          leaf: segments[segments.length - 1] ?? path,
          depth: segments.length - 1,
          imageCount: ids.size,
          ratedCounts: { r4plus, r5 },
          minCaptureAt,
          maxCaptureAt,
        })
      }

      return { data }
    },
    {
      query: z.object({
        root: z.enum(['fuji', 'raws', 'share']).default('fuji').optional(),
      }),
      response: { 200: z.object({ data: z.array(AlbumNodeDto) }) },
      detail: {
        tags: ['Library'],
        summary: 'List the album tree (Lightroom keyword hierarchy)',
        description:
          "The virtual folder tree the admin browses instead of directories: the Fuji tree is one flat directory, so the hierarchy that matters is the one Lightroom wrote into the JPEGs (XMP-lr:HierarchicalSubject → `image_keywords`). Returns one node per distinct path PREFIX — a stored 'Ereignisse|Segeln 25' emits both an 'Ereignisse' node and an 'Ereignisse|Segeln 25' node — plus a synthetic node with path='' and leaf='(untagged)' covering every kind=jpeg image with no keywords at all (today the majority of the library, so it is a first-class node, not an edge case; it is always emitted, even at count 0). `imageCount` is RECURSIVE (the node and everything below it) and deduped per image, so an image tagged with two paths under the same parent counts once there. Only kind='jpeg' images are counted — RAFs carry no keywords. Sorted by path, so the untagged node comes first. Feed a node's `path` back into GET /library/images?root=…&kind=jpeg&album=… as the count preview (leave `recursive` unset — it defaults to true on this route and in POST /api/shares alike, so the preview is recursive exactly like this node's `imageCount`), or feed its emptiness into ?untagged=true. An album share is scoped to the SAME `root` as the tree it was previewed in, so a node's `imageCount` is the share's membership (before `minRating`).",
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .get(
    '/api/library/images',
    async ({ query, status }) => {
      // Two different questions about the same axis — "inside this album" and
      // "in no album at all" — so a request asking both is a client bug, not a
      // silent empty result.
      if (query.album !== undefined && query.untagged !== undefined) {
        return status(400, 'album and untagged are mutually exclusive')
      }

      const page = query.page ?? 1
      const limit = query.limit ?? 50
      const sort = query.sort ?? 'captureAt'
      const order = query.order ?? 'desc'
      const offset = (page - 1) * limit

      // Defaults to TRUE, matching `recursive ?? true` in POST /api/shares for
      // both a folder and an album source. This route IS the create-share count
      // preview (design §12), so an unspecified `recursive` MUST resolve the
      // same way on both sides or the operator approves one number and ships
      // another. True — not false — because the share side is the one that
      // can't move: the DB column defaults to 1 (design §4), every existing
      // folder share was created under it, and GET /library/albums reports
      // RECURSIVE per-node counts, so a non-recursive preview of an interior
      // node like 'Ereignisse' would report ~0 for a 558-image subtree.
      const recursive = query.recursive ?? true

      const conditions = []
      if (query.root) conditions.push(eq(images.root, query.root))
      if (query.kind) conditions.push(eq(images.kind, query.kind))
      if (query.dir !== undefined) {
        if (recursive) {
          // Same byte-exact scope builder the folder-share filter uses, so the
          // create-share count preview matches the share's real membership.
          // dir='' is the unconstrained predicate here for the same reason it is
          // in shareImageFilter: recursive from the root is the whole root.
          if (query.dir !== '') conditions.push(dirAtOrBelow(query.dir))
        } else {
          conditions.push(eq(images.dir, query.dir))
        }
      }
      if (query.album !== undefined) {
        // Same scope builder the album-share membership filter uses, and the
        // same string-boolean `recursive` toggle as `dir`. album='' is the
        // unconstrained predicate, i.e. "in any album" — the exact complement
        // of untagged=true.
        conditions.push(exists(keywordExistsFor(albumAtOrBelow(query.album, recursive))))
      }
      if (query.untagged) conditions.push(notExists(keywordExistsFor()))
      if (query.captureFrom) {
        conditions.push(gte(images.captureAt, toCaptureInstant(query.captureFrom, 'start')))
      }
      if (query.captureTo) {
        conditions.push(lte(images.captureAt, toCaptureInstant(query.captureTo, 'end')))
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
        // Applies to `dir` and `album` alike. Default true — see the handler.
        recursive: z
          .stringbool()
          .default(true)
          .optional()
          .describe(
            'Include sub-directories of `dir` / sub-albums below `album` (default true, the same default POST /api/shares applies to a folder or album source). Send `recursive=false` for that folder/album exactly.',
          ),
        album: z
          .string()
          .optional()
          .describe(
            "Lightroom keyword path from GET /library/albums, e.g. 'Ereignisse|Segeln 25'; scoped by `recursive`. '' means any album.",
          ),
        // Same string-boolean reasoning as `recursive`.
        untagged: z
          .stringbool()
          .optional()
          .describe('Only images with no keywords at all. 400 if combined with `album`.'),
        captureFrom: CaptureBoundSchema.optional().describe(
          'Inclusive lower capture-date bound: an ISO instant, or a bare YYYY-MM-DD meaning that whole UTC day from 00:00:00.000Z',
        ),
        captureTo: CaptureBoundSchema.optional().describe(
          'Inclusive upper capture-date bound: an ISO instant, or a bare YYYY-MM-DD meaning that whole UTC day through 23:59:59.999Z',
        ),
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
      response: {
        200: z.object({ data: z.array(ImageDto), total: z.number().int() }),
        400: z.string(),
      },
      detail: {
        tags: ['Library'],
        summary: 'List images by album, capture date or folder',
        description:
          "Paginated image list. Every filter composes (AND): root, dir, album (a GET /library/albums path, matching at or below it) OR untagged=true (no keywords at all — the two are mutually exclusive, 400 if both are sent), captureFrom/captureTo (inclusive; a bare YYYY-MM-DD is that whole UTC day, so ?captureFrom=2026-07-04&captureTo=2026-07-11 is 'the Mallorca week'), kind, minimum rating (0 = no filter) and a case-insensitive filename-stem substring. `dir` and `album` are both scoped by `recursive`, which defaults to TRUE — the same default POST /api/shares applies — so this route is a faithful count preview of the share a scope would produce: ?root=fuji&kind=jpeg&album=X (plus minRating, if any) returns the `total` that POST /api/shares {source:{type:'album',album:'X'}} will contain, and the same holds for dir/folder. Images with a NULL capture_at are excluded once either date bound is set. `total` is the unfiltered-by-pagination count. Fetch bytes via GET /library/images/{id}/file.",
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
  .post('/api/library/asset-token', () => mintAssetToken(), {
    response: {
      200: z.object({
        token: z.string(),
        expiresAt: z.string().describe('ISO 8601 token expiry'),
      }),
    },
    detail: {
      tags: ['Library'],
      summary: 'Mint a short-lived asset token',
      description:
        'Issues an HMAC-signed token scoped to GET /library/images/{id}/file, valid for 1 hour. The admin SPA mints one per session and appends it as `?assetToken=…` so browser `<img>` tags can load thumbnails without carrying the bearer secret in a URL.',
      security: [{ BearerAuth: [] }],
    },
  })

// Public byte-serving route — bearer header OR a short-lived ?assetToken=….
export const libraryFileRoutes = new Elysia({ name: 'library-file' }).get(
  '/api/library/images/:id/file',
  async ({ params, query, request, status, set }) => {
    const header = request.headers.get('authorization')
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null
    const ok = bearer === env.API_SECRET || verifyAssetToken(query.assetToken)
    if (!ok) return status(401, 'Unauthorized')

    const [row] = await db.select().from(images).where(eq(images.id, params.id)).limit(1)
    if (!row) return status(404, 'Image not found')

    const absPath = safeJoin(rootBaseDir(row.root), row.relPath)

    set.headers['cache-control'] = 'private, max-age=31536000, immutable'

    if (query.size === 'orig') {
      set.headers['content-type'] = contentTypeForExt(row.ext)
      return Bun.file(absPath)
    }

    // RAF has no rendition (design §6) — renderRendition rejects it, which
    // without this guard surfaced as an unhandled 500 per tile. A grid browsing
    // the raws root must never ask, but a hand-built URL still gets a real
    // answer instead of an error page.
    if (row.kind === 'raw') {
      return status(415, 'RAW files have no rendition — request ?size=orig for the original bytes')
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
      assetToken: z
        .string()
        .optional()
        .describe(
          'Short-lived asset token from POST /api/library/asset-token, for browser <img> tags',
        ),
    }),
    detail: {
      tags: ['Library'],
      summary: 'Serve image bytes (rendition or original)',
      description:
        'Returns bytes for a library image by id: size=thumb|med|full renders a cached rendition; size=orig serves the original file. A `kind=raw` row (RAF) has no rendition and answers 415 for every size but `orig`. Accepts the bearer header OR `?assetToken=…` (minted by POST /api/library/asset-token) so browser `<img>` tags can load thumbnails without carrying the bearer secret in a URL. This is the ONLY route accepting assetToken.',
      security: [{ BearerAuth: [] }],
    },
  },
)

import { basename, extname } from 'node:path'
import { Elysia } from 'elysia'
import { z } from 'zod'
import { and, asc, count, desc, eq, isNull, like, sql } from 'drizzle-orm'
import { getB2ReconcileStatus, runB2Reconcile } from '../cron/b2-reconcile.js'
import { runReverseBackup } from '../cron/reverse-backup.js'
import { db } from '../db/index.js'
import { b2Objects } from '../db/schema.js'
import { env } from '../env.js'
import { cdnOriginalUrl, cdnThumbUrl } from '../lib/cdn.js'
import { assertValidSubdir, deriveObjectFilename } from '../lib/naming.js'
import { getS3 } from '../lib/s3.js'
import { assertUploadableFile } from '../lib/upload-guard.js'

// B2 object views + maintenance actions (design §8, extended in stage 4 for
// the admin Public page: prefix/sort/pagination on the list, plus delete and
// direct-to-B2 upload). Reads the b2_objects mirror table; reconcile +
// reverse-backup run the corresponding jobs on demand.

const B2_PREFIX_GROUP = ['fuji', 'blog', 'gen', 'misc'] as const
const THUMB_WIDTH = 480 // matches the renditions 'thumb' size (design §6)

const B2ObjectDto = z.object({
  key: z.string(),
  size: z.number().int(),
  lastModified: z.string(),
  etag: z.string().nullable(),
  mirrored: z.boolean().describe('Whether the key has been pulled into B2_MIRROR_DIR'),
  publishedImageId: z.number().int().nullable(),
  firstSeenAt: z.string(),
  cdnUrl: z.string().describe('Original-bytes img.jkrumm.com URL'),
  thumbUrl: z.string().describe(`Resized (rs:fit:${THUMB_WIDTH}) img.jkrumm.com URL`),
})

/** Validates a decoded B2 key is inside the managed prefix and free of
 * traversal segments. Throws a plain Error (routes surface it as a 400) —
 * this is the single guard both DELETE and upload key-construction go through. */
function assertManagedKey(key: string): void {
  if (!key.startsWith(env.B2_PREFIX)) {
    throw new Error(`key must start with the managed prefix "${env.B2_PREFIX}"`)
  }
  if (key.includes('..') || key.includes('\0')) {
    throw new Error('key contains a traversal segment')
  }
}

function sanitizeUploadFilename(originalName: string): string {
  const ext = extname(originalName)
  const rawStem = basename(originalName, ext) || 'upload'
  const stem = rawStem.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'upload'
  return `${stem}${ext}`
}

export const b2Routes = new Elysia({ name: 'b2' })
  .get(
    '/api/b2',
    async ({ query }) => {
      const page = query.page ?? 1
      const limit = query.limit ?? 50
      const sort = query.sort ?? 'lastModified'
      const order = query.order ?? 'desc'
      const offset = (page - 1) * limit

      const conditions = []
      if (query.prefix && query.prefix !== 'all') {
        conditions.push(like(b2Objects.key, `${env.B2_PREFIX}${query.prefix}/%`))
      }
      // SQLite's LIKE is case-insensitive for ASCII by default (design §7), so
      // a plain substring pattern already satisfies "case-insensitive".
      if (query.q) conditions.push(like(b2Objects.key, `%${query.q}%`))
      const where = conditions.length > 0 ? and(...conditions) : undefined

      const sortCol =
        sort === 'key' ? b2Objects.key : sort === 'size' ? b2Objects.size : b2Objects.lastModified

      const [rows, countResult, totalBytesResult, unmirroredResult] = await Promise.all([
        db
          .select()
          .from(b2Objects)
          .where(where)
          .orderBy(order === 'asc' ? asc(sortCol) : desc(sortCol))
          .limit(limit)
          .offset(offset),
        db.select({ count: count() }).from(b2Objects).where(where),
        db.select({ sum: sql<number>`coalesce(sum(${b2Objects.size}), 0)` }).from(b2Objects),
        db.select({ count: count() }).from(b2Objects).where(isNull(b2Objects.mirroredAt)),
      ])

      return {
        data: rows.map((row) => ({
          key: row.key,
          size: row.size,
          lastModified: row.lastModified,
          etag: row.etag,
          mirrored: row.mirroredAt !== null,
          publishedImageId: row.publishedImageId,
          firstSeenAt: row.firstSeenAt,
          cdnUrl: cdnOriginalUrl(row.key),
          thumbUrl: cdnThumbUrl(row.key, THUMB_WIDTH),
        })),
        total: Number(countResult[0]?.count ?? 0),
        totalBytes: Number(totalBytesResult[0]?.sum ?? 0),
        unmirroredCount: Number(unmirroredResult[0]?.count ?? 0),
        lastReconcileAt: getB2ReconcileStatus().lastFinishedAt,
      }
    },
    {
      query: z.object({
        prefix: z
          .enum(['all', ...B2_PREFIX_GROUP])
          .optional()
          .describe('Filter by the img/<prefix>/ grouping; omit or "all" for everything'),
        q: z
          .string()
          .optional()
          .describe('Case-insensitive substring match against the object key'),
        page: z.coerce.number().int().min(1).default(1).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50).optional(),
        sort: z.enum(['lastModified', 'key', 'size']).default('lastModified').optional(),
        order: z.enum(['asc', 'desc']).default('desc').optional(),
      }),
      response: {
        200: z.object({
          data: z.array(B2ObjectDto),
          total: z.number().int(),
          totalBytes: z.number().int().describe('Sum of size across ALL objects (unfiltered)'),
          unmirroredCount: z.number().int().describe('Count lacking mirrored_at (unfiltered)'),
          lastReconcileAt: z.string().nullable().describe('When the bucket was last reconciled'),
        }),
      },
      detail: {
        tags: ['Backblaze'],
        summary: 'List mirrored B2 objects',
        description:
          'Paginated view of the b2_objects table (the local mirror of the bucket keyspace), filterable by the img/<prefix>/ grouping and a case-insensitive key substring (`q`), and sortable by lastModified/key/size. Each row flags whether it has been reverse-mirrored locally, links to the library image it was published from (if any), and carries ready-to-use CDN URLs. totalBytes/unmirroredCount/lastReconcileAt are always bucket-wide, ignoring the prefix/q filters, so the admin Public page can show cache health regardless of the active filter.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .post(
    '/api/b2/reconcile',
    ({ set }) => {
      void Promise.resolve()
        .then(() => runB2Reconcile())
        .catch(() => {
          /* fail-soft; logged inside the job */
        })
      set.status = 202
      return { started: true }
    },
    {
      response: { 202: z.object({ started: z.boolean() }) },
      detail: {
        tags: ['Backblaze'],
        summary: 'Reconcile the B2 bucket into b2_objects',
        description:
          'Starts a background job that lists the img/ keyspace via S3 and upserts/removes b2_objects rows so out-of-band uploads (photoflow/rclone) appear locally. Returns 202 immediately.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .post(
    '/api/b2/upload',
    async ({ body, status }) => {
      try {
        assertUploadableFile(body.file)
      } catch (err) {
        return status(400, err instanceof Error ? err.message : 'Invalid file')
      }

      if (body.subdir) {
        try {
          assertValidSubdir(body.subdir)
        } catch (err) {
          return status(400, err instanceof Error ? err.message : 'Invalid subdir')
        }
      }

      const filename = deriveObjectFilename(body.prefix, sanitizeUploadFilename(body.file.name))
      const key = body.subdir
        ? `${env.B2_PREFIX}${body.prefix}/${body.subdir}/${filename}`
        : `${env.B2_PREFIX}${body.prefix}/${filename}`

      const s3 = getS3()
      if (await s3.exists(key)) {
        return { uploaded: false, key, cdnUrl: cdnOriginalUrl(key), reason: 'key already exists' }
      }

      const bytes = await body.file.bytes()
      await s3.put(key, bytes)

      const now = new Date().toISOString()
      // onConflictDoUpdate: a stale mirror row can survive an out-of-band S3
      // delete (s3.exists() above only checks the live bucket), so a re-upload
      // to the same key must upsert rather than plain-insert — otherwise the
      // UNIQUE violation on the key PK would 500 an upload that already
      // succeeded against S3. Only refreshes what the new upload actually
      // changed (size/lastModified/etag/mirrored); firstSeenAt and
      // publishedImageId are left untouched.
      await db
        .insert(b2Objects)
        .values({
          key,
          size: bytes.byteLength,
          lastModified: now,
          firstSeenAt: now,
        })
        .onConflictDoUpdate({
          target: b2Objects.key,
          set: { size: bytes.byteLength, lastModified: now, etag: null, mirroredAt: null },
        })

      return { uploaded: true, key, cdnUrl: cdnOriginalUrl(key) }
    },
    {
      body: z.object({
        file: z.file().describe('The image file to upload'),
        prefix: z.enum(B2_PREFIX_GROUP),
        subdir: z
          .string()
          .optional()
          .describe(
            'Optional nested path under <prefix>/, e.g. "2026/07/trip" (preserves imgcli sync directory structure). Segments must match [A-Za-z0-9._-]+, no leading/trailing slash, no "." or ".." segment, max 8 segments, max 200 chars total — rejected with 400 otherwise.',
          ),
      }),
      response: {
        200: z.object({
          uploaded: z.boolean(),
          key: z.string(),
          cdnUrl: z.string(),
          reason: z.string().optional().describe('Present when uploaded is false'),
        }),
        400: z.string(),
      },
      detail: {
        tags: ['Backblaze'],
        summary: 'Upload a file straight to the B2 img/ keyspace',
        description:
          'Multipart upload directly to B2 under img/<prefix>/<filename> (prefix ∈ fuji|blog|gen|misc), or img/<prefix>/<subdir>/<filename> when subdir is given — never touches the local disk roots. Rejects (400) an extension/MIME type the indexer would not recognize or a file over 50 MB, same guard as POST /api/images. subdir is validated strictly (it becomes part of an object key): no leading/trailing slash, no empty/"."/".." segment, segment chars restricted to [A-Za-z0-9._-], max 8 segments, max 200 chars total — any violation is a 400 before B2 is touched. Readable prefixes (fuji/blog) use the sanitized upload filename; opaque prefixes (gen/misc) mint a random 16-char [a-z0-9] basename via lib/naming.ts instead (same rule as POST /api/publish), nested under subdir when present. Skips (does not overwrite) a key that already exists on B2, mirroring POST /api/publish. Upserts b2_objects on success (refreshing size/lastModified/etag/mirrored, preserving firstSeenAt/publishedImageId if a stale row exists) and returns the CDN URL.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .get(
    '/api/b2/:key',
    async ({ params, status }) => {
      let key: string
      try {
        key = decodeURIComponent(params.key)
      } catch {
        return status(400, 'Malformed key encoding')
      }

      try {
        assertManagedKey(key)
      } catch (err) {
        return status(400, err instanceof Error ? err.message : 'Invalid key')
      }

      const object = await getS3().head(key)
      if (!object) {
        return status(404, 'Object not found')
      }

      // Mirror row is looked up separately from the live head() — a key can
      // exist on B2 without ever having been mirrored locally (e.g. an
      // out-of-band upload before the next reconcile tick), so the mirror
      // fields are best-effort, not guaranteed.
      const [mirrorRow] = await db.select().from(b2Objects).where(eq(b2Objects.key, key)).limit(1)

      return {
        key: object.key,
        size: object.size,
        lastModified: object.lastModified,
        etag: object.etag ?? null,
        cdnUrl: cdnOriginalUrl(key),
        mirrored: mirrorRow?.mirroredAt != null,
        publishedImageId: mirrorRow?.publishedImageId ?? null,
        firstSeenAt: mirrorRow?.firstSeenAt ?? null,
      }
    },
    {
      params: z.object({
        key: z.string().describe('URL-encoded full B2 key, e.g. img%2Ffuji%2Fx.jpg'),
      }),
      response: {
        200: z.object({
          key: z.string(),
          size: z.number().int(),
          lastModified: z.string(),
          etag: z.string().nullable(),
          cdnUrl: z.string().describe('Original-bytes img.jkrumm.com URL'),
          mirrored: z.boolean().describe('Whether the key has been pulled into B2_MIRROR_DIR'),
          publishedImageId: z.number().int().nullable(),
          firstSeenAt: z.string().nullable().describe('Null when there is no b2_objects row'),
        }),
        400: z.string(),
        404: z.string(),
      },
      detail: {
        tags: ['Backblaze'],
        summary: 'Get live B2 object info',
        description:
          'Head-requests a single key directly against the bucket (unlike GET /api/b2, which reads the local b2_objects mirror table) and joins in whatever mirror metadata exists for that key. The key must be URL-encoded (slashes included) as a single path segment and must start with the managed img/ prefix, same rule as DELETE /api/b2/:key — malformed encoding or an unmanaged/traversal key is a 400. 404 if the key does not exist on B2. mirrored/publishedImageId/firstSeenAt come from the b2_objects row when one exists (null/false otherwise) — a key can be on B2 without a mirror row if it was uploaded out-of-band before the next reconcile tick.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .delete(
    '/api/b2/:key',
    async ({ params, status }) => {
      let key: string
      try {
        key = decodeURIComponent(params.key)
      } catch {
        return status(400, 'Malformed key encoding')
      }

      try {
        assertManagedKey(key)
      } catch (err) {
        return status(400, err instanceof Error ? err.message : 'Invalid key')
      }

      await getS3().delete(key)
      await db.delete(b2Objects).where(eq(b2Objects.key, key))
      return { deleted: true }
    },
    {
      params: z.object({
        key: z.string().describe('URL-encoded full B2 key, e.g. img%2Ffuji%2Fx.jpg'),
      }),
      response: { 200: z.object({ deleted: z.boolean() }), 400: z.string() },
      detail: {
        tags: ['Backblaze'],
        summary: 'Delete an object from B2',
        description:
          'Deletes a key from the bucket and its b2_objects row. The key must be URL-encoded (slashes included) as a single path segment and must start with the managed img/ prefix — anything else, including traversal segments, is rejected with 400 before touching B2. Destructive and irreversible.',
        security: [{ BearerAuth: [] }],
      },
    },
  )

// Reverse backup lives at /api/backup/reverse-run (design §8), not under /b2.
export const backupRoutes = new Elysia({ name: 'backup' }).post(
  '/api/backup/reverse-run',
  ({ set }) => {
    void Promise.resolve()
      .then(() => runReverseBackup())
      .catch(() => {
        /* fail-soft; logged inside the job */
      })
    set.status = 202
    return { started: true }
  },
  {
    response: { 202: z.object({ started: z.boolean() }) },
    detail: {
      tags: ['Backblaze'],
      summary: 'Run the reverse backup (B2 → HomeLab)',
      description:
        'Starts a background pull of every b2_objects key lacking mirrored_at (or with a changed etag) into B2_MIRROR_DIR/<key minus img/>, setting mirrored_at, then pings UPTIME_KUMA_PUSH_URL if configured. Covers direct-public files whose only home is B2. Returns 202 immediately.',
      security: [{ BearerAuth: [] }],
    },
  },
)

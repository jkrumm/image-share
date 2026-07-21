import { Elysia } from 'elysia'
import { z } from 'zod'
import { count, like } from 'drizzle-orm'
import { runB2Reconcile } from '../cron/b2-reconcile.js'
import { runReverseBackup } from '../cron/reverse-backup.js'
import { db } from '../db/index.js'
import { b2Objects } from '../db/schema.js'

// B2 object views + maintenance actions (design §8). Reads the b2_objects
// mirror table; reconcile + reverse-backup run the corresponding jobs on demand.
const B2ObjectDto = z.object({
  key: z.string(),
  size: z.number().int(),
  lastModified: z.string(),
  etag: z.string().nullable(),
  mirrored: z.boolean().describe('Whether the key has been pulled into B2_MIRROR_DIR'),
  publishedImageId: z.number().int().nullable(),
  firstSeenAt: z.string(),
})

export const b2Routes = new Elysia({ name: 'b2' })
  .get(
    '/api/b2',
    async ({ query }) => {
      const page = query.page ?? 1
      const limit = query.limit ?? 50
      const offset = (page - 1) * limit
      const where = query.prefix ? like(b2Objects.key, `${query.prefix}%`) : undefined

      const [rows, countResult] = await Promise.all([
        db.select().from(b2Objects).where(where).limit(limit).offset(offset),
        db.select({ count: count() }).from(b2Objects).where(where),
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
        })),
        total: Number(countResult[0]?.count ?? 0),
      }
    },
    {
      query: z.object({
        prefix: z.string().optional().describe('Filter by key prefix'),
        page: z.coerce.number().int().min(1).default(1).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50).optional(),
      }),
      response: { 200: z.object({ data: z.array(B2ObjectDto), total: z.number().int() }) },
      detail: {
        tags: ['Backblaze'],
        summary: 'List mirrored B2 objects',
        description:
          'Paginated view of the b2_objects table (the local mirror of the bucket keyspace), optionally filtered by key prefix. Each row flags whether it has been reverse-mirrored locally and links to the library image it was published from (if any).',
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

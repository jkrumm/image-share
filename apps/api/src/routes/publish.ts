import { Elysia } from 'elysia'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { getS3 } from '../lib/s3.js'
import { db } from '../db/index.js'
import { images, b2Objects } from '../db/schema.js'
import { env } from '../env.js'
import { rootBaseDir, safeJoin } from '../lib/paths.js'

// Publish to the public CDN (design §8). Copies images to B2 under
// img/<prefix>/<filename>, skips-and-reports existing keys, upserts b2_objects
// with published_image_id, and returns the img.jkrumm.com CDN URLs.

function cdnUrlForKey(key: string): string {
  const withoutPrefix = key.startsWith(env.B2_PREFIX) ? key.slice(env.B2_PREFIX.length) : key
  return `${env.CDN_BASE}/${withoutPrefix}`
}

export const publishRoutes = new Elysia({ name: 'publish' }).post(
  '/api/publish',
  async ({ body }) => {
    const s3 = getS3()
    const published: { id: number; key: string; cdnUrl: string }[] = []
    const skipped: { id: number; key: string; reason: string }[] = []

    for (const id of body.imageIds) {
      const [row] = await db.select().from(images).where(eq(images.id, id)).limit(1)
      if (!row) {
        skipped.push({ id, key: '', reason: 'image not found' })
        continue
      }

      const filename = `${row.stem}.${row.ext}`
      const key = `${env.B2_PREFIX}${body.prefix}/${filename}`

      if (await s3.exists(key)) {
        skipped.push({ id, key, reason: 'key already exists' })
        continue
      }

      const absPath = safeJoin(rootBaseDir(row.root), row.relPath)
      const bytes = await Bun.file(absPath).bytes()
      await s3.put(key, bytes)

      const now = new Date().toISOString()
      const [existingObj] = await db
        .select({ key: b2Objects.key })
        .from(b2Objects)
        .where(eq(b2Objects.key, key))
        .limit(1)
      if (existingObj) {
        await db
          .update(b2Objects)
          .set({ size: bytes.byteLength, lastModified: now, publishedImageId: id })
          .where(eq(b2Objects.key, key))
      } else {
        await db.insert(b2Objects).values({
          key,
          size: bytes.byteLength,
          lastModified: now,
          publishedImageId: id,
          firstSeenAt: now,
        })
      }

      published.push({ id, key, cdnUrl: cdnUrlForKey(key) })
    }

    return { published, skipped }
  },
  {
    body: z.object({
      imageIds: z.array(z.number().int()).min(1),
      prefix: z.enum(['fuji', 'blog', 'gen', 'misc']),
    }),
    response: {
      200: z.object({
        published: z.array(
          z.object({
            id: z.number().int(),
            key: z.string().describe('Full B2 key incl. img/ prefix'),
            cdnUrl: z.string().describe('CDN_BASE/<key minus img/ prefix>'),
          }),
        ),
        skipped: z
          .array(z.object({ id: z.number().int(), key: z.string(), reason: z.string() }))
          .describe('Images whose target key already existed'),
      }),
    },
    detail: {
      tags: ['Publish'],
      summary: 'Publish library images to the public CDN',
      description:
        'Copies each image to B2 under img/<prefix>/<filename> (prefix ∈ fuji|blog|gen|misc), skipping and reporting keys that already exist, then upserts b2_objects with published_image_id. Returns the resulting img.jkrumm.com CDN URLs. The HomeLab remains source of truth; B2 is a mirror.',
      security: [{ BearerAuth: [] }],
    },
  },
)

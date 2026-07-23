import { Elysia } from 'elysia'
import { z } from 'zod'
import { and, eq, like } from 'drizzle-orm'
import { getS3 } from '../lib/s3.js'
import { db } from '../db/index.js'
import { images, b2Objects } from '../db/schema.js'
import { env } from '../env.js'
import { cdnOriginalUrl } from '../lib/cdn.js'
import { deriveObjectFilename, isOpaquePrefix } from '../lib/naming.js'
import { rootBaseDir, safeJoin } from '../lib/paths.js'

// Publish to the public CDN (design §8). Copies images to B2 under
// img/<prefix>/<filename>, skips-and-reports existing keys, upserts b2_objects
// with published_image_id, and returns the img.jkrumm.com CDN URLs (via the
// shared lib/cdn.ts helper — also used by routes/b2.ts, design §8/§12 stage 4).
//
// Opaque prefixes (gen/misc) get a random key from lib/naming.ts instead of
// the file stem, so the object name itself is the access control behind the
// CDN's unsigned URLs. Since the random name breaks the "skip if key exists"
// republish guard, opaque prefixes instead check b2_objects for an existing
// row already published from this image under the same prefix.

export const publishRoutes = new Elysia({ name: 'publish' }).post(
  '/api/publish',
  async ({ body }) => {
    const s3 = getS3()
    const published: { id: number; key: string; cdnUrl: string }[] = []
    const skipped: { id: number; key: string; reason: string; cdnUrl?: string }[] = []

    for (const id of body.imageIds) {
      const [row] = await db.select().from(images).where(eq(images.id, id)).limit(1)
      if (!row) {
        skipped.push({ id, key: '', reason: 'image not found' })
        continue
      }

      const opaque = isOpaquePrefix(body.prefix)

      if (opaque) {
        const [existing] = await db
          .select({ key: b2Objects.key })
          .from(b2Objects)
          .where(
            and(
              eq(b2Objects.publishedImageId, id),
              like(b2Objects.key, `${env.B2_PREFIX}${body.prefix}/%`),
            ),
          )
          .limit(1)
        if (existing) {
          skipped.push({
            id,
            key: existing.key,
            reason: 'already published under this prefix',
            cdnUrl: cdnOriginalUrl(existing.key),
          })
          continue
        }
      }

      const filename = deriveObjectFilename(body.prefix, `${row.stem}.${row.ext}`)
      const key = `${env.B2_PREFIX}${body.prefix}/${filename}`

      if (!opaque && (await s3.exists(key))) {
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

      published.push({ id, key, cdnUrl: cdnOriginalUrl(key) })
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
          .array(
            z.object({
              id: z.number().int(),
              key: z.string(),
              reason: z.string(),
              cdnUrl: z
                .string()
                .optional()
                .describe('Set when an existing published object is being reported, not created'),
            }),
          )
          .describe('Images whose target key already existed or were already published'),
      }),
    },
    detail: {
      tags: ['Publish'],
      summary: 'Publish library images to the public CDN',
      description:
        "Copies each image to B2 under img/<prefix>/<filename> (prefix ∈ fuji|blog|gen|misc), then upserts b2_objects with published_image_id. Readable prefixes (fuji/blog) use the file stem and skip-and-report a pre-existing key; opaque prefixes (gen/misc) mint a random 16-char [a-z0-9] basename via lib/naming.ts (an unguessable name is the access control behind the CDN's unsigned URLs) and instead skip-and-report if this image was already published under the same prefix. Returns the resulting img.jkrumm.com CDN URLs. The HomeLab remains source of truth; B2 is a mirror.",
      security: [{ BearerAuth: [] }],
    },
  },
)

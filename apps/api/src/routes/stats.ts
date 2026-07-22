import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import { z } from 'zod'
import { count, eq, isNull } from 'drizzle-orm'
import { db, sqlite } from '../db/index.js'
import { images, shares, shareTokens, b2Objects } from '../db/schema.js'
import { env } from '../env.js'
import { getIndexStatus } from '../indexer/scan.js'
import pkg from '../../package.json' with { type: 'json' }

// Service stats snapshot (design §8). Powers the admin Activity page StatCards.

async function renditionCacheBytesTotal(): Promise<number> {
  const dir = join(env.DATA_DIR, 'renditions')
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const s = await stat(join(dir, entry.name))
    total += s.size
  }
  return total
}

function dbSizeBytes(): number {
  const pageCount = (sqlite.query('PRAGMA page_count').get() as { page_count: number } | null)
    ?.page_count
  const pageSize = (sqlite.query('PRAGMA page_size').get() as { page_size: number } | null)
    ?.page_size
  return (pageCount ?? 0) * (pageSize ?? 0)
}

export const statsRoutes = new Elysia({ name: 'stats' }).get(
  '/api/stats',
  async () => {
    const [
      imagesTotal,
      jpegs,
      raws,
      shareRoot,
      sharesTotal,
      activeTokens,
      b2Total,
      b2Unmirrored,
      renditionCacheBytes,
    ] = await Promise.all([
      db.select({ count: count() }).from(images),
      db.select({ count: count() }).from(images).where(eq(images.kind, 'jpeg')),
      db.select({ count: count() }).from(images).where(eq(images.kind, 'raw')),
      db.select({ count: count() }).from(images).where(eq(images.root, 'share')),
      db.select({ count: count() }).from(shares),
      db.select({ count: count() }).from(shareTokens).where(isNull(shareTokens.revokedAt)),
      db.select({ count: count() }).from(b2Objects),
      db.select({ count: count() }).from(b2Objects).where(isNull(b2Objects.mirroredAt)),
      renditionCacheBytesTotal(),
    ])

    return {
      images: Number(imagesTotal[0]?.count ?? 0),
      jpegs: Number(jpegs[0]?.count ?? 0),
      raws: Number(raws[0]?.count ?? 0),
      share: Number(shareRoot[0]?.count ?? 0),
      shares: Number(sharesTotal[0]?.count ?? 0),
      activeTokens: Number(activeTokens[0]?.count ?? 0),
      b2Objects: Number(b2Total[0]?.count ?? 0),
      b2Unmirrored: Number(b2Unmirrored[0]?.count ?? 0),
      renditionCacheBytes,
      dbSizeBytes: dbSizeBytes(),
      lastIndexAt: getIndexStatus().lastFinishedAt,
      version: pkg.version,
    }
  },
  {
    response: {
      200: z.object({
        images: z.number().int(),
        jpegs: z.number().int(),
        raws: z.number().int(),
        share: z.number().int(),
        shares: z.number().int(),
        activeTokens: z.number().int(),
        b2Objects: z.number().int(),
        b2Unmirrored: z.number().int(),
        renditionCacheBytes: z.number().int(),
        dbSizeBytes: z.number().int(),
        lastIndexAt: z.string().nullable(),
        version: z.string(),
      }),
    },
    detail: {
      tags: ['Stats'],
      summary: 'Service statistics snapshot',
      description:
        'Aggregate counts and sizes: total images (by kind), shares, active tokens, B2 objects (+ unmirrored), rendition cache bytes, DB size, last index time, and the service version. Powers the admin Activity dashboard.',
      security: [{ BearerAuth: [] }],
    },
  },
)

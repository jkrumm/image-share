import { Cron } from 'croner'
import { eq, inArray } from 'drizzle-orm'
import { tracedTick } from '../telemetry.js'
import { db } from '../db/index.js'
import { b2Objects } from '../db/schema.js'
import { env } from '../env.js'
import { getS3 } from '../lib/s3.js'

// B2 bucket → b2_objects reconciliation (design §9): 45 5 * * *.

const SCHEDULE = '45 5 * * *'

export interface ReconcileResult {
  listed: number
  upserted: number
  removed: number
}

export interface B2ReconcileStatus {
  lastStartedAt: string | null
  lastFinishedAt: string | null
}

// Single source of truth for "how stale is the b2_objects cache", surfaced by
// GET /api/b2 (design §8) so the admin Public page can show cache staleness.
// Mirrors indexer/scan.ts's status-object pattern.
const status: B2ReconcileStatus = { lastStartedAt: null, lastFinishedAt: null }

export function getB2ReconcileStatus(): B2ReconcileStatus {
  return { ...status }
}

/**
 * List the img/ keyspace via the S3 port and upsert/remove b2_objects rows so
 * out-of-band uploads (photoflow/rclone) appear locally (design §8).
 */
export async function runB2Reconcile(): Promise<ReconcileResult> {
  status.lastStartedAt = new Date().toISOString()
  const objects = await getS3().list(env.B2_PREFIX)
  const seenKeys = new Set(objects.map((o) => o.key))
  const now = new Date().toISOString()

  let upserted = 0
  for (const obj of objects) {
    const [existing] = await db
      .select({ key: b2Objects.key })
      .from(b2Objects)
      .where(eq(b2Objects.key, obj.key))
      .limit(1)

    if (existing) {
      await db
        .update(b2Objects)
        .set({ size: obj.size, lastModified: obj.lastModified, etag: obj.etag ?? null })
        .where(eq(b2Objects.key, obj.key))
    } else {
      await db.insert(b2Objects).values({
        key: obj.key,
        size: obj.size,
        lastModified: obj.lastModified,
        etag: obj.etag ?? null,
        firstSeenAt: now,
      })
    }
    upserted++
  }

  const existingRows = await db.select({ key: b2Objects.key }).from(b2Objects)
  const staleKeys = existingRows.map((r) => r.key).filter((key) => !seenKeys.has(key))
  if (staleKeys.length > 0) {
    await db.delete(b2Objects).where(inArray(b2Objects.key, staleKeys))
  }

  status.lastFinishedAt = new Date().toISOString()
  return { listed: objects.length, upserted, removed: staleKeys.length }
}

export function registerB2ReconcileCron(): void {
  new Cron(SCHEDULE, () => {
    void tracedTick('cron.b2-reconcile.scheduled', { 'cron.schedule': SCHEDULE }, () =>
      runB2Reconcile(),
    )
  })
}

import { mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { Cron } from 'croner'
import { eq } from 'drizzle-orm'
import { log, tracedTick } from '../telemetry.js'
import { db } from '../db/index.js'
import { b2Objects } from '../db/schema.js'
import { env } from '../env.js'
import { getS3 } from '../lib/s3.js'
import { safeJoin } from '../lib/paths.js'
import { tracedFetch } from '../lib/traced-fetch.js'

// Reverse backup B2 → HomeLab (design §9): 0 6 * * *. Pulls unmirrored/changed
// keys into B2_MIRROR_DIR, then pings UPTIME_KUMA_PUSH_URL (via tracedFetch).

const SCHEDULE = '0 6 * * *'

export interface ReverseBackupResult {
  mirrored: number
  bytes: number
  errors: number
}

/**
 * Download every b2_objects key lacking mirrored_at, or whose locally-mirrored
 * file is missing/size-mismatched (a proxy for "changed etag" — the schema
 * only retains the latest-known etag, not the one that was actually mirrored,
 * so a size delta is the cheapest available staleness signal), into
 * B2_MIRROR_DIR/<key minus img/>, sets mirrored_at, then sends the Uptime
 * Kuma heartbeat if configured (design §8).
 */
export async function runReverseBackup(): Promise<ReverseBackupResult> {
  const rows = await db.select().from(b2Objects)
  const s3 = getS3()

  let mirrored = 0
  let bytes = 0
  let errors = 0

  for (const row of rows) {
    const relKey = row.key.startsWith(env.B2_PREFIX) ? row.key.slice(env.B2_PREFIX.length) : row.key
    let destPath: string
    try {
      destPath = safeJoin(env.B2_MIRROR_DIR, relKey)
    } catch (err) {
      errors++
      log.error('reverse-backup: unsafe mirror path, skipping', err, { key: row.key })
      continue
    }

    const needsMirror = row.mirroredAt === null || !isMirroredUpToDate(destPath, row.size)
    if (!needsMirror) continue

    try {
      const data = await s3.get(row.key)
      mkdirSync(dirname(destPath), { recursive: true })
      await Bun.write(destPath, data)
      await db
        .update(b2Objects)
        .set({ mirroredAt: new Date().toISOString() })
        .where(eq(b2Objects.key, row.key))
      mirrored++
      bytes += data.byteLength
    } catch (err) {
      errors++
      log.error('reverse-backup: failed to mirror key', err, { key: row.key })
    }
  }

  if (env.UPTIME_KUMA_PUSH_URL) {
    try {
      await tracedFetch(env.UPTIME_KUMA_PUSH_URL)
    } catch (err) {
      log.error('reverse-backup: heartbeat failed', err)
    }
  }

  return { mirrored, bytes, errors }
}

function isMirroredUpToDate(destPath: string, expectedSize: number): boolean {
  try {
    return statSync(destPath).size === expectedSize
  } catch {
    return false
  }
}

export function registerReverseBackupCron(): void {
  new Cron(SCHEDULE, () => {
    void tracedTick('cron.reverse-backup.scheduled', { 'cron.schedule': SCHEDULE }, () =>
      runReverseBackup(),
    )
  })
}

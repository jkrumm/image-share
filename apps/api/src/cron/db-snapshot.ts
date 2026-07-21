import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Cron } from 'croner'
import { tracedTick } from '../telemetry.js'
import { sqlite } from '../db/index.js'
import { env } from '../env.js'

// Nightly SQLite snapshot (design §9): 0 3 * * *, before restic's 03:30 run.
// `VACUUM INTO SNAPSHOT_DIR/image-share-<weekday>.sqlite` — 7 rotating copies.
// Protects the non-rebuildable shares / share_tokens tables.

const SCHEDULE = '0 3 * * *'

export interface SnapshotResult {
  path: string
  bytes: number
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

/**
 * Run `VACUUM INTO` to the day-of-week snapshot path (7 rotating files —
 * design §9). Uses the bun:sqlite handle from db/index.ts directly since
 * VACUUM INTO is not part of the drizzle query builder.
 */
export async function runDbSnapshot(): Promise<SnapshotResult> {
  mkdirSync(env.SNAPSHOT_DIR, { recursive: true })
  // getDay() is always 0..6, matching WEEKDAYS' 7 entries exactly.
  const weekday = WEEKDAYS[new Date().getDay()] as (typeof WEEKDAYS)[number]
  const path = join(env.SNAPSHOT_DIR, `image-share-${weekday}.sqlite`)

  // VACUUM INTO requires the destination not to already exist.
  rmSync(path, { force: true })
  sqlite.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`)

  const bytes = Bun.file(path).size
  return { path, bytes }
}

export function registerDbSnapshotCron(): void {
  new Cron(SCHEDULE, () => {
    void tracedTick('cron.db-snapshot.scheduled', { 'cron.schedule': SCHEDULE }, () =>
      runDbSnapshot(),
    )
  })
}

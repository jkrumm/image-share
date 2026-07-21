import { Cron } from 'croner'
import { sql } from 'drizzle-orm'
import { tracedTick } from '../telemetry.js'
import { db } from '../db/index.js'
import { images } from '../db/schema.js'
import { runScan, type ScanCounts } from '../indexer/scan.js'

// Nightly full reindex (design §9): 15 5 * * *, plus a background scan on boot
// when the images table is empty.

const SCHEDULE = '15 5 * * *'

/** Run a full reconcile scan. Delegates to the indexer's single-flight scan. */
export function runReindex(): Promise<ScanCounts> {
  return runScan()
}

export function registerReindexCron(): void {
  new Cron(SCHEDULE, () => {
    void tracedTick('cron.reindex.scheduled', { 'cron.schedule': SCHEDULE }, () => runReindex())
  })
}

/**
 * Kick a one-off background scan on boot iff the images table is empty (design
 * §9) — e.g. first boot, or after a rebuild-from-scratch (§4: the DB is a
 * rebuildable cache). Fire-and-forget: failures land in getIndexStatus().lastError
 * via runScan's own status bookkeeping, and tracedTick records the span.
 */
export function reindexOnBootIfEmpty(): void {
  void (async () => {
    const [row] = await db.select({ count: sql<number>`count(*)` }).from(images)
    if ((row?.count ?? 0) === 0) {
      await tracedTick('cron.reindex.boot', {}, () => runReindex())
    }
  })().catch(() => {
    /* errors surface via getIndexStatus().lastError */
  })
}

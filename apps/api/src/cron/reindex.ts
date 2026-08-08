import { Cron } from 'croner'
import { sql } from 'drizzle-orm'
import { tracedTick } from '../telemetry.js'
import { db as defaultDb, type Db } from '../db/index.js'
import { images } from '../db/schema.js'
import { keywordBackfillPending, runScan, type ScanCounts } from '../indexer/scan.js'

// Nightly full reindex (design §9): 15 5 * * *, plus a background scan on boot
// when the index cannot serve the app as it stands.

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

/** Why a boot scan is needed — also the span attribute, so it shows up in OTEL. */
export type BootScanReason = 'empty-index' | 'keyword-backfill'

/**
 * Does this boot need a background scan, and why (design §9)?
 *
 * - `empty-index` — first boot, or a rebuild from scratch (§4: the DB is a
 *   rebuildable cache).
 * - `keyword-backfill` — the index has rows, but at least one non-RAW row still
 *   carries `keywords_indexed_at = NULL`. This is EXACTLY the state a deploy of
 *   the album feature leaves behind: the migration creates `image_keywords`
 *   empty and marks every pre-existing row unbackfilled (§4). Counting rows
 *   alone said "6028, nothing to do", so the album tree — the headline browse
 *   axis — stayed empty until the 05:15 cron happened to fire, and the only
 *   manual way out was knowing about Activity → "Rescan now".
 *
 * Null when the index is populated AND fully backfilled: the nightly cron owns
 * routine reconciliation, and a scan on every restart would re-read metadata
 * for thousands of files on a 4-core box for nothing.
 */
export async function bootScanReason(database: Db = defaultDb): Promise<BootScanReason | null> {
  const [row] = await database.select({ count: sql<number>`count(*)` }).from(images)
  if ((row?.count ?? 0) === 0) return 'empty-index'
  return (await keywordBackfillPending(database)) ? 'keyword-backfill' : null
}

/**
 * Kick a one-off background scan on boot iff `bootScanReason` says the index
 * cannot serve the app as it stands. Returns the reason it acted on (null when
 * it did nothing) so callers/tests can assert the decision; production calls it
 * fire-and-forget through `reindexOnBoot`.
 *
 * `scan` is injected only by tests (the repo's setScanDb/setS3/setShareDb
 * pattern) — the decision is what is worth testing, a real tree walk is not.
 */
export async function runBootScanIfNeeded(
  scan: () => Promise<ScanCounts> = runReindex,
): Promise<BootScanReason | null> {
  const reason = await bootScanReason()
  if (reason === null) return null
  await tracedTick('cron.reindex.boot', { 'reindex.boot_reason': reason }, scan)
  return reason
}

/**
 * Fire-and-forget wrapper for boot wiring. Failures land in
 * getIndexStatus().lastError via runScan's own status bookkeeping, and
 * tracedTick records the span.
 */
export function reindexOnBoot(): void {
  void runBootScanIfNeeded().catch(() => {
    /* errors surface via getIndexStatus().lastError */
  })
}

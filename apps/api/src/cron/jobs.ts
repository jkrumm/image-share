import { env } from '../env.js'
import { registerReindexCron, reindexOnBoot } from './reindex.js'
import { registerB2ReconcileCron } from './b2-reconcile.js'
import { registerReverseBackupCron } from './reverse-backup.js'
import { registerRenditionSweepCron } from './rendition-sweep.js'
import { registerDbSnapshotCron } from './db-snapshot.js'

// Cron wiring (design §9). Gated by CRON_ENABLED (default true) so tests and
// one-off local runs can disable all scheduled work. Each job registers its own
// croner schedule and wraps every tick in a fresh root span (see tracedTick).
export function registerCronJobs(): void {
  if (!env.CRON_ENABLED) {
    console.info('[cron] CRON_ENABLED=false — no scheduled jobs registered')
    return
  }
  registerDbSnapshotCron()
  registerReindexCron()
  registerB2ReconcileCron()
  registerReverseBackupCron()
  registerRenditionSweepCron()
  // Background boot scan when the index is empty OR a keyword backfill is still
  // pending — the state a deploy of the album feature leaves behind (design §9).
  reindexOnBoot()
  console.info('[cron] scheduled jobs registered')
}

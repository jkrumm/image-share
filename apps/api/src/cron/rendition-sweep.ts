import { Cron } from 'croner'
import { tracedTick } from '../telemetry.js'
import { sweepRenditionCache, type SweepResult } from '../renditions/cache.js'

// Rendition cache eviction (design §9): 30 4 * * 0 (weekly, Sunday).

const SCHEDULE = '30 4 * * 0'

/** Age + size-cap eviction of the on-disk rendition cache. */
export function runRenditionSweep(): Promise<SweepResult> {
  return sweepRenditionCache()
}

export function registerRenditionSweepCron(): void {
  new Cron(SCHEDULE, () => {
    void tracedTick('cron.rendition-sweep.scheduled', { 'cron.schedule': SCHEDULE }, () =>
      runRenditionSweep(),
    )
  })
}

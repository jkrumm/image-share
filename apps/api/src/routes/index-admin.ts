import { Elysia } from 'elysia'
import { z } from 'zod'
import { getIndexStatus, runScan } from '../indexer/scan.js'

// Index control (design §8). Rescan runs the full reconcile scan in the
// background (202 immediately); status returns the single-flight indexer state.

const ScanCountsSchema = z.object({
  scanned: z.number().int(),
  added: z.number().int(),
  updated: z.number().int(),
  removed: z.number().int(),
})

export const indexAdminRoutes = new Elysia({ name: 'index-admin' })
  .post(
    '/api/index/rescan',
    ({ set }) => {
      // Single-flight (design §5): report whether THIS call actually started a
      // scan vs. one already being in flight, without ever awaiting it here.
      const alreadyRunning = getIndexStatus().running
      // Fire-and-forget: kick the scan, return 202 immediately (design §8).
      // Deferred via Promise.resolve so a synchronous throw becomes a caught
      // rejection rather than a 500 on this response. runScan() itself is a
      // single-flight no-op when already running, so calling it unconditionally
      // is safe — the `started` flag below just reflects that to the caller.
      void Promise.resolve()
        .then(() => runScan())
        .catch(() => {
          /* errors surface via getIndexStatus().lastError */
        })
      set.status = 202
      return { started: !alreadyRunning }
    },
    {
      response: { 202: z.object({ started: z.boolean() }) },
      detail: {
        tags: ['Index'],
        summary: 'Trigger a full library rescan',
        description:
          'Starts a background reconcile scan across all roots and returns 202 immediately. Single-flight — a scan already running is not restarted. Poll GET /index/status for progress and the last run’s counts.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .get('/api/index/status', () => getIndexStatus(), {
    response: {
      200: z.object({
        running: z.boolean(),
        startedAt: z.string().nullable(),
        lastFinishedAt: z.string().nullable(),
        lastCounts: ScanCountsSchema.nullable(),
        lastError: z.string().nullable(),
      }),
    },
    detail: {
      tags: ['Index'],
      summary: 'Indexer status',
      description:
        'Returns whether a scan is currently running, when it started/last finished, the last run’s {scanned, added, updated, removed} counts, and the last error if any. Pair with POST /index/rescan.',
      security: [{ BearerAuth: [] }],
    },
  })

import { trace, SpanStatusCode } from '@opentelemetry/api'
import { Elysia } from 'elysia'
import { z } from 'zod'
import { opentelemetry } from '@elysiajs/opentelemetry'
import { openapi } from '@elysiajs/openapi'
import { cors } from '@elysiajs/cors'
import { telemetryConfig } from './telemetry.js'
import { env } from './env.js'
import { runMigrations } from './db/index.js'
import { authGuard } from './lib/auth-guard.js'
import { endExiftool } from './indexer/metadata.js'
import { registerCronJobs } from './cron/jobs.js'
import pkg from '../package.json' with { type: 'json' }

// Public surface (before the bearer guard).
import { discoveryRoute } from './routes/discovery.js'
import { healthRoute } from './routes/health.js'
import { libraryFileRoutes } from './routes/library.js'
import { shareRoutes } from './share/routes.js'

// Bearer-guarded admin surface (inside the /api group).
import { libraryRoutes } from './routes/library.js'
import { indexAdminRoutes } from './routes/index-admin.js'
import { sharesRoutes } from './routes/shares.js'
import { ingestRoutes } from './routes/ingest.js'
import { publishRoutes } from './routes/publish.js'
import { b2Routes, backupRoutes } from './routes/b2.js'
import { statsRoutes } from './routes/stats.js'

// SPA fallback (mounted last).
import { staticPlugin } from './static.js'

// Apply migrations before the server accepts traffic (mirrors argo).
runMigrations()

// Plugin order (design §10): otel → onError → cors → openapi → public → api
// (authGuard scoped inside the /api group) → static SPA fallback.
export const app = new Elysia()
  .use(
    opentelemetry({
      ...telemetryConfig,
      checkIfShouldTrace: (req) => {
        const u = new URL(req.url)
        // Skip the discovery/probe surfaces + static SPA assets — polled often,
        // pure noise in the trace tree.
        return (
          u.pathname !== '/' &&
          u.pathname !== '/health' &&
          u.pathname !== '/api' &&
          !u.pathname.startsWith('/openapi')
        )
      },
    }),
  )
  .onError(({ error }) => {
    const span = trace.getActiveSpan()
    if (span) {
      span.recordException(error as Error)
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) })
    }
  })
  .use(
    cors({
      origin: ['https://share.jkrumm.com', 'https://share.test', 'http://localhost:7721'],
      // W3C trace-context headers must survive the browser→API hop so
      // distributed tracing links the two sides.
      allowedHeaders: ['Authorization', 'Content-Type', 'traceparent', 'tracestate', 'baggage'],
      exposeHeaders: ['x-total-count'],
    }),
  )
  .use(
    openapi({
      mapJsonSchema: { zod: z.toJSONSchema },
      documentation: {
        info: {
          title: 'image-share API',
          version: pkg.version,
          description:
            'Personal image service for Johannes Krumm: read-only library index, friend folder sharing (share.jkrumm.com), on-demand renditions, bearer-token ingest for agents, and publish-to-B2 (img.jkrumm.com). Start at GET /api for discovery. Everything under /api except discovery requires `Authorization: Bearer <API_SECRET>`; /s/* is the public share surface.',
        },
        servers: [{ url: 'https://share.jkrumm.com', description: 'HomeLab (Cloudflare Tunnel)' }],
        components: {
          securitySchemes: { BearerAuth: { type: 'http', scheme: 'bearer' } },
        },
        tags: [
          {
            name: 'System',
            description: 'Discovery (/api) and liveness (/health) — public, unauthenticated.',
          },
          {
            name: 'Library',
            description:
              'Read-only index of the photo tree + uploads: directory listing, image listing, and byte serving (renditions + originals).',
          },
          {
            name: 'Index',
            description: 'Indexer control — trigger a rescan and read its status.',
          },
          {
            name: 'Shares',
            description:
              'Friend folder sharing — create/update/delete shares, roll and add tokens. The rendered pages themselves live on the public /s/* surface.',
          },
          {
            name: 'Ingest',
            description: 'Agent upload endpoint — multipart image ingest into the uploads area.',
          },
          {
            name: 'Publish',
            description: 'Copy library images to the public B2/CDN keyspace.',
          },
          {
            name: 'Backblaze',
            description:
              'B2 object mirror — list objects, reconcile the bucket, and run the reverse backup (B2 → HomeLab).',
          },
          {
            name: 'Stats',
            description: 'Aggregate service statistics for the admin dashboard.',
          },
        ],
      },
    }),
  )
  // ── Public surface (before the scoped bearer guard) ──────────────────────
  .use(discoveryRoute) // GET /api discovery
  .use(healthRoute) // GET /health
  .use(libraryFileRoutes) // assetToken byte route (browser <img> tags)
  .use(shareRoutes) // /s/* public share pages
  .use(staticPlugin) // SPA fallback (`/*` wildcard — lowest routing precedence)
  // ── Bearer-guarded admin surface ─────────────────────────────────────────
  // authGuard is `as: 'scoped'`, so it propagates to every sibling plugin
  // mounted AFTER it here, but not to the public routes above. Each admin
  // plugin carries its own `/api/...` prefix (Caddy does not strip /api).
  .use(authGuard)
  .use(libraryRoutes)
  .use(indexAdminRoutes)
  .use(sharesRoutes)
  .use(ingestRoutes)
  .use(publishRoutes)
  .use(b2Routes)
  .use(backupRoutes)
  .use(statsRoutes)
  .listen({ port: env.PORT, idleTimeout: 255 })

export type App = typeof app

registerCronJobs()

console.log(`image-share api running on port ${env.PORT}`)

const shutdown = async (): Promise<void> => {
  await endExiftool()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

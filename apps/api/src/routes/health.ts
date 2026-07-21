import { Elysia } from 'elysia'
import { z } from 'zod'

// Liveness probe (design §8, §10). Public, no DB touch — used by the Docker
// healthcheck and the Uptime Kuma monitors on both hosts.
export const healthRoute = new Elysia().get('/health', () => ({ status: 'ok' as const }), {
  response: z.object({ status: z.literal('ok') }),
  detail: {
    tags: ['System'],
    summary: 'Liveness probe',
    description:
      'Returns `{ status: "ok" }` if the API process is up. No auth required, does not touch the database. Served at share.jkrumm.com/health (Caddy passthrough).',
  },
})

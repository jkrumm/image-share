import { Elysia } from 'elysia'
import { z } from 'zod'
import pkg from '../../package.json' with { type: 'json' }

// API discovery (design §8). Public root of the admin surface at `GET /api` —
// AI agents call this first, then read /openapi/json for the full contract.
export const discoveryRoute = new Elysia().get(
  '/api',
  () => ({
    name: 'image-share API',
    version: pkg.version,
    description:
      'Personal image service for Johannes Krumm: read-only library index, friend folder sharing, on-demand renditions, bearer ingest, and publish-to-B2. Start here, then read /openapi/json.',
    docs: {
      scalar: '/openapi',
      json: '/openapi/json',
    },
    auth: {
      scheme: 'Bearer',
      header: 'Authorization: Bearer <API_SECRET>',
      public: ['GET /api', 'GET /health', 'GET /openapi', 'GET /openapi/json', 'GET /s/*'],
    },
    tags: ['System', 'Library', 'Index', 'Shares', 'Ingest', 'Publish', 'Backblaze', 'Stats'],
  }),
  {
    response: z.object({
      name: z.string(),
      version: z.string(),
      description: z.string(),
      docs: z.object({
        scalar: z.string().describe('Interactive OpenAPI UI'),
        json: z.string().describe('Raw OpenAPI JSON spec'),
      }),
      auth: z.object({
        scheme: z.string(),
        header: z.string(),
        public: z.array(z.string()).describe('Paths that do not require Bearer auth'),
      }),
      tags: z.array(z.string()).describe('Top-level OpenAPI tag taxonomy'),
    }),
    detail: {
      tags: ['System'],
      summary: 'API discovery — start here',
      description:
        'Public discovery endpoint. Returns the API name, version, where to find the OpenAPI spec (Scalar UI + raw JSON), the auth scheme, and the tag taxonomy. Everything else under /api requires `Authorization: Bearer <API_SECRET>`.',
    },
  },
)

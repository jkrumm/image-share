import { Elysia } from 'elysia'
import { env } from '../env.js'

// Bearer auth guard for the admin `/api/*` surface (design §8).
//
// `as: 'scoped'` propagates the lifecycle to sibling plugins mounted after this
// guard inside the same parent instance — in index.ts the guard is mounted at
// the head of the `/api` group so it covers every route in that group, while
// the public surface (discovery, health, share pages, the access_token file
// route, static SPA) is mounted OUTSIDE the group and stays unguarded.
//
// Auth runs in `onTransform` (before schema validation) so unauthenticated
// requests can't trigger 422 body-echo responses. Reads the Authorization
// header directly.
export const authGuard = new Elysia({ name: 'auth' }).onTransform(
  { as: 'scoped' },
  ({ request, status }) => {
    const header = request.headers.get('authorization')
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null
    if (!token || token !== env.API_SECRET) {
      throw status(401, 'Unauthorized')
    }
  },
)

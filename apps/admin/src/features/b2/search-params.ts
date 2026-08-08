import { z } from 'zod'
import type { B2ListParams } from '../../lib/queries/b2'

// URL state for the Public (CDN) page, and its translation into
// `GET /api/b2` query params.

export const B2_PAGE_LIMIT = 60

export const B2SearchSchema = z.object({
  prefix: z.enum(['all', 'fuji', 'blog', 'gen', 'misc']).default('all'),
  q: z.string().default(''),
  page: z.number().int().min(1).default(1),
  sort: z.enum(['lastModified', 'key', 'size']).default('lastModified'),
  order: z.enum(['asc', 'desc']).default('desc'),
})

export type B2SearchParams = z.infer<typeof B2SearchSchema>

export function toB2ListParams(
  search: B2SearchParams,
  limit = B2_PAGE_LIMIT,
): B2ListParams & { page: number; limit: number } {
  return {
    prefix: search.prefix,
    // An empty box is "no filter", not `q=''` — omitted so every unfiltered
    // page shares one query key with the bucket-wide summary's assumptions.
    ...(search.q && { q: search.q }),
    page: search.page,
    limit,
    sort: search.sort,
    order: search.order,
  }
}

/** Whether the list on screen is a subset of the bucket — drives the empty copy. */
export function isB2Filtered(search: B2SearchParams): boolean {
  return search.prefix !== 'all' || search.q !== ''
}

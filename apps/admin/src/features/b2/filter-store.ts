import { createSearchStore, field } from 'basalt-ui/router-tanstack'
import { B2_ORDERS, B2_PREFIXES, B2_SORTS } from './search-params'

/**
 * The Public page's filters, bound to `PageBar.filters`. `page` is not a field: it is
 * positional, never mirrored, and stays in `B2SearchSchema`, which the route composes with this —
 * `resets` drops it in the same navigate as any filter write, so a narrowed list starts on page 1.
 * `q` is URL-only — a stale search box handed back on the next visit reads as a broken page.
 */
export const b2Filters = createSearchStore({
  key: 'b2-filters',
  fields: {
    q: field.string({}, { persist: false }),
    prefix: field.enum(B2_PREFIXES, 'all'),
    sort: field.enum(B2_SORTS, 'lastModified'),
    order: field.enum(B2_ORDERS, 'desc'),
  },
  resets: ['page'],
}).labels({
  prefix: { all: 'All prefixes', fuji: 'Fuji', blog: 'Blog', gen: 'Generated', misc: 'Misc' },
  sort: { lastModified: 'Last modified', key: 'Key', size: 'Size' },
  order: { desc: 'Descending', asc: 'Ascending' },
})

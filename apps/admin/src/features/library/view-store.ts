import { createSearchStore, field } from 'basalt-ui/router-tanstack'
import { LIBRARY_ORDERS, LIBRARY_SORTS } from './search-params'

/**
 * How the Library grid is ordered, bound to `PageBar.filters`. A browse preference, so it is
 * mirrored and follows the owner back to the page — it never reaches a share (a selection share is
 * always capture order, see ./selection). Every other Library param stays in
 * `LibrarySearchSchema`, which the route composes with this.
 */
export const libraryView = createSearchStore({
  key: 'library-view',
  fields: {
    sort: field.enum(LIBRARY_SORTS, 'captureAt'),
    order: field.enum(LIBRARY_ORDERS, 'desc'),
  },
  // A reorder lands on page 1, as every Library filter write does.
  resets: ['page'],
}).labels({
  sort: { captureAt: 'Capture date', name: 'Name' },
  order: { desc: 'Newest', asc: 'Oldest' },
})

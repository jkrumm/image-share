import { z } from 'zod'
import type { LibraryImagesParams, LibraryRoot } from '../../lib/queries/library'
import type { ShareRoot, ShareSourceInput } from '../../lib/queries/shares'

// The Library page's URL state and the pure derivations built from it. Kept out
// of the route module so both halves — what a URL is allowed to say, and what
// query it turns into — are testable without mounting the page.

export const LIBRARY_PAGE_LIMIT = 60

export const LibrarySearchSchema = z.object({
  // Defaulted, not optional: an undefined root fetched across ALL roots, so the
  // first paint of the page pulled RAF rows into a grid that can never render
  // them (a RAF has no rendition). Fuji is the library.
  root: z.enum(['fuji', 'raws', 'share']).default('fuji'),
  dir: z.string().optional(),
  /** A `GET /api/library/albums` path. Mutually exclusive with `untagged`. */
  album: z.string().optional(),
  untagged: z.boolean().default(false),
  // Matches the API's own default and POST /api/shares — so the grid is a
  // faithful preview of the share a scope would produce.
  recursive: z.boolean().default(true),
  minRating: z.number().int().min(0).max(5).optional(),
  captureFrom: z.string().optional(),
  captureTo: z.string().optional(),
  stem: z.string().optional(),
  page: z.number().int().min(1).default(1),
  sort: z.enum(['captureAt', 'name']).default('captureAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
})

export type LibrarySearchParams = z.infer<typeof LibrarySearchSchema>

/** RAWs are browsable but never shareable — every raws row is `kind='raw'`. */
export function shareRootOf(root: LibraryRoot): ShareRoot | null {
  return root === 'raws' ? null : root
}

function scopeAxisLabel(search: LibrarySearchParams): string {
  if (search.untagged) return 'Untagged'
  if (search.album !== undefined) return `Album · ${search.album}`
  if (search.dir !== undefined) return `Folder · ${search.dir === '' ? '(root)' : search.dir}`
  return 'All images'
}

/** The capture range as one phrase, or null when neither bound is set. */
export function dateRangeLabel(search: LibrarySearchParams): string | null {
  const { captureFrom, captureTo } = search
  if (captureFrom === undefined && captureTo === undefined) return null
  if (captureFrom !== undefined && captureTo !== undefined) return `${captureFrom} → ${captureTo}`
  if (captureFrom !== undefined) return `from ${captureFrom}`
  return `until ${captureTo}`
}

/**
 * The line above the grid. It names EVERY active filter that narrows the set,
 * not just the browse axis — the count next to it is the count of all of them
 * together, and the share button beside it acts on the same thing.
 */
export function scopeLabel(search: LibrarySearchParams): string {
  const parts = [scopeAxisLabel(search)]
  const dates = dateRangeLabel(search)
  if (dates !== null) parts.push(dates)
  if (search.stem) parts.push(`“${search.stem}”`)
  return parts.join(' · ')
}

/**
 * Filters a live folder/album share source cannot carry: POST /api/shares
 * scopes are (root, dir|album, recursive, minRating) and nothing else, so a
 * scope share minted while these are set would ship a different — always
 * larger — set than the grid on screen.
 */
export function unshareableFilters(search: LibrarySearchParams): string[] {
  const dropped: string[] = []
  if (search.captureFrom !== undefined || search.captureTo !== undefined) dropped.push('the dates')
  if (search.stem) dropped.push('the filename filter')
  return dropped
}

/** A live, root-scoped share source — everything POST /api/shares can express but a selection. */
export type ScopeShareSource = Exclude<ShareSourceInput, { type: 'selection' }>

/** The browsed scope as a share source, or null when it isn't shareable as one. */
export function scopeSourceOf(search: LibrarySearchParams): ScopeShareSource | null {
  const root = shareRootOf(search.root)
  if (root === null) return null
  // 0 is "no filter" everywhere in this app (and in the share predicate), so it
  // is normalised to null rather than stored as a literal `rating >= 0`.
  const minRating = search.minRating ? search.minRating : null
  if (search.album !== undefined && search.album !== '') {
    return { type: 'album', root, album: search.album, recursive: search.recursive, minRating }
  }
  if (search.dir !== undefined) {
    return { type: 'folder', root, dir: search.dir, recursive: search.recursive, minRating }
  }
  return null
}

/**
 * The browse AXIS itself, when no live share source can express it — phrased to
 * slot into the same "a live album or folder share cannot carry …" sentence the
 * filters use. Null when the axis IS expressible as a scope (or when the root
 * has nothing shareable at all, which kills the button outright).
 *
 * These are not edge cases: ~1794 of 2352 JPEGs are untagged (design §3.1), so
 * "Untagged, narrowed to a week" is a first-class way to share a trip that was
 * never tagged in Lightroom. It used to render NO share button at all, because
 * the button keyed off a scope source that neither axis can produce — the
 * operator had to walk every page via "Select all N matching" instead, for the
 * axis the design calls first-class.
 */
export function unscopableAxis(search: LibrarySearchParams): string | null {
  if (shareRootOf(search.root) === null) return null
  if (scopeSourceOf(search) !== null) return null
  if (search.untagged) return 'the untagged bucket'
  // `album=''` is "any album" — a real browse scope, but POST /api/shares
  // rejects it (it would mean "every tagged image").
  if (search.album === '') return 'the “any album” bucket'
  return 'the “All images” axis'
}

/**
 * What the toolbar's share button does — and it is never "quietly ship a
 * different set than the one counted next to it".
 *
 *  - `scope`    — the axis IS an album/folder and every active filter fits the
 *                 share source: a live share, which keeps tracking the library.
 *  - `snapshot` — something on screen no scope source can express (a capture-date
 *                 or filename filter, or an axis that is not an album/folder at
 *                 all), so the button materialises exactly the matching images
 *                 into a selection share and says why. `dropped` is never empty
 *                 in this mode — the UI renders it as the reason.
 *  - null       — ONLY `root='raws'`, where no row is shareable (every one is
 *                 `kind='raw'`, which POST /api/shares rejects).
 */
export type ShareAction =
  | { mode: 'scope'; source: ScopeShareSource }
  | { mode: 'snapshot'; dropped: string[] }
  | null

export function shareActionOf(search: LibrarySearchParams): ShareAction {
  if (shareRootOf(search.root) === null) return null
  const axis = unscopableAxis(search)
  const filters = unshareableFilters(search)
  const dropped = axis === null ? filters : [axis, ...filters]
  const source = scopeSourceOf(search)
  if (source !== null && dropped.length === 0) return { mode: 'scope', source }
  return { mode: 'snapshot', dropped }
}

/** The URL state as `GET /api/library/images` query params. */
export function toImagesParams(
  search: LibrarySearchParams,
  limit = LIBRARY_PAGE_LIMIT,
): LibraryImagesParams {
  const params: LibraryImagesParams = {
    root: search.root,
    page: search.page,
    limit,
    sort: search.sort,
    order: search.order,
    recursive: search.recursive,
  }
  // Albums, renditions and shares are all JPEG-only; the raws root is the one
  // place the grid is browsing something else.
  if (search.root !== 'raws') params.kind = 'jpeg'
  if (search.dir !== undefined) params.dir = search.dir
  // `album` and `untagged` are a 400 when sent together — even `untagged=false`
  // counts as "sent", so exactly one of them may appear in the query.
  if (search.album !== undefined) params.album = search.album
  else if (search.untagged) params.untagged = true
  if (search.minRating) params.minRating = search.minRating
  if (search.captureFrom) params.captureFrom = search.captureFrom
  if (search.captureTo) params.captureTo = search.captureTo
  if (search.stem) params.stem = search.stem
  return params
}

/** Everything that changes WHICH images match — sort/order deliberately excluded. */
export function filterKeyOf(search: LibrarySearchParams): string {
  return JSON.stringify([
    search.root,
    search.dir ?? null,
    search.album ?? null,
    search.untagged,
    search.recursive,
    search.minRating ?? 0,
    search.captureFrom ?? null,
    search.captureTo ?? null,
    search.stem ?? null,
  ])
}

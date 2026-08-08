import type { ImageDto, ImageKind } from '../../lib/queries/library'

/**
 * What the Library page remembers about a selected image.
 *
 * Selection is a Map, not a Set of ids, for one reason: a selection share
 * promises capture order, and the old Set could only order the ids that
 * happened to be on the CURRENT page — anything picked on page 2 fell back to
 * click order and silently shipped in the wrong sequence. Every id enters the
 * selection through a row we have already fetched, so its sort key is known at
 * that moment; keeping it makes the ordering exact across pages, across
 * filters, and across a page the user has long since navigated away from.
 */
export type SelectedImage = {
  id: number
  stem: string
  ext: string
  root: string
  dir: string
  kind: ImageKind
  captureAt: string | null
  rating: number | null
}

export type Selection = ReadonlyMap<number, SelectedImage>

export function toSelected(image: ImageDto): SelectedImage {
  return {
    id: image.id,
    stem: image.stem,
    ext: image.ext,
    root: image.root,
    dir: image.dir,
    kind: image.kind,
    captureAt: image.captureAt,
    rating: image.rating,
  }
}

/**
 * The order a selection SHIPS in: oldest capture first, tie-broken by id.
 *
 * Deliberately not parameterised by the toolbar's sort/order. Those are a
 * BROWSE preference — how the owner is looking for photos right now — and they
 * used to leak all the way to the friend: the grid defaults to captureAt/DESC,
 * so a 20-photo trip arrived scrolling backwards, and picking Sort=Name shipped
 * it in filename order instead. Folder and album shares have always been
 * capture-ascending, so this is also what makes all three source types agree.
 *
 * `asc(capture_at), asc(id)` is exactly the API's own ordering (share-auth.ts),
 * so the review modal shows the sequence the share page will render. NULL
 * capture dates sort first, matching SQLite.
 */
function compareByCapture(a: SelectedImage, b: SelectedImage): number {
  const left = a.captureAt ?? ''
  const right = b.captureAt ?? ''
  if (left !== right) return left < right ? -1 : 1
  return a.id - b.id
}

/** The selection in the order a share of it will be delivered. */
export function orderedSelection(selection: Selection): SelectedImage[] {
  return Array.from(selection.values()).toSorted(compareByCapture)
}

/**
 * Selected rows that can never be shared: a `.RAF` has no rendition (design
 * §6), so every tile of it would 500 on the friend's page. The RAWs root is a
 * first-class browse axis and "Select all N matching" takes all 3661 of its
 * rows, so this is one click away — POST /api/shares rejects them (400), and
 * the page uses this to say so BEFORE the modal opens.
 */
export function unshareableSelection(selection: Selection): SelectedImage[] {
  return orderedSelection(selection).filter((image) => image.kind !== 'jpeg')
}

export function addToSelection(
  selection: Selection,
  images: ImageDto[],
): Map<number, SelectedImage> {
  const next = new Map(selection)
  for (const image of images) next.set(image.id, toSelected(image))
  return next
}

export function removeFromSelection(
  selection: Selection,
  ids: number[],
): Map<number, SelectedImage> {
  const next = new Map(selection)
  for (const id of ids) next.delete(id)
  return next
}

/** Drops everything not in `keepIds` — "keep only what the current filter matches". */
export function intersectSelection(
  selection: Selection,
  keepIds: Set<number>,
): Map<number, SelectedImage> {
  const next = new Map<number, SelectedImage>()
  for (const [id, image] of selection) {
    if (keepIds.has(id)) next.set(id, image)
  }
  return next
}

// ── Staleness ────────────────────────────────────────────────────────────────
//
// A share is built from the WHOLE selection, not from what is on screen. So the
// page tracks every filter (see `filterKeyOf`) under which something currently
// selected was picked, and warns as soon as that set is anything other than
// "exactly the filter you are looking at".

export type SelectionKeys = ReadonlySet<string>

/** True when the selection contains images the current filter does not describe. */
export function isSelectionStale(
  selection: Selection,
  keys: SelectionKeys,
  filterKey: string,
): boolean {
  return selection.size > 0 && !(keys.size === 1 && keys.has(filterKey))
}

/**
 * The key set after a selection change.
 *
 * `matchesCurrentFilter` is the "the new selection was just computed FROM this
 * filter" case (keep-only-matching), which collapses the history to one key.
 * A plain add cannot claim that — anything picked under an earlier filter is
 * still in there — so it only records that this filter contributed. Returns
 * `keys` unchanged when nothing moved, so React can skip the re-render.
 */
export function nextSelectionKeys(
  keys: SelectionKeys,
  selection: Selection,
  filterKey: string,
  matchesCurrentFilter = false,
): SelectionKeys {
  if (selection.size === 0) return keys.size === 0 ? keys : new Set<string>()
  if (matchesCurrentFilter) {
    return keys.size === 1 && keys.has(filterKey) ? keys : new Set([filterKey])
  }
  return keys.has(filterKey) ? keys : new Set(keys).add(filterKey)
}

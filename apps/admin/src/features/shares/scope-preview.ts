import { skipToken, useQuery } from '@tanstack/react-query'
import { useDebouncedValue } from '@mantine/hooks'
import { unwrap } from 'basalt-ui/query'
import { client } from '../../lib/eden'
import type { ShareSourceInput } from '../../lib/queries/shares'
import { shareScopeLabel } from './share-forms'

export type ScopePreview = {
  /** Images the share will contain, or undefined while unknown. */
  total: number | undefined
  /**
   * The number on screen was computed for the CURRENT source. False while a
   * keystroke debounce is settling — the create modal blocks submit then, so a
   * share can never be minted against a scope the operator never saw a count
   * for.
   */
  fresh: boolean
  /** Set when the preview request itself failed (the count is unverifiable). */
  error: unknown
  /** Human-readable scope line, e.g. `Album fuji/Ereignisse|Segeln 25 (incl. sub-albums)`. */
  label: string
}

const DEBOUNCE_MS = 300

/**
 * The live image count for a share source, computed by handing
 * GET /api/library/images the SAME scope object the share will be POSTed with
 * (plus the `kind='jpeg'` restriction the share predicate applies) — that route
 * is documented as exactly this preview and shares POST /api/shares'
 * `recursive` default.
 *
 * Preview-equals-reality is the invariant, and it is structural here: the hook
 * takes the resolved `ShareSourceInput` rather than loose form values, so there
 * is no second place where a scope field could be assembled differently for the
 * preview than for the create call.
 */
export function useScopePreview(source: ShareSourceInput | null): ScopePreview {
  // Debounced so a typed directory doesn't fire a request per keystroke. The
  // count belongs to the debounced value; `fresh` reports whether that is still
  // the live scope.
  const [debounced] = useDebouncedValue(source, DEBOUNCE_MS)
  const previewed = debounced !== null && debounced.type !== 'selection' ? debounced : null

  const params =
    previewed === null
      ? null
      : {
          root: previewed.root,
          ...(previewed.type === 'album' ? { album: previewed.album } : { dir: previewed.dir }),
          kind: 'jpeg' as const,
          recursive: previewed.recursive,
          // 0 and null both mean "no filter" on this route and in the share
          // predicate alike, so an unset rating is simply not sent.
          ...(previewed.minRating ? { minRating: previewed.minRating } : {}),
          page: 1,
          limit: 1,
        }

  const query = useQuery({
    queryKey: ['library', 'images', 'share-scope-preview', params] as const,
    queryFn:
      params === null ? skipToken : () => unwrap(client.api.library.images.get({ query: params })),
  })

  if (source === null) return { total: undefined, fresh: true, error: null, label: '' }

  const label = shareScopeLabel(source)
  if (source.type === 'selection') {
    return { total: source.imageIds.length, fresh: true, error: null, label }
  }

  const fresh = JSON.stringify(source) === JSON.stringify(previewed)
  return {
    total: fresh ? query.data?.total : undefined,
    fresh,
    error: fresh ? query.error : null,
    label,
  }
}

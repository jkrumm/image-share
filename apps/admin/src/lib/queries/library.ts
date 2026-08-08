import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { unwrap } from 'basalt-ui/query'
import { client } from '../eden'

export type LibraryRoot = 'fuji' | 'raws' | 'share'
export type ImageKind = 'jpeg' | 'raw' | 'image' | 'other'

export type ImageDto = {
  id: number
  root: LibraryRoot
  relPath: string
  dir: string
  stem: string
  ext: string
  kind: ImageKind
  fileSize: number
  mtimeMs: number
  captureAt: string | null
  orientation: number | null
  rating: number | null
  width: number | null
  height: number | null
  rawPath: string | null
  indexedAt: string
}

export type DirDto = {
  root: LibraryRoot
  dir: string
  imageCount: number
  ratedCounts: { r4plus: number; r5: number }
  rawPairedCount: number
  minCaptureAt: string | null
  maxCaptureAt: string | null
}

/**
 * A node of the Lightroom keyword tree (`GET /api/library/albums`) — the axis
 * the library is actually browsed on, because the Fuji tree is one flat
 * directory (design §3.1).
 *
 * The server emits one node per distinct path PREFIX, so every ancestor of a
 * stored path is guaranteed to be present and the client only has to nest what
 * it is given. `path: ''` / `leaf: '(untagged)'` is the synthetic node covering
 * every JPEG with no keywords at all — today ~76% of the library, so it is a
 * first-class entry, not an edge case. `imageCount` is recursive and deduped.
 */
export type AlbumNode = {
  path: string
  leaf: string
  depth: number
  imageCount: number
  ratedCounts: { r4plus: number; r5: number }
  minCaptureAt: string | null
  maxCaptureAt: string | null
}

export type LibrarySort = 'captureAt' | 'name'
export type LibraryOrder = 'asc' | 'desc'

export type LibraryImagesParams = {
  root?: LibraryRoot
  dir?: string
  kind?: ImageKind
  recursive?: boolean
  /** A `GET /api/library/albums` path. `''` means "in any album". Mutually
   * exclusive with `untagged` — sending both is a 400, not an empty result. */
  album?: string
  untagged?: boolean
  /** Inclusive; a bare `YYYY-MM-DD` means that whole UTC day. */
  captureFrom?: string
  captureTo?: string
  minRating?: number
  /** Case-insensitive substring match against the filename stem. */
  stem?: string
  page?: number
  limit?: number
  sort?: LibrarySort
  order?: LibraryOrder
}

/** The server's own cap on `limit` — the page size "select all matching" walks with. */
export const MAX_PAGE_LIMIT = 200

export const libraryQueries = {
  all: () => ['library'] as const,
  dirs: () =>
    queryOptions({
      queryKey: [...libraryQueries.all(), 'dirs'] as const,
      queryFn: () => unwrap(client.api.library.dirs.get()),
    }),
  albums: (root: LibraryRoot) =>
    queryOptions({
      queryKey: [...libraryQueries.all(), 'albums', root] as const,
      queryFn: () => unwrap(client.api.library.albums.get({ query: { root } })),
    }),
  images: (params: LibraryImagesParams) =>
    queryOptions({
      queryKey: [...libraryQueries.all(), 'images', params] as const,
      queryFn: () => unwrap(client.api.library.images.get({ query: params })),
    }),
}

/**
 * Every image matching `params`, ignoring its `page`/`limit` — the backing call
 * for "select all matching" and for pruning a selection down to the current
 * filter. Walks the server's own 200-row cap sequentially (a 2365-image root is
 * 12 requests) rather than asking for an unbounded page, and re-reads `total`
 * from the first response so it stops exactly where the server says it ends.
 *
 * `hardLimit` is a safety valve, not a business rule: it exists so a
 * mis-specified filter cannot spin forever against a library that grew.
 */
export async function fetchAllMatchingImages(
  params: LibraryImagesParams,
  hardLimit = 10_000,
): Promise<ImageDto[]> {
  const collected: ImageDto[] = []
  let page = 1
  let total = Infinity

  while (collected.length < Math.min(total, hardLimit)) {
    const result = await unwrap(
      client.api.library.images.get({
        query: { ...params, page, limit: MAX_PAGE_LIMIT },
      }),
    )
    total = result.total
    if (result.data.length === 0) break
    collected.push(...(result.data as ImageDto[]))
    page += 1
  }

  return collected
}

export type PublishInput = { imageIds: number[]; prefix: 'fuji' | 'blog' | 'gen' | 'misc' }

export function usePublishImages() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: PublishInput) => unwrap(client.api.publish.post(body)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['b2'] })
      void qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })
}

import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { unwrap } from 'basalt-ui/query'
import { client } from '../eden'
import { uploadWithProgress, type UploadProgress } from '../upload-with-progress'

// The public CDN browser (design §8/§12 stage 4) — a peer of library.ts for
// the private Library page. Also owns the Reconcile/Reverse-backup triggers,
// moved off the Activity page (which keeps only StatCards + the indexer).

export type B2Prefix = 'fuji' | 'blog' | 'gen' | 'misc'

export type B2ObjectDto = {
  key: string
  size: number
  lastModified: string
  etag: string | null
  mirrored: boolean
  publishedImageId: number | null
  firstSeenAt: string
  cdnUrl: string
  thumbUrl: string
}

export type B2ListParams = {
  prefix?: 'all' | B2Prefix
  /** Case-insensitive substring match against the object key. */
  q?: string
  page?: number
  limit?: number
  sort?: 'lastModified' | 'key' | 'size'
  order?: 'asc' | 'desc'
}

export type B2ListResponse = {
  data: B2ObjectDto[]
  /** Count AFTER prefix/q — this is the pagination total, not a bucket total. */
  total: number
  totalBytes: number
  unmirroredCount: number
  lastReconcileAt: string | null
}

/** What the Public header strip shows. `objects` is bucket-wide like the other
 * three — see {@link b2Queries.bucketSummary}. */
export type B2BucketSummary = {
  objects: number
  totalBytes: number
  unmirroredCount: number
  lastReconcileAt: string | null
}

export const b2Queries = {
  all: () => ['b2'] as const,
  list: (params: B2ListParams) =>
    queryOptions({
      queryKey: [...b2Queries.all(), 'list', params] as const,
      queryFn: () => unwrap(client.api.b2.get({ query: params })) as Promise<B2ListResponse>,
    }),
  /**
   * The header strip must read bucket-wide "regardless of the active filter"
   * (design §12). `GET /api/b2` returns totalBytes/unmirroredCount/lastReconcileAt
   * unfiltered but `total` filtered, so an unfiltered one-row call is the only
   * way to get a bucket-wide object count without changing the API contract.
   * Costs one COUNT — and it is shared by every filter combination, so switching
   * prefix or typing in the search box never refetches it.
   */
  bucketSummary: () =>
    queryOptions({
      queryKey: [...b2Queries.all(), 'bucket-summary'] as const,
      queryFn: async (): Promise<B2BucketSummary> => {
        const res = (await unwrap(
          client.api.b2.get({ query: { page: 1, limit: 1 } }),
        )) as B2ListResponse
        return {
          objects: res.total,
          totalBytes: res.totalBytes,
          unmirroredCount: res.unmirroredCount,
          lastReconcileAt: res.lastReconcileAt,
        }
      },
    }),
}

function invalidateB2(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: b2Queries.all() })
  void qc.invalidateQueries({ queryKey: ['stats'] })
}

export function useTriggerB2Reconcile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => unwrap(client.api.b2.reconcile.post()),
    onSuccess: () => invalidateB2(qc),
  })
}

export function useTriggerReverseBackup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => unwrap(client.api.backup['reverse-run'].post()),
    onSuccess: () => invalidateB2(qc),
  })
}

export function useDeleteB2Object() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (key: string) => unwrap(client.api.b2({ key: encodeURIComponent(key) }).delete()),
    onSuccess: () => invalidateB2(qc),
  })
}

export type B2UploadInput = {
  file: File
  prefix: B2Prefix
  /**
   * Nested path under `img/<prefix>/`, e.g. `2026/07/trip` — preserves the
   * exporter's directory structure instead of flattening every upload into one
   * directory. Validated server-side (segments `[A-Za-z0-9._-]+`, max 8 segments
   * / 200 chars, no `.`/`..`); a violation comes back as a 400 before B2 is
   * touched, and the message is surfaced verbatim by `notifyMutation`.
   */
  subdir?: string
  onProgress?: (progress: UploadProgress) => void
}
export type B2UploadResult = { uploaded: boolean; key: string; cdnUrl: string; reason?: string }

export function useUploadB2Object() {
  const qc = useQueryClient()
  return useMutation({
    // Not Eden: this is the one call that needs upload progress (see
    // lib/upload-with-progress.ts). Same route, same bearer, same error shape.
    mutationFn: ({ file, prefix, subdir, onProgress }: B2UploadInput) => {
      const body = new FormData()
      body.append('file', file)
      body.append('prefix', prefix)
      if (subdir) body.append('subdir', subdir)
      return uploadWithProgress<B2UploadResult>({
        path: '/api/b2/upload',
        body,
        ...(onProgress && { onProgress }),
      })
    },
    onSuccess: () => invalidateB2(qc),
  })
}

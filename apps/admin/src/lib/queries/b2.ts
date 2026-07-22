import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { unwrap } from 'basalt-ui/query'
import { client } from '../eden'

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
  page?: number
  limit?: number
  sort?: 'lastModified' | 'key' | 'size'
  order?: 'asc' | 'desc'
}

export type B2ListResponse = {
  data: B2ObjectDto[]
  total: number
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

export type B2UploadInput = { file: File; prefix: B2Prefix }
export type B2UploadResult = { uploaded: boolean; key: string; cdnUrl: string; reason?: string }

export function useUploadB2Object() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ file, prefix }: B2UploadInput) =>
      unwrap(client.api.b2.upload.post({ file, prefix })) as Promise<B2UploadResult>,
    onSuccess: () => invalidateB2(qc),
  })
}

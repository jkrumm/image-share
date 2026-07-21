import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { unwrap } from 'basalt-ui/query'
import { client } from '../eden'

export type StatsDto = {
  images: number
  jpegs: number
  raws: number
  uploads: number
  shares: number
  activeTokens: number
  b2Objects: number
  b2Unmirrored: number
  renditionCacheBytes: number
  dbSizeBytes: number
  lastIndexAt: string | null
  version: string
}

export type IndexStatusDto = {
  running: boolean
  startedAt: string | null
  lastFinishedAt: string | null
  lastCounts: { scanned: number; added: number; updated: number; removed: number } | null
  lastError: string | null
}

export type B2ObjectDto = {
  key: string
  size: number
  lastModified: string
  etag: string | null
  mirrored: boolean
  publishedImageId: number | null
  firstSeenAt: string
}

export const activityQueries = {
  stats: () =>
    queryOptions({
      queryKey: ['stats'] as const,
      queryFn: () => unwrap(client.api.stats.get()),
      // The Activity page auto-refreshes so a running index/rescan shows progress.
      refetchInterval: 5000,
    }),
  indexStatus: () =>
    queryOptions({
      queryKey: ['index', 'status'] as const,
      queryFn: () => unwrap(client.api.index.status.get()),
      refetchInterval: 5000,
    }),
  b2: (params: { prefix?: string; page?: number; limit?: number }) =>
    queryOptions({
      queryKey: ['b2', 'list', params] as const,
      queryFn: () => unwrap(client.api.b2.get({ query: params })),
    }),
}

function invalidateActivity(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['stats'] })
  void qc.invalidateQueries({ queryKey: ['index'] })
  void qc.invalidateQueries({ queryKey: ['b2'] })
}

export function useTriggerRescan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => unwrap(client.api.index.rescan.post()),
    onSuccess: () => invalidateActivity(qc),
  })
}

export function useTriggerB2Reconcile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => unwrap(client.api.b2.reconcile.post()),
    onSuccess: () => invalidateActivity(qc),
  })
}

export function useTriggerReverseBackup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => unwrap(client.api.backup['reverse-run'].post()),
    onSuccess: () => invalidateActivity(qc),
  })
}

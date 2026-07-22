import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { unwrap } from 'basalt-ui/query'
import { client } from '../eden'

export type StatsDto = {
  images: number
  jpegs: number
  raws: number
  share: number
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
}

export function useTriggerRescan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => unwrap(client.api.index.rescan.post()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stats'] })
      void qc.invalidateQueries({ queryKey: ['index'] })
    },
  })
}

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

export type LibraryImagesParams = {
  root?: LibraryRoot
  dir?: string
  recursive?: boolean
  minRating?: number
  page?: number
  limit?: number
  sort?: 'captureAt' | 'name'
  order?: 'asc' | 'desc'
}

export const libraryQueries = {
  all: () => ['library'] as const,
  dirs: () =>
    queryOptions({
      queryKey: [...libraryQueries.all(), 'dirs'] as const,
      queryFn: () => unwrap(client.api.library.dirs.get()),
    }),
  images: (params: LibraryImagesParams) =>
    queryOptions({
      queryKey: [...libraryQueries.all(), 'images', params] as const,
      queryFn: () => unwrap(client.api.library.images.get({ query: params })),
    }),
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

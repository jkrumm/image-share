import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { unwrap } from 'basalt-ui/query'
import { client } from '../eden'
import type { LibraryRoot } from './library'

export type TokenDto = {
  id: number
  token: string
  createdAt: string
  revokedAt: string | null
  url: string
}

export type ShareDto = {
  id: number
  slug: string
  root: LibraryRoot
  dir: string
  minRating: number | null
  sizeLimit: 'medium' | 'full'
  includeRaws: boolean
  hasPassword: boolean
  expiresAt: string | null
  note: string | null
  createdAt: string
  tokens: TokenDto[]
}

// Shares can only target roots that hold JPEG-kind rows; RAWS_ROOT is rejected
// server-side (a raws share can never contain an image). Mirrors the API's
// CreateShareBody.root enum.
export type ShareRoot = 'library' | 'uploads'

export type CreateShareInput = {
  slug: string
  root: ShareRoot
  dir: string
  minRating?: number | null
  sizeLimit: 'medium' | 'full'
  includeRaws: boolean
  password?: string | null
  expiresAt?: string | null
  note?: string | null
}

export type UpdateShareInput = Partial<CreateShareInput> & { id: number }

export const sharesQueries = {
  all: () => ['shares'] as const,
  list: () =>
    queryOptions({
      queryKey: [...sharesQueries.all(), 'list'] as const,
      queryFn: () => unwrap(client.api.shares.get()),
    }),
}

function invalidateShares(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: sharesQueries.all() })
}

export function useCreateShare() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateShareInput) => unwrap(client.api.shares.post(body)),
    onSuccess: () => invalidateShares(qc),
  })
}

export function useUpdateShare() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateShareInput) =>
      unwrap(client.api.shares({ id: String(id) }).patch(body)),
    onSuccess: () => invalidateShares(qc),
  })
}

export function useDeleteShare() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => unwrap(client.api.shares({ id: String(id) }).delete()),
    onSuccess: () => invalidateShares(qc),
  })
}

export function useRollShareToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => unwrap(client.api.shares({ id: String(id) }).roll.post()),
    onSuccess: () => invalidateShares(qc),
  })
}

export function useAddShareToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => unwrap(client.api.shares({ id: String(id) }).tokens.post()),
    onSuccess: () => invalidateShares(qc),
  })
}

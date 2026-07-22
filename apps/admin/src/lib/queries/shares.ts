import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { unwrap } from 'basalt-ui/query'
import { client } from '../eden'

export type TokenRole = 'view' | 'download' | 'full'

export type TokenDto = {
  id: number
  role: TokenRole
  label: string | null
  createdAt: string
  revokedAt: string | null
  url: string
}

// Folder shares can only target roots that hold JPEG-kind rows; RAWS_ROOT is
// rejected server-side (a raws share can never contain an image). Mirrors the
// API's ShareRootEnum.
export type ShareRoot = 'fuji' | 'share'

export type ShareDto = {
  id: number
  slug: string
  title: string
  sourceType: 'folder' | 'selection'
  root: ShareRoot | null
  dir: string | null
  minRating: number | null
  expiresAt: string | null
  note: string | null
  createdAt: string
  imageCount: number
  tokens: TokenDto[]
}

export type ShareSourceInput =
  | { type: 'folder'; root: ShareRoot; dir: string; minRating?: number | null }
  | { type: 'selection'; imageIds: number[] }

export type CreateShareInput = {
  slug?: string
  title: string
  note?: string | null
  expiresAt?: string | null
  source: ShareSourceInput
}

export type UpdateShareInput = {
  id: number
  title?: string
  note?: string | null
  expiresAt?: string | null
  minRating?: number | null
  imageIds?: number[]
}

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
    mutationFn: ({ id, role, label }: { id: number; role: TokenRole; label?: string | null }) =>
      unwrap(client.api.shares({ id: String(id) }).tokens.post({ role, label })),
    onSuccess: () => invalidateShares(qc),
  })
}

export function useRevokeShareToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, tokenId }: { id: number; tokenId: number }) =>
      unwrap(
        client.api
          .shares({ id: String(id) })
          .tokens({ tokenId: String(tokenId) })
          .revoke.post(),
      ),
    onSuccess: () => invalidateShares(qc),
  })
}

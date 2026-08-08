import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { unwrap } from 'basalt-ui/query'
import { client } from '../eden'
import type { ImageDto } from './library'

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
  sourceType: 'folder' | 'selection' | 'album'
  root: ShareRoot | null
  dir: string | null
  /** Album shares: the hierarchical keyword path, e.g. `Ereignisse|Segeln 25`. */
  album: string | null
  /** Folder shares: sub-directories of `dir`. Album shares: sub-albums of `album`. */
  recursive: boolean
  minRating: number | null
  expiresAt: string | null
  note: string | null
  createdAt: string
  imageCount: number
  tokens: TokenDto[]
}

export type ShareDetailDto = ShareDto & { images: ImageDto[] }

/**
 * The `source` POST /api/shares accepts.
 *
 * `recursive` and `minRating` are REQUIRED here even though the server defaults
 * them, and that is load-bearing: the create-share count preview hits
 * GET /api/library/images with this exact object, so any field the client
 * leaves to a server default is a field the preview and the share can disagree
 * on. State the whole scope, preview the whole scope, ship the whole scope.
 */
export type ShareSourceInput =
  | {
      type: 'folder'
      root: ShareRoot
      dir: string
      recursive: boolean
      minRating: number | null
    }
  | {
      type: 'album'
      root: ShareRoot
      /** Hierarchical keyword path from GET /api/library/albums, e.g. `Ereignisse|Segeln 25`. */
      album: string
      recursive: boolean
      minRating: number | null
    }
  | { type: 'selection'; imageIds: number[] }

export type CreateShareInput = {
  slug?: string
  title: string
  note?: string | null
  expiresAt?: string | null
  /** Role of the initial minted token — the server defaults to `view`. */
  role?: TokenRole
  source: ShareSourceInput
}

export type UpdateShareInput = {
  id: number
  title?: string
  note?: string | null
  expiresAt?: string | null
  minRating?: number | null
  recursive?: boolean
  /** Album shares only — re-targets the hierarchical keyword path. */
  album?: string
  imageIds?: number[]
}

export const sharesQueries = {
  all: () => ['shares'] as const,
  list: () =>
    queryOptions({
      queryKey: [...sharesQueries.all(), 'list'] as const,
      queryFn: () => unwrap(client.api.shares.get()),
    }),
  detail: (id: number) =>
    queryOptions({
      queryKey: [...sharesQueries.all(), 'detail', id] as const,
      queryFn: () => unwrap(client.api.shares({ id: String(id) }).get()) as Promise<ShareDetailDto>,
    }),
}

/** Share detail page data — thin wrapper over sharesQueries.detail(id). */
export function useShare(id: number) {
  return useQuery(sharesQueries.detail(id))
}

function invalidateShares(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: sharesQueries.all() })
}

export function useCreateShare() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateShareInput) =>
      unwrap(client.api.shares.post(body)) as Promise<ShareDto>,
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
      unwrap(
        client.api.shares({ id: String(id) }).tokens.post({ role, label }),
      ) as Promise<TokenDto>,
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

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { uploadWithProgress, type UploadProgress } from '../upload-with-progress'

export type UploadImageResponse = {
  id: number
  root: 'share'
  relPath: string
  adminFileUrl: string
}

export type UploadImageInput = {
  file: File
  /**
   * Sub-directory hint under the share area — the file lands in
   * `SHARE_ROOT/<yyyy>/<mm>/<dir>/`. Empty/`.`/`..` segments are stripped
   * server-side; the resulting `relPath` comes back in the response.
   */
  dir?: string
  onProgress?: (progress: UploadProgress) => void
}

export function useUploadImage() {
  const qc = useQueryClient()
  return useMutation({
    // Not Eden: multipart upload with per-byte progress, which fetch cannot
    // report (see lib/upload-with-progress.ts). Same route, same bearer header,
    // same error shape as an Eden envelope.
    mutationFn: ({ file, dir, onProgress }: UploadImageInput) => {
      const body = new FormData()
      body.append('file', file)
      if (dir) body.append('dir', dir)
      return uploadWithProgress<UploadImageResponse>({
        path: '/api/images',
        body,
        ...(onProgress && { onProgress }),
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['library'] })
      void qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })
}

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { unwrap } from 'basalt-ui/query'
import { client } from '../eden'

export type UploadImageResponse = {
  id: number
  root: 'share'
  relPath: string
  adminFileUrl: string
}

export function useUploadImage() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (file: File) => unwrap(client.api.images.post({ file })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['library'] })
      void qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })
}

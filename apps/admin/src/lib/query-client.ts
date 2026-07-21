import { MutationCache, QueryCache } from '@tanstack/react-query'
import { createBasaltQueryClient } from 'basalt-ui/query'
import { clearToken, isUnauthorizedError } from './auth'

export const queryClient = createBasaltQueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (isUnauthorizedError(error)) clearToken()
    },
  }),
  mutationCache: new MutationCache({
    onError: (error) => {
      if (isUnauthorizedError(error)) clearToken()
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (isUnauthorizedError(error)) return false
        return failureCount < 1
      },
    },
  },
})

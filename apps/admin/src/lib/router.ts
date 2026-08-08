import { createRouter } from '@tanstack/react-router'
import { queryClient } from './query-client'
import { RouteErrorComponent, RouteNotFound } from '../features/common/route-error'
import { routeTree } from '../routeTree.gen'

export const router = createRouter({
  routeTree,
  // The admin SPA is served under /admin (design §1); the API serves the shell
  // and its assets at that prefix, so the router must resolve routes there too.
  basepath: '/admin',
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  // Without these a thrown render error unmounts the whole app to a blank page
  // and an unknown /admin URL renders nothing. Both keep the shell around.
  defaultErrorComponent: RouteErrorComponent,
  defaultNotFoundComponent: RouteNotFound,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

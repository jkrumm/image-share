// Shared admin building blocks. Pages import from here, not from the individual
// files — one import line, one place to look for what already exists.

export {
  ErrorState,
  LoadingState,
  QueryState,
  type EmptyCopy,
  type ErrorStateProps,
  type QueryStateLike,
  type QueryStateProps,
  type StateVariant,
} from './query-state'

export { RouteErrorComponent, RouteNotFound } from './route-error'

export { LibraryImage, useImageFileUrl, type LibraryImageProps } from './library-image'

export { notifyMutation, type NotifyMutationMessages } from './notify'

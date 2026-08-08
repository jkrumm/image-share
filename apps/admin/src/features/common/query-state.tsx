import { Alert, Button, Center, Group, Loader, Stack, Text } from '@mantine/core'
import { EmptyState } from 'basalt-ui'
import type { ReactNode } from 'react'
import { toErrorMessage } from '../../lib/eden'

// The one thing a page renders around a query. Before this existed the SPA had
// zero error branches: a 500 on the library rendered "No images", a dropped
// connection on a share detail rendered "Share not found — it may have been
// deleted". Every page now shows the REAL server message plus a retry.

export type StateVariant = 'page' | 'section'

/**
 * The structural subset of a TanStack `UseQueryResult` that these components
 * read. Typed as a subset (not `UseQueryResult<T>`) so a hand-rolled or
 * composed result can be passed without casting.
 */
export type QueryStateLike<TData> = {
  data: TData | undefined
  isError: boolean
  error: unknown
  fetchStatus: 'fetching' | 'paused' | 'idle'
  refetch: () => unknown
}

export type EmptyCopy = {
  title: string
  description: string
  action?: ReactNode
}

// ── Building blocks (usable on their own, outside a query) ───────────────────

export function LoadingState({ variant = 'page' }: { variant?: StateVariant }): ReactNode {
  if (variant === 'section') return <Loader size="sm" />
  return (
    <Center py={64}>
      <Loader size="sm" />
    </Center>
  )
}

export type ErrorStateProps = {
  /** Whatever was thrown — the raw Eden envelope is fine, it gets decoded. */
  error: unknown
  /** Alert heading. Say what failed, e.g. `Could not load images`. */
  title?: string
  /** Shown only when the server body carries no readable message. */
  fallback?: string
  onRetry?: () => void
  /** Disables/spins the retry button while a refetch is in flight. */
  retrying?: boolean
  variant?: StateVariant
  /** Extra controls beside Retry (e.g. a "Back to shares" link). */
  action?: ReactNode
}

export function ErrorState({
  error,
  title = 'Something went wrong',
  fallback = 'The request failed.',
  onRetry,
  retrying = false,
  variant = 'page',
  action,
}: ErrorStateProps): ReactNode {
  const alert = (
    <Alert color="red" variant="light" title={title}>
      <Stack gap="sm">
        <Text size="sm">{toErrorMessage(error, fallback)}</Text>
        {(onRetry || action) && (
          <Group gap="xs">
            {onRetry && (
              <Button size="xs" variant="default" loading={retrying} onClick={onRetry}>
                Retry
              </Button>
            )}
            {action}
          </Group>
        )}
      </Stack>
    </Alert>
  )
  if (variant === 'section') return alert
  return <Stack py="md">{alert}</Stack>
}

// ── QueryState ───────────────────────────────────────────────────────────────

/** `[]`, `{ data: [], total }` (the API's pagination envelope) and null all count as empty. */
function defaultIsEmpty(data: unknown): boolean {
  if (data === null || data === undefined) return true
  if (Array.isArray(data)) return data.length === 0
  if (typeof data === 'object' && Array.isArray((data as { data?: unknown }).data)) {
    return (data as { data: unknown[] }).data.length === 0
  }
  return false
}

export type QueryStateProps<TData> = {
  query: QueryStateLike<TData>
  /** A render function gets `data` narrowed to non-undefined; plain nodes also work. */
  children: ReactNode | ((data: TData) => ReactNode)
  /** Omit to render nothing when the result is empty. */
  empty?: EmptyCopy
  /** Override the default `[]` / `{ data: [] }` emptiness test. */
  isEmpty?: (data: TData) => boolean
  /** Alert heading on the error branch — say what failed. */
  errorTitle?: string
  errorFallback?: string
  /** Extra controls beside Retry on the error branch. */
  errorAction?: ReactNode
  variant?: StateVariant
  /** Replace the default spinner (e.g. with a skeleton grid). */
  loading?: ReactNode
}

/**
 * Renders loading / error-with-retry / empty / children for a query, in that
 * order. Branch precedence is deliberate:
 *
 *  - error AND no cached data → full error state (the page cannot render)
 *  - error WITH cached data   → children, plus a compact retry banner on top
 *    (a background refetch failing must not blank a page that already works)
 *  - no data, fetch idle      → empty (this is a `enabled: false` query)
 *  - no data, fetching        → loading
 *
 * @example
 * <QueryState query={q} empty={{ title: 'No images', description: 'Pick an album.' }}>
 *   {({ data }) => <Grid>{data.map(…)}</Grid>}
 * </QueryState>
 */
export function QueryState<TData>({
  query,
  children,
  empty,
  isEmpty,
  errorTitle = 'Could not load',
  errorFallback = 'The request failed.',
  errorAction,
  variant = 'page',
  loading,
}: QueryStateProps<TData>): ReactNode {
  const { data, isError, error, fetchStatus } = query
  const retrying = fetchStatus === 'fetching'
  const retry = (): void => void query.refetch()

  if (isError && data === undefined) {
    return (
      <ErrorState
        error={error}
        title={errorTitle}
        fallback={errorFallback}
        onRetry={retry}
        retrying={retrying}
        variant={variant}
        action={errorAction}
      />
    )
  }

  if (data === undefined) {
    if (fetchStatus === 'idle' && !isError) {
      return empty ? renderEmpty(empty, variant) : null
    }
    return loading ?? <LoadingState variant={variant} />
  }

  const emptyNow = isEmpty ? isEmpty(data) : defaultIsEmpty(data)
  const body = emptyNow
    ? empty
      ? renderEmpty(empty, variant)
      : null
    : typeof children === 'function'
      ? children(data)
      : children

  if (!isError) return body

  return (
    <Stack gap="sm">
      <ErrorState
        error={error}
        title="Showing cached data"
        fallback="The last refresh failed."
        onRetry={retry}
        retrying={retrying}
        variant="section"
      />
      {body}
    </Stack>
  )
}

function renderEmpty(empty: EmptyCopy, variant: StateVariant): ReactNode {
  return (
    <EmptyState
      title={empty.title}
      description={empty.description}
      variant={variant}
      {...(empty.action !== undefined && { action: empty.action })}
    />
  )
}

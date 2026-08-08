import { Alert, Button, Code, Container, Group, Stack, Text, Title } from '@mantine/core'
import { Link, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { VX } from 'basalt-ui/tokens'
import type { ReactNode } from 'react'

// Wired into lib/router.ts as defaultErrorComponent / defaultNotFoundComponent.
// Without them a thrown render error unmounts the whole SPA to a blank page and
// an unknown URL renders nothing at all.

/**
 * Route-level crash fallback (argo's dashboard ErrorBoundary, adapted — this
 * repo ships no icon pack, so the states are text-only).
 */
export function RouteErrorComponent({ error, reset }: ErrorComponentProps): ReactNode {
  const router = useRouter()

  const retry = (): void => {
    reset()
    void router.invalidate()
  }

  const message = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error && error.name ? error.name : 'Error'
  const stack = error instanceof Error ? error.stack : undefined

  return (
    <Container size="sm" pt={64} pb={64}>
      <Stack gap="lg">
        <Stack gap={4}>
          <Title order={2}>Something went wrong</Title>
          <Text c="dimmed" size="sm">
            This page hit an unexpected error. The rest of the admin is still usable.
          </Text>
        </Stack>

        <Alert color="red" variant="light" title={name}>
          <Text size="sm">{message || 'Unknown error'}</Text>
        </Alert>

        {import.meta.env.DEV && stack && (
          <Code block style={{ fontSize: VX.text.micro, maxHeight: 280, overflow: 'auto' }}>
            {stack}
          </Code>
        )}

        <Group gap="sm">
          <Button onClick={retry}>Try again</Button>
          <Button variant="default" onClick={() => window.location.reload()}>
            Reload page
          </Button>
          <Button variant="subtle" component={Link} to="/">
            Back to library
          </Button>
        </Group>
      </Stack>
    </Container>
  )
}

/** Route-level 404 — an unknown `/admin/...` URL. */
export function RouteNotFound(): ReactNode {
  return (
    <Container size="sm" pt={64} pb={64}>
      <Stack gap="lg">
        <Stack gap={4}>
          <Title order={2}>Page not found</Title>
          <Text c="dimmed" size="sm">
            That URL does not exist in the admin.
          </Text>
        </Stack>
        <Group gap="sm">
          <Button component={Link} to="/">
            Back to library
          </Button>
        </Group>
      </Stack>
    </Container>
  )
}

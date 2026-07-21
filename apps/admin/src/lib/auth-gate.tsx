import { Button, Container, PasswordInput, Stack, Text, Title } from '@mantine/core'
import { field, useBasaltForm } from 'basalt-ui/forms'
import type { ReactNode } from 'react'
import { z } from 'zod'
import { useAuthStore } from './auth'

type Props = { children: ReactNode }

const TokenSchema = z.object({
  token: z.string().trim().min(1, 'API bearer token is required'),
})

export function AuthGate({ children }: Props) {
  const token = useAuthStore((s) => s.token)
  if (token) return <>{children}</>
  return <TokenPrompt />
}

function TokenPrompt() {
  const setToken = useAuthStore((s) => s.setToken)
  const form = useBasaltForm({
    initialValues: { token: '' },
    schema: TokenSchema,
  })

  return (
    <Container size="xs" pt={120} pb={64}>
      <Stack gap="lg">
        <Stack gap={4}>
          <Title order={2}>Image Share</Title>
          <Text c="dimmed" size="sm">
            Enter the API_SECRET bearer token to continue. It is stored in this browser&apos;s
            localStorage and reused on every request.
          </Text>
        </Stack>
        <form
          onSubmit={form.onSubmit(({ token }) => {
            setToken(token.trim())
            window.location.reload()
          })}
        >
          <Stack gap="sm">
            <PasswordInput
              label="API token"
              placeholder="Bearer token"
              autoComplete="current-password"
              {...field(form, 'token')}
            />
            <Button type="submit">Sign in</Button>
          </Stack>
        </form>
      </Stack>
    </Container>
  )
}

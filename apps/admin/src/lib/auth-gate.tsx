import { Button, Center, Container, Loader, PasswordInput, Stack, Text, Title } from '@mantine/core'
import { field, useBasaltForm } from 'basalt-ui/forms'
import type { ReactNode } from 'react'
import { z } from 'zod'
import { useAssetToken, useAssetTokenStore } from './asset-token'
import { useAuthStore } from './auth'

type Props = { children: ReactNode }

const TokenSchema = z.object({
  token: z.string().trim().min(1, 'API bearer token is required'),
})

export function AuthGate({ children }: Props) {
  const token = useAuthStore((s) => s.token)
  if (!token) return <TokenPrompt />
  return <AssetTokenGate>{children}</AssetTokenGate>
}

// Runs only once a bearer exists (the asset-token mint call needs it). Blocks
// on the first mint so `imageFileUrl` — called synchronously during render —
// never produces a token-less <img> URL. A mint 401 is handled globally by
// queryClient's onError (clearToken), which drops the bearer and bounces the
// outer AuthGate back to the TokenPrompt.
//
// Gates on the STORE, not on the query's `data`: useAssetToken copies data
// into the store from a useEffect, which runs *after* children have already
// rendered. Releasing on `data` therefore paints one frame of <img> tags with
// an empty token — every thumbnail 401s and only recovers on the next
// re-render. Subscribing to the store makes this gate re-render when the
// token actually lands, so children never see a null token.
function AssetTokenGate({ children }: Props) {
  useAssetToken()
  const assetToken = useAssetTokenStore((s) => s.token)
  if (!assetToken) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    )
  }
  return <>{children}</>
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

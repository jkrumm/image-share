import '@mantine/core/styles.layer.css'
import '@mantine/notifications/styles.layer.css'
import 'basalt-ui/styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BasaltProvider, createBasaltTheme } from 'basalt-ui'
import { BasaltOverlays } from 'basalt-ui/commands'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { AuthGate } from './lib/auth-gate'
import { queryClient } from './lib/query-client'
import { router } from './lib/router'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element not found')

createRoot(rootEl).render(
  <StrictMode>
    <BasaltProvider
      theme={createBasaltTheme()}
      defaultColorScheme="dark"
      // oxlint-disable-next-line no-console
      onError={(error, ctx) => console.error('[basalt]', ctx, error)}
    >
      {/* spotlight/hotkeys peers (@mantine/spotlight, @tanstack/react-hotkeys) are not
          installed — this admin has no command palette, so both layers stay off. */}
      <BasaltOverlays spotlight={false} hotkeys={false}>
        <QueryClientProvider client={queryClient}>
          <AuthGate>
            <RouterProvider router={router} />
          </AuthGate>
        </QueryClientProvider>
      </BasaltOverlays>
    </BasaltProvider>
  </StrictMode>,
)

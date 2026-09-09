import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { BasaltShell, ThemeToggle } from 'basalt-ui'
import { NotificationBell } from 'basalt-ui/notifications'
import { useNav } from 'basalt-ui/router-tanstack'
import { NAV } from '../lib/nav'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout,
})

function RootLayout() {
  const nav = useNav(NAV)

  return (
    <BasaltShell
      brand={{ name: 'Image Share', version: __APP_VERSION__ }}
      {...nav}
      globalActions={[
        { key: 'bell', node: <NotificationBell /> },
        { key: 'theme', node: <ThemeToggle /> },
      ]}
    >
      <Outlet />
    </BasaltShell>
  )
}

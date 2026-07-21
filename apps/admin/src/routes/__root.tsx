import { createRootRouteWithContext, Link, Outlet, useMatchRoute } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { NavLink as MantineNavLink, Text } from '@mantine/core'
import { BasaltShell, ThemeToggle } from 'basalt-ui'
import { NotificationBell } from 'basalt-ui/notifications'
import type { BreadcrumbLinkRenderer, NavLinkRenderer, SidebarSection } from 'basalt-ui'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout,
})

const NAV_TARGETS: Record<string, { to: string }> = {
  library: { to: '/' },
  shares: { to: '/shares' },
  activity: { to: '/activity' },
  uploads: { to: '/uploads' },
}

const renderBreadcrumbLink: BreadcrumbLinkRenderer = (href, label) => (
  <Text size="sm" c="dimmed" truncate component={Link} to={href as never}>
    {label}
  </Text>
)

function RootLayout() {
  const matchRoute = useMatchRoute()

  const isLibraryActive = !!matchRoute({ to: '/' })
  const isSharesActive = !!matchRoute({ to: '/shares', fuzzy: true })
  const isActivityActive = !!matchRoute({ to: '/activity', fuzzy: true })
  const isUploadsActive = !!matchRoute({ to: '/uploads', fuzzy: true })

  const renderNavLink: NavLinkRenderer = (item, { active, close, navLinkClassName }) => {
    const target = NAV_TARGETS[item.key]
    if (!target) return <MantineNavLink label={item.label} leftSection={item.icon} disabled />
    return (
      <MantineNavLink
        component={Link}
        to={target.to as never}
        label={item.label}
        leftSection={item.icon}
        active={active}
        className={navLinkClassName}
        onClick={() => close?.()}
      />
    )
  }

  const sections: SidebarSection[] = [
    {
      label: 'Image Share',
      items: [
        { key: 'library', label: 'Library', icon: null, href: '/', active: isLibraryActive },
        {
          key: 'shares',
          label: 'Shares',
          icon: null,
          href: '/shares',
          active: isSharesActive,
        },
        {
          key: 'activity',
          label: 'Activity',
          icon: null,
          href: '/activity',
          active: isActivityActive,
        },
        {
          key: 'uploads',
          label: 'Uploads',
          icon: null,
          href: '/uploads',
          active: isUploadsActive,
        },
      ],
    },
  ]

  return (
    <BasaltShell
      brand={{ name: 'Image Share', version: __APP_VERSION__ }}
      sections={sections}
      renderNavLink={renderNavLink}
      renderBreadcrumbLink={renderBreadcrumbLink}
      globalActions={
        <>
          <NotificationBell />
          <ThemeToggle />
        </>
      }
    >
      <Outlet />
    </BasaltShell>
  )
}

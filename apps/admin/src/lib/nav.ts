import { linkOptions } from '@tanstack/react-router'
import { defineNav, navGroup } from 'basalt-ui/router-tanstack'
import { B2SearchSchema } from '../features/b2/search-params'
import { LibrarySearchSchema } from '../features/library/search-params'

/**
 * The single navigation definition — it drives the desktop sidebar AND the mobile bar.
 *
 * A leaf module by contract: it imports `@tanstack/react-router` and `basalt-ui/router-tanstack`
 * and never `routeTree.gen` or `__root.tsx`, so anything else (a redirect, a future command
 * palette) can import it without closing a cycle.
 *
 * `/shares/$id` is deliberately absent — a nav destination cannot carry a route param, and the
 * detail page reaches its breadcrumb parent through the `shares` entry below.
 *
 * No icons: this app installs no icon set, so every slot is label-only. Four destinations claim a
 * bar slot and Uploads falls to the More overlay, which keeps the bar at the 5-slot cap
 * (4 tabs + More) instead of silently dropping one.
 */
export const NAV = defineNav({
  groups: [
    navGroup({ id: 'image-share', label: 'Image Share' }, [
      {
        id: 'library',
        label: 'Library (Private)',
        short: 'Library',
        mobile: 'tab',
        exact: true,
        // Both schemas have a default for every key, so `parse({})` IS the landing state. It is a
        // click-time thunk rather than a module-scope object so a long-lived tab never pins a
        // stale default, and so the router sees the required search params it asks for — the old
        // hand-rolled nav hid that requirement behind a `to={… as never}` cast.
        link: linkOptions({ to: '/', search: () => LibrarySearchSchema.parse({}) }),
      },
      {
        id: 'public',
        label: 'Public (CDN)',
        short: 'Public',
        mobile: 'tab',
        link: linkOptions({ to: '/public', search: () => B2SearchSchema.parse({}) }),
      },
      {
        id: 'shares',
        label: 'Shares',
        mobile: 'tab',
        link: linkOptions({ to: '/shares' }),
      },
      {
        id: 'activity',
        label: 'Activity',
        mobile: 'tab',
        link: linkOptions({ to: '/activity' }),
      },
      {
        id: 'uploads',
        label: 'Uploads',
        link: linkOptions({ to: '/uploads' }),
      },
    ]),
  ],
})

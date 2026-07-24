---
paths:
  - apps/api/**
---

# Route Conventions

## Pagination

All list endpoints use the same shape:

```ts
query: z.object({
  page: z.coerce.number().int().min(1).default(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50).optional(),
  sort: z.enum([...validColumns]).optional(),
  order: z.enum(['asc', 'desc']).default('desc').optional(),
})
response: z.object({ data: z.array(ItemSchema), total: z.number().int() })
```

`page` is 1-indexed. `total` is the count before pagination (for the UI). Some
reads return `{ data }` only (no `total`) when the full set is always returned
(e.g. `/library/dirs`, `/shares`).

## Response shapes

- `200`: data payload
- `201`: created resource (e.g. a share) — `set.status = 201`
- `202`: `{ started: boolean }` for fire-and-forget jobs (rescan, reconcile, reverse-backup)
- `400` / `404`: `z.string()` for validation / missing-resource errors

## Naming

- Route files: `<resource>.ts`; exported constant `<resource>Routes`; prefix `/<resource>`.
- **Use `.get('', …)`** (empty string) for the prefix root — never `.get('/', …)` (trailing slash).
- **All path and query params: camelCase** (`{id}`, `minRating`, `sizeLimit`). Never snake_case.
- Collections plural (`/shares`, `/images`).

## Auth boundary (design §8)

- The bearer guard (`lib/auth-guard.ts`, `as: 'scoped'`) is mounted at the head
  of the `/api` group in `index.ts` — every route in that group is guarded.
- Public routes are mounted OUTSIDE the group: discovery (`GET /api`), health,
  the share surface (`/s/*`), the `assetToken` byte route
  (`/api/library/images/:id/file`), and the static SPA.
- The `assetToken` query bypass is for that ONE byte route only (browser
  `<img>` tags). It is a short-lived HMAC token minted by the bearer-guarded
  `POST /api/library/asset-token` (`lib/asset-token.ts`) — never the raw
  `API_SECRET`. Do not add the bypass elsewhere.

## Filesystem safety (hard rule, design §3)

Every file access resolves through `lib/paths.ts safeJoin(root, rel)`, which
throws on traversal — surface it as a 400. Images are addressed by DB integer
`id` in URLs; raw paths never appear in a route.

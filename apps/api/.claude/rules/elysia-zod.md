---
paths:
  - apps/api/**
---

# Elysia + Zod Validation — image-share API Constraints

Constraints and known degradations when using Zod v4 with `@elysiajs/openapi`.
The general Elysia patterns live in `~/SourceRoot/dotfiles/rules/elysia.md`; this
file covers the project-specific Zod constraints (adapted from argo).

## Plugin config

```ts
import { openapi } from '@elysiajs/openapi'
import { z } from 'zod'

app.use(openapi({
  mapJsonSchema: { zod: z.toJSONSchema },   // REQUIRED for Zod v4
  documentation: { ... },
}))
```

Without `mapJsonSchema: { zod: z.toJSONSchema }` the Scalar UI renders empty schemas.

## Known degradations / rules

- **Literal unions — use `z.enum`, never `z.union([z.literal(...)])` in response
  schemas.** `@elysiajs/openapi` serializes literal unions to invalid OpenAPI
  JSON. Use `z.enum(['medium', 'full'])`.
- **Dates — ISO strings, never `z.date()` / `z.transform()` in route schemas.**
  The wire format is always a string; `z.date()` breaks response serialization.
  Use `z.string().describe('ISO 8601 date')`.
- **No `z.custom()`, `z.void()`, or branded types in route schemas.**
- **Object unions in response schemas are allowed** (render as `oneOf`).
- **`z.unknown()`** for truly opaque fields.

## Query/path param coercion — use `z.coerce.number()` / `z.coerce.boolean()`

Elysia does not coerce Zod `z.number()`/`z.boolean()` in query or path params —
the validator receives the raw string and 422s. Always coerce:

```ts
query: z.object({
  page: z.coerce.number().int().min(1).default(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50).optional(),
  recursive: z.coerce.boolean().default(false).optional(),
})
params: z.object({ id: z.coerce.number().int() })
```

For body fields (JSON-parsed) use plain `z.number()` / `z.boolean()`.

## File uploads

Multipart bodies use `z.file()` for the binary part (see `routes/ingest.ts`).

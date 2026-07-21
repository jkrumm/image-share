---
paths:
  - apps/api/**
---

# OpenAPI — Tags, Paths, and Detail Blocks

The image-share API is consumed by **two classes of clients**: the admin SPA
(Eden Treaty, full TypeScript types on `type App = typeof app`) and **AI agents**
(the dotfiles `img` skill + others, which read `/openapi/json` or browse Scalar
at `/openapi`). The spec is the agent contract — treat every route's `detail`
block as documentation for a stranger who has only the OpenAPI JSON.

## Discovery

- `GET /api` — public discovery: `{ name, version, docs, auth, tags }`. Agents start here.
- `GET /openapi` — Scalar UI. `GET /openapi/json` — raw spec.

## Tag taxonomy (enum — do not invent new tags)

Every route MUST use exactly one of these. Keep this list in lockstep with the
`tags:` array in `src/index.ts`.

| Tag         | Belongs to it                                                        |
| ----------- | -------------------------------------------------------------------- |
| `System`    | `/api` (discovery), `/health`                                        |
| `Library`   | `/library/dirs`, `/library/images`, `/library/images/:id/file`       |
| `Index`     | `/index/rescan`, `/index/status`                                     |
| `Shares`    | admin `/shares*` CRUD + token ops, AND the public `/s/*` share pages |
| `Ingest`    | `POST /images` (agent upload)                                        |
| `Publish`   | `POST /publish`                                                      |
| `Backblaze` | `/b2*`, `/backup/reverse-run`                                        |
| `Stats`     | `/stats`                                                             |

If a new route doesn't fit, **expand the taxonomy here first**, in lockstep with
`src/index.ts`. Free-form tags break the agent contract.

## Path conventions

- **No trailing slashes.** `.get('', handler)`, never `.get('/', handler)`.
- **Path + query params: camelCase.** `{id}`, `minRating`, `sizeLimit`.
- **Collections plural.** `/shares`, `/images`.
- Action subroutes are fine (`/index/rescan`, `/shares/:id/roll`).

## Required fields on every `detail` block

```ts
detail: {
  tags: ['Library'],               // MUST be from the enum above
  summary: 'One-line imperative',   // MUST be present (Scalar sidebar)
  description: '...',                // MUST be present (1–3 sentences)
  security: [{ BearerAuth: [] }],    // on every /api route EXCEPT discovery + health
}
```

Public `/s/*` share routes carry `tags` + `summary` + `description` but NO
`security` (access is governed by token/k, not the bearer). The `access_token`
byte route documents `security: [{ BearerAuth: [] }]` even though it also
accepts the query token.

### Description quality bar

Cover: (1) what it returns — shape + semantics; (2) parameter semantics;
(3) when to use this vs. a sibling (name the sibling). Bad: "Returns images."
Good: "Paginated image list filtered by root/dir and minimum rating, sorted by
capture date; fetch bytes via GET /library/images/{id}/file."

## Safety net

The admin SPA imports `type App = typeof app`, so path/param/query renames
surface as TS errors in the SPA's query files. Run the SPA typecheck after
touching route shapes.

// The Eden `App` type (see lib/eden.ts) is `typeof app` from apps/api/src/index.ts,
// resolved via a TS path alias — so this browser project's tsc program transitively
// type-checks the ENTIRE api source tree (not just its exported types) under THIS
// tsconfig's ambient globals. The api is deliberately Bun-native (bun:sqlite,
// Bun.password, Bun.S3Client, Bun.file, Bun.$ — design §2), so without `bun-types`
// visible here those identifiers are unresolved. Rather than pull the full
// `bun-types` package into the browser program (global surface overlaps with DOM
// lib + @types/node — timers, fetch, Response, …), these are minimal, deliberately
// loose (`any`) shims: enough for tsc to resolve the api's Bun usage without
// affecting this app's own code, which never touches these APIs at runtime.
declare const Bun: any

declare module 'bun:sqlite' {
  export class Database {
    constructor(filename?: string, options?: unknown)
    [key: string]: any
  }
}

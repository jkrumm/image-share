// `bun:test` types, without adding a dependency to this app.
//
// The admin app is a browser bundle and has no `bun-types` of its own; pulling
// the whole package in would drop Bun's global surface (timers, fetch, Response,
// …) on top of DOM lib + @types/node, which is exactly what
// `lib/bun-ambient-shim.d.ts` exists to avoid. `test.d.ts` is the one file in
// that package that declares a MODULE and nothing global, so referencing it
// alone gives the tests real matcher types and leaves this app's globals
// untouched — and unlike a hand-written shim it cannot drift from the runtime.
//
// The path goes through the api workspace's node_modules because `bun-types` is
// its devDependency and that is where `bun install` links it.
/// <reference types="../../api/node_modules/bun-types/test" />

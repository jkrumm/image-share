/// <reference types="vite/client" />

// `__APP_VERSION__` is injected by `basaltViteConfig`'s `define`, and the package
// ships no ambient declaration for it — so every consumer re-declares it here and
// then trips the shipped preset's own `no-underscore-dangle`.
// oxlint-disable-next-line no-underscore-dangle
declare const __APP_VERSION__: string

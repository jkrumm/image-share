import { resolve, sep } from 'node:path'
import { env } from '../env.js'

/** Image root identifiers (design §3): `fuji`/`raws` are read-only source
 * trees, `share` is the service-owned read-write ingest area. */
export type ImageRoot = 'fuji' | 'raws' | 'share'

/**
 * Absolute base directory for an image root (design §3). Single source of
 * truth — every route/module resolves a root's base dir through here instead
 * of duplicating the root→env mapping.
 */
export function rootBaseDir(root: string): string {
  switch (root) {
    case 'fuji':
      return env.FUJI_ROOT
    case 'raws':
      return env.RAWS_ROOT
    case 'share':
      return env.SHARE_ROOT
    default:
      throw new Error(`unknown image root: ${root}`)
  }
}

/**
 * Resolve `rel` against `root` and assert the result stays inside `root`
 * (design §3, hard rule). Guards every filesystem access against path traversal
 * (`../`, absolute paths, symlink-style escapes expressed in the string).
 *
 * Throws on escape — callers surface this as a 400. The returned path is
 * absolute and safe to hand to `Bun.file` / `sharp` / `fs`.
 */
export function safeJoin(root: string, rel: string): string {
  const rootAbs = resolve(root)
  const target = resolve(rootAbs, rel)
  // Allow the root itself, or any descendant (rootAbs + separator prefix). The
  // separator check prevents `/photos/library-evil` from passing as a child of
  // `/photos/library`.
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
    throw new Error(`path escapes root: ${rel}`)
  }
  return target
}

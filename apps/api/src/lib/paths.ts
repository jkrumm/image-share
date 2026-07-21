import { resolve, sep } from 'node:path'

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

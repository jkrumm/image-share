import { basename } from 'node:path'

// `Content-Disposition: attachment` builder, shared by the single-file download
// route (`share/routes.ts`) and the streaming ZIP (`share/zip.ts`).
//
// It lives in its own module because both call sites are user-controlled: the
// file route interpolates an indexed `rel_path`, the ZIP interpolates a
// share `slug`. A raw interpolation lets a `"` or a newline in either value
// terminate the quoted-string / the header itself (response splitting), and a
// non-ASCII byte makes the header unparseable for some clients.

/**
 * Build a `Content-Disposition: attachment` value for `name`.
 *
 * `basename` strips any directory component; the ASCII fallback replaces every
 * non-printable/non-ASCII byte plus `"` and `\` with `_`, and the RFC 5987
 * `filename*` variant carries the real UTF-8 name percent-encoded. Clients that
 * understand `filename*` use it; the rest get the sanitized ASCII fallback.
 */
export function attachment(name: string): string {
  const safe = basename(name)
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`
}

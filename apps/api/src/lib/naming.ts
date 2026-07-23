import { extname } from 'node:path'

// Opaque-prefix object naming (design §8/§12 stage 4 follow-up). The CDN
// serves unsigned URLs — for `gen/`/`misc/` an unguessable object name IS the
// access control, mirroring the dotfiles `imgcli` tool's
// is_opaque_prefix/random-name logic (16-char [a-z0-9], extension preserved).
// `fuji/`/`blog/` stay stem-based: they're meant to be a browsable, readable
// public gallery, so predictability there is the point, not a gap.

export const OPAQUE_PREFIXES = ['gen', 'misc'] as const
export type OpaquePrefix = (typeof OPAQUE_PREFIXES)[number]

export function isOpaquePrefix(prefix: string): prefix is OpaquePrefix {
  return (OPAQUE_PREFIXES as readonly string[]).includes(prefix)
}

/** Random 16-char [a-z0-9] string via the Web Crypto RNG — same
 * alphabet/length as imgcli's random-name generator. */
function randomBasename(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

/** Derives the filename portion of a B2 object key for the given prefix.
 * Opaque prefixes (`gen`/`misc`) get a fresh random 16-char basename with the
 * original extension preserved; readable prefixes (`fuji`/`blog`) keep the
 * original filename unchanged. */
export function deriveObjectFilename(prefix: string, originalFilename: string): string {
  if (!isOpaquePrefix(prefix)) return originalFilename
  return `${randomBasename()}${extname(originalFilename)}`
}

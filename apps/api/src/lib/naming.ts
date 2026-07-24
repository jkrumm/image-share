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

// Optional `subdir` on POST /api/b2/upload (imgcli sync migration): `aws s3
// sync` preserves nested directory structure, and routing that through the
// flat `<prefix>/<filename>` key shape would silently collapse every export
// into one directory and collide filenames. `subdir` nests under the prefix
// instead. It becomes part of an object key, so it is treated as hostile
// input and validated strictly rather than merely sanitized.
const SUBDIR_MAX_LENGTH = 200
const SUBDIR_MAX_SEGMENTS = 8
const SUBDIR_SEGMENT_RE = /^[A-Za-z0-9._-]+$/

/** Validates a `subdir` value bound for a B2 key. Throws a plain Error (routes
 * surface it as a 400) — mirrors assertManagedKey in routes/b2.ts. Rejects a
 * leading/trailing slash, empty segments, `.`/`..` segments, characters
 * outside `[A-Za-z0-9._-]`, over 200 chars total, or more than 8 segments. */
export function assertValidSubdir(subdir: string): void {
  if (subdir.length > SUBDIR_MAX_LENGTH) {
    throw new Error(`subdir must be at most ${SUBDIR_MAX_LENGTH} characters`)
  }
  if (subdir.startsWith('/') || subdir.endsWith('/')) {
    throw new Error('subdir must not start or end with "/"')
  }
  const segments = subdir.split('/')
  if (segments.length > SUBDIR_MAX_SEGMENTS) {
    throw new Error(`subdir must have at most ${SUBDIR_MAX_SEGMENTS} segments`)
  }
  for (const segment of segments) {
    if (segment === '') {
      throw new Error('subdir must not contain empty segments')
    }
    if (segment === '.' || segment === '..') {
      throw new Error('subdir segments must not be "." or ".."')
    }
    if (!SUBDIR_SEGMENT_RE.test(segment)) {
      throw new Error(`subdir segment "${segment}" contains disallowed characters`)
    }
  }
}

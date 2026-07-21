// Metadata extraction (design §5). Heavy native deps (exifr, exiftool-vendored)
// are dynamically imported inside the extract function so module load — and
// therefore process boot — never pays for them. The exiftool singleton is
// `.end()`ed only on SIGTERM.
//
// Smoke-tested exiftool-vendored 37.0.0 under Bun 1.3.14 (read + write, incl.
// a standalone .xmp sidecar) before writing this file — batch-cluster behaves
// normally, no fallback to spawning the vendored exiftool binary directly is
// needed (design's documented fallback path is unused).

import { basename } from 'node:path'

export type ImageKind = 'jpeg' | 'raw' | 'image' | 'other'

export interface ImageMetadata {
  captureAt: string | null // ISO 8601
  orientation: number | null
  rating: number | null
  width: number | null
  height: number | null
}

// Filenames like `2026-07-21_14-30-05_foo.jpg` — a capture-date fallback used
// when EXIF/XMP carries no DateTimeOriginal/CreateDate (design §5). Pure and
// unit-tested.
const FILENAME_DATE_RE = /(\d{4})-(\d{2})-(\d{2})[_ ](\d{2})-(\d{2})-(\d{2})/

/**
 * Parse an ISO 8601 timestamp out of a filename following the
 * `YYYY-MM-DD_HH-MM-SS` convention. Returns null when the pattern is absent or
 * the components are not a valid calendar date/time.
 */
export function parseFilenameDate(name: string): string | null {
  const m = FILENAME_DATE_RE.exec(name)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return null
  // Reject overflow (e.g. month 13) — Date would have rolled it over.
  if (parsed.getUTCMonth() + 1 !== Number(mo) || parsed.getUTCDate() !== Number(d)) return null
  return iso
}

/** JS `Date` → ISO string, or null when absent/invalid. exifr returns parsed
 * `Date` instances for date-ish EXIF/XMP tags. */
function jsDateToIso(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  return null
}

/** exiftool-vendored returns `ExifDateTime | ExifDate | string` for date tags.
 * `ExifDateTime`/`ExifDate` both expose `toISOString()`; fall back to `Date`
 * parsing for the raw-string case. */
function exifToolDateToIso(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  if (typeof value === 'object' && 'toISOString' in value) {
    const fn = (value as { toISOString: (options?: unknown) => string | undefined }).toISOString
    const iso = fn.call(value)
    return iso ?? null
  }
  return null
}

function captureDateFallback(mtimeMs: number, absPath: string): string {
  return parseFilenameDate(basename(absPath)) ?? new Date(mtimeMs).toISOString()
}

/** JPEG/PNG/WebP/AVIF/HEIC via exifr (design §5): embedded EXIF + XMP only —
 * sidecars are never consulted for these kinds ("embedded wins for JPEG"). */
async function extractViaExifr(input: {
  absPath: string
  mtimeMs: number
}): Promise<ImageMetadata> {
  const exifr = (await import('exifr')).default
  const tags = await exifr
    .parse(input.absPath, {
      // ifd0 cannot be disabled in exifr and only accepts a FormatOptions
      // object (not boolean) — omitted here, it still parses alongside tiff.
      tiff: true,
      exif: true,
      xmp: true,
      translateValues: false,
    })
    .catch(() => null)

  const captureAt =
    jsDateToIso(tags?.DateTimeOriginal) ??
    jsDateToIso(tags?.CreateDate) ??
    captureDateFallback(input.mtimeMs, input.absPath)

  const orientation = typeof tags?.Orientation === 'number' ? tags.Orientation : null
  const rating = typeof tags?.Rating === 'number' ? tags.Rating : null
  // ImageWidth/ImageHeight are IFD0 tags (rare on photos); ExifImageWidth/
  // ExifImageHeight (Exif SubIFD PixelXDimension/PixelYDimension) are the
  // reliable source for the actual pixel dimensions.
  const width =
    typeof tags?.ExifImageWidth === 'number'
      ? tags.ExifImageWidth
      : typeof tags?.ImageWidth === 'number'
        ? tags.ImageWidth
        : null
  const height =
    typeof tags?.ExifImageHeight === 'number'
      ? tags.ExifImageHeight
      : typeof tags?.ImageHeight === 'number'
        ? tags.ImageHeight
        : null

  return { captureAt, orientation, rating, width, height }
}

// Module-level reference to the dynamically-imported exiftool-vendored module
// so `endExiftool` can close the SAME singleton instance the extractor used,
// without paying the import cost until a RAF is actually indexed.
let exiftoolModule: typeof import('exiftool-vendored') | null = null

async function loadExiftool(): Promise<import('exiftool-vendored').ExifTool> {
  exiftoolModule ??= await import('exiftool-vendored')
  return exiftoolModule.exiftool
}

/** RAF via the exiftool-vendored singleton (design §5): sidecar `.xmp` rating
 * wins over any embedded rating when a sidecar is paired. */
async function extractViaExiftool(input: {
  absPath: string
  sidecarPath?: string | undefined
  mtimeMs: number
}): Promise<ImageMetadata> {
  const exiftool = await loadExiftool()
  const tags = await exiftool.read(input.absPath).catch(() => null)
  const sidecarTags = input.sidecarPath
    ? await exiftool.read(input.sidecarPath).catch(() => null)
    : null

  const captureAt =
    exifToolDateToIso(tags?.DateTimeOriginal) ??
    exifToolDateToIso(tags?.CreateDate) ??
    captureDateFallback(input.mtimeMs, input.absPath)

  const orientation = typeof tags?.Orientation === 'number' ? tags.Orientation : null
  const embeddedRating = typeof tags?.Rating === 'number' ? tags.Rating : null
  const sidecarRating = typeof sidecarTags?.Rating === 'number' ? sidecarTags.Rating : null
  const rating = sidecarTags ? sidecarRating : embeddedRating

  const width = typeof tags?.ImageWidth === 'number' ? tags.ImageWidth : null
  const height = typeof tags?.ImageHeight === 'number' ? tags.ImageHeight : null

  return { captureAt, orientation, rating, width, height }
}

/**
 * Extract capture date, orientation, rating, and dimensions from an image or
 * RAF+sidecar (design §5). `kind === 'raw'` routes through exiftool-vendored;
 * every other recognized kind ('jpeg' | 'image') routes through exifr.
 */
export function extractMetadata(input: {
  absPath: string
  kind: ImageKind
  /** Absolute path to a paired `.xmp` sidecar, if one exists. */
  sidecarPath?: string | undefined
  /** File mtime (ms) — the final capture-date fallback. */
  mtimeMs: number
}): Promise<ImageMetadata> {
  if (input.kind === 'raw') {
    return extractViaExiftool(input)
  }
  return extractViaExifr(input)
}

/** Shut the exiftool singleton down cleanly. Called on SIGTERM (design §5). */
export async function endExiftool(): Promise<void> {
  // No singleton is spawned until a RAF is indexed; no-op until then.
  if (exiftoolModule) {
    await exiftoolModule.exiftool.end()
  }
}

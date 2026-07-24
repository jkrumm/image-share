import { extname } from 'node:path'
import { EXT_KIND } from '../indexer/scan.js'
import { CONTENT_TYPE_BY_EXT } from '../routes/library.js'

// Shared upload extension/MIME/size guard (design §8). Both POST /api/images
// (ingest, service-owned disk) and POST /api/b2/upload (direct-to-B2) accept
// arbitrary multipart file uploads and must reject anything the indexer
// wouldn't recognize, or anything oversized, before it ever touches disk or
// B2 — single source of truth so the two routes can't drift.

// Same extension set the indexer recognizes (EXT_KIND, indexer/scan.ts) — for
// the ingest route, anything else would be written to SHARE_ROOT and then
// rejected by indexSinglePath, orphaning the file on disk. Rejecting up front
// avoids that.
export const ALLOWED_EXTENSIONS = new Set(Object.keys(EXT_KIND))
// Same ext→mime mapping library.ts uses to serve bytes back out.
export const ALLOWED_MIME_TYPES = new Set(Object.values(CONTENT_TYPE_BY_EXT))
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 // 50 MB

/**
 * Validates an uploaded file's extension/MIME/size. Throws a plain Error with
 * an actionable message on failure — callers surface it as a 400 (mirrors
 * assertManagedKey in routes/b2.ts).
 */
export function assertUploadableFile(file: File): void {
  const ext = extname(file.name).slice(1).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported file extension "${ext || '(none)'}" — allowed: ${[...ALLOWED_EXTENSIONS].toSorted().join(', ')}`,
    )
  }
  // Bun's multipart parser re-derives File#type from the filename extension
  // rather than trusting the wire Content-Type of the part (verified against
  // this exact runtime: a raw multipart body declaring "Content-Type:
  // application/pdf" on a `sneaky.jpg` part still yields `type: "image/jpeg"`
  // — the client's declared MIME never actually reaches the handler for a
  // recognized extension). This check is therefore a defense-in-depth no-op
  // today, guarding only against a future parser change; the extension check
  // above is the real gate. `.raf` has no known mime and yields `''`, which
  // skips this check entirely.
  if (file.type && !ALLOWED_MIME_TYPES.has(file.type)) {
    throw new Error(`Unsupported MIME type "${file.type}" for extension ".${ext}"`)
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`File too large (${file.size} bytes) — max ${MAX_UPLOAD_BYTES} bytes (50 MB)`)
  }
}

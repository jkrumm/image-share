import { getToken } from './auth'

// The only place in this SPA that talks HTTP without Eden, and it exists for one
// reason: `fetch` still cannot report UPLOAD progress. A streamed request body
// needs `duplex: 'half'` + HTTP/2 and is unimplemented in Safari, so the browser
// gives no bytes-sent event at all — while XHR has exposed `upload.onprogress`
// forever. A 40 MB HEIC over the HomeLab uplink is a visible wait; showing a
// spinner instead of a percentage there is a worse trade than this 60-line
// escape hatch (and adding an upload library for one number is not an option —
// no new dependencies).
//
// Everything else is kept identical to the Eden path: same bearer header, and a
// rejection that `toErrorMessage` / `errorStatus` decode exactly like an Eden
// envelope, so call sites need no special-casing.

// Mirrors lib/eden.ts: image-share's routes carry their own literal `/api/...`
// prefix, so the base is the bare origin (the Vite dev proxy forwards unchanged).
const baseUrl = import.meta.env.VITE_API_URL ?? window.location.origin

export type UploadProgress = {
  loaded: number
  total: number
  /** 0–100, or `null` while the browser reports an indeterminate body length. */
  percent: number | null
}

export type UploadWithProgressInput = {
  /** Path on the API host, e.g. `/api/images`. */
  path: string
  body: FormData
  onProgress?: (progress: UploadProgress) => void
}

/** Carries the server's own words plus the status, so `toErrorMessage(err)` and
 * `errorStatus(err)` behave the same as they do for a thrown Eden envelope. */
export class UploadError extends Error {
  readonly status: number
  readonly value: unknown

  constructor(status: number, value: unknown) {
    super(uploadErrorMessage(status, value))
    this.name = 'UploadError'
    this.status = status
    this.value = value
  }
}

function uploadErrorMessage(status: number, value: unknown): string {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (value && typeof value === 'object') {
    const message = (value as { message?: unknown }).message
    if (typeof message === 'string' && message.trim() !== '') return message
  }
  return status === 0
    ? 'Upload failed — the request never reached the server'
    : `Upload failed (HTTP ${status})`
}

function parseResponse(text: string): unknown {
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** POSTs multipart form data with per-byte progress. Resolves the parsed JSON
 * body, rejects with an {@link UploadError} on any non-2xx or transport failure. */
export function uploadWithProgress<T>({
  path,
  body,
  onProgress,
}: UploadWithProgressInput): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${baseUrl}${path}`)

    const token = getToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)

    if (onProgress) {
      xhr.upload.addEventListener('progress', (event: ProgressEvent) => {
        const total = event.lengthComputable ? event.total : 0
        onProgress({
          loaded: event.loaded,
          total,
          percent: total > 0 ? Math.min(100, Math.round((event.loaded / total) * 100)) : null,
        })
      })
      // The last progress event fires before the server has answered; pin the bar
      // at 100 % while the request is in flight rather than leaving it at 97 %.
      xhr.upload.addEventListener('load', () => onProgress({ loaded: 1, total: 1, percent: 100 }))
    }

    xhr.addEventListener('load', () => {
      const value = parseResponse(xhr.responseText)
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(value as T)
        return
      }
      reject(new UploadError(xhr.status, value))
    })
    xhr.addEventListener('error', () =>
      reject(new UploadError(0, 'Network error — the upload did not reach the server')),
    )
    xhr.addEventListener('timeout', () => reject(new UploadError(0, 'The upload timed out')))
    xhr.addEventListener('abort', () => reject(new UploadError(0, 'The upload was cancelled')))

    xhr.send(body)
  })
}

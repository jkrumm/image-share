import { env } from '../env.js'

// B2 (S3-compatible) access via the built-in Bun.S3Client — no aws-sdk (design
// §2). A tiny port interface is exposed so tests inject a fake (design §13);
// the production adapter wraps Bun.S3Client.

export interface S3Object {
  key: string
  size: number
  lastModified: string // ISO 8601
  etag?: string
}

export interface S3Port {
  /** List objects under a key prefix (full keys, incl. any bucket prefix). */
  list(prefix: string): Promise<S3Object[]>
  /** Return true if a key already exists (publish uses this to skip-and-report). */
  exists(key: string): Promise<boolean>
  /** Write bytes to a key. */
  put(key: string, data: ArrayBuffer | Uint8Array | Blob | string): Promise<void>
  /** Read the full object bytes for a key (reverse-backup mirror). */
  get(key: string): Promise<Uint8Array>
  /** Head metadata for a single key, or null if it does not exist. */
  head(key: string): Promise<S3Object | null>
}

/**
 * Production adapter over Bun.S3Client, configured from the B2_* env. Kept as a
 * factory so a bad/empty config only fails when B2 is actually used, not at
 * boot (the singleton below is constructed lazily on first use).
 */
export function createBunS3(): S3Port {
  const bucket = new Bun.S3Client({
    endpoint: env.B2_ENDPOINT,
    region: env.B2_REGION,
    bucket: env.B2_BUCKET,
    accessKeyId: env.B2_KEY_ID,
    secretAccessKey: env.B2_APP_KEY,
  })

  return {
    async list(prefix) {
      const results: S3Object[] = []
      let continuationToken: string | undefined
      do {
        const page = await bucket.list({
          prefix,
          maxKeys: 1000,
          ...(continuationToken ? { continuationToken } : {}),
        })
        for (const obj of page.contents ?? []) {
          results.push({
            key: obj.key,
            size: obj.size ?? 0,
            lastModified: obj.lastModified ?? new Date().toISOString(),
            ...(obj.eTag ? { etag: obj.eTag } : {}),
          })
        }
        continuationToken = page.isTruncated ? page.continuationToken : undefined
      } while (continuationToken)
      return results
    },

    exists(key) {
      return bucket.exists(key)
    },

    async put(key, data) {
      await bucket.write(key, data)
    },

    async get(key) {
      return bucket.file(key).bytes()
    },

    async head(key) {
      try {
        const stat = await bucket.stat(key)
        return {
          key,
          size: stat.size,
          lastModified: stat.lastModified.toISOString(),
          etag: stat.etag,
        }
      } catch {
        return null
      }
    },
  }
}

let singleton: S3Port | null = null

/** Lazily-constructed process-wide S3 port. Tests override via `setS3`. */
export function getS3(): S3Port {
  if (!singleton) singleton = createBunS3()
  return singleton
}

/** Inject a fake S3 port (tests) or reset with `null`. */
export function setS3(port: S3Port | null): void {
  singleton = port
}

import type { ShareDto } from '../../lib/queries/shares'

/**
 * The real `SHARE_BASE_URL` the API mints links with, recovered from an existing
 * token URL (`${base}/${slug}?token=…`).
 *
 * It is server-side env with no route exposing it, and the create modal used to
 * hardcode `share.jkrumm.com/<slug>` in its slug preview — a lie in dev
 * (`http://localhost:7720/s`) and anywhere the env differs. Neither a slug nor a
 * base64url token can contain `/`, so the last slash is the one before the slug.
 *
 * Returns null when no share has been created yet, or when the only URLs on
 * hand carry no path at all; callers show a slug-only preview then rather than
 * guess a host.
 */
export function deriveShareBaseUrl(shares: readonly ShareDto[]): string | null {
  for (const share of shares) {
    for (const token of share.tokens) {
      const cut = token.url.lastIndexOf('/')
      if (cut > 0) return token.url.slice(0, cut)
    }
  }
  return null
}

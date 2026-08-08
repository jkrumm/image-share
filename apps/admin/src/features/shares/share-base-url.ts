import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { sharesQueries } from '../../lib/queries/shares'
import { deriveShareBaseUrl } from './share-links'

/**
 * The real `SHARE_BASE_URL` the API mints links with, recovered from an
 * existing token URL (`${base}/${slug}?token=…` — neither a slug nor a
 * base64url token can contain `/`, so the last slash is the one before the
 * slug).
 *
 * It is server-side env with no route exposing it, and the create modal used
 * to hardcode `share.jkrumm.com/<slug>` in its slug preview — a lie in dev
 * (`http://localhost:7720/s`) and anywhere the env differs. Returns null when
 * no share has been created yet; callers show a slug-only preview then rather
 * than guess a host.
 *
 * `enabled` is what keeps the always-mounted create modal on the Library page
 * from pulling the whole shares list (one image COUNT per share) on every
 * library visit — pass the modal's `opened`.
 */
export function useShareBaseUrl(enabled: boolean): string | null {
  const { data } = useQuery({ ...sharesQueries.list(), enabled })
  return useMemo(() => deriveShareBaseUrl(data?.data ?? []), [data])
}

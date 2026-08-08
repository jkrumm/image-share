import type { TokenDto, TokenRole } from '../../lib/queries/shares'

// Shared role presentation — used by the shares list (badge color), the share
// detail page (badge color + legible role semantics, design §12) and both
// token-minting surfaces (create modal + add-link modal).
export const ROLE_COLOR: Record<TokenRole, string> = {
  view: 'gray',
  download: 'blue',
  full: 'grape',
}

export const ROLE_LABEL: Record<TokenRole, string> = {
  view: 'View',
  download: 'Download',
  full: 'Full',
}

export const ROLE_DESCRIPTION: Record<TokenRole, string> = {
  view: 'Preview and lightbox, no downloads',
  download: 'Originals as JPEG, also as a zip',
  full: 'Everything download can, plus the paired RAW files',
}

/** One source of truth for every role `Select` — the create modal mints the
 * first (and optionally a second) link with these, the add-link modal reuses
 * them verbatim so the wording can never drift between the two surfaces. */
export const ROLE_OPTIONS: { value: TokenRole; label: string }[] = [
  { value: 'view', label: 'View — thumbnails and lightbox, no downloads' },
  { value: 'download', label: 'Download — + full size, original download, zip' },
  { value: 'full', label: 'Full — + paired RAW download' },
]

export function activeTokens(tokens: TokenDto[]): TokenDto[] {
  return tokens.filter((t) => t.revokedAt === null)
}

/**
 * Display order for a share's links: active before revoked, newest first
 * within each group. The API returns them in `id` order, which puts the link
 * you just minted at the BOTTOM of a four-link share behind two revoked ones —
 * the one case where you're guaranteed to be looking for a specific row.
 */
export function sortTokens(tokens: TokenDto[]): TokenDto[] {
  return tokens.toSorted((a, b) => {
    const revokedDelta = Number(a.revokedAt !== null) - Number(b.revokedAt !== null)
    if (revokedDelta !== 0) return revokedDelta
    const created = Date.parse(b.createdAt) - Date.parse(a.createdAt)
    // Unparseable timestamps fall through to id, which is monotonic anyway.
    if (created !== 0 && !Number.isNaN(created)) return created
    return b.id - a.id
  })
}

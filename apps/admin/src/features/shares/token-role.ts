import type { TokenDto, TokenRole } from '../../lib/queries/shares'

// Shared role presentation — used by both the shares list (badge color) and
// the share detail page (badge color + legible role semantics, design §12).
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

export function activeTokens(tokens: TokenDto[]): TokenDto[] {
  return tokens.filter((t) => t.revokedAt === null)
}

import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  CopyButton,
  Group,
  Paper,
  Text,
  Tooltip,
} from '@mantine/core'
import { useEffect, useRef, type ReactNode } from 'react'
import { VX, alpha } from 'basalt-ui/tokens'
import { formatDateTime, formatRelative } from '../../lib/format'
import type { TokenDto } from '../../lib/queries/shares'
import { ROLE_COLOR, ROLE_DESCRIPTION, ROLE_LABEL } from './token-role'

type Props = {
  token: TokenDto
  /** Ring + scroll-into-view for the link that was just minted. */
  highlighted?: boolean
  /** Omitted on the create-modal success screen, where there is nothing to revoke yet. */
  onRevoke?: () => void
}

/**
 * One share link. The URL is an `Anchor`, not a `Text` — opening it in a new
 * tab to see exactly what the friend sees is the whole trust-building move on
 * this page, and it used to be un-clickable monospace.
 *
 * Mobile: the URL truncates inside a `miw={0}` flex child instead of wrapping,
 * so the Copy/Revoke buttons keep a fixed position instead of being shoved
 * around by a 90-character link.
 */
export function TokenRow({ token, highlighted = false, onRevoke }: Props): ReactNode {
  const revoked = token.revokedAt !== null
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [highlighted])

  return (
    <Paper
      ref={ref}
      withBorder
      p="xs"
      style={{
        opacity: revoked ? 0.55 : 1,
        ...(highlighted && {
          boxShadow: `0 0 0 2px ${VX.accent}`,
          backgroundColor: alpha(VX.accent, 0.06),
        }),
      }}
    >
      <Group justify="space-between" wrap="nowrap" gap="xs" align="flex-start">
        <Group gap={6} wrap="wrap" style={{ flex: 1, minWidth: 0 }}>
          <Tooltip label={ROLE_DESCRIPTION[token.role]}>
            <Badge color={ROLE_COLOR[token.role]} variant="light">
              {ROLE_LABEL[token.role]}
            </Badge>
          </Tooltip>
          {token.label !== null && token.label !== '' && (
            <Text size="sm" fw={500}>
              {token.label}
            </Text>
          )}
          {revoked && (
            <Badge color="red" variant="outline" size="sm">
              Revoked
            </Badge>
          )}
          <Anchor
            href={token.url}
            target="_blank"
            rel="noreferrer"
            size="sm"
            ff="monospace"
            truncate="end"
            w="100%"
            title={token.url}
          >
            {token.url}
          </Anchor>
          <Tooltip label={formatDateTime(token.createdAt)}>
            <Text size="xs" c="dimmed">
              created {formatRelative(token.createdAt)}
              {revoked && ` · revoked ${formatRelative(token.revokedAt)}`}
            </Text>
          </Tooltip>
        </Group>
        <Group gap={4} wrap="nowrap">
          <CopyButton value={token.url}>
            {({ copied, copy }) => (
              <Button size="xs" variant={copied ? 'light' : 'default'} onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
          </CopyButton>
          <Tooltip label="Open the share exactly as the recipient sees it">
            <ActionIcon
              component="a"
              href={token.url}
              target="_blank"
              rel="noreferrer"
              variant="default"
              size="lg"
              aria-label="Preview this link in a new tab"
            >
              ↗
            </ActionIcon>
          </Tooltip>
          {!revoked && onRevoke && (
            <Button size="xs" variant="subtle" color="red" onClick={onRevoke}>
              Revoke
            </Button>
          )}
        </Group>
      </Group>
    </Paper>
  )
}

import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import {
  Badge,
  Button,
  CopyButton,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core'
import { modals } from '@mantine/modals'
import { useQuery } from '@tanstack/react-query'
import { EmptyState, PageActions } from 'basalt-ui'
import { notifyPromise } from 'basalt-ui/notifications'
import { AddTokenModal } from '../features/shares/add-token-modal'
import { ShareFormModal } from '../features/shares/share-form-modal'
import {
  sharesQueries,
  useDeleteShare,
  useRevokeShareToken,
  useRollShareToken,
  type ShareDto,
  type TokenRole,
} from '../lib/queries/shares'

export const Route = createFileRoute('/shares')({
  component: SharesPage,
})

const ROLE_COLOR: Record<TokenRole, string> = { view: 'gray', download: 'blue', full: 'grape' }

function activeTokens(share: ShareDto) {
  return share.tokens.filter((t) => t.revokedAt === null)
}

function sourceLabel(share: ShareDto): string {
  if (share.sourceType === 'selection') {
    return `${share.imageCount} selected image${share.imageCount === 1 ? '' : 's'}`
  }
  return `${share.root}/${share.dir || '(root)'}`
}

function SharesPage() {
  const { data, isLoading } = useQuery(sharesQueries.list())
  const [formOpened, setFormOpened] = useState(false)
  const [editing, setEditing] = useState<ShareDto | undefined>(undefined)
  const [tokenModalShareId, setTokenModalShareId] = useState<number | null>(null)
  const rollToken = useRollShareToken()
  const revokeToken = useRevokeShareToken()
  const deleteShare = useDeleteShare()

  const shares = data?.data ?? []

  function openCreate() {
    setEditing(undefined)
    setFormOpened(true)
  }

  function openEdit(share: ShareDto) {
    setEditing(share)
    setFormOpened(true)
  }

  function handleRoll(share: ShareDto) {
    modals.openConfirmModal({
      title: 'Roll all active tokens',
      children: (
        <Text size="sm">
          Revokes every active token for &quot;{share.title}&quot; and mints a same-role replacement
          for each. Existing links stop working immediately.
        </Text>
      ),
      labels: { confirm: 'Roll tokens', cancel: 'Cancel' },
      confirmProps: { color: 'orange' },
      onConfirm: () => {
        void notifyPromise(rollToken.mutateAsync(share.id), {
          loading: 'Rolling tokens…',
          success: 'Tokens rolled',
          error: 'Could not roll tokens',
        })
      },
    })
  }

  function handleRevoke(share: ShareDto, tokenId: number) {
    void notifyPromise(revokeToken.mutateAsync({ id: share.id, tokenId }), {
      loading: 'Revoking token…',
      success: 'Token revoked',
      error: 'Could not revoke token',
    })
  }

  function handleDelete(share: ShareDto) {
    modals.openConfirmModal({
      title: 'Delete share',
      children: (
        <Text size="sm">
          Delete &quot;{share.title}&quot;? All its tokens stop working immediately. This cannot be
          undone.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        void notifyPromise(deleteShare.mutateAsync(share.id), {
          loading: 'Deleting share…',
          success: 'Share deleted',
          error: 'Could not delete share',
        })
      },
    })
  }

  return (
    <Stack gap="md">
      <PageActions>
        <Button onClick={openCreate}>New share</Button>
      </PageActions>

      {isLoading && <Loader size="sm" />}

      {!isLoading && shares.length === 0 && (
        <EmptyState
          title="No shares yet"
          description="Create a share to hand a friend a folder link with rollable, role-scoped tokens."
          action={<Button onClick={openCreate}>New share</Button>}
        />
      )}

      {shares.length > 0 && (
        <Table.ScrollContainer minWidth={900}>
          <Table striped highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Title</Table.Th>
                <Table.Th>Source</Table.Th>
                <Table.Th>Expires</Table.Th>
                <Table.Th>Tokens</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {shares.map((share) => (
                <Table.Tr key={share.id}>
                  <Table.Td>
                    <Text fw={600}>{share.title}</Text>
                    <Text size="xs" c="dimmed">
                      {share.slug}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {sourceLabel(share)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {share.expiresAt ?? '—'}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4} wrap="wrap">
                      {activeTokens(share).length === 0 && (
                        <Text size="xs" c="dimmed">
                          none active
                        </Text>
                      )}
                      {activeTokens(share).map((token) => (
                        <CopyButton key={token.id} value={token.url}>
                          {({ copied, copy }) => (
                            <Tooltip label={copied ? 'Copied' : `Copy ${token.role} link`}>
                              <Badge
                                color={ROLE_COLOR[token.role]}
                                variant="light"
                                style={{ cursor: 'pointer' }}
                                onClick={copy}
                                rightSection={
                                  <Text
                                    span
                                    size="xs"
                                    style={{ cursor: 'pointer' }}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleRevoke(share, token.id)
                                    }}
                                  >
                                    ×
                                  </Text>
                                }
                              >
                                {token.label ? `${token.role} (${token.label})` : token.role}
                              </Badge>
                            </Tooltip>
                          )}
                        </CopyButton>
                      ))}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4} justify="flex-end" wrap="nowrap">
                      <Tooltip label="Edit">
                        <Button size="xs" variant="subtle" onClick={() => openEdit(share)}>
                          Edit
                        </Button>
                      </Tooltip>
                      <Tooltip label="Add a role-scoped token">
                        <Button
                          size="xs"
                          variant="subtle"
                          onClick={() => setTokenModalShareId(share.id)}
                        >
                          Add token
                        </Button>
                      </Tooltip>
                      <Tooltip label="Revoke every active token and mint same-role replacements">
                        <Button
                          size="xs"
                          variant="subtle"
                          color="orange"
                          onClick={() => handleRoll(share)}
                        >
                          Roll
                        </Button>
                      </Tooltip>
                      <Tooltip label="Delete">
                        <Button
                          size="xs"
                          variant="subtle"
                          color="red"
                          onClick={() => handleDelete(share)}
                        >
                          Delete
                        </Button>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      <ShareFormModal opened={formOpened} onClose={() => setFormOpened(false)} share={editing} />
      {tokenModalShareId !== null && (
        <AddTokenModal
          shareId={tokenModalShareId}
          opened={tokenModalShareId !== null}
          onClose={() => setTokenModalShareId(null)}
        />
      )}
    </Stack>
  )
}

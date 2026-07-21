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
import { ShareFormModal } from '../features/shares/share-form-modal'
import {
  sharesQueries,
  useAddShareToken,
  useDeleteShare,
  useRollShareToken,
  type ShareDto,
} from '../lib/queries/shares'

export const Route = createFileRoute('/shares')({
  component: SharesPage,
})

function activeToken(share: ShareDto) {
  return share.tokens.find((t) => t.revokedAt === null) ?? share.tokens[0]
}

function SharesPage() {
  const { data, isLoading } = useQuery(sharesQueries.list())
  const [formOpened, setFormOpened] = useState(false)
  const [editing, setEditing] = useState<ShareDto | undefined>(undefined)
  const rollToken = useRollShareToken()
  const addToken = useAddShareToken()
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
      title: 'Roll share token',
      children: (
        <Text size="sm">
          Revokes all active tokens for &quot;{share.slug}&quot; and mints a new one. Existing links
          stop working immediately.
        </Text>
      ),
      labels: { confirm: 'Roll token', cancel: 'Cancel' },
      confirmProps: { color: 'orange' },
      onConfirm: () => {
        void notifyPromise(rollToken.mutateAsync(share.id), {
          loading: 'Rolling token…',
          success: 'Token rolled',
          error: 'Could not roll token',
        })
      },
    })
  }

  function handleAddToken(share: ShareDto) {
    void notifyPromise(addToken.mutateAsync(share.id), {
      loading: 'Minting token…',
      success: 'Token added',
      error: 'Could not add token',
    })
  }

  function handleDelete(share: ShareDto) {
    modals.openConfirmModal({
      title: 'Delete share',
      children: (
        <Text size="sm">
          Delete &quot;{share.slug}&quot;? All its tokens stop working immediately. This cannot be
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
          description="Create a share to hand a friend a folder link with a rollable token."
          action={<Button onClick={openCreate}>New share</Button>}
        />
      )}

      {shares.length > 0 && (
        <Table.ScrollContainer minWidth={800}>
          <Table striped highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Slug</Table.Th>
                <Table.Th>Folder</Table.Th>
                <Table.Th>Size / RAWs</Table.Th>
                <Table.Th>Expires</Table.Th>
                <Table.Th>Tokens</Table.Th>
                <Table.Th>Link</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {shares.map((share) => {
                const token = activeToken(share)
                const activeCount = share.tokens.filter((t) => t.revokedAt === null).length
                return (
                  <Table.Tr key={share.id}>
                    <Table.Td>
                      <Group gap={6}>
                        <Text fw={600}>{share.slug}</Text>
                        {share.hasPassword && (
                          <Badge size="xs" variant="light">
                            password
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {share.root}/{share.dir || '(root)'}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">
                        {share.sizeLimit}
                        {share.includeRaws ? ' + RAWs' : ''}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {share.expiresAt ?? '—'}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="light">{activeCount} active</Badge>
                    </Table.Td>
                    <Table.Td>
                      {token && (
                        <CopyButton value={token.url}>
                          {({ copied, copy }) => (
                            <Button size="xs" variant="default" onClick={copy}>
                              {copied ? 'Copied' : 'Copy URL'}
                            </Button>
                          )}
                        </CopyButton>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        <Tooltip label="Edit">
                          <Button size="xs" variant="subtle" onClick={() => openEdit(share)}>
                            Edit
                          </Button>
                        </Tooltip>
                        <Tooltip label="Add a parallel token for another recipient">
                          <Button
                            size="xs"
                            variant="subtle"
                            loading={addToken.isPending && addToken.variables === share.id}
                            onClick={() => handleAddToken(share)}
                          >
                            Add token
                          </Button>
                        </Tooltip>
                        <Tooltip label="Revoke active tokens and mint a new one">
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
                )
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      <ShareFormModal opened={formOpened} onClose={() => setFormOpened(false)} share={editing} />
    </Stack>
  )
}

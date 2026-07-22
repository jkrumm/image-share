import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { Badge, Button, Loader, Stack, Table, Text } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { EmptyState, PageActions } from 'basalt-ui'
import { CreateShareModal } from '../features/shares/create-share-modal'
import { activeTokens } from '../features/shares/token-role'
import { sharesQueries, type ShareDto } from '../lib/queries/shares'

export const Route = createFileRoute('/shares')({
  component: SharesPage,
})

function sourceLabel(share: ShareDto): string {
  if (share.sourceType === 'selection') return 'Selection'
  return `Folder · ${share.dir ? `${share.root}/${share.dir}` : share.root}`
}

function SharesPage() {
  const { data, isLoading } = useQuery(sharesQueries.list())
  const [createOpened, setCreateOpened] = useState(false)
  const navigate = useNavigate()

  const shares = data?.data ?? []

  return (
    <Stack gap="md">
      <PageActions>
        <Button onClick={() => setCreateOpened(true)}>New share</Button>
      </PageActions>

      {isLoading && <Loader size="sm" />}

      {!isLoading && shares.length === 0 && (
        <EmptyState
          title="No shares yet"
          description="Create a share to hand a friend a folder or selection link with rollable, role-scoped tokens."
          action={<Button onClick={() => setCreateOpened(true)}>New share</Button>}
        />
      )}

      {shares.length > 0 && (
        <Table.ScrollContainer minWidth={800}>
          <Table striped highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Title</Table.Th>
                <Table.Th>Slug</Table.Th>
                <Table.Th>Source</Table.Th>
                <Table.Th>Images</Table.Th>
                <Table.Th>Links</Table.Th>
                <Table.Th>Created</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {shares.map((share) => (
                <Table.Tr
                  key={share.id}
                  onClick={() =>
                    void navigate({ to: '/shares/$id', params: { id: String(share.id) } })
                  }
                  style={{ cursor: 'pointer' }}
                >
                  <Table.Td>
                    <Text fw={600}>{share.title}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" ff="monospace" c="dimmed">
                      {share.slug}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {sourceLabel(share)}
                    </Text>
                  </Table.Td>
                  <Table.Td>{share.imageCount}</Table.Td>
                  <Table.Td>
                    <Badge size="sm" variant="light">
                      {activeTokens(share.tokens).length}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      {share.createdAt}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      <CreateShareModal opened={createOpened} onClose={() => setCreateOpened(false)} />
    </Stack>
  )
}

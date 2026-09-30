import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState, type MouseEvent, type ReactNode } from 'react'
import { Anchor, Badge, Button, Group, Stack, Table, Text, Tooltip } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { PageBar, QueryState } from 'basalt-ui'
import { CreateShareModal } from '../features/shares/create-share-modal'
import { ROLE_COLOR, ROLE_LABEL, activeTokens, sortTokens } from '../features/shares/token-role'
import { formatDate, formatNumber } from '../lib/format'
import { sharesQueries, type ShareDto } from '../lib/queries/shares'
import classes from '../features/shares/shares-table.module.css'

export const Route = createFileRoute('/shares')({
  component: SharesPage,
})

function sourceLabel(share: ShareDto): string {
  if (share.sourceType === 'selection') return 'Selection'
  // The root is part of an album share's scope, exactly as it is for a folder
  // share — an album resolves against one root, never across all of them.
  if (share.sourceType === 'album') return `Album · ${share.root}/${share.album}`
  return `Folder · ${share.dir ? `${share.root}/${share.dir}` : share.root}`
}

function SharesPage(): ReactNode {
  const query = useQuery(sharesQueries.list())
  const [createOpened, setCreateOpened] = useState(false)

  return (
    <Stack gap="md">
      <PageBar
        actions={{
          primary: { key: 'new-share', label: 'New share', onClick: () => setCreateOpened(true) },
        }}
      />

      <QueryState
        query={query}
        errorTitle="Could not load shares"
        empty={{
          title: 'No shares yet',
          description:
            'Create a share to hand a friend an album, a folder or a selection — with rollable, role-scoped links.',
          action: <Button onClick={() => setCreateOpened(true)}>New share</Button>,
        }}
      >
        {(data) => <SharesTable shares={data.data} />}
      </QueryState>

      <CreateShareModal opened={createOpened} onClose={() => setCreateOpened(false)} />
    </Stack>
  )
}

function SharesTable({ shares }: { shares: ShareDto[] }): ReactNode {
  const navigate = useNavigate()

  // The low-value columns fold on the table's OWN width (shares-table.module.css)
  // instead of forcing every phone into a horizontal scroll on the whole table.
  return (
    <div className={classes.wrap}>
      <Table striped highlightOnHover verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Title</Table.Th>
            <Table.Th className={classes.regular}>Slug</Table.Th>
            <Table.Th className={classes.regular}>Source</Table.Th>
            <Table.Th>Images</Table.Th>
            <Table.Th>Links</Table.Th>
            <Table.Th className={classes.wide}>Created</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {shares.map((share) => {
            const params = { id: String(share.id) }
            const active = sortTokens(activeTokens(share.tokens))
            return (
              <Table.Tr
                key={share.id}
                // Row click is the convenience path; the title is a real
                // <a href>, so the row is keyboard-focusable, middle-clickable
                // and openable in a new tab like any other link.
                onClick={() => void navigate({ to: '/shares/$id', params })}
                style={{ cursor: 'pointer' }}
              >
                <Table.Td>
                  {/* renderRoot, not `component={Link}`: TanStack's `params`
                      only typechecks on `Link` itself, and dropping it would
                      cost the typed route the whole point of this link. */}
                  <Anchor
                    fw={600}
                    onClick={(e: MouseEvent) => e.stopPropagation()}
                    renderRoot={(props) => <Link to="/shares/$id" params={params} {...props} />}
                  >
                    {share.title}
                  </Anchor>
                  <Text size="xs" c="dimmed" className={classes.compactOnly}>
                    {share.slug} · {sourceLabel(share)}
                  </Text>
                </Table.Td>
                <Table.Td className={classes.regular}>
                  <Text size="sm" ff="monospace" c="dimmed">
                    {share.slug}
                  </Text>
                </Table.Td>
                <Table.Td className={classes.regular}>
                  <Text size="sm" c="dimmed">
                    {sourceLabel(share)}
                  </Text>
                </Table.Td>
                <Table.Td>{formatNumber(share.imageCount)}</Table.Td>
                <Table.Td>
                  {active.length === 0 ? (
                    <Text size="xs" c="dimmed">
                      none
                    </Text>
                  ) : (
                    <Group gap={4} wrap="nowrap">
                      {active.slice(0, 3).map((token) => (
                        <Tooltip key={token.id} label={token.label ?? ROLE_LABEL[token.role]}>
                          <Badge size="sm" variant="light" color={ROLE_COLOR[token.role]}>
                            {ROLE_LABEL[token.role]}
                          </Badge>
                        </Tooltip>
                      ))}
                      {active.length > 3 && (
                        <Text size="xs" c="dimmed">
                          +{active.length - 3}
                        </Text>
                      )}
                    </Group>
                  )}
                </Table.Td>
                <Table.Td className={classes.wide}>
                  <Text size="xs" c="dimmed">
                    {formatDate(share.createdAt)}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )
          })}
        </Table.Tbody>
      </Table>
    </div>
  )
}

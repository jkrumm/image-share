import { createFileRoute } from '@tanstack/react-router'
import { Badge, Button, Group, SimpleGrid, Stack, Table, Text } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { StatCard } from 'basalt-ui'
import { notifyPromise } from 'basalt-ui/notifications'
import {
  activityQueries,
  useTriggerB2Reconcile,
  useTriggerRescan,
  useTriggerReverseBackup,
} from '../lib/queries/activity'

export const Route = createFileRoute('/activity')({
  component: ActivityPage,
})

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

function ActivityPage() {
  const { data: stats } = useQuery(activityQueries.stats())
  const { data: indexStatus } = useQuery(activityQueries.indexStatus())
  const { data: b2 } = useQuery(activityQueries.b2({ page: 1, limit: 50 }))

  const rescan = useTriggerRescan()
  const reconcile = useTriggerB2Reconcile()
  const reverseBackup = useTriggerReverseBackup()

  function handleRescan() {
    void notifyPromise(rescan.mutateAsync(), {
      loading: 'Starting rescan…',
      success: 'Rescan started',
      error: 'Could not start rescan',
    })
  }

  function handleReconcile() {
    void notifyPromise(reconcile.mutateAsync(), {
      loading: 'Starting B2 reconcile…',
      success: 'Reconcile started',
      error: 'Could not start reconcile',
    })
  }

  function handleReverseBackup() {
    void notifyPromise(reverseBackup.mutateAsync(), {
      loading: 'Starting reverse backup…',
      success: 'Reverse backup started',
      error: 'Could not start reverse backup',
    })
  }

  return (
    <Stack gap="lg">
      {stats && (
        <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} spacing="sm">
          <StatCard label="Images" value={String(stats.images)} />
          <StatCard label="JPEGs" value={String(stats.jpegs)} />
          <StatCard label="RAWs" value={String(stats.raws)} />
          <StatCard label="Uploads" value={String(stats.uploads)} />
          <StatCard label="Shares" value={String(stats.shares)} />
          <StatCard label="Active tokens" value={String(stats.activeTokens)} />
          <StatCard label="B2 objects" value={String(stats.b2Objects)} />
          <StatCard label="B2 unmirrored" value={String(stats.b2Unmirrored)} />
          <StatCard label="Rendition cache" value={formatBytes(stats.renditionCacheBytes)} />
          <StatCard label="DB size" value={formatBytes(stats.dbSizeBytes)} />
          <StatCard label="Last index" value={stats.lastIndexAt ?? 'never'} />
          <StatCard label="Version" value={stats.version} />
        </SimpleGrid>
      )}

      <Group justify="space-between" wrap="wrap">
        <Stack gap={2}>
          <Text fw={600} size="sm">
            Indexer
          </Text>
          <Text size="xs" c="dimmed">
            {indexStatus?.running
              ? 'Scan in progress…'
              : indexStatus?.lastFinishedAt
                ? `Last finished ${indexStatus.lastFinishedAt}`
                : 'Never run'}
            {indexStatus?.lastCounts &&
              ` — scanned ${indexStatus.lastCounts.scanned}, added ${indexStatus.lastCounts.added}, updated ${indexStatus.lastCounts.updated}, removed ${indexStatus.lastCounts.removed}`}
            {indexStatus?.lastError && ` — last error: ${indexStatus.lastError}`}
          </Text>
        </Stack>
        <Button size="sm" loading={rescan.isPending || indexStatus?.running} onClick={handleRescan}>
          Rescan now
        </Button>
      </Group>

      <Group justify="space-between" wrap="wrap">
        <Text fw={600} size="sm">
          Backblaze B2
        </Text>
        <Group gap="xs">
          <Button
            size="xs"
            variant="default"
            loading={reconcile.isPending}
            onClick={handleReconcile}
          >
            Reconcile bucket
          </Button>
          <Button
            size="xs"
            variant="default"
            loading={reverseBackup.isPending}
            onClick={handleReverseBackup}
          >
            Run reverse backup
          </Button>
        </Group>
      </Group>

      {b2 && b2.data.length > 0 && (
        <Table.ScrollContainer minWidth={600}>
          <Table striped highlightOnHover verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Key</Table.Th>
                <Table.Th>Size</Table.Th>
                <Table.Th>Mirrored</Table.Th>
                <Table.Th>Published image</Table.Th>
                <Table.Th>Last modified</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {b2.data.map((obj) => (
                <Table.Tr key={obj.key}>
                  <Table.Td>
                    <Text size="sm" ff="monospace">
                      {obj.key}
                    </Text>
                  </Table.Td>
                  <Table.Td>{formatBytes(obj.size)}</Table.Td>
                  <Table.Td>
                    <Badge size="xs" color={obj.mirrored ? 'green' : 'gray'} variant="light">
                      {obj.mirrored ? 'mirrored' : 'not mirrored'}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{obj.publishedImageId ?? '—'}</Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      {obj.lastModified}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Stack>
  )
}

import { createFileRoute } from '@tanstack/react-router'
import { Button, Group, SimpleGrid, Stack, Text } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { StatCard } from 'basalt-ui'
import { notifyPromise } from 'basalt-ui/notifications'
import { formatBytes } from '../lib/format'
import { activityQueries, useTriggerRescan } from '../lib/queries/activity'

export const Route = createFileRoute('/activity')({
  component: ActivityPage,
})

function ActivityPage() {
  const { data: stats } = useQuery(activityQueries.stats())
  const { data: indexStatus } = useQuery(activityQueries.indexStatus())

  const rescan = useTriggerRescan()

  function handleRescan() {
    void notifyPromise(rescan.mutateAsync(), {
      loading: 'Starting rescan…',
      success: 'Rescan started',
      error: 'Could not start rescan',
    })
  }

  return (
    <Stack gap="lg">
      {stats && (
        <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} spacing="sm">
          <StatCard label="Images" value={String(stats.images)} />
          <StatCard label="JPEGs" value={String(stats.jpegs)} />
          <StatCard label="RAWs" value={String(stats.raws)} />
          <StatCard label="Share uploads" value={String(stats.share)} />
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
    </Stack>
  )
}

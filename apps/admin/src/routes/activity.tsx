import { createFileRoute } from '@tanstack/react-router'
import { Button, Group, SimpleGrid, Stack, Text } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { StatCard } from 'basalt-ui'
import { QueryState, notifyMutation } from '../features/common'
import { formatBytes, formatDateTime, formatNumber, formatRelative } from '../lib/format'
import { activityQueries, useTriggerRescan, type IndexStatusDto } from '../lib/queries/activity'

export const Route = createFileRoute('/activity')({
  component: ActivityPage,
})

function ActivityPage() {
  const statsQuery = useQuery(activityQueries.stats())
  const indexQuery = useQuery(activityQueries.indexStatus())

  const rescan = useTriggerRescan()

  function handleRescan() {
    void notifyMutation(rescan.mutateAsync(), {
      loading: 'Starting rescan…',
      success: 'Rescan started',
      error: 'Could not start rescan',
    }).catch(() => {
      /* message already surfaced by notifyMutation */
    })
  }

  return (
    <Stack gap="lg">
      <QueryState
        query={statsQuery}
        errorTitle="Could not load stats"
        errorFallback="The service did not return its counters."
        variant="section"
      >
        {(stats) => (
          <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} spacing="sm">
            <StatCard label="Images" value={formatNumber(stats.images)} />
            <StatCard label="JPEGs" value={formatNumber(stats.jpegs)} />
            <StatCard label="RAWs" value={formatNumber(stats.raws)} />
            <StatCard label="Share uploads" value={formatNumber(stats.share)} />
            <StatCard label="Shares" value={formatNumber(stats.shares)} />
            <StatCard label="Active tokens" value={formatNumber(stats.activeTokens)} />
            <StatCard label="B2 objects" value={formatNumber(stats.b2Objects)} />
            <StatCard label="B2 unmirrored" value={formatNumber(stats.b2Unmirrored)} />
            <StatCard label="Rendition cache" value={formatBytes(stats.renditionCacheBytes)} />
            <StatCard label="DB size" value={formatBytes(stats.dbSizeBytes)} />
            <StatCard label="Last index" value={formatDateTime(stats.lastIndexAt, 'never')} />
            <StatCard label="Version" value={stats.version} />
          </SimpleGrid>
        )}
      </QueryState>

      <Group justify="space-between" wrap="wrap" align="flex-end" gap="md">
        <Stack gap={4} style={{ flex: 1, minWidth: 240 }}>
          <Text fw={600} size="sm">
            Indexer
          </Text>
          <QueryState
            query={indexQuery}
            errorTitle="Could not load indexer status"
            errorFallback="The indexer status endpoint did not answer."
            variant="section"
          >
            {(status) => <IndexerSummary status={status} />}
          </QueryState>
        </Stack>
        <Button
          size="sm"
          loading={rescan.isPending || indexQuery.data?.running}
          onClick={handleRescan}
        >
          Rescan now
        </Button>
      </Group>
    </Stack>
  )
}

function IndexerSummary({ status }: { status: IndexStatusDto }) {
  const headline = status.running
    ? `Scan in progress… (started ${formatRelative(status.startedAt, 'just now')})`
    : status.lastFinishedAt
      ? `Last finished ${formatDateTime(status.lastFinishedAt)} · ${formatRelative(status.lastFinishedAt)}`
      : 'Never run'

  const counts = status.lastCounts
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">
        {headline}
        {counts &&
          ` — scanned ${formatNumber(counts.scanned)}, added ${formatNumber(counts.added)}, updated ${formatNumber(counts.updated)}, removed ${formatNumber(counts.removed)}`}
      </Text>
      {status.lastError && (
        <Text size="xs" c="red">
          Last error: {status.lastError}
        </Text>
      )}
    </Stack>
  )
}

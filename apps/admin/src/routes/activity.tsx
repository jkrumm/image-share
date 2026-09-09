import { createFileRoute } from '@tanstack/react-router'
import { Button, Group, SimpleGrid, Stack, Text } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { QueryState, StatCard } from 'basalt-ui'
import { notifyMutation } from '../features/common'
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
        tier="section"
      >
        {(stats) => (
          <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} spacing="sm">
            <StatCard title="Images" value={formatNumber(stats.images)} />
            <StatCard title="JPEGs" value={formatNumber(stats.jpegs)} />
            <StatCard title="RAWs" value={formatNumber(stats.raws)} />
            <StatCard title="Share uploads" value={formatNumber(stats.share)} />
            <StatCard title="Shares" value={formatNumber(stats.shares)} />
            <StatCard title="Active tokens" value={formatNumber(stats.activeTokens)} />
            <StatCard title="B2 objects" value={formatNumber(stats.b2Objects)} />
            <StatCard
              title="B2 unmirrored"
              value={formatNumber(stats.b2Unmirrored)}
              // Zero IS the earned state here — every published key is on the CDN — so it
              // asserts `good` rather than staying untinted.
              tone={stats.b2Unmirrored > 0 ? 'warn' : 'good'}
            />
            <StatCard title="Rendition cache" value={formatBytes(stats.renditionCacheBytes)} />
            <StatCard title="DB size" value={formatBytes(stats.dbSizeBytes)} />
            <StatCard title="Last index" value={formatDateTime(stats.lastIndexAt, 'never')} />
            <StatCard title="Version" value={stats.version} />
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
            tier="section"
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

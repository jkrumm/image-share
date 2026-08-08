import { Badge, Group, NavLink, ScrollArea, Text } from '@mantine/core'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { unwrap } from 'basalt-ui/query'
import type { ReactNode } from 'react'
import { QueryState } from '../common'
import { client } from '../../lib/eden'
import { formatDateRange, formatNumber } from '../../lib/format'
import type { ShareRoot } from '../../lib/queries/shares'

export type AlbumNode = {
  /** Full hierarchical keyword path, `|`-separated. `''` is the synthetic untagged node. */
  path: string
  leaf: string
  depth: number
  /** Recursive (node + everything below it), deduped per image. */
  imageCount: number
  ratedCounts: { r4plus: number; r5: number }
  minCaptureAt: string | null
  maxCaptureAt: string | null
}

/**
 * The album tree (Lightroom's XMP keyword hierarchy). Keyed under the shared
 * `library` prefix so it invalidates with the rest of the library cache.
 */
export function albumsQuery(root: ShareRoot) {
  return queryOptions({
    queryKey: ['library', 'albums', root] as const,
    queryFn: () =>
      unwrap(client.api.library.albums.get({ query: { root } })) as Promise<{ data: AlbumNode[] }>,
  })
}

type Props = {
  root: ShareRoot
  /** Selected path, or `''` for nothing selected. */
  value: string
  onChange: (path: string) => void
}

/**
 * Album tree as a flat indented list — the browse axis that actually exists.
 * The Fuji tree is ONE directory of 2365 files, so the directory picker can
 * only ever offer "everything"; the keyword hierarchy is where `Segeln 25`
 * lives.
 *
 * The synthetic `path=''` untagged node is deliberately not offered: POST
 * /api/shares requires a non-empty album (an empty one would mean "every
 * tagged image"), so an untagged bucket can only be shared as a selection.
 */
export function AlbumPicker({ root, value, onChange }: Props): ReactNode {
  const query = useQuery(albumsQuery(root))

  return (
    <QueryState
      query={query}
      variant="section"
      errorTitle="Could not load albums"
      empty={{
        title: 'No albums in this root',
        description:
          'Albums come from the Lightroom keyword hierarchy written into the JPEGs. Share a folder instead, or tag the images in Lightroom and re-index.',
      }}
      isEmpty={(data) => data.data.filter((node) => node.path !== '').length === 0}
    >
      {(data) => (
        <ScrollArea.Autosize mah={260} type="auto">
          {data.data
            .filter((node) => node.path !== '')
            .map((node) => {
              const range = formatDateRange(node.minCaptureAt, node.maxCaptureAt, '')
              return (
                <NavLink
                  key={node.path}
                  active={node.path === value}
                  onClick={() => onChange(node.path)}
                  pl={12 + node.depth * 16}
                  label={
                    <Group gap="xs" wrap="nowrap">
                      <Text size="sm" truncate="end">
                        {node.leaf}
                      </Text>
                      <Badge size="xs" variant="light">
                        {formatNumber(node.imageCount)}
                      </Badge>
                    </Group>
                  }
                  {...(range !== '' && { description: range })}
                />
              )
            })}
        </ScrollArea.Autosize>
      )}
    </QueryState>
  )
}

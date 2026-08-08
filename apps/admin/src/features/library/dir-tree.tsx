import { NavLink, Skeleton, Stack, Text } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { QueryState } from '../common'
import { formatNumber } from '../../lib/format'
import { libraryQueries, type DirDto, type LibraryRoot } from '../../lib/queries/library'

type Props = {
  root: LibraryRoot | undefined
  dir: string | undefined
  onSelect: (root: LibraryRoot, dir: string) => void
}

const ROOT_LABEL: Record<LibraryRoot, string> = {
  fuji: 'Fuji',
  raws: 'RAWs',
  share: 'Share',
}

function groupByRoot(dirs: DirDto[]): Map<LibraryRoot, DirDto[]> {
  const groups = new Map<LibraryRoot, DirDto[]>()
  for (const d of dirs) {
    const list = groups.get(d.root) ?? []
    list.push(d)
    groups.set(d.root, list)
  }
  return groups
}

/**
 * The directory axis — deliberately the FALLBACK, not the default.
 *
 * The Fuji tree is a single flat directory of ~2400 JPEGs (design §3.1), so
 * this list is three rows on the real library and carries no hierarchy worth
 * browsing. Albums (`album-tree.tsx`) are the primary axis; this stays reachable
 * for the share root and for the rare case of sharing a literal folder.
 */
export function DirTree({ root, dir, onSelect }: Props) {
  const query = useQuery(libraryQueries.dirs())

  return (
    <QueryState
      query={query}
      variant="section"
      errorTitle="Could not load folders"
      empty={{ title: 'No folders', description: 'Nothing has been indexed yet.' }}
      loading={
        <Stack gap={4}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={`dir-skeleton-${i}`} h={28} radius="sm" />
          ))}
        </Stack>
      }
    >
      {(data) => {
        const groups = groupByRoot(data.data as DirDto[])
        return (
          <Stack gap="sm">
            {(['fuji', 'share', 'raws'] as const).map((r) => {
              const items = groups.get(r) ?? []
              if (items.length === 0) return null
              return (
                <Stack key={r} gap={2}>
                  <Text size="xs" c="dimmed" fw={600} tt="uppercase" px={4}>
                    {ROOT_LABEL[r]}
                  </Text>
                  {items
                    .toSorted((a, b) => a.dir.localeCompare(b.dir))
                    .map((d) => (
                      <NavLink
                        key={`${d.root}:${d.dir}`}
                        label={d.dir === '' ? '(root)' : d.dir}
                        description={`${formatNumber(d.imageCount)} image${d.imageCount === 1 ? '' : 's'}`}
                        active={root === d.root && dir === d.dir}
                        onClick={() => onSelect(d.root, d.dir)}
                        py={4}
                      />
                    ))}
                </Stack>
              )
            })}
          </Stack>
        )
      }}
    </QueryState>
  )
}

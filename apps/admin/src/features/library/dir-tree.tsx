import { NavLink, ScrollArea, Skeleton, Stack, Text } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { libraryQueries, type DirDto, type LibraryRoot } from '../../lib/queries/library'

type Props = {
  root: LibraryRoot | undefined
  dir: string | undefined
  onSelect: (root: LibraryRoot, dir: string) => void
}

const ROOT_LABEL: Record<LibraryRoot, string> = {
  library: 'Library',
  raws: 'RAWs',
  uploads: 'Uploads',
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

export function DirTree({ root, dir, onSelect }: Props) {
  const { data, isLoading } = useQuery(libraryQueries.dirs())

  if (isLoading) {
    return (
      <Stack gap={4} p="sm">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={`skeleton-${i}`} h={28} radius="sm" />
        ))}
      </Stack>
    )
  }

  const groups = groupByRoot(data?.data ?? [])

  return (
    <ScrollArea.Autosize mah="calc(100vh - 140px)">
      <Stack gap="md" p="sm">
        {(['library', 'uploads', 'raws'] as const).map((r) => {
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
                    description={`${d.imageCount} image${d.imageCount === 1 ? '' : 's'}`}
                    active={root === d.root && dir === d.dir}
                    onClick={() => onSelect(d.root, d.dir)}
                    py={4}
                  />
                ))}
            </Stack>
          )
        })}
      </Stack>
    </ScrollArea.Autosize>
  )
}

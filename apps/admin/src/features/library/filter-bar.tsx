import { Button, Checkbox, CloseButton, Group, Menu, Select, TextInput } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { useEffect, useRef, useState } from 'react'
import type { LibraryOrder, LibrarySort } from '../../lib/queries/library'
import { MinRatingInput } from '../shares/min-rating-input'
import { DATE_PRESETS } from './date-presets'
import { pushStemUp, syncStemDown } from './stem-sync'

export type FilterValue = {
  minRating: number | undefined
  recursive: boolean
  captureFrom: string | undefined
  captureTo: string | undefined
  stem: string | undefined
  sort: LibrarySort
  order: LibraryOrder
}

export type FilterPatch = Partial<FilterValue>

export type FilterChangeOptions = {
  /**
   * Replace the current history entry instead of pushing one. Set for the
   * debounced filename push, so typing a word doesn't bury the previous view
   * under one Back press per pause.
   */
  replace?: boolean
}

type Props = FilterValue & {
  /** Which scope the `recursive` toggle applies to, so the label tells the truth. */
  axis: 'album' | 'dir' | 'none'
  onChange: (patch: FilterPatch, options?: FilterChangeOptions) => void
}

const RECURSIVE_LABEL: Record<Props['axis'], string> = {
  album: 'Include sub-albums',
  dir: 'Include subfolders',
  none: 'Include everything below',
}

export function FilterBar({
  minRating,
  recursive,
  captureFrom,
  captureTo,
  stem,
  sort,
  order,
  axis,
  onChange,
}: Props) {
  // The stem box is typed into, so it holds its own value and pushes into the
  // URL on a debounce — otherwise every keystroke is a navigation and a refetch.
  // Both directions are arbitrated by ./stem-sync, which is where the reasoning
  // (and its regression tests) live.
  const [stemDraft, setStemDraft] = useState(stem ?? '')
  const [debouncedStem] = useDebouncedValue(stemDraft, 300)
  const pushed = useRef<string | undefined>(stem)

  // The push effect must NOT depend on `onChange`: a parent that hands it a
  // fresh function every render (a plain function declaration in the route body
  // is the normal case) would otherwise re-run this effect on every unrelated
  // re-render, mid-debounce.
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })

  useEffect(() => {
    const next = syncStemDown({ pushed: pushed.current }, stem)
    if (next === null) return
    pushed.current = next.pushed
    setStemDraft(next.draft)
  }, [stem])

  useEffect(() => {
    const next = pushStemUp({ draft: stemDraft, pushed: pushed.current }, debouncedStem)
    if (next === null) return
    pushed.current = next.pushed
    onChangeRef.current({ stem: next.pushed }, { replace: true })
  }, [stemDraft, debouncedStem])

  const hasDates = captureFrom !== undefined || captureTo !== undefined

  return (
    <Group gap="sm" wrap="wrap" align="flex-end">
      <TextInput
        size="xs"
        w={{ base: '100%', xs: 200 }}
        label="Filename"
        placeholder="DSCF1234"
        value={stemDraft}
        onChange={(event) => setStemDraft(event.currentTarget.value)}
        rightSection={
          stemDraft === '' ? null : (
            <CloseButton
              size="sm"
              aria-label="Clear filename filter"
              onClick={() => setStemDraft('')}
            />
          )
        }
      />

      <TextInput
        size="xs"
        type="date"
        w={{ base: 'calc(50% - var(--mantine-spacing-sm) / 2)', xs: 150 }}
        label="From"
        value={captureFrom ?? ''}
        onChange={(event) => onChange({ captureFrom: event.currentTarget.value || undefined })}
      />
      <TextInput
        size="xs"
        type="date"
        w={{ base: 'calc(50% - var(--mantine-spacing-sm) / 2)', xs: 150 }}
        label="To"
        value={captureTo ?? ''}
        onChange={(event) => onChange({ captureTo: event.currentTarget.value || undefined })}
      />

      <Menu position="bottom-start" withinPortal>
        <Menu.Target>
          <Button size="xs" variant="default">
            Dates ▾
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {DATE_PRESETS.map((preset) => (
            <Menu.Item key={preset.label} onClick={() => onChange(preset.range(new Date()))}>
              {preset.label}
            </Menu.Item>
          ))}
          <Menu.Divider />
          <Menu.Item
            disabled={!hasDates}
            onClick={() => onChange({ captureFrom: undefined, captureTo: undefined })}
          >
            Clear dates
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>

      <MinRatingInput
        size="xs"
        value={minRating ?? 0}
        onChange={(value) => onChange({ minRating: value === 0 ? undefined : value })}
      />

      <Checkbox
        size="xs"
        label={RECURSIVE_LABEL[axis]}
        disabled={axis === 'none'}
        checked={recursive}
        onChange={(event) => onChange({ recursive: event.currentTarget.checked })}
      />

      <Select
        size="xs"
        w={140}
        label="Sort"
        data={[
          { value: 'captureAt', label: 'Capture date' },
          { value: 'name', label: 'Name' },
        ]}
        value={sort}
        onChange={(value) => value && onChange({ sort: value as LibrarySort })}
        allowDeselect={false}
      />
      <Select
        size="xs"
        w={110}
        label="Order"
        data={[
          { value: 'desc', label: 'Newest' },
          { value: 'asc', label: 'Oldest' },
        ]}
        value={order}
        onChange={(value) => value && onChange({ order: value as LibraryOrder })}
        allowDeselect={false}
      />
    </Group>
  )
}

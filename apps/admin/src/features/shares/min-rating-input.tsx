import { Anchor, Group, Input, Rating } from '@mantine/core'
import type { ReactNode } from 'react'

type Props = {
  /** 0 means "no filter" — the same convention the API and the share predicate use. */
  value: number
  onChange: (value: number) => void
  label?: string
  /** `xs` for the compact Library toolbar; default elsewhere. */
  size?: 'xs' | 'sm'
}

/**
 * The one minimum-rating control — the Library toolbar, the create modal and
 * share Settings all render THIS, so the same concept never ships in two shapes
 * with two different copies.
 *
 * The "clear" affordance is the reason it exists as a component at all: a bare
 * Mantine `Rating` can only be reset to 0 with `allowClear`, which is not on by
 * default and which basalt-ui does not theme in — so a toolbar rolling its own
 * `Rating` is a filter the operator can set and then never remove.
 */
export function MinRatingInput({
  value,
  onChange,
  label = 'Minimum rating',
  size,
}: Props): ReactNode {
  return (
    <Input.Wrapper label={label} description="No stars = no filter" size={size}>
      <Group gap="xs" mt={4}>
        <Rating size={size === 'xs' ? 'sm' : undefined} value={value} onChange={onChange} />
        {value > 0 && (
          <Anchor component="button" type="button" size="xs" c="dimmed" onClick={() => onChange(0)}>
            clear
          </Anchor>
        )}
      </Group>
    </Input.Wrapper>
  )
}

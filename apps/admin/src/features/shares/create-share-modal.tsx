import {
  Alert,
  Button,
  Checkbox,
  Divider,
  Group,
  Input,
  Modal,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core'
import { useNavigate } from '@tanstack/react-router'
import { useMemo, useState, type ReactNode } from 'react'
import { field, FormErrorSummary, useBasaltForm } from 'basalt-ui/forms'
import { notifyMutation } from '../common'
import { toErrorMessage } from '../../lib/eden'
import { formatNumber } from '../../lib/format'
import {
  useAddShareToken,
  useCreateShare,
  type CreateShareInput,
  type ShareDto,
  type ShareSourceInput,
  type TokenDto,
} from '../../lib/queries/shares'
import { AlbumPicker } from './album-picker'
import { MinRatingInput } from './min-rating-input'
import { useScopePreview } from './scope-preview'
import { useShareBaseUrl } from './share-base-url'
import {
  CREATE_SHARE_INITIAL_VALUES,
  CreateShareFormSchema,
  deriveSlugPreview,
  isCreateShareBlocked,
  resolveShareSource,
  type CreateShareFormValues,
} from './share-forms'
import { TokenRow } from './token-row'
import { ROLE_OPTIONS } from './token-role'

// Creation asks the minimum — title + note + who gets which link — because the
// caller already knows WHAT is being shared. `source` is fixed by the Library
// page's entry points (selection / folder / album); it's left undefined only
// for the Shares list's "New share" action, which has no ambient context and
// shows a picker instead.
export type CreateShareModalSource = ShareSourceInput

type Props = {
  opened: boolean
  onClose: () => void
  source?: CreateShareModalSource
  /** Fired after a successful create — the Library page clears its selection. */
  onCreated?: (share: ShareDto) => void
}

type CreatedState = { share: ShareDto; extraToken: TokenDto | null }

export function CreateShareModal({ opened, onClose, source, onCreated }: Props): ReactNode {
  const navigate = useNavigate()
  const createShare = useCreateShare()
  const addToken = useAddShareToken()
  const shareBaseUrl = useShareBaseUrl(opened)
  const [created, setCreated] = useState<CreatedState | null>(null)

  const form = useBasaltForm<CreateShareFormValues>({
    initialValues: { ...CREATE_SHARE_INITIAL_VALUES },
    schema: CreateShareFormSchema,
    mode: 'controlled',
  })

  const { scope, root, album, dir, recursive, minRating } = form.values

  // ONE resolved source, used verbatim by both the count preview and the POST
  // body. Anything assembled twice is a place where the preview and the share
  // can disagree, which is the invariant this modal exists to protect.
  const resolvedSource: ShareSourceInput | null = useMemo(
    () => resolveShareSource({ scope, root, album, dir, recursive, minRating }, source),
    [source, scope, root, album, dir, recursive, minRating],
  )

  const preview = useScopePreview(resolvedSource)

  const isPicker = source === undefined
  const slugPreview = deriveSlugPreview(form.values.title)
  const pending = createShare.isPending || addToken.isPending

  // Includes the "the count is still unknown" case — a preview that is retrying,
  // or one that has given up. See `isCreateShareBlocked`.
  const blocked = isCreateShareBlocked(resolvedSource, preview)

  function handleClose() {
    form.reset()
    setCreated(null)
    onClose()
  }

  async function submit(values: CreateShareFormValues) {
    if (resolvedSource === null) return

    const body: CreateShareInput = {
      title: values.title,
      note: values.note === '' ? null : values.note,
      role: values.role,
      source: resolvedSource,
    }

    let share: ShareDto
    try {
      share = await notifyMutation(createShare.mutateAsync(body), {
        loading: 'Creating share…',
        success: 'Share created',
        error: 'Could not create share',
      })
    } catch {
      return // notifyMutation already surfaced the real server message
    }

    onCreated?.(share)

    // The second link is a separate mint, so its failure must not discard the
    // share (and its first link) that already exists.
    let extraToken: TokenDto | null = null
    if (values.secondLink) {
      try {
        extraToken = await notifyMutation(
          addToken.mutateAsync({
            id: share.id,
            role: values.secondRole,
            label: values.secondLabel === '' ? null : values.secondLabel,
          }),
          {
            loading: 'Minting second link…',
            success: 'Second link added',
            error: 'Share created, but the second link could not be minted',
          },
        )
      } catch {
        extraToken = null
      }
    }

    // Stay put and show the links. Navigating away on success was the reason
    // every share needed a second surface visit before it could be sent.
    setCreated({ share, extraToken })
  }

  if (created) {
    return (
      <Modal
        opened={opened}
        onClose={handleClose}
        title="Share created"
        size="lg"
        closeOnClickOutside={false}
      >
        <Stack gap="sm">
          <Stack gap={2}>
            <Text fw={600}>{created.share.title}</Text>
            <Text size="sm" c="dimmed">
              {preview.label}
            </Text>
          </Stack>
          <Text size="sm">Send these links — copy now, they are shown on the detail page too.</Text>
          {[...created.share.tokens, ...(created.extraToken ? [created.extraToken] : [])].map(
            (token) => (
              <TokenRow key={token.id} token={token} />
            ),
          )}
          <Group justify="flex-end" mt="xs">
            <Button variant="default" onClick={handleClose}>
              Done
            </Button>
            <Button
              onClick={() => {
                const id = String(created.share.id)
                handleClose()
                void navigate({ to: '/shares/$id', params: { id } })
              }}
            >
              Open share
            </Button>
          </Group>
        </Stack>
      </Modal>
    )
  }

  return (
    <Modal opened={opened} onClose={handleClose} title="Create share" size="lg">
      <form onSubmit={form.onSubmit((values) => void submit(values))}>
        <Stack gap="sm">
          <FormErrorSummary form={form} />

          {isPicker && (
            <>
              <Group grow>
                <Input.Wrapper label="Browse by">
                  <SegmentedControl
                    fullWidth
                    mt={4}
                    value={scope}
                    onChange={(v) =>
                      form.setFieldValue('scope', v as CreateShareFormValues['scope'])
                    }
                    data={[
                      { value: 'album', label: 'Album' },
                      { value: 'folder', label: 'Folder' },
                    ]}
                  />
                </Input.Wrapper>
                <Select
                  label="Root"
                  data={[
                    { value: 'fuji', label: 'Fuji' },
                    { value: 'share', label: 'Share' },
                  ]}
                  allowDeselect={false}
                  value={root}
                  onChange={(v) => {
                    if (!v) return
                    form.setFieldValue('root', v as CreateShareFormValues['root'])
                    // An album path belongs to the root it was picked in — a
                    // keyword tree is per-root, so carrying it across would
                    // preview 0 against a path that doesn't exist there.
                    form.setFieldValue('album', '')
                  }}
                />
              </Group>

              {scope === 'album' ? (
                <Input.Wrapper
                  label="Album"
                  description="Lightroom keyword hierarchy — untagged images can only be shared as a selection"
                >
                  <AlbumPicker
                    root={root}
                    value={album}
                    onChange={(path) => form.setFieldValue('album', path)}
                  />
                </Input.Wrapper>
              ) : (
                <TextInput
                  label="Directory"
                  description="Empty means the whole root"
                  placeholder="2026/mallorca"
                  {...field(form, 'dir')}
                />
              )}

              <Group gap="lg" align="flex-end">
                <MinRatingInput
                  value={minRating}
                  onChange={(v) => form.setFieldValue('minRating', v)}
                />
                <Checkbox
                  label={scope === 'album' ? 'Include sub-albums' : 'Include subfolders'}
                  checked={recursive}
                  onChange={(e) => form.setFieldValue('recursive', e.currentTarget.checked)}
                />
              </Group>
            </>
          )}

          <ScopeSummary preview={preview} picked={resolvedSource !== null} />

          <TextInput
            label="Title"
            placeholder="Mallorca 2026"
            autoFocus
            description={
              form.values.title === ''
                ? undefined
                : shareBaseUrl
                  ? `${shareBaseUrl}/${slugPreview}`
                  : `/${slugPreview}`
            }
            {...field(form, 'title')}
          />
          <Textarea
            label="Note"
            placeholder="Optional note — markdown is supported"
            autosize
            minRows={2}
            {...field(form, 'note')}
          />

          <Divider label="Links" labelPosition="left" />

          <Select
            label="Link for everyone"
            description="The first link, minted with the share"
            data={ROLE_OPTIONS}
            allowDeselect={false}
            {...field(form, 'role')}
          />

          <Checkbox
            label="Also mint a second link with a different role"
            description="The usual case: view for the group, full (originals + RAWs) for one person"
            checked={form.values.secondLink}
            onChange={(e) => form.setFieldValue('secondLink', e.currentTarget.checked)}
          />

          {form.values.secondLink && (
            <Group grow align="flex-start">
              <Select
                label="Second link"
                data={ROLE_OPTIONS}
                allowDeselect={false}
                {...field(form, 'secondRole')}
              />
              <TextInput
                label="Who it is for"
                placeholder="e.g. Tom"
                {...field(form, 'secondLabel')}
              />
            </Group>
          )}

          <Button type="submit" loading={pending} disabled={blocked}>
            Create share
          </Button>
        </Stack>
      </form>
    </Modal>
  )
}

function ScopeSummary({
  preview,
  picked,
}: {
  preview: ReturnType<typeof useScopePreview>
  picked: boolean
}): ReactNode {
  if (!picked) {
    return (
      <Text size="sm" c="dimmed">
        Pick an album (or switch to Folder) to see what the share will contain.
      </Text>
    )
  }

  if (preview.error) {
    return (
      <Alert color="yellow" variant="light" title="Could not verify the image count">
        <Text size="sm">{toErrorMessage(preview.error, 'The preview request failed.')}</Text>
        <Text size="sm" mt={4}>
          {preview.label}
        </Text>
      </Alert>
    )
  }

  if (preview.total === 0) {
    return (
      <Text size="sm" c="red">
        No images match {preview.label} — check the scope, the subfolder/sub-album toggle and the
        rating.
      </Text>
    )
  }

  const count =
    preview.total === undefined
      ? '…'
      : `${formatNumber(preview.total)} image${preview.total === 1 ? '' : 's'}`
  return (
    <Text size="sm" c="dimmed">
      {preview.label} · {count}
    </Text>
  )
}

import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import {
  Accordion,
  Anchor,
  Button,
  Checkbox,
  Group,
  Stack,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core'
import { useClipboard } from '@mantine/hooks'
import { modals } from '@mantine/modals'
import { DangerZone, EmptyState } from 'basalt-ui'
import { field, FormErrorSummary, useBasaltForm } from 'basalt-ui/forms'
import { QueryState, notifyMutation } from '../features/common'
import { AddTokenModal } from '../features/shares/add-token-modal'
import { MinRatingInput } from '../features/shares/min-rating-input'
import {
  SettingsFormSchema,
  settingsInitialValues,
  toUpdateSharePatch,
  type SettingsFormValues,
} from '../features/shares/share-forms'
import { ShareImages } from '../features/shares/share-images'
import { TokenRow } from '../features/shares/token-row'
import { activeTokens, sortTokens } from '../features/shares/token-role'
import { errorStatus } from '../lib/eden'
import { formatDate, formatDateTime, formatNumber, formatRelative } from '../lib/format'
import type { ImageDto } from '../lib/queries/library'
import {
  useDeleteShare,
  useRevokeShareToken,
  useRollShareToken,
  useShare,
  useUpdateShare,
  type ShareDetailDto,
} from '../lib/queries/shares'

export const Route = createFileRoute('/shares/$id')({
  component: ShareDetailPage,
})

function sourceLine(share: ShareDetailDto): string {
  if (share.sourceType === 'selection') {
    return `Selection · ${formatNumber(share.images.length)} image${share.images.length === 1 ? '' : 's'}`
  }
  const scope = share.recursive
    ? share.sourceType === 'album'
      ? '(incl. sub-albums)'
      : '(incl. subfolders)'
    : share.sourceType === 'album'
      ? '(this album only)'
      : '(this folder only)'
  const rating = share.minRating ? ` · ${share.minRating}★ and up` : ''
  if (share.sourceType === 'album') return `Album ${share.root}/${share.album} ${scope}${rating}`
  const label = share.dir ? `${share.root}/${share.dir}` : share.root
  return `Folder ${label} ${scope}${rating}`
}

function ShareDetailPage(): ReactNode {
  const { id } = Route.useParams()
  const shareId = Number(id)
  const query = useShare(shareId)

  const backLink = (
    <Anchor component={Link} to="/shares" size="sm" c="dimmed">
      ← All shares
    </Anchor>
  )

  // A real 404 is the ONLY case that means "deleted". Everything else — a 500,
  // a dropped connection, an expired bearer — used to render as a deletion.
  if (query.isError && query.data === undefined && errorStatus(query.error) === 404) {
    return (
      <Stack gap="lg">
        {backLink}
        <EmptyState
          title="Share not found"
          description="It was deleted, or the link you followed points at an id that never existed."
          action={
            <Button component={Link} to="/shares">
              Back to shares
            </Button>
          }
        />
      </Stack>
    )
  }

  return (
    <Stack gap="lg">
      {backLink}
      <QueryState
        query={query}
        errorTitle="Could not load this share"
        errorAction={
          <Button component={Link} to="/shares" size="xs" variant="subtle">
            Back to shares
          </Button>
        }
      >
        {(share) => <ShareDetail share={share} />}
      </QueryState>
    </Stack>
  )
}

function ShareDetail({ share }: { share: ShareDetailDto }): ReactNode {
  const navigate = useNavigate()
  const clipboard = useClipboard({ timeout: 2000 })

  const updateShare = useUpdateShare()
  const deleteShare = useDeleteShare()
  const rollToken = useRollShareToken()
  const revokeToken = useRevokeShareToken()

  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [showRevoked, setShowRevoked] = useState(false)
  const [addTokenOpened, setAddTokenOpened] = useState(false)
  const [highlightTokenId, setHighlightTokenId] = useState<number | null>(null)

  const shareId = share.id

  function startEditTitle() {
    setTitleDraft(share.title)
    setIsEditingTitle(true)
  }

  function saveTitle() {
    if (titleDraft.trim() === '' || titleDraft === share.title) {
      setIsEditingTitle(false)
      return
    }
    void notifyMutation(updateShare.mutateAsync({ id: shareId, title: titleDraft }), {
      loading: 'Saving title…',
      success: 'Title updated',
      error: 'Could not update title',
    })
      .then(() => setIsEditingTitle(false))
      .catch(() => {
        /* the real server message is already on screen */
      })
  }

  function handleRoll() {
    modals.openConfirmModal({
      title: 'Roll all active links',
      children: (
        <Text size="sm">
          Revokes every active link for &quot;{share.title}&quot; and mints a same-role replacement
          for each. Existing links stop working immediately.
        </Text>
      ),
      labels: { confirm: 'Roll links', cancel: 'Cancel' },
      confirmProps: { color: 'orange' },
      onConfirm: () => {
        void notifyMutation(rollToken.mutateAsync(shareId), {
          loading: 'Rolling links…',
          success: 'Links rolled',
          error: 'Could not roll links',
        }).catch(() => {
          /* the real server message is already on screen */
        })
      },
    })
  }

  function handleRevoke(tokenId: number) {
    modals.openConfirmModal({
      title: 'Revoke link',
      children: <Text size="sm">This link stops working immediately.</Text>,
      labels: { confirm: 'Revoke', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        void notifyMutation(revokeToken.mutateAsync({ id: shareId, tokenId }), {
          loading: 'Revoking link…',
          success: 'Link revoked',
          error: 'Could not revoke link',
        }).catch(() => {
          /* the real server message is already on screen */
        })
      },
    })
  }

  function handleRemoveImage(image: ImageDto) {
    modals.openConfirmModal({
      title: 'Remove from share',
      children: (
        <Text size="sm">
          Remove {image.stem}.{image.ext} from &quot;{share.title}&quot;? The file itself is not
          touched — you can add it back from the Library.
        </Text>
      ),
      labels: { confirm: 'Remove', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        const remaining = share.images.map((i) => i.id).filter((id) => id !== image.id)
        void notifyMutation(updateShare.mutateAsync({ id: shareId, imageIds: remaining }), {
          loading: 'Removing image…',
          success: 'Image removed',
          error: 'Could not remove image',
        }).catch(() => {
          /* the real server message is already on screen */
        })
      },
    })
  }

  function handleDelete() {
    modals.openConfirmModal({
      title: 'Delete share',
      children: (
        <Text size="sm">
          Delete &quot;{share.title}&quot;? All its links stop working immediately. This cannot be
          undone.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        void notifyMutation(deleteShare.mutateAsync(shareId), {
          loading: 'Deleting share…',
          success: 'Share deleted',
          error: 'Could not delete share',
        })
          .then(() => void navigate({ to: '/shares' }))
          .catch(() => {
            /* the real server message is already on screen */
          })
      },
    })
  }

  const tokens = sortTokens(showRevoked ? share.tokens : activeTokens(share.tokens))

  return (
    <>
      <Stack gap={4}>
        {isEditingTitle ? (
          <Group gap="xs">
            <TextInput
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveTitle()}
              autoFocus
              size="lg"
            />
            <Button size="xs" onClick={saveTitle} loading={updateShare.isPending}>
              Save
            </Button>
            <Button size="xs" variant="default" onClick={() => setIsEditingTitle(false)}>
              Cancel
            </Button>
          </Group>
        ) : (
          <Group gap="xs">
            <Text size="xl" fw={700}>
              {share.title}
            </Text>
            <Button size="xs" variant="subtle" onClick={startEditTitle}>
              Edit
            </Button>
          </Group>
        )}
        <Text size="sm" ff="monospace" c="dimmed">
          {share.slug}
        </Text>
        <Text size="sm" c="dimmed">
          {sourceLine(share)}
        </Text>
        <Tooltip label={formatDateTime(share.createdAt)}>
          <Text size="xs" c="dimmed">
            Created {formatRelative(share.createdAt)}
            {share.expiresAt !== null && ` · expires ${formatDate(share.expiresAt)}`}
          </Text>
        </Tooltip>
      </Stack>

      <Stack gap="sm">
        <Group justify="space-between">
          <Text fw={600}>Links</Text>
          <Group gap="xs">
            <Checkbox
              label="Show revoked"
              checked={showRevoked}
              onChange={(e) => setShowRevoked(e.currentTarget.checked)}
            />
            <Tooltip label="Revoke every active link and mint same-role replacements">
              <Button size="xs" variant="subtle" color="orange" onClick={handleRoll}>
                Roll all links
              </Button>
            </Tooltip>
          </Group>
        </Group>

        {tokens.length === 0 && (
          <Text size="sm" c="dimmed">
            No links yet — nobody can open this share.
          </Text>
        )}

        {tokens.map((token) => (
          <TokenRow
            key={token.id}
            token={token}
            highlighted={token.id === highlightTokenId}
            onRevoke={() => handleRevoke(token.id)}
          />
        ))}

        <Group gap="xs">
          <Button size="xs" variant="light" onClick={() => setAddTokenOpened(true)}>
            Add link
          </Button>
          {highlightTokenId !== null && (
            <Text size="xs" c="dimmed">
              {clipboard.copied ? 'New link copied to clipboard' : 'New link highlighted above'}
            </Text>
          )}
        </Group>
      </Stack>

      <Stack gap="sm">
        <Text fw={600}>Images</Text>
        {share.sourceType !== 'selection' && (
          <Text size="xs" c="dimmed">
            Content follows the {share.sourceType} automatically — change what is in it by re-rating
            or re-tagging in the library, or by adjusting the scope in Settings.
          </Text>
        )}
        {share.images.length === 0 ? (
          <Text size="sm" c="dimmed">
            No images in this share yet.
          </Text>
        ) : (
          <ShareImages
            images={share.images}
            removing={updateShare.isPending}
            {...(share.sourceType === 'selection' && { onRemove: handleRemoveImage })}
          />
        )}
      </Stack>

      <Accordion variant="separated">
        <Accordion.Item value="settings">
          <Accordion.Control>Settings</Accordion.Control>
          <Accordion.Panel>
            <ShareSettingsForm share={share} />
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>

      <DangerZone title="Delete this share" description="This cannot be undone.">
        <Button color="red" variant="outline" onClick={handleDelete}>
          Delete share
        </Button>
      </DangerZone>

      <AddTokenModal
        shareId={shareId}
        opened={addTokenOpened}
        onClose={() => setAddTokenOpened(false)}
        onCreated={(token) => {
          setHighlightTokenId(token.id)
          // Best effort: the row is highlighted and carries its own Copy
          // button, so a clipboard rejection costs nothing.
          clipboard.copy(token.url)
        }}
      />
    </>
  )
}

function ShareSettingsForm({ share }: { share: ShareDetailDto }): ReactNode {
  const updateShare = useUpdateShare()
  const form = useBasaltForm<SettingsFormValues>({
    initialValues: settingsInitialValues(share),
    schema: SettingsFormSchema,
    mode: 'controlled',
  })

  // minRating and recursive are folder- AND album-scope fields; PATCH rejects
  // both only on a selection share.
  const scoped = share.sourceType !== 'selection'

  function handleSubmit(values: SettingsFormValues) {
    void notifyMutation(updateShare.mutateAsync(toUpdateSharePatch(share, values)), {
      loading: 'Saving settings…',
      success: 'Settings saved',
      error: 'Could not save settings',
    }).catch(() => {
      /* the real server message is already on screen */
    })
  }

  return (
    <form onSubmit={form.onSubmit(handleSubmit)}>
      <Stack gap="sm">
        <FormErrorSummary form={form} />
        <Textarea
          label="Note"
          description="Markdown is supported"
          autosize
          minRows={2}
          {...field(form, 'note')}
        />
        <TextInput
          type="date"
          label="Expires"
          description="Empty means no expiry"
          {...field(form, 'expiresAt')}
        />
        {scoped && (
          <>
            <MinRatingInput
              value={form.values.minRating}
              onChange={(v) => form.setFieldValue('minRating', v)}
            />
            <Checkbox
              label={share.sourceType === 'album' ? 'Include sub-albums' : 'Include subfolders'}
              description={
                share.sourceType === 'album'
                  ? 'Off shares only the images tagged with this exact album'
                  : 'Off shares only the images directly in this folder'
              }
              checked={form.values.recursive}
              onChange={(e) => form.setFieldValue('recursive', e.currentTarget.checked)}
            />
          </>
        )}
        <Group>
          <Button type="submit" size="xs" loading={updateShare.isPending}>
            Save settings
          </Button>
        </Group>
      </Stack>
    </form>
  )
}

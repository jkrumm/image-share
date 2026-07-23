import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import {
  ActionIcon,
  Anchor,
  AspectRatio,
  Accordion,
  Badge,
  Button,
  Checkbox,
  CopyButton,
  Group,
  Image,
  Loader,
  NumberInput,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core'
import { modals } from '@mantine/modals'
import { z } from 'zod'
import { DangerZone, EmptyState } from 'basalt-ui'
import { field, FormErrorSummary, useBasaltForm } from 'basalt-ui/forms'
import { notifyPromise } from 'basalt-ui/notifications'
import { AddTokenModal } from '../features/shares/add-token-modal'
import {
  ROLE_COLOR,
  ROLE_DESCRIPTION,
  ROLE_LABEL,
  activeTokens,
} from '../features/shares/token-role'
import { imageFileUrl } from '../lib/eden'
import {
  useDeleteShare,
  useRevokeShareToken,
  useRollShareToken,
  useShare,
  useUpdateShare,
  type ShareDetailDto,
  type TokenDto,
} from '../lib/queries/shares'

export const Route = createFileRoute('/shares/$id')({
  component: ShareDetailPage,
})

function sourceLine(share: ShareDetailDto): string {
  if (share.sourceType === 'selection') {
    return `Selection · ${share.images.length} image${share.images.length === 1 ? '' : 's'}`
  }
  const label = share.dir ? `${share.root}/${share.dir}` : share.root
  return `Folder ${label} ${share.recursive ? '(incl. subfolders)' : '(this folder only)'}`
}

function ShareDetailPage() {
  const { id } = Route.useParams()
  const shareId = Number(id)
  const navigate = useNavigate()
  const { data: share, isLoading } = useShare(shareId)

  const updateShare = useUpdateShare()
  const deleteShare = useDeleteShare()
  const rollToken = useRollShareToken()
  const revokeToken = useRevokeShareToken()

  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [showRevoked, setShowRevoked] = useState(false)
  const [addTokenOpened, setAddTokenOpened] = useState(false)

  if (isLoading) return <Loader size="sm" />
  if (!share) return <EmptyState title="Share not found" description="It may have been deleted." />

  function startEditTitle() {
    setTitleDraft(share!.title)
    setIsEditingTitle(true)
  }

  function saveTitle() {
    if (titleDraft.trim() === '' || titleDraft === share!.title) {
      setIsEditingTitle(false)
      return
    }
    void notifyPromise(updateShare.mutateAsync({ id: shareId, title: titleDraft }), {
      loading: 'Saving title…',
      success: 'Title updated',
      error: 'Could not update title',
    })
      .then(() => setIsEditingTitle(false))
      .catch(() => {
        /* toast already shown by notifyPromise */
      })
  }

  function handleRoll() {
    modals.openConfirmModal({
      title: 'Roll all active links',
      children: (
        <Text size="sm">
          Revokes every active link for &quot;{share!.title}&quot; and mints a same-role replacement
          for each. Existing links stop working immediately.
        </Text>
      ),
      labels: { confirm: 'Roll links', cancel: 'Cancel' },
      confirmProps: { color: 'orange' },
      onConfirm: () => {
        void notifyPromise(rollToken.mutateAsync(shareId), {
          loading: 'Rolling links…',
          success: 'Links rolled',
          error: 'Could not roll links',
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
        void notifyPromise(revokeToken.mutateAsync({ id: shareId, tokenId }), {
          loading: 'Revoking link…',
          success: 'Link revoked',
          error: 'Could not revoke link',
        })
      },
    })
  }

  function handleRemoveImage(imageId: number) {
    const remaining = share!.images.map((image) => image.id).filter((id_) => id_ !== imageId)
    void notifyPromise(updateShare.mutateAsync({ id: shareId, imageIds: remaining }), {
      loading: 'Removing image…',
      success: 'Image removed',
      error: 'Could not remove image',
    })
  }

  function handleDelete() {
    modals.openConfirmModal({
      title: 'Delete share',
      children: (
        <Text size="sm">
          Delete &quot;{share!.title}&quot;? All its links stop working immediately. This cannot be
          undone.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        void notifyPromise(deleteShare.mutateAsync(shareId), {
          loading: 'Deleting share…',
          success: 'Share deleted',
          error: 'Could not delete share',
        })
          .then(() => void navigate({ to: '/shares' }))
          .catch(() => {
            /* toast already shown by notifyPromise */
          })
      },
    })
  }

  const tokens = showRevoked ? share.tokens : activeTokens(share.tokens)

  return (
    <Stack gap="lg">
      <Anchor component={Link} to="/shares" size="sm" c="dimmed">
        ← All shares
      </Anchor>

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
            No links yet.
          </Text>
        )}

        {tokens.map((token) => (
          <TokenRow key={token.id} token={token} onRevoke={() => handleRevoke(token.id)} />
        ))}

        <Group>
          <Button size="xs" variant="light" onClick={() => setAddTokenOpened(true)}>
            Add link
          </Button>
        </Group>
      </Stack>

      <Stack gap="sm">
        <Text fw={600}>Images</Text>
        {share.sourceType === 'folder' && (
          <Text size="xs" c="dimmed">
            Content follows the folder automatically — remove images by moving/rating them in the
            library, not here.
          </Text>
        )}
        {share.images.length === 0 && (
          <Text size="sm" c="dimmed">
            No images in this share yet.
          </Text>
        )}
        {share.images.length > 0 && (
          <SimpleGrid cols={{ base: 3, sm: 4, md: 6, lg: 8 }} spacing="xs">
            {share.images.map((image) => (
              <div key={image.id} style={{ position: 'relative' }}>
                {share.sourceType === 'selection' && (
                  <ActionIcon
                    size="sm"
                    color="red"
                    variant="filled"
                    pos="absolute"
                    top={4}
                    right={4}
                    style={{ zIndex: 1 }}
                    aria-label="Remove from share"
                    onClick={() => handleRemoveImage(image.id)}
                  >
                    ✕
                  </ActionIcon>
                )}
                <AspectRatio ratio={1}>
                  <Image
                    src={imageFileUrl(image.id, 'thumb')}
                    alt={image.stem}
                    fit="cover"
                    radius="sm"
                  />
                </AspectRatio>
              </div>
            ))}
          </SimpleGrid>
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
      />
    </Stack>
  )
}

function TokenRow({ token, onRevoke }: { token: TokenDto; onRevoke: () => void }) {
  const revoked = token.revokedAt !== null
  return (
    <Group
      justify="space-between"
      wrap="wrap"
      style={{ opacity: revoked ? 0.5 : 1, textDecoration: revoked ? 'line-through' : undefined }}
    >
      <Group gap="xs" wrap="wrap">
        <Tooltip label={ROLE_DESCRIPTION[token.role]}>
          <Badge color={ROLE_COLOR[token.role]} variant="light">
            {ROLE_LABEL[token.role]}
          </Badge>
        </Tooltip>
        {token.label && (
          <Text size="sm" c="dimmed">
            {token.label}
          </Text>
        )}
        <Text size="sm" ff="monospace">
          {token.url}
        </Text>
        <Text size="xs" c="dimmed">
          created {token.createdAt}
          {revoked && ` · revoked ${token.revokedAt}`}
        </Text>
      </Group>
      <Group gap="xs">
        <CopyButton value={token.url}>
          {({ copied, copy }) => (
            <Button size="xs" variant="default" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          )}
        </CopyButton>
        {!revoked && (
          <Button size="xs" variant="subtle" color="red" onClick={onRevoke}>
            Revoke
          </Button>
        )}
      </Group>
    </Group>
  )
}

const SettingsFormSchema = z.object({
  note: z.string(),
  expiresAt: z.string(),
  minRating: z.union([z.number().int().min(0).max(5), z.literal('')]),
  recursive: z.boolean(),
})

type SettingsFormValues = z.infer<typeof SettingsFormSchema>

function ShareSettingsForm({ share }: { share: ShareDetailDto }) {
  const updateShare = useUpdateShare()
  const form = useBasaltForm<SettingsFormValues>({
    initialValues: {
      note: share.note ?? '',
      expiresAt: share.expiresAt ?? '',
      minRating: share.minRating ?? '',
      recursive: share.recursive,
    },
    schema: SettingsFormSchema,
    mode: 'controlled',
  })

  function handleSubmit(values: SettingsFormValues) {
    void notifyPromise(
      updateShare.mutateAsync({
        id: share.id,
        note: values.note === '' ? null : values.note,
        expiresAt: values.expiresAt === '' ? null : values.expiresAt,
        // Both are folder-only server-side (PATCH rejects `recursive` on a
        // selection share), so only send them for a folder share.
        ...(share.sourceType === 'folder'
          ? {
              // 0 is "no filter", same as the create modal — storing a literal
              // 0 would mean `rating >= 0`, which drops every unrated image.
              minRating:
                values.minRating === '' || values.minRating === 0 ? null : values.minRating,
              recursive: values.recursive,
            }
          : {}),
      }),
      { loading: 'Saving settings…', success: 'Settings saved', error: 'Could not save settings' },
    )
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
        {share.sourceType === 'folder' && (
          <>
            <NumberInput
              label="Minimum rating"
              placeholder="Any"
              description="Empty or 0 means no filter"
              min={0}
              max={5}
              {...field(form, 'minRating')}
            />
            <Checkbox
              label="Include subfolders"
              description="Off shares only the images directly in this folder"
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

import { Button, Modal, Select, Stack, TextInput } from '@mantine/core'
import { useState, type ReactNode } from 'react'
import { notifyMutation } from '../common'
import { useAddShareToken, type TokenDto, type TokenRole } from '../../lib/queries/shares'
import { ROLE_OPTIONS } from './token-role'

type Props = {
  shareId: number
  opened: boolean
  onClose: () => void
  /** Handed the minted token so the caller can highlight, scroll to and copy it. */
  onCreated?: (token: TokenDto) => void
}

/** Mints an additional token on an existing share with a chosen role + label. */
export function AddTokenModal({ shareId, opened, onClose, onCreated }: Props): ReactNode {
  const [role, setRole] = useState<TokenRole>('view')
  const [label, setLabel] = useState('')
  const addToken = useAddShareToken()

  function handleSubmit() {
    void notifyMutation(
      addToken.mutateAsync({ id: shareId, role, label: label === '' ? null : label }),
      { loading: 'Minting link…', success: 'Link added', error: 'Could not add link' },
    )
      .then((token) => {
        setRole('view')
        setLabel('')
        onClose()
        onCreated?.(token)
      })
      .catch(() => {
        /* the real server message is already on screen */
      })
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Add a link" size="sm">
      <Stack gap="sm">
        <Select
          label="Role"
          data={ROLE_OPTIONS}
          value={role}
          onChange={(v) => v && setRole(v as TokenRole)}
          allowDeselect={false}
        />
        <TextInput
          label="Who it is for"
          description="Optional label — shown only to you"
          placeholder="e.g. grandma"
          value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
        />
        <Button onClick={handleSubmit} loading={addToken.isPending}>
          Add link
        </Button>
      </Stack>
    </Modal>
  )
}

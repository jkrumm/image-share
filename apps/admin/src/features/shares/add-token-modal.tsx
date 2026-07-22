import { Button, Modal, Select, Stack, TextInput } from '@mantine/core'
import { useState } from 'react'
import { notifyPromise } from 'basalt-ui/notifications'
import { useAddShareToken, type TokenRole } from '../../lib/queries/shares'

type Props = {
  shareId: number
  opened: boolean
  onClose: () => void
}

const ROLE_OPTIONS: { value: TokenRole; label: string }[] = [
  { value: 'view', label: 'View — thumb/med only, no downloads' },
  { value: 'download', label: 'Download — + full size, original download, zip' },
  { value: 'full', label: 'Full — + paired RAW download' },
]

/** Mints an additional token on an existing share with a chosen role + label. */
export function AddTokenModal({ shareId, opened, onClose }: Props) {
  const [role, setRole] = useState<TokenRole>('view')
  const [label, setLabel] = useState('')
  const addToken = useAddShareToken()

  function handleSubmit() {
    void notifyPromise(
      addToken.mutateAsync({ id: shareId, role, label: label === '' ? null : label }),
      { loading: 'Minting token…', success: 'Token added', error: 'Could not add token' },
    )
      .then(() => {
        setRole('view')
        setLabel('')
        onClose()
      })
      .catch(() => {
        /* toast already shown by notifyPromise */
      })
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Add a token" size="sm">
      <Stack gap="sm">
        <Select
          label="Role"
          data={ROLE_OPTIONS}
          value={role}
          onChange={(v) => v && setRole(v as TokenRole)}
          allowDeselect={false}
        />
        <TextInput
          label="Label (optional)"
          placeholder="e.g. grandma"
          value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
        />
        <Button onClick={handleSubmit} loading={addToken.isPending}>
          Add token
        </Button>
      </Stack>
    </Modal>
  )
}

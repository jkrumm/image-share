import { notifications } from '@mantine/notifications'
import { add } from 'basalt-ui/notifications'
import type { ReactNode } from 'react'
import { toErrorMessage } from '../../lib/eden'

// basalt's notifyPromise takes a STATIC `error` ReactNode and never sees the
// rejection value, which is why every call site in this SPA showed 'Could not
// create share' and threw away what the server actually said ('slug already in
// use', 'recursive is rejected on a selection share', a 403 on a fuji delete).
// notifyMutation mirrors notifyPromise's show → update shape and records to the
// same basalt history store, but resolves the message from the thrown error.

let seq = 0
function nextId(): string {
  seq += 1
  return `mutation-${Date.now()}-${seq}`
}

export type NotifyMutationMessages = {
  loading: ReactNode
  success: ReactNode
  /** Only used when the server body carries no readable message. */
  error: string
}

/**
 * Loading toast → success, or → the REAL server message on failure. Re-throws,
 * so a `.catch` for local state (closing a modal, resetting a form) still runs.
 *
 * @example
 * await notifyMutation(createShare.mutateAsync(body), {
 *   loading: 'Creating share…',
 *   success: 'Share created',
 *   error: 'Could not create share',
 * })
 */
export function notifyMutation<T>(
  promise: Promise<T>,
  messages: NotifyMutationMessages,
): Promise<T> {
  const id = nextId()
  notifications.show({
    id,
    message: messages.loading,
    loading: true,
    autoClose: false,
    withCloseButton: false,
    role: 'status',
  })

  return promise.then(
    (result) => {
      notifications.update({
        id,
        message: messages.success,
        color: 'green',
        loading: false,
        autoClose: 2000,
        withCloseButton: true,
        role: 'status',
      })
      add({ id, intent: 'success', message: String(messages.success), createdAt: Date.now() })
      return result
    },
    (err: unknown) => {
      const message = toErrorMessage(err, messages.error)
      notifications.update({
        id,
        message,
        color: 'red',
        loading: false,
        autoClose: false,
        withCloseButton: true,
        role: 'alert',
      })
      add({ id, intent: 'error', message, createdAt: Date.now() })
      throw err
    },
  )
}

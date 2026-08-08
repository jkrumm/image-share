import { Center, Image, Text, type ImageProps, type MantineStyleProps } from '@mantine/core'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { refreshAssetToken, useAssetTokenValue } from '../../lib/asset-token'
import { imageFileUrl, type ImageFileSize } from '../../lib/eden'
import { FRESH_REMINT_STATE, onImageError, onImageLoad } from './image-recovery'

/**
 * Reactive image URL. Unlike the bare `imageFileUrl(id, size)`, this subscribes
 * to the asset-token store, so an already-painted `<img>` gets a fresh URL the
 * moment the token is re-minted instead of holding a dead one until the next
 * unrelated re-render.
 */
export function useImageFileUrl(id: number, size: ImageFileSize = 'thumb'): string {
  const token = useAssetTokenValue()
  return imageFileUrl(id, size, token)
}

export type LibraryImageProps = {
  id: number
  /** Byte-route size. `thumb` (480 webp) for grids, `full` (2560 jpeg) for the lightbox. */
  size?: ImageFileSize
  alt?: string
  fit?: CSSProperties['objectFit']
  radius?: ImageProps['radius']
  loading?: 'lazy' | 'eager'
  onClick?: () => void
  className?: string
  style?: CSSProperties
} & Pick<MantineStyleProps, 'h' | 'w' | 'mah' | 'maw'>

/**
 * The one way to render library bytes. Handles the whole asset-token lifecycle
 * so no page has to:
 *
 *  - rebuilds its URL when the token is re-minted (reactive store subscription)
 *  - on a load failure, forces ONE re-mint per failure episode (debounced
 *    globally to a single request even when a 60-image grid fails at once) —
 *    this is the only recovery path for an expired token, which never reaches
 *    TanStack Query's error handling because it fails inside the browser's
 *    image loader
 *  - if it still fails with the fresh token, gives up and shows a placeholder
 *    instead of spending a second, useless re-mint
 *  - re-arms on a successful load, so an hour later the next expiry recovers too
 *
 * The policy itself lives in ./image-recovery, where it is unit-tested as the
 * sequence it is.
 */
export function LibraryImage({
  id,
  size = 'thumb',
  alt = '',
  fit = 'cover',
  radius,
  loading = 'lazy',
  onClick,
  className,
  style,
  ...dimensions
}: LibraryImageProps): ReactNode {
  const token = useAssetTokenValue()
  const [broken, setBroken] = useState(false)
  // Whether this image already spent its one re-mint. Keyed on the IMAGE and
  // re-armed by a successful load — see ./image-recovery for why keying it on
  // the token value made the placeholder below unreachable.
  const remint = useRef(FRESH_REMINT_STATE)

  useEffect(() => {
    remint.current = FRESH_REMINT_STATE
  }, [id, size])

  useEffect(() => {
    setBroken(false)
  }, [token, id, size])

  const handleError = (): void => {
    const { action, next } = onImageError(remint.current, token)
    remint.current = next
    if (action === 'remint') {
      refreshAssetToken()
      return
    }
    setBroken(true)
  }

  const handleLoad = (): void => {
    remint.current = onImageLoad()
  }

  if (broken) {
    return (
      <Center className={className} style={style} {...dimensions}>
        <Text size="xs" c="dimmed">
          Unavailable
        </Text>
      </Center>
    )
  }

  return (
    <Image
      src={imageFileUrl(id, size, token)}
      alt={alt}
      loading={loading}
      onError={handleError}
      onLoad={handleLoad}
      onClick={onClick}
      className={className}
      style={{ objectFit: fit, ...style }}
      {...(radius !== undefined && { radius })}
      {...dimensions}
    />
  )
}

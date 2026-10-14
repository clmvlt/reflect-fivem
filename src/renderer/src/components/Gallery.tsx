import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { num } from '../lib/format'

/** Lecteur YouTube sans cookies, lancé tout de suite (il n'est chargé qu'au clic sur « lecture »). */
const embedUrl = (id: string): string => `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0`

type Item = { kind: 'image'; key: string; index: number } | { kind: 'video'; id: string }

/**
 * Images d'un pack et, s'il y en a une, sa vidéo YouTube, juste après la couverture (comme sur le site). Avant le clic
 * sur « lecture », on affiche la couverture assombrie : YouTube n'est contacté qu'à ce moment-là.
 */
export function Gallery({
  images,
  youtubeId,
  image,
  thumb,
  empty,
  actions
}: {
  /** Clés des images, couverture en premier. */
  images: string[]
  youtubeId?: string | null
  /** Image affichée en grand. */
  image: (key: string) => ReactNode
  /** Adresse de la vignette d'une image. */
  thumb: (key: string) => string
  /** Cadre d'un pack sans image ni vidéo. */
  empty: ReactNode
  /** Sous la galerie, selon l'image affichée (null pendant la vidéo). */
  actions?: (key: string | null) => ReactNode
}) {
  const { t } = useTranslation()
  const [shown, setShown] = useState(0)
  const [playing, setPlaying] = useState(false)
  const items: Item[] = images.map((key, index) => ({ kind: 'image', key, index }))
  if (youtubeId) items.splice(Math.min(1, items.length), 0, { kind: 'video', id: youtubeId })
  const at = Math.min(shown, items.length - 1)
  const current = items[at] as Item | undefined

  const select = (i: number): void => {
    setShown(i)
    setPlaying(false)
  }

  return (
    <div className="media">
      <div className="viewer">
        {!current ? (
          empty
        ) : current.kind === 'image' ? (
          image(current.key)
        ) : playing ? (
          <iframe
            src={embedUrl(current.id)}
            title={t('gallery.videoTitle')}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <button className="video-facade" onClick={() => setPlaying(true)} aria-label={t('gallery.play')}>
            {images[0] && image(images[0])}
            <span className="video-play" aria-hidden="true">
              <PlayIcon size={26} />
            </span>
            <span className="video-note">{t('gallery.youtube')}</span>
          </button>
        )}
      </div>
      {items.length > 1 && (
        <div className="thumbs">
          {items.map((item, i) =>
            item.kind === 'image' ? (
              <button key={item.key} className={`thumb ${i === at ? 'is-selected' : ''}`} onClick={() => select(i)} aria-label={t('gallery.image', { n: num(item.index + 1) })}>
                <img src={thumb(item.key)} alt="" draggable={false} />
              </button>
            ) : (
              <button key="video" className={`thumb thumb-video ${i === at ? 'is-selected' : ''}`} onClick={() => select(i)} aria-label={t('gallery.video')}>
                <PlayIcon size={14} />
                <span>{t('gallery.video')}</span>
              </button>
            )
          )}
        </div>
      )}
      {actions?.(current?.kind === 'image' ? current.key : null)}
    </div>
  )
}

function PlayIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11.14-6.86a1 1 0 0 0 0-1.72L9.5 4.28A1 1 0 0 0 8 5.14Z" />
    </svg>
  )
}

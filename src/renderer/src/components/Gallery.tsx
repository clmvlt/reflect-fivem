import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { num } from '../lib/format'

const YOUTUBE = 'https://www.youtube-nocookie.com'

/** Lecteur YouTube sans cookies, lancé tout de suite (il n'est chargé qu'au clic sur « lecture »). */
const embedUrl = (id: string): string => `${YOUTUBE}/embed/${encodeURIComponent(id)}?autoplay=1&rel=0`

/**
 * Lecteur de l'aperçu d'une carte : sans le son (lecture automatique permise), sans clavier, et qui dit à la page où en
 * est la vidéo (enablejsapi). Pas de boucle : elle ajouterait les boutons « précédente » et « suivante » au milieu.
 */
const previewUrl = (id: string): string =>
  `${YOUTUBE}/embed/${encodeURIComponent(id)}?autoplay=1&mute=1&controls=0&disablekb=1&fs=0&iv_load_policy=3&rel=0&playsinline=1&enablejsapi=1`

/** Survol d'une carte avant que sa vidéo ne se lance. */
const PREVIEW_DELAY = 1000

/**
 * Aperçu vidéo d'une carte : la vidéo à lancer (null tant que la souris n'est pas restée PREVIEW_DELAY ms sur la carte)
 * et les événements à poser sur la carte. Rien sans vidéo, ni quand Windows demande moins d'animations.
 */
export function useVideoPreview(youtubeId: string | null): [string | null, { onMouseEnter: () => void; onMouseLeave: () => void }] {
  const [active, setActive] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const onMouseEnter = (): void => {
    if (!youtubeId || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setActive(true), PREVIEW_DELAY)
  }
  const onMouseLeave = (): void => {
    window.clearTimeout(timer.current)
    setActive(false)
  }
  return [active ? youtubeId : null, { onMouseEnter, onMouseLeave }]
}

/** Message du lecteur YouTube (texte JSON), null s'il n'en est pas un. */
function playerMessage(data: unknown): { event?: string; info?: unknown } | null {
  try {
    const m: unknown = typeof data === 'string' ? JSON.parse(data) : data
    return m && typeof m === 'object' ? m : null
  } catch {
    return null
  }
}

/**
 * Vidéo posée sur la couverture d'une carte, montrée seulement pendant la lecture : avant (chargement, vidéo
 * introuvable ou refusée par YouTube) et après la fin, la couverture reste visible. Les clics passent à travers,
 * jusqu'à la carte.
 */
export function CoverVideo({ id }: { id: string }) {
  const { t } = useTranslation()
  const frame = useRef<HTMLIFrameElement>(null)
  const listen = useRef(0)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (e.origin !== YOUTUBE || e.source !== frame.current?.contentWindow) return
      window.clearInterval(listen.current)
      // État du lecteur (initialDelivery, puis infoDelivery à chaque changement) ; 1 : lecture en cours, 0 : terminée.
      const info = playerMessage(e.data)?.info as { playerState?: unknown } | null | undefined
      const state = typeof info === 'object' ? info?.playerState : undefined
      if (state === 1 || state === 0) setPlaying(state === 1)
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      window.clearInterval(listen.current)
    }
  }, [])

  // Le lecteur n'envoie son état qu'à une page qui l'écoute : on le lui dit jusqu'à sa première réponse.
  const onLoad = (): void => {
    const hello = (): void => frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), YOUTUBE)
    hello()
    window.clearInterval(listen.current)
    listen.current = window.setInterval(hello, 250)
  }

  return (
    <iframe
      ref={frame}
      className={`cover-video ${playing ? 'is-playing' : ''}`}
      src={previewUrl(id)}
      title={t('gallery.videoTitle')}
      allow="autoplay; encrypted-media"
      referrerPolicy="strict-origin-when-cross-origin"
      tabIndex={-1}
      aria-hidden="true"
      onLoad={onLoad}
    />
  )
}

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

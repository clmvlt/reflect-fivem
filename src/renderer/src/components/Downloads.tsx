import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { DownloadItem, DownloadKind } from '@shared/types'
import { useStore } from '../store'
import { bytes, marketImageUrl, num } from '../lib/format'

/** Téléchargement en cours ou en file d'attente de cette fiche de la Marketplace (ou de cette création), null sinon. */
export function useDownload(id: string | null | undefined): DownloadItem | null {
  const { downloads } = useStore()
  return (id && downloads.find((d) => d.id === id)) || null
}

/** Pourcentage, null tant que la durée est inconnue. */
function percent(d: DownloadItem): number | null {
  return d.total > 0 ? Math.min(100, Math.floor((d.current / d.total) * 100)) : null
}

/** File d'attente, attente d'une autre opération, ou étape en cours. */
function statusText(d: DownloadItem, t: TFunction): string {
  if (d.status === 'queued') return t('downloads.status.queued')
  if (d.status === 'waiting') return t('downloads.status.waiting')
  if (d.phase) return d.phase
  return t(d.status === 'installing' ? 'downloads.status.installing' : 'downloads.status.starting')
}

/** Temps restant au débit actuel (null s'il n'est pas connu). */
function remaining(d: DownloadItem, t: TFunction): string | null {
  if (!d.bytes || d.speed <= 0 || d.current >= d.total) return null
  const s = Math.ceil((d.total - d.current) / d.speed)
  if (s < 60) return t('downloads.etaSeconds', { n: num(s) })
  if (s < 3600) return t('downloads.etaMinutes', { n: num(Math.ceil(s / 60)) })
  return t('downloads.etaHours', { h: num(Math.floor(s / 3600)), m: num(Math.floor((s % 3600) / 60)) })
}

/** Taille téléchargée, débit et temps restant ; sinon l'étape en cours. */
function detailText(d: DownloadItem, t: TFunction): string {
  if (d.status !== 'downloading' || !d.bytes) return statusText(d, t)
  return [t('downloads.size', { done: bytes(d.current), total: bytes(d.total) }), d.speed > 0 && t('downloads.speed', { value: bytes(d.speed) }), remaining(d, t)]
    .filter(Boolean)
    .join(' · ')
}

function Track({ d }: { d: DownloadItem }) {
  const pct = d.status === 'queued' ? 0 : percent(d)
  return (
    <span className="track">
      <span className={`fill ${pct === null ? 'is-waiting' : ''}`} style={pct === null ? undefined : { width: `${pct}%` }} />
    </span>
  )
}

/** Vignette : image de la fiche, ou celle d'un composant ou d'un style pour une création de « Créer ton pack ». */
function thumbUrl(d: DownloadItem): string | null {
  if (d.kind === 'build') return d.coverUrl ?? null
  return d.coverId ? marketImageUrl(d.id, d.coverId, true, d.kind) : null
}

function Thumb({ d, size }: { d: DownloadItem; size: number }) {
  const [failed, setFailed] = useState(false)
  const src = thumbUrl(d)
  return (
    <span className="dl-thumb" style={{ width: size, height: size }} aria-hidden>
      {src && !failed ? (
        <img src={src} alt="" draggable={false} onError={() => setFailed(true)} />
      ) : (
        <svg width={size / 2} height={size / 2} viewBox="0 0 16 16" fill="currentColor">
          <path d="M7.25 1.5h1.5v7.19l2.47-2.47 1.06 1.06L8 11.56 3.72 7.28l1.06-1.06 2.47 2.47z" />
          <path d="M2 13h12v1.5H2z" />
        </svg>
      )}
    </span>
  )
}

/** Annuler (téléchargement en cours) ou retirer de la file ; absent pendant l'ajout à la bibliothèque. */
function CancelButton({ d }: { d: DownloadItem }) {
  const { t } = useTranslation()
  const { run } = useStore()
  if (d.status === 'installing') return null
  const label = d.status === 'queued' ? t('downloads.remove') : t('downloads.cancel')
  return (
    <button
      className="close dl-cancel"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        void run(() => window.api.downloadCancel(d.id))
      }}
    >
      ×
    </button>
  )
}

/** Progression d'un téléchargement à la place du bouton Télécharger (cartes et fiches). */
export function DownloadInline({ d }: { d: DownloadItem }) {
  const { t } = useTranslation()
  const pct = percent(d)
  return (
    <div className="dl-inline" title={detailText(d, t)}>
      {d.status === 'queued' ? (
        <>
          <span className="state">{t('downloads.status.queued')}</span>
          <div className="spacer" />
        </>
      ) : (
        <>
          <Track d={d} />
          <span className="pct">{pct === null ? '' : t('progress.percent', { value: num(pct) })}</span>
        </>
      )}
      <CancelButton d={d} />
    </div>
  )
}

/**
 * Bande en bas de la fenêtre pendant les téléchargements : celui en cours (progression, taille, débit, temps restant)
 * et la file d'attente. Un clic ouvre la fiche du pack (ou la création).
 */
export function DownloadBar({ onOpen }: { onOpen: (id: string, kind: DownloadKind) => void }) {
  const { t } = useTranslation()
  const { downloads } = useStore()
  const [queueOpen, setQueueOpen] = useState(false)
  const queueRef = useRef<HTMLDivElement>(null)
  const [current, ...queue] = downloads

  // File vidée : la liste se referme ; clic ailleurs ou Échap aussi.
  useEffect(() => {
    if (!queue.length) setQueueOpen(false)
  }, [queue.length])
  useEffect(() => {
    if (!queueOpen) return
    const onDown = (e: MouseEvent): void => {
      if (queueRef.current && !queueRef.current.contains(e.target as Node)) setQueueOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setQueueOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [queueOpen])

  if (!current) return null
  const pct = percent(current)
  const open = (d: DownloadItem): void => {
    setQueueOpen(false)
    onOpen(d.id, d.kind)
  }
  return (
    <section className="dl-bar" aria-label={t('downloads.bar')}>
      <button className="dl-main" onClick={() => open(current)} title={t('downloads.openPage')}>
        <Thumb d={current} size={40} />
        <span className="dl-info">
          <span className="dl-top">
            <span className="dl-name ellipsis">{current.name}</span>
            <span className="pct">{pct === null || current.status === 'queued' ? '' : t('progress.percent', { value: num(pct) })}</span>
          </span>
          <Track d={current} />
          <span className="dl-detail ellipsis">{detailText(current, t)}</span>
        </span>
      </button>
      {queue.length > 0 && (
        <div className="dl-queue" ref={queueRef}>
          <button className={`dl-queue-btn ${queueOpen ? 'is-open' : ''}`} aria-expanded={queueOpen} onClick={() => setQueueOpen((o) => !o)}>
            <span className="dl-stack" aria-hidden>
              {queue.slice(0, 3).map((d) => (
                <Thumb key={d.id} d={d} size={22} />
              ))}
            </span>
            <span className="dl-queue-count">{t('downloads.queue', { count: queue.length })}</span>
            <svg className="dl-chevron" width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M8 4.5 14.5 11l-1.06 1.06L8 6.62l-5.44 5.44L1.5 11z" />
            </svg>
          </button>
          {queueOpen && (
            <div className="dl-pop" role="list" aria-label={t('downloads.queueTitle')}>
              <div className="dl-pop-title">{t('downloads.next')}</div>
              {queue.map((d, i) => (
                <div key={d.id} className="dl-pop-item" role="listitem">
                  <button className="dl-pop-open" onClick={() => open(d)} title={t('downloads.openPage')}>
                    <span className="dl-pos">{num(i + 1)}</span>
                    <Thumb d={d} size={32} />
                    <span className="dl-name ellipsis">{d.name}</span>
                  </button>
                  <CancelButton d={d} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <CancelButton d={current} />
    </section>
  )
}

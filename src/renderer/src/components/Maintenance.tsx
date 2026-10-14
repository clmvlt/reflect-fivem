import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { t } from 'i18next'
import {
  clockText,
  countdown,
  msUntil,
  nextBoundary,
  nextMaintenance,
  ongoingMaintenance,
  SOON_BEFORE,
  type Maintenance,
  type MaintenanceState,
  type Ongoing
} from '@shared/maintenance'
import { formatDate, formatDateTime, formatList } from '@shared/intl'
import { useStore } from '../store'
import { q } from '../lib/format'
import { DiscordIcon } from './DiscordView'

// Maintenances prévues par l'admin (état envoyé par le processus principal, voir @shared/maintenance) :
//  - annonce en haut de l'application dans les 7 jours qui précèdent, avec un compte à rebours dans la dernière heure ;
//  - pendant la maintenance, écran de maintenance à la place des pages qui passent par le serveur (Marketplace,
//    compte) et bandeau sur les autres : la bibliothèque reste utilisable ;
//  - l'admin connecté n'est pas bloqué : un petit bandeau le rappelle seulement.

export interface MaintenanceInfo {
  state: MaintenanceState | null
  ongoing: Ongoing | null
  /** Prochaine maintenance annoncée (dans moins de 7 jours). */
  next: Maintenance | null
  admin: boolean
  /** Pages qui passent par le serveur remplacées par l'écran de maintenance. */
  blocked: boolean
}

/** État des maintenances, recalculé à chaque changement d'affichage (annonce, dernière heure, début, fin). */
export function useMaintenance(): MaintenanceInfo {
  const { maintenance, account } = useStore()
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!maintenance) return
    const at = nextBoundary(maintenance)
    if (at === null) return
    // setTimeout ne dépasse pas 24,8 jours.
    const timer = window.setTimeout(() => setTick((n) => n + 1), Math.min(Math.max(0, at - Date.now()) + 50, 2 ** 31 - 1))
    return () => window.clearTimeout(timer)
  }, [maintenance, tick])
  const ongoing = maintenance ? ongoingMaintenance(maintenance) : null
  const admin = !!account?.admin
  return { state: maintenance, ongoing, next: maintenance && !ongoing ? nextMaintenance(maintenance) : null, admin, blocked: !!ongoing && !admin }
}

/** Heure du poste rafraîchie chaque seconde (comptes à rebours). */
function useNow(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()
const DAY: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' }
const TIME: Intl.DateTimeFormatOptions = { timeStyle: 'short' }

/** « le mardi 20 octobre de 22:00 à 23:30 », ou « du … à 22:00 au … à 02:00 » sur deux jours (heure locale). */
export function rangeText(m: Maintenance): string {
  const start = new Date(m.startsAt)
  const end = new Date(m.endsAt)
  if (sameDay(start, end)) return t('maintenance.range.sameDay', { date: formatDate(start, DAY), start: formatDateTime(start, TIME), end: formatDateTime(end, TIME) })
  return t('maintenance.range.days', { start: formatDateTime(start, { ...DAY, hour: '2-digit', minute: '2-digit' }), end: formatDateTime(end, { ...DAY, hour: '2-digit', minute: '2-digit' }) })
}

/** Fin prévue à l'heure locale : l'heure seule si c'est aujourd'hui, sinon avec le jour. */
function endText(m: Maintenance): string {
  const end = new Date(m.endsAt)
  return sameDay(end, new Date()) ? formatDateTime(end, TIME) : formatDateTime(end, { ...DAY, hour: '2-digit', minute: '2-digit' })
}

/** « 01:05:09 », ou « 2 j 01:05:09 » au-delà d'un jour. */
function countdownText(ms: number): string {
  const c = countdown(ms)
  return c.days ? t('maintenance.countdown.days', { days: c.days, clock: clockText(c) }) : clockText(c)
}

/** Message de l'admin (texte libre, non traduit). */
function AdminMessage({ m }: { m: Maintenance }) {
  if (!m.message) return null
  return <p className="maint-message">{m.message}</p>
}

/** Téléchargements arrêtés par la maintenance, repris tout seuls à la fin. */
function PausedDownloads() {
  const { t } = useTranslation()
  const { overview } = useStore()
  const paused = overview?.pausedDownloads ?? []
  if (!paused.length) return null
  return <p className="maint-paused">{t('maintenance.paused', { count: paused.length, names: formatList(paused.map((d) => q(d.name))) })}</p>
}

// ------------------------------------------------------------------ bandeau

const DISMISSED_KEY = 'maintenance-dismissed'

function readDismissed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * Bandeau en haut de l'application : annonce d'une maintenance (fermée, elle revient avec un compte à rebours dans la
 * dernière heure), maintenance en cours sur les pages qui restent utilisables, ou rappel pour l'admin.
 * `screen` : la page affiche déjà l'écran de maintenance.
 */
export function MaintenanceBanner({ info, screen }: { info: MaintenanceInfo; screen: boolean }) {
  const { t } = useTranslation()
  const [dismissed, setDismissed] = useState(readDismissed)
  const { ongoing, next, admin, state } = info

  if (ongoing) {
    if (admin)
      return (
        <div className="bar maint-bar is-admin" role="status">
          <span className="bar-text">{t('maintenance.admin', { end: endText(ongoing.maintenance) })}</span>
        </div>
      )
    if (screen) return null
    return (
      <div className="bar bar-warning maint-bar" role="status">
        <div className="bar-text">
          <span>{ongoing.overdue ? t('maintenance.bannerOverdue') : t('maintenance.banner', { end: endText(ongoing.maintenance) })}</span>
          <PausedDownloads />
        </div>
      </div>
    )
  }
  if (!next || !state) return null
  // Clé de l'annonce : une maintenance déplacée par l'admin est annoncée de nouveau ; la dernière heure aussi.
  return <Announcement m={next} state={state} dismissed={dismissed} onDismiss={(key) => setDismissed(dismiss(key))} />
}

function dismiss(key: string): string[] {
  const next = [...readDismissed().filter((k) => k !== key), key].slice(-50)
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
  } catch {
    /* stockage indisponible : fermé pour cette session */
  }
  return next
}

function Announcement({ m, state, dismissed, onDismiss }: { m: Maintenance; state: MaintenanceState; dismissed: string[]; onDismiss: (key: string) => void }) {
  const { t } = useTranslation()
  const soon = msUntil(m.startsAt, state) <= SOON_BEFORE
  const key = `${m.id}@${m.startsAt}${soon ? ':soon' : ''}`
  if (dismissed.includes(key)) return null
  return (
    <div className={`bar maint-bar ${soon ? 'bar-warning' : ''}`} role="status">
      <div className="bar-text">
        {soon ? <SoonTitle m={m} state={state} /> : <strong>{t('maintenance.announceTitle')}</strong>}
        <span>{t('maintenance.announce', { range: rangeText(m) })}</span>
        <AdminMessage m={m} />
      </div>
      <button className="close" onClick={() => onDismiss(key)} aria-label={t('common.close')} title={t('common.close')}>
        ×
      </button>
    </div>
  )
}

function SoonTitle({ m, state }: { m: Maintenance; state: MaintenanceState }) {
  const { t } = useTranslation()
  const now = useNow()
  return (
    <strong>
      {t('maintenance.soonTitle')} <span className="maint-clock">{countdownText(msUntil(m.startsAt, state, now))}</span>
    </strong>
  )
}

// ------------------------------------------------------------------ écran

/** Écran de maintenance, à la place d'une page qui passe par le serveur. Disparaît tout seul à la fin. */
export function MaintenanceScreen({ ongoing, state }: { ongoing: Ongoing; state: MaintenanceState }) {
  const { t } = useTranslation()
  const { checkMaintenance, links, openLink } = useStore()
  const [checking, setChecking] = useState(false)
  const now = useNow()
  const m = ongoing.maintenance
  const retry = async (): Promise<void> => {
    setChecking(true)
    try {
      await checkMaintenance()
    } finally {
      setChecking(false)
    }
  }
  return (
    <div className="page maint-page">
      <div className="maint-screen" role="status" aria-live="polite">
        <div className="empty-icon" aria-hidden>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />
          </svg>
        </div>
        <h1 className="maint-title">{t('maintenance.screen.title')}</h1>
        {ongoing.overdue ? (
          <p className="empty-text">{t('maintenance.screen.overdue')}</p>
        ) : (
          <>
            <p className="empty-text">{t('maintenance.screen.until', { end: endText(m) })}</p>
            <div className="maint-countdown" aria-label={t('maintenance.screen.remaining')}>
              {countdownText(msUntil(m.endsAt, state, now))}
            </div>
          </>
        )}
        <AdminMessage m={m} />
        <p className="empty-text">{t('maintenance.screen.local')}</p>
        <PausedDownloads />
        <div className="empty-actions">
          <button className="primary" onClick={() => void retry()} disabled={checking}>
            {checking ? t('maintenance.screen.checking') : t('common.retry')}
          </button>
          {/* Avancement de la maintenance annoncé sur le serveur Discord. */}
          {links.discord && (
            <button className="maint-discord" onClick={() => openLink('discord')}>
              <DiscordIcon size={14} />
              {t('maintenance.screen.discord')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

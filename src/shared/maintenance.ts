// Maintenances prévues par l'admin (GET /maintenance de l'API) : types et calculs communs au processus principal et à
// l'interface. Aucune dépendance (testé avec vitest).
//
// Les dates de l'API sont en UTC (ISO 8601) et affichées à l'heure locale. Les comparaisons avec « maintenant » se font
// à l'heure du serveur (serverTime de GET /maintenance) : une horloge du poste en avance ou en retard ne décale ni
// l'annonce, ni le compte à rebours, ni le début ou la fin de l'écran de maintenance.

export interface Maintenance {
  id: string
  startsAt: string
  endsAt: string
  /** Texte libre de l'admin, non traduit (vide si aucun). */
  message: string
  status: 'upcoming' | 'active' | 'finished'
  createdAt: string | null
  updatedAt: string | null
}

/** État connu des maintenances, partagé par le processus principal et l'interface (gardé aussi sur le disque). */
export interface MaintenanceState {
  /** Heure du serveur moins heure du poste (ms), mesurée à la dernière réponse de GET /maintenance. */
  clockOffset: number
  /**
   * Maintenance en cours confirmée par l'API : `active` de GET /maintenance, ou celle d'une réponse 503 « maintenance ».
   * Gardée jusqu'à ce que GET /maintenance réponde qu'aucune n'est en cours.
   */
  active: Maintenance | null
  /** Maintenances à venir, la plus proche d'abord. */
  upcoming: Maintenance[]
  /** Dernière confirmation de `active` par l'API, à l'heure du serveur (ISO), null sans maintenance confirmée. */
  confirmedAt: string | null
  /** Dernière réponse de GET /maintenance, à l'heure du serveur (ISO). */
  checkedAt: string | null
  /** Le dernier essai de GET /maintenance n'a pas abouti (hors ligne, serveur injoignable) : plages connues seulement. */
  offline: boolean
}

export const emptyMaintenanceState = (): MaintenanceState => ({ clockOffset: 0, active: null, upcoming: [], confirmedAt: null, checkedAt: null, offline: false })

/** Annonce affichée quand une maintenance commence dans moins de 7 jours. */
export const ANNOUNCE_BEFORE = 7 * 24 * 3_600_000
/** Dernière heure avant le début : compte à rebours, vérifications rapprochées. */
export const SOON_BEFORE = 3_600_000
/** Notification Windows avant le début. */
export const NOTIFY_BEFORE = 15 * 60_000
/** GET /maintenance : toutes les 5 minutes, toutes les 30 secondes dans la dernière heure et pendant une maintenance. */
export const CHECK_EVERY = 5 * 60_000
export const CHECK_EVERY_SOON = 30_000

const time = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN)

/** Maintenance reçue de l'API (dans GET /maintenance ou dans une réponse 503) ; null si elle est inutilisable. */
export function parseMaintenance(raw: unknown): Maintenance | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
  const id = str(r.id)
  const startsAt = str(r.startsAt)
  const endsAt = str(r.endsAt)
  if (!id || !startsAt || !endsAt || !Number.isFinite(time(startsAt)) || !Number.isFinite(time(endsAt))) return null
  const status = r.status === 'active' || r.status === 'finished' ? r.status : 'upcoming'
  return { id, startsAt, endsAt, message: typeof r.message === 'string' ? r.message.trim() : '', status, createdAt: str(r.createdAt), updatedAt: str(r.updatedAt) }
}

/**
 * Réponse de GET /maintenance. `sentAt` et `receivedAt` : heure du poste à l'envoi et à la réception ; l'heure du
 * serveur est comparée au milieu de l'aller-retour. Null si la réponse est inutilisable.
 */
export function parseMaintenanceStatus(raw: unknown, sentAt: number, receivedAt: number): Pick<MaintenanceState, 'clockOffset' | 'active' | 'upcoming' | 'checkedAt'> | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { serverTime?: unknown; active?: unknown; upcoming?: unknown }
  const serverTime = typeof r.serverTime === 'string' ? time(r.serverTime) : NaN
  if (!Number.isFinite(serverTime)) return null
  const upcoming = (Array.isArray(r.upcoming) ? r.upcoming : [])
    .map(parseMaintenance)
    .filter((m): m is Maintenance => !!m)
    .sort((a, b) => time(a.startsAt) - time(b.startsAt))
  return {
    clockOffset: Math.round(serverTime - (sentAt + receivedAt) / 2),
    active: parseMaintenance(r.active),
    upcoming,
    checkedAt: new Date(serverTime).toISOString()
  }
}

/** Heure du serveur (ms) d'après l'horloge du poste corrigée. */
export function serverNow(state: Pick<MaintenanceState, 'clockOffset'>, now = Date.now()): number {
  return now + state.clockOffset
}

export interface Ongoing {
  maintenance: Maintenance
  /** Fin prévue dépassée alors que l'API refuse encore les requêtes : « prend plus de temps que prévu ». */
  overdue: boolean
}

/**
 * Maintenance en cours, ou null :
 *  - confirmée par l'API, jusqu'à sa fin prévue, et au-delà tant que l'API la confirme après cette fin ;
 *  - sinon une plage connue qui contient l'heure du serveur (serveur injoignable, ou commencée depuis la dernière
 *    réponse).
 */
export function ongoingMaintenance(state: MaintenanceState, now = Date.now()): Ongoing | null {
  const t = serverNow(state, now)
  const confirmed = state.active
  if (confirmed) {
    const end = time(confirmed.endsAt)
    if (t < end) return { maintenance: confirmed, overdue: false }
    if (time(state.confirmedAt) >= end) return { maintenance: confirmed, overdue: true }
  }
  const known = state.upcoming.find((m) => time(m.startsAt) <= t && t < time(m.endsAt))
  return known ? { maintenance: known, overdue: false } : null
}

/** Prochaine maintenance à annoncer (début dans moins de 7 jours), hors maintenance en cours. */
export function nextMaintenance(state: MaintenanceState, now = Date.now()): Maintenance | null {
  const t = serverNow(state, now)
  return state.upcoming.find((m) => time(m.startsAt) > t && time(m.startsAt) - t <= ANNOUNCE_BEFORE) ?? null
}

/** Temps restant (ms, 0 au plus bas) avant une date de l'API, à l'heure du serveur. */
export function msUntil(iso: string, state: Pick<MaintenanceState, 'clockOffset'>, now = Date.now()): number {
  return Math.max(0, time(iso) - serverNow(state, now))
}

export interface Countdown {
  days: number
  hours: number
  minutes: number
  seconds: number
}

/** Compte à rebours (arrondi à la seconde supérieure : jamais « 0 s » avant l'heure). */
export function countdown(ms: number): Countdown {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return { days: Math.floor(total / 86400), hours: Math.floor((total % 86400) / 3600), minutes: Math.floor((total % 3600) / 60), seconds: total % 60 }
}

/** « 01:05:09 » (heures, minutes, secondes ; les jours sont affichés à part). */
export function clockText(c: Countdown): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(c.hours)}:${two(c.minutes)}:${two(c.seconds)}`
}

/**
 * Prochain instant (heure du poste, ms) où l'affichage change : annonce à 7 jours, compte à rebours à 1 heure, début et
 * fin d'une maintenance. Null s'il n'y en a aucun.
 */
export function nextBoundary(state: MaintenanceState, now = Date.now()): number | null {
  const t = serverNow(state, now)
  let next = Infinity
  for (const m of [state.active, ...state.upcoming]) {
    if (!m) continue
    const start = time(m.startsAt)
    for (const b of [start - ANNOUNCE_BEFORE, start - SOON_BEFORE, start, time(m.endsAt)]) if (b > t && b < next) next = b
  }
  return Number.isFinite(next) ? next - state.clockOffset : null
}

/**
 * Délai avant la prochaine vérification (GET /maintenance) : 30 s pendant une maintenance ou dans l'heure qui précède,
 * 5 min sinon, et juste après le début de la dernière heure, le prochain début ou la prochaine fin.
 */
export function nextCheckDelay(state: MaintenanceState, now = Date.now()): number {
  const t = serverNow(state, now)
  const soon = !!ongoingMaintenance(state, now) || state.upcoming.some((m) => time(m.startsAt) - t <= SOON_BEFORE)
  let delay = soon ? CHECK_EVERY_SOON : CHECK_EVERY
  for (const m of [state.active, ...state.upcoming]) {
    if (!m) continue
    const start = time(m.startsAt)
    for (const b of [start - SOON_BEFORE, start, time(m.endsAt)]) if (b > t) delay = Math.min(delay, b - t + 1000)
  }
  return Math.max(1000, delay)
}

// Maintenances prévues par l'admin : état suivi par le processus principal et envoyé à l'interface.
//
// GET /maintenance (jamais refusé, même pendant une maintenance) au démarrage, puis toutes les 5 minutes, toutes les
// 30 secondes pendant une maintenance ou dans l'heure qui précède, juste après chaque début ou fin prévus, et dès
// qu'une requête est refusée pour maintenance (MaintenanceError, voir http.ts). La réponse corrige l'horloge du poste
// (serverTime) et la dernière connue est gardée sur le disque : serveur injoignable pendant une plage connue, c'est
// l'écran de maintenance qui s'affiche, pas le mode hors ligne.
//
// Les téléchargements interrompus par une maintenance sont mis en pause (PausedDownloads) et repris à sa fin.
//
// Aucune dépendance à Electron ici (testé avec vitest).

import type { MarketKind } from '@shared/types'
import {
  emptyMaintenanceState,
  NOTIFY_BEFORE,
  nextCheckDelay,
  ongoingMaintenance,
  parseMaintenanceStatus,
  serverNow,
  type Maintenance,
  type MaintenanceState,
  type Ongoing
} from '@shared/maintenance'
import { ApiError, MaintenanceError, type Fetch } from './http'
import { readJson, writeJsonAtomic } from '../util/fsx'
import { log } from '../util/log'

/** Pas deux vérifications à moins de 5 secondes d'intervalle à cause de requêtes refusées en rafale. */
const REPORT_DEBOUNCE = 5000
const CHECK_TIMEOUT = 10_000

interface SavedState extends MaintenanceState {
  /** Maintenances déjà annoncées par une notification de Windows. */
  notified?: string[]
}

export interface MaintenanceDeps {
  apiUrl: string
  /** fetch de l'API (GET /maintenance n'est jamais refusé pour maintenance). */
  fetch: Fetch
  /** Dernier état connu, pour le prochain démarrage (maintenance.json). */
  file: string
  /** État changé : envoyé à l'interface. */
  onChange: (state: MaintenanceState) => void
  /** Notification de Windows avant le début d'une maintenance. */
  notify?: (m: Maintenance) => void
  now?: () => number
}

export class MaintenanceWatch {
  private state: MaintenanceState = emptyMaintenanceState()
  private notified = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private checking: Promise<MaintenanceState> | null = null
  private lastCheck = 0
  private wasOngoing = false
  private started = false
  private overListeners = new Set<() => void>()
  private saving: Promise<void> = Promise.resolve()

  constructor(private deps: MaintenanceDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  get current(): MaintenanceState {
    return this.state
  }

  /** Maintenance en cours (confirmée par l'API, ou plage connue), à cet instant. */
  ongoing(): Ongoing | null {
    return ongoingMaintenance(this.state, this.now())
  }

  /** Dernier état connu, lu sur le disque (avant la première vérification). */
  async load(): Promise<void> {
    const saved = await readJson<SavedState | null>(this.deps.file, null)
    if (saved && typeof saved === 'object' && Array.isArray(saved.upcoming)) {
      const { notified, ...state } = saved
      this.state = { ...emptyMaintenanceState(), ...state, offline: false }
      this.notified = new Set(Array.isArray(notified) ? notified : [])
    }
    this.wasOngoing = !!this.ongoing()
  }

  /** Première vérification, puis les suivantes à leur rythme. */
  start(): Promise<MaintenanceState> {
    this.started = true
    return this.check()
  }

  dispose(): void {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Prévenu quand une maintenance se termine (téléchargements en pause à reprendre). */
  onOver(listener: () => void): () => void {
    this.overListeners.add(listener)
    return () => {
      this.overListeners.delete(listener)
    }
  }

  /** GET /maintenance (une seule à la fois). Serveur injoignable : l'état connu est gardé. */
  check(): Promise<MaintenanceState> {
    this.checking ??= this.fetchStatus().finally(() => {
      this.checking = null
    })
    return this.checking
  }

  /**
   * Requête refusée pour maintenance : la maintenance de la réponse est confirmée tout de suite (l'interface affiche
   * l'écran de maintenance), puis GET /maintenance vérifie l'état complet.
   */
  report(err: MaintenanceError): void {
    const t = serverNow(this.state, this.now())
    const at = new Date(t).toISOString()
    // Réponse sans la maintenance (API plus ancienne) : fin estimée d'après Retry-After.
    const maintenance = err.maintenance ??
      this.state.active ?? {
        id: 'unknown',
        startsAt: at,
        endsAt: new Date(t + Math.max(60, err.retryAfter ?? 300) * 1000).toISOString(),
        message: '',
        status: 'active' as const,
        createdAt: null,
        updatedAt: null
      }
    this.update({ ...this.state, active: maintenance, confirmedAt: at })
    if (this.now() - this.lastCheck >= REPORT_DEBOUNCE) void this.check()
  }

  private async fetchStatus(): Promise<MaintenanceState> {
    const sentAt = this.now()
    this.lastCheck = sentAt
    try {
      const response = await this.deps.fetch(`${this.deps.apiUrl}/maintenance`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CHECK_TIMEOUT)
      })
      // API plus ancienne, sans maintenances.
      if (response.status === 404) {
        this.update({ ...emptyMaintenanceState(), clockOffset: this.state.clockOffset })
        return this.state
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const status = parseMaintenanceStatus(await response.json(), sentAt, this.now())
      if (!status) throw new Error('réponse inattendue')
      this.update({ ...status, confirmedAt: status.active ? status.checkedAt : null, offline: false })
    } catch (err) {
      if (!this.state.offline) log.info(`Maintenances non vérifiées : ${(err as Error).message}`)
      this.update({ ...this.state, offline: true })
    }
    await this.saving
    return this.state
  }

  private update(next: MaintenanceState): void {
    const changed = JSON.stringify(next) !== JSON.stringify(this.state)
    this.state = next
    if (changed) {
      this.deps.onChange(next)
      void this.save()
    }
    this.evaluate()
  }

  /** Fin de maintenance, notification avant le début, prochaine vérification. */
  private evaluate(): void {
    const now = this.now()
    const ongoing = ongoingMaintenance(this.state, now)
    if (this.wasOngoing && !ongoing) {
      log.info('Maintenance terminée')
      for (const listener of this.overListeners) listener()
    } else if (!this.wasOngoing && ongoing) log.info(`Maintenance en cours jusqu'à ${ongoing.maintenance.endsAt}`)
    this.wasOngoing = !!ongoing

    const t = serverNow(this.state, now)
    for (const m of this.state.upcoming) {
      const left = Date.parse(m.startsAt) - t
      if (left <= 0 || left > NOTIFY_BEFORE || this.notified.has(m.id)) continue
      this.notified.add(m.id)
      void this.save()
      this.deps.notify?.(m)
    }

    if (!this.started) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.check(), nextCheckDelay(this.state, now))
    this.timer.unref?.()
  }

  private async save(): Promise<void> {
    // Maintenances annoncées encore utiles seulement.
    const known = new Set(this.state.upcoming.map((m) => m.id))
    const notified = [...this.notified].filter((id) => known.has(id))
    const saved: SavedState = { ...this.state, notified }
    // Écritures l'une après l'autre : la dernière demandée est celle qui reste sur le disque.
    this.saving = this.saving.then(() =>
      writeJsonAtomic(this.deps.file, saved).catch((err: unknown) => log.warn(`Maintenances non enregistrées : ${(err as Error).message}`))
    )
    await this.saving
  }
}

// ------------------------------------------------------------------ téléchargements en pause

export interface PausedDownload {
  /** Identifiant du pack ou du mod sur la Marketplace. */
  id: string
  kind: MarketKind
  name: string
  /** Téléchargement fait pour le compte (marketClaim) plutôt qu'un ajout à la bibliothèque. */
  claim?: boolean
  pausedAt: string
}

/** Après un échec de reprise (réseau, serveur), nouvel essai au bout d'une minute. */
const RESUME_RETRY = 60_000

/**
 * Téléchargements arrêtés par une maintenance : gardés (sur le disque aussi) et repris un par un à sa fin, avec leur
 * fichier partiel (requête Range). Pendant la pause, la bibliothèque reste utilisable : aucune tâche n'est bloquée.
 */
export class PausedDownloads {
  private items: PausedDownload[] = []
  private resuming = false
  private retryAt = 0
  private saving: Promise<void> = Promise.resolve()

  constructor(
    private file: string,
    /** Relance le téléchargement (tâche de la Marketplace). */
    private start: (d: PausedDownload) => Promise<unknown>,
    private now: () => number = Date.now
  ) {}

  async load(): Promise<void> {
    const saved = await readJson<PausedDownload[] | null>(this.file, null)
    this.items = Array.isArray(saved) ? saved.filter((d) => typeof d?.id === 'string' && (d.kind === 'pack' || d.kind === 'mod')) : []
  }

  list(): PausedDownload[] {
    return [...this.items]
  }

  async pause(d: Omit<PausedDownload, 'pausedAt'>): Promise<void> {
    this.items = [...this.items.filter((x) => x.id !== d.id), { ...d, pausedAt: new Date(this.now()).toISOString() }]
    log.info(`Téléchargement en pause (maintenance) : ${d.name}`)
    await this.save()
  }

  /** Abandonne la reprise d'un téléchargement (pack téléchargé autrement entre-temps, par exemple). */
  async forget(id: string): Promise<void> {
    if (!this.items.some((d) => d.id === id)) return
    this.items = this.items.filter((d) => d.id !== id)
    await this.save()
  }

  /**
   * Reprend le plus ancien téléchargement en pause. L'appelant vérifie avant qu'aucune maintenance n'est en cours et
   * qu'aucune tâche ne tourne. Renvoie true si un téléchargement a été relancé.
   */
  async resumeNext(): Promise<boolean> {
    const next = this.items[0]
    if (!next || this.resuming || this.now() < this.retryAt) return false
    this.resuming = true
    this.items = this.items.slice(1)
    try {
      await this.start(next)
      log.info(`Téléchargement repris : ${next.name}`)
      return true
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        log.info(`Téléchargement en pause abandonné (${next.name}) : ${err.message}`)
        return false
      }
      // Encore en maintenance : attend la prochaine fin. Autre erreur : nouvel essai plus tard.
      if (!(err instanceof MaintenanceError)) this.retryAt = this.now() + RESUME_RETRY
      log.info(`Téléchargement non repris (${next.name}) : ${(err as Error).message}`)
      this.items = [next, ...this.items.filter((d) => d.id !== next.id)]
      return false
    } finally {
      this.resuming = false
      await this.save()
    }
  }

  /** Délai avant le prochain essai de reprise après un échec (0 si rien n'empêche de reprendre). */
  retryDelay(): number {
    return Math.max(0, this.retryAt - this.now())
  }

  private async save(): Promise<void> {
    const items = [...this.items]
    this.saving = this.saving.then(() =>
      writeJsonAtomic(this.file, items).catch((err: unknown) => log.warn(`Téléchargements en pause non enregistrés : ${(err as Error).message}`))
    )
    await this.saving
  }
}

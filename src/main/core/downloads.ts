// File des téléchargements de la Marketplace (et des créations de « Créer ton pack ») : un seul à la fois, dans l'ordre
// demandé. Chaque téléchargement peut être annulé tant qu'il n'a pas commencé à modifier la bibliothèque. L'interface
// reçoit la file à chaque changement, avec la progression et le débit du téléchargement en cours.

import type { DownloadDone, DownloadItem, DownloadKind } from '@shared/types'
import type { Report } from './installer'

export interface DownloadJob {
  id: string
  kind: DownloadKind
  name: string
  coverId: string | null
  /** Création : adresse pm-media de sa vignette (image d'un composant, d'un style ou image en jeu). */
  coverUrl?: string | null
  claim: boolean
  /** Titre de la tâche, pendant l'ajout à la bibliothèque (« Téléchargement de... », « Mise à jour de... »). */
  title: string
  /** Pack (ou mod) de la bibliothèque relié à la fiche, avant le téléchargement (nouvelle version : l'ancienne). */
  localId?: string | null
}

export interface DownloadContext {
  report: Report
  signal: AbortSignal
  abort: AbortController
  /** Archive téléchargée : attend la fin des autres tâches (waiting), puis modifie la bibliothèque (installing). */
  setStatus: (status: 'waiting' | 'installing') => void
}

interface Entry {
  job: DownloadJob
  item: DownloadItem
  abort: AbortController
  /** Octets reçus ces dernières secondes, pour le débit. */
  samples: { at: number; bytes: number }[]
}

/** Durée sur laquelle le débit est moyenné. */
const SPEED_WINDOW = 3000
/** Intervalle minimal entre deux envois de la progression à l'interface. */
const EMIT_INTERVAL = 250

export class DownloadQueue {
  private entries: Entry[] = []
  private current: Entry | null = null
  private lastEmit = 0
  private emitTimer: NodeJS.Timeout | null = null

  constructor(
    private opts: {
      run: (job: DownloadJob, ctx: DownloadContext) => Promise<unknown>
      onChange: (items: DownloadItem[]) => void
      onDone: (done: DownloadDone) => void
      now?: () => number
    }
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  list(): DownloadItem[] {
    return this.entries.map((e) => ({ ...e.item }))
  }

  /** Au moins un téléchargement en cours ou en attente. */
  get busy(): boolean {
    return this.entries.length > 0
  }

  has(id: string): boolean {
    return this.entries.some((e) => e.job.id === id)
  }

  /** Ajoute un téléchargement à la fin de la file. Renvoie false si ce pack y était déjà (rien n'est ajouté). */
  add(job: DownloadJob): boolean {
    if (this.has(job.id)) return false
    const item: DownloadItem = {
      id: job.id,
      kind: job.kind,
      name: job.name,
      coverId: job.coverId,
      ...(job.coverUrl ? { coverUrl: job.coverUrl } : {}),
      claim: job.claim,
      status: 'queued',
      phase: '',
      current: 0,
      total: 0,
      bytes: false,
      speed: 0
    }
    this.entries.push({ job, item, abort: new AbortController(), samples: [] })
    this.emit(true)
    this.next()
    return true
  }

  /**
   * Annule un téléchargement : retiré de la file s'il attend son tour, interrompu s'il est en cours. Refusé (false)
   * pendant l'ajout à la bibliothèque, qui ne peut plus être interrompu sans risque.
   */
  cancel(id: string): boolean {
    const entry = this.entries.find((e) => e.job.id === id)
    if (!entry || entry.item.status === 'installing') return false
    if (entry !== this.current) {
      this.entries = this.entries.filter((e) => e !== entry)
      this.emit(true)
      this.opts.onDone({ id, kind: entry.job.kind, name: entry.job.name, ok: false, cancelled: true })
      return true
    }
    // En cours : retiré de la file une fois le téléchargement arrêté.
    entry.abort.abort()
    return true
  }

  private next(): void {
    if (this.current) return
    const entry = this.entries[0]
    if (!entry) return
    this.current = entry
    entry.item = { ...entry.item, status: 'downloading' }
    this.emit(true)
    const ctx: DownloadContext = {
      report: (phase, current, total, _detail, bytes) => this.progress(entry, phase, current, total, !!bytes),
      signal: entry.abort.signal,
      abort: entry.abort,
      setStatus: (status) => {
        entry.samples = []
        entry.item = { ...entry.item, status, phase: '', current: 0, total: 0, bytes: false, speed: 0 }
        this.emit(true)
      }
    }
    void this.opts.run(entry.job, ctx).then(
      (result) => this.finish(entry, { ok: true, result }),
      (err: unknown) => {
        if (entry.abort.signal.aborted) return this.finish(entry, { ok: false, cancelled: true })
        // Code de l'erreur de l'API (pack payant refusé : l'interface propose la connexion ou l'achat).
        const code = (err as { code?: unknown })?.code
        this.finish(entry, { ok: false, error: (err as Error)?.message ?? String(err), ...(typeof code === 'string' ? { code } : {}) })
      }
    )
  }

  private finish(entry: Entry, outcome: Pick<DownloadDone, 'ok' | 'cancelled' | 'error' | 'code' | 'result'>): void {
    this.entries = this.entries.filter((e) => e !== entry)
    this.current = null
    this.emit(true)
    const update = entry.job.localId ? { update: true } : {}
    this.opts.onDone({ id: entry.job.id, kind: entry.job.kind, name: entry.job.name, ...update, ...outcome })
    this.next()
  }

  private progress(entry: Entry, phase: string, current: number, total: number, bytes: boolean): void {
    const at = this.now()
    let speed = 0
    if (bytes) {
      // Reprise après une coupure (moins d'octets qu'avant) : le débit repart de zéro.
      const last = entry.samples[entry.samples.length - 1]
      if (last && current < last.bytes) entry.samples = []
      entry.samples.push({ at, bytes: current })
      while (entry.samples.length > 2 && at - entry.samples[1].at >= SPEED_WINDOW) entry.samples.shift()
      const first = entry.samples[0]
      const span = at - first.at
      speed = span >= 500 ? ((current - first.bytes) * 1000) / span : entry.item.speed
    } else entry.samples = []
    const changed = phase !== entry.item.phase
    entry.item = { ...entry.item, phase, current, total, bytes, speed }
    // Nouvelle étape : tout de suite ; progression d'une même étape : au plus toutes les 250 ms.
    this.emit(changed)
  }

  /** Envoie la file à l'interface : tout de suite pour un changement d'état, au plus toutes les 250 ms sinon. */
  private emit(now: boolean): void {
    const elapsed = this.now() - this.lastEmit
    if (!now && elapsed < EMIT_INTERVAL) {
      this.emitTimer ??= setTimeout(() => {
        this.emitTimer = null
        this.emit(true)
      }, EMIT_INTERVAL - elapsed)
      return
    }
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = null
    this.lastEmit = this.now()
    this.opts.onChange(this.list())
  }
}

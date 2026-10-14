// Modèle de comparaison des performances (GET /app/performance) : classes de cartes graphiques, résolutions, seuils.
// Gardé en mémoire une heure (comme le cache de l'API) et sur le disque pour le lancement suivant ; hors ligne, la
// dernière copie reçue sert, sinon celle embarquée dans l'application. La requête ne contient rien de la machine.

import { currentLocale } from '@shared/i18n'
import { EMBEDDED_PERFORMANCE_MODEL, parsePerformanceModel, type PerformanceModel } from '@shared/performance'
import { readJson, writeJsonAtomic } from '../util/fsx'
import { log } from '../util/log'

/** Durée du cache (celle de l'API), et délai avant de réessayer après un échec. */
const MAX_AGE = 60 * 60 * 1000
const RETRY = 5 * 60 * 1000

interface SavedModel {
  fetchedAt: number
  /** Langue des libellés (niveaux, classes de cartes) : une copie dans une autre langue ne sert que hors ligne. */
  locale?: string
  model: unknown
}

export class PerformanceModels {
  private model: PerformanceModel | null = null
  /** Dernière réponse de l'API (ou dernier essai en échec). */
  private checkedAt = 0
  /** Le dernier essai a échoué : nouvel essai au bout de quelques minutes seulement. */
  private checkedFailed = false
  private loading: Promise<PerformanceModel> | null = null

  constructor(
    private apiUrl: string,
    /** Copie sur le disque (performance-model.json). */
    private file: string,
    private fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>,
    private now: () => number = Date.now
  ) {}

  /** Langue changée : les libellés du modèle sont redemandés à l'API (la copie connue sert encore hors ligne). */
  clear(): void {
    this.checkedAt = 0
  }

  /** Modèle à jour (au plus une heure), sinon le dernier connu. */
  get(): Promise<PerformanceModel> {
    if (this.model && this.now() - this.checkedAt < (this.checkedFailed ? RETRY : MAX_AGE)) return Promise.resolve(this.model)
    return (this.loading ??= this.load().finally(() => (this.loading = null)))
  }

  private async load(): Promise<PerformanceModel> {
    if (!this.model) {
      // Premier appel : copie du disque, encore fraîche peut-être.
      const saved = await readJson<SavedModel | null>(this.file, null)
      const model = saved ? parsePerformanceModel(saved.model) : null
      if (model) {
        this.model = model
        if (this.now() - saved!.fetchedAt < MAX_AGE && (saved!.locale ?? 'fr') === currentLocale()) {
          this.checkedAt = saved!.fetchedAt
          this.checkedFailed = false
          return model
        }
      }
    }
    try {
      const response = await this.fetch(`${this.apiUrl}/app/performance`, { signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const raw: unknown = await response.json()
      const model = parsePerformanceModel(raw)
      if (!model) throw new Error('réponse inattendue')
      this.model = model
      this.checkedAt = this.now()
      this.checkedFailed = false
      await writeJsonAtomic(this.file, { fetchedAt: this.checkedAt, locale: currentLocale(), model: raw } satisfies SavedModel).catch(() => undefined)
    } catch (err) {
      // Hors ligne, ou API plus ancienne sans ce modèle : la copie connue (ou embarquée) sert en attendant.
      log.info(`Modèle de performance non chargé : ${(err as Error).message}`)
      this.model ??= EMBEDDED_PERFORMANCE_MODEL
      this.checkedAt = this.now()
      this.checkedFailed = true
    }
    return this.model
  }
}

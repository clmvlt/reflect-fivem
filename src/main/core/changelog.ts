// Fenêtre « Nouveautés » : notes des versions publiées depuis la dernière que l'utilisateur a vue.
//
// Au démarrage, la version lancée est comparée à la dernière dont les nouveautés ont été vues (lastSeenChangelogVersion
// des réglages) :
//  - premier lancement (aucune) : notes de la version lancée (GET /app/releases/<version>) ;
//  - après une mise à jour : notes des versions publiées depuis (GET /app/releases/changelog?since=…&until=…) ;
//  - même version : rien ; version plus ancienne (retour en arrière) : enregistrée sans rien montrer.
// Requête impossible (hors ligne, version de dev non publiée : 404) : rien n'est montré ni enregistré, nouvel essai au
// prochain lancement. Aucune note : la version est enregistrée sans rien montrer. « OK » l'enregistre (dismiss).
// Le bouton « Nouveautés » des réglages remontre les notes de la version lancée à la demande (latest).
//
// Aucune dépendance à Electron ici (testé avec vitest).

import { compareVersions, isChangelogEmpty, isVersion, parseReleaseNotes, type ReleaseNotes, type WhatsNew } from '@shared/changelog'
import { t } from 'i18next'
import type { Fetch } from './http'
import { log } from '../util/log'

const FETCH_TIMEOUT = 10_000

export interface WhatsNewDeps {
  apiUrl: string
  fetch: Fetch
  /** Version lancée (app.getVersion()). */
  version: string
  /** Dernière version dont les nouveautés ont été vues (réglages). */
  lastSeen: () => string | undefined
  /** Enregistre la dernière version vue. */
  save: (version: string) => Promise<void>
  /** Nouveautés à montrer (null : plus rien). */
  onChange: (whatsNew: WhatsNew | null) => void
}

export class WhatsNewWatch {
  private pending: WhatsNew | null = null
  private checking: Promise<WhatsNew | null> | null = null

  constructor(private deps: WhatsNewDeps) {}

  /** Nouveautés à montrer, null s'il n'y en a pas (ou pas encore). */
  get current(): WhatsNew | null {
    return this.pending
  }

  /** Compare la version lancée à la dernière vue et demande les notes manquantes à l'API (une vérification à la fois). */
  check(): Promise<WhatsNew | null> {
    this.checking ??= this.run().finally(() => {
      this.checking = null
    })
    return this.checking
  }

  /** « OK » : la version lancée est vue, la fenêtre ne revient plus avant la prochaine mise à jour. */
  async dismiss(): Promise<void> {
    this.set(null)
    await this.deps.save(this.deps.version)
  }

  /**
   * Notes de la version lancée, sinon de la dernière publiée (version de dev pas encore publiée) : bouton « Nouveautés »
   * des réglages. Rien n'est enregistré.
   */
  async latest(): Promise<WhatsNew> {
    let release: ReleaseNotes | null
    try {
      const raw = (await this.get(`/app/releases/${encodeURIComponent(this.deps.version)}`, true)) ?? (await this.get('/app/releases/latest', true))
      release = raw === null ? null : parseReleaseNotes(raw)
    } catch (err) {
      log.info(`Nouveautés non chargées : ${(err as Error).message}`)
      throw new Error(t('whatsNew.unavailable'))
    }
    if (!release || isChangelogEmpty(release.changelog)) throw new Error(t('whatsNew.empty'))
    return { version: release.version, releases: [release] }
  }

  private async run(): Promise<WhatsNew | null> {
    const { version } = this.deps
    const seen = this.deps.lastSeen()
    // Numéro illisible (réglages modifiés à la main) : comme un premier lancement.
    const since = isVersion(seen) ? seen : undefined
    if (since && compareVersions(since, version) === 0) return this.pending
    if (since && compareVersions(since, version) > 0) {
      log.info(`Nouveautés : version ${version} plus ancienne que la dernière vue (${since}), rien à montrer`)
      await this.save(version)
      return null
    }
    let releases: ReleaseNotes[] | null
    try {
      releases = since ? await this.since(since) : await this.release(version)
    } catch (err) {
      log.info(`Nouveautés non chargées : ${(err as Error).message}`)
      return this.pending
    }
    const shown = releases.filter((r) => !isChangelogEmpty(r.changelog))
    if (!shown.length) {
      // Version sans notes : vue, rien à montrer.
      await this.save(version)
      this.set(null)
      return null
    }
    this.set({ version, releases: shown })
    return this.pending
  }

  /** GET /app/releases/changelog : versions publiées après `since` jusqu'à la version lancée (incluse). */
  private async since(since: string): Promise<ReleaseNotes[]> {
    const query = new URLSearchParams({ since, until: this.deps.version })
    const body = await this.get(`/app/releases/changelog?${query}`)
    if (!Array.isArray(body)) throw new Error('réponse inattendue')
    return body.map(parseReleaseNotes).filter((r): r is ReleaseNotes => !!r)
  }

  /** GET /app/releases/<version> : notes de la version lancée (404 si elle n'est pas publiée). */
  private async release(version: string): Promise<ReleaseNotes[]> {
    const release = parseReleaseNotes(await this.get(`/app/releases/${encodeURIComponent(version)}`))
    if (!release) throw new Error('réponse inattendue')
    return [release]
  }

  /** Réponse de l'API ; null pour une version inconnue (404) si `missing` est accepté. */
  private async get(path: string, missing = false): Promise<unknown> {
    const response = await this.deps.fetch(`${this.deps.apiUrl}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT)
    })
    if (missing && response.status === 404) return null
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  }

  private async save(version: string): Promise<void> {
    await this.deps.save(version).catch((err: unknown) => log.warn(`Dernière version vue non enregistrée : ${(err as Error).message}`))
  }

  private set(next: WhatsNew | null): void {
    if (next === this.pending) return
    this.pending = next
    this.deps.onChange(next)
  }
}

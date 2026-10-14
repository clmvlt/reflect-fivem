// Liens publics de l'application (invitation Discord...), modifiables à tout moment par les admins depuis le site.
//
// GET /links (sans compte, jamais refusé pendant une maintenance) au démarrage, puis quand la fenêtre reprend le focus,
// au plus une fois par minute. La dernière réponse est gardée sur le disque (links.json) : hors ligne ou API qui ne
// répond pas, ce sont ces liens qui s'affichent ; sans lien connu, le bouton est masqué.
//
// Aucune dépendance à Electron ici (testé avec vitest).

import { emptyLinks, parseLinks, type AppLinks } from '@shared/links'
import type { Fetch } from './http'
import { readJson, writeJsonAtomic } from '../util/fsx'
import { log } from '../util/log'

/** Pas plus d'une requête par minute (Cache-Control: max-age=60 de l'API). */
export const LINKS_REFRESH_MIN = 60_000
const FETCH_TIMEOUT = 8000

export interface LinksDeps {
  apiUrl: string
  fetch: Fetch
  /** Derniers liens reçus, pour le prochain démarrage et le mode hors ligne (links.json). */
  file: string
  /** Liens changés : envoyés à l'interface. */
  onChange: (links: AppLinks) => void
  now?: () => number
}

export class LinksWatch {
  private links: AppLinks = emptyLinks()
  private lastAttempt = -Infinity
  private loading: Promise<AppLinks> | null = null
  private saving: Promise<void> = Promise.resolve()

  constructor(private deps: LinksDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  get current(): AppLinks {
    return this.links
  }

  /** Derniers liens connus, lus sur le disque (avant la première requête). */
  async load(): Promise<void> {
    this.links = parseLinks(await readJson<unknown>(this.deps.file, null)) ?? emptyLinks()
  }

  /** GET /links, sauf si la dernière requête date de moins d'une minute (une seule à la fois). */
  refresh(): Promise<AppLinks> {
    if (this.loading) return this.loading
    if (this.now() - this.lastAttempt < LINKS_REFRESH_MIN) return Promise.resolve(this.links)
    this.lastAttempt = this.now()
    this.loading = this.fetchLinks().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  private async fetchLinks(): Promise<AppLinks> {
    try {
      const response = await this.deps.fetch(`${this.deps.apiUrl}/links`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const links = parseLinks(await response.json())
      if (!links) throw new Error('réponse inattendue')
      await this.update(links)
    } catch (err) {
      log.info(`Liens non chargés : ${(err as Error).message}`)
    }
    return this.links
  }

  private async update(next: AppLinks): Promise<void> {
    if (JSON.stringify(next) === JSON.stringify(this.links)) return
    this.links = next
    this.deps.onChange(next)
    // Écritures l'une après l'autre : la dernière demandée est celle qui reste sur le disque.
    this.saving = this.saving.then(() =>
      writeJsonAtomic(this.deps.file, next).catch((err: unknown) => log.warn(`Liens non enregistrés : ${(err as Error).message}`))
    )
    await this.saving
  }
}

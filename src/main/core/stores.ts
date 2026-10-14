import path from 'node:path'
import type { AppState, HistoryEntry, Settings } from '@shared/types'
import { tm } from '@shared/i18n'
import { readJson, writeJsonAtomic } from '../util/fsx'

export class JsonStore<T> {
  private value: T
  constructor(
    private file: string,
    initial: T
  ) {
    this.value = initial
  }
  async load(fallback: T): Promise<T> {
    this.value = { ...fallback, ...(await readJson<Partial<T>>(this.file, {})) } as T
    return this.value
  }
  get(): T {
    return this.value
  }
  async set(v: T): Promise<void> {
    this.value = v
    await writeJsonAtomic(this.file, v)
  }
  async patch(p: Partial<T>): Promise<T> {
    await this.set({ ...this.value, ...p })
    return this.value
  }
}

export function defaultSettings(dataDir: string): Settings {
  return {
    libraryDir: path.join(dataDir, 'Bibliotheque'),
    fivemPath: null,
    gtaPath: null
  }
}

export const emptyState = (): AppState => ({ schema: 1, active: null, history: [] })

/**
 * Ajoute une entrée à l'historique. Avec `msg`, le résumé est traduit à l'affichage ; `summary` (par défaut le texte
 * de `msg` dans la langue courante) reste le repli.
 */
export function pushHistory(state: AppState, e: Omit<HistoryEntry, 'at' | 'summary'> & { summary?: string }): AppState {
  const entry: HistoryEntry = { ...e, summary: e.summary ?? tm(e.msg), at: new Date().toISOString() }
  const history = [entry, ...state.history].slice(0, 200)
  return { ...state, history }
}

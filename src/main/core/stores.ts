import path from 'node:path'
import type { AppState, HistoryEntry, InstalledMod, Settings } from '@shared/types'
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
  /** Passe à un autre fichier (état d'une autre instance) et le lit. */
  async open(file: string, fallback: T): Promise<T> {
    this.file = file
    return this.load(fallback)
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

export const emptyState = (): AppState => ({ schema: 1, active: null, mods: [], history: [] })

/**
 * État lu sur le disque, complété : un state.json d'avant les mods n'a pas de liste de mods, une entrée illisible est
 * écartée (le mod reste dans la bibliothèque des mods, désactivé). Renvoie le même objet s'il n'y a rien à corriger.
 */
export function normalizeState(s: AppState): AppState {
  const raw = (s as Partial<AppState>).mods
  const valid = (m: InstalledMod): boolean => !!m && typeof m.id === 'string' && Array.isArray(m.files)
  if (Array.isArray(raw) && raw.every(valid) && raw.every((m) => Array.isArray(m.shadowed) && Array.isArray(m.createdDirs)) && Array.isArray(s.history))
    return s
  const mods = (Array.isArray(raw) ? raw : []).filter(valid).map((m) => ({
    ...m,
    name: typeof m.name === 'string' ? m.name : m.id,
    enabled: m.enabled === true,
    appliedAt: m.appliedAt ?? null,
    roots: m.roots ?? { fivem: '', gta: '' },
    createdDirs: Array.isArray(m.createdDirs) ? m.createdDirs : [],
    shadowed: Array.isArray(m.shadowed) ? m.shadowed : []
  }))
  return { ...s, active: s.active ?? null, mods, history: Array.isArray(s.history) ? s.history : [] }
}

/**
 * Ajoute une entrée à l'historique. Avec `msg`, le résumé est traduit à l'affichage ; `summary` (par défaut le texte
 * de `msg` dans la langue courante) reste le repli.
 */
export function pushHistory(state: AppState, e: Omit<HistoryEntry, 'at' | 'summary'> & { summary?: string }): AppState {
  const entry: HistoryEntry = { ...e, summary: e.summary ?? tm(e.msg), at: new Date().toISOString() }
  const history = [entry, ...state.history].slice(0, 200)
  return { ...state, history }
}

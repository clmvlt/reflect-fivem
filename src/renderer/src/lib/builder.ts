// « Créer ton pack » côté interface : composition en cours (brouillon : composants et outils d'ambiance), règles de
// choix, conflits en direct, réglages des outils (seulement ce que le joueur change) et contrôles des paramètres
// d'effets. Les règles propres aux outils d'ambiance sont dans @shared/ambiance.

import { cleanTools, fromLegacy, recommendedTools, toolBases, TOOL_KEYS, toolOff } from '@shared/ambiance'
import type {
  BuilderAdjustments,
  BuilderBuild,
  BuilderBuildComponent,
  BuilderCatalog,
  BuilderCategory,
  BuilderComponentCard,
  BuilderControlValue,
  BuilderParam,
  BuilderProblem,
  BuilderTools
} from '@shared/types'

/** Étape finale de l'assistant, après les groupes du catalogue. */
export const SUMMARY = 'summary'
export const NAME_MAX = 80

/**
 * Composition en cours : composants (hors outils d'ambiance) et choix de chaque outil. `removed` : composants retirés
 * depuis l'enregistrement (ni choisis, ni installables).
 */
export interface Draft {
  id: string | null
  name: string
  components: string[]
  tools: BuilderTools
  removed: BuilderBuildComponent[]
  /** Noms connus des composants (création ouverte), pour ceux absents du catalogue. */
  names: Record<string, string>
}

/** Nouvelle création : « Recommandé » (le choix par défaut de chaque outil). */
export function newDraft(name: string, catalog: BuilderCatalog): Draft {
  return { id: null, name, components: [], tools: recommendedTools(catalog), removed: [], names: {} }
}

/**
 * Création ouverte. Ses composants d'outils sont dans `tools` (« Importé d'un pack ») ; une création d'avant les outils
 * (preset ReShade parmi ses composants) est convertie. Un outil importé d'un composant retiré n'est plus installable :
 * il passe sur « Aucun », le composant est signalé avec les autres composants retirés.
 */
export function draftOf(build: BuilderBuild): Draft {
  const known = build.components.filter((c): c is BuilderBuildComponent & { id: string } => !!c.id)
  const categories = new Map(known.map((c) => [c.id, c.category]))
  const { components, tools } = fromLegacy(
    known.filter((c) => c.available).map((c) => c.id),
    (id) => categories.get(id),
    null,
    cleanTools(build.tools)
  )
  const removed = build.components.filter((c) => !c.available)
  for (const key of TOOL_KEYS) {
    const component = tools[key].component
    if (tools[key].mode === 'pack' && component && removed.some((c) => c.id === component)) tools[key] = toolOff()
  }
  return { id: build.id, name: build.name, components, tools, removed, names: Object.fromEntries(known.map((c) => [c.id, c.name])) }
}

/**
 * Brouillon gardé d'avant les outils d'ambiance (`reshade`, preset et bases parmi les composants) : ses composants
 * d'outils deviennent leur choix « Importé d'un pack », avec ses réglages ReShade pour le preset.
 */
export function upgradeDraft(draft: Omit<Draft, 'tools'> & { tools?: unknown; reshade?: unknown }, categoryOf: (id: string) => string | null | undefined): Draft {
  const { reshade, tools: rawTools, ...rest } = draft
  if (rawTools !== undefined && reshade === undefined) return { ...rest, tools: cleanTools(rawTools) }
  const { components, tools } = fromLegacy(draft.components, categoryOf, reshade, cleanTools(rawTools))
  return { ...rest, components, tools }
}

/** Ce qui est enregistré d'une création : comparé pour savoir s'il reste des changements à enregistrer. */
export function snapshot(d: Pick<Draft, 'name' | 'components' | 'tools'>): string {
  return JSON.stringify({ name: d.name.trim(), components: [...d.components].sort(), tools: sortKeys(cleanTools(d.tools)) })
}

function sortKeys(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortKeys(v)])
  )
}

export interface CardRef {
  card: BuilderComponentCard
  category: BuilderCategory
}

export function cardIndex(catalog: BuilderCatalog): Map<string, CardRef> {
  const out = new Map<string, CardRef>()
  for (const category of catalog.categories) for (const card of category.components) out.set(card.id, { card, category })
  return out
}

/**
 * Choisit (ou retire) un composant : dans une catégorie à choix unique, il remplace celui qui y était. `null` vide la
 * catégorie (« Aucun »).
 */
export function toggle(components: string[], index: Map<string, CardRef>, category: BuilderCategory, id: string | null): string[] {
  const others = category.single || id === null ? components.filter((c) => index.get(c)?.category.key !== category.key) : components
  if (id === null) return others
  return components.includes(id) ? components.filter((c) => c !== id) : [...others, id]
}

/** Composants choisis qui remplacent les mêmes fichiers du jeu que `card` (un seul des deux s'appliquerait). */
export function conflictsOf(card: BuilderComponentCard, chosen: BuilderComponentCard[]): BuilderComponentCard[] {
  return chosen.filter((c) => c.id !== card.id && (card.conflictsWith.includes(c.id) || c.conflictsWith.includes(card.id)))
}

/**
 * Éléments choisis qui empêchent de choisir `card` (ils remplacent les mêmes fichiers). Dans une catégorie à choix
 * unique (`single`), l'élément déjà choisi n'en fait pas partie : choisir `card` le remplace.
 */
export function blockersOf(card: BuilderComponentCard, single: boolean, chosen: BuilderComponentCard[]): BuilderComponentCard[] {
  return conflictsOf(card, chosen).filter((c) => !(single && c.category === card.category))
}

/**
 * Problèmes montrés au joueur : sans les conflits (deux éléments qui remplacent les mêmes fichiers, un seul s'applique),
 * évités au moment du choix (élément incompatible désactivé) et sans rien à régler ensuite.
 */
export function shownProblems(problems: BuilderProblem[]): BuilderProblem[] {
  return problems.filter((p) => p.type !== 'conflict')
}

/** Bases que `card` demande (QuantV, NVE, ReShade) et qu'aucun composant choisi ni outil actif ne fournit. */
export function missingBases(card: BuilderComponentCard, chosen: BuilderComponentCard[], tools: BuilderTools): string[] {
  const bases = toolBases(tools)
  return card.requires.filter((base) => !bases.includes(base) && !chosen.some((c) => c.id !== card.id && c.provides.includes(base)))
}

// ---------------------------------------------------------------------------
// Réglages d'un outil : seuls les changements du joueur sont gardés

/**
 * Valeurs de départ d'un outil (style ou preset du pack, réglages simples compris), relevées dans son état quand le
 * joueur n'y avait rien changé : revenir à l'une d'elles efface le réglage.
 */
export interface Starts {
  controls: Record<string, BuilderControlValue | null>
  techniques: Record<string, boolean>
  /** « fichier/paramètre » → valeur. */
  values: Record<string, string>
}

export const noStarts = (): Starts => ({ controls: {}, techniques: {}, values: {} })

/** Change un réglage simple ; revenir à sa valeur de départ (curseur : 0) le retire. */
export function setControl<A extends BuilderAdjustments>(a: A, key: string, value: BuilderControlValue | null, start: BuilderControlValue | null): A {
  const controls = { ...a.controls }
  if (value === null || value === start) delete controls[key]
  else controls[key] = value
  return { ...a, controls }
}

/** Active ou coupe un effet ; revenir à son état de départ retire le réglage. */
export function setTechnique<A extends BuilderAdjustments>(a: A, name: string, on: boolean, start: boolean | undefined): A {
  const techniques = { ...a.techniques }
  if (on === start) delete techniques[name]
  else techniques[name] = on
  return { ...a, techniques }
}

/** Valeur de départ d'un paramètre : celle du style ou du preset du pack, sinon celle par défaut de l'effet. */
export function baseValue(p: BuilderParam): string {
  return p.baseValue ?? p.defaultValue ?? p.value ?? ''
}

/** Change un paramètre (mode avancé) ; revenir à sa valeur de départ (`start`) le retire. */
export function setParam<A extends BuilderAdjustments>(a: A, file: string, name: string, value: string | null, start: string): A {
  const params = { ...a.values[file] }
  if (value === null || sameValue(value, start)) delete params[name]
  else params[name] = value
  const values = { ...a.values }
  if (Object.keys(params).length) values[file] = params
  else delete values[file]
  return { ...a, values }
}

/** Même valeur, aux arrondis près (« 1.000000 » et « 1 »). */
function sameValue(a: string, b: string): boolean {
  if (a.trim() === b.trim()) return true
  const x = numbers(a)
  const y = numbers(b)
  return !!x && !!y && x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) < 1e-6)
}

/** Nombres d'une valeur de preset (« 1.0,0.5,0.2 ») ; null si elle n'en est pas une. */
export function numbers(value: string): number[] | null {
  const parts = value.split(',').map((s) => s.trim())
  if (!parts.length || parts.some((s) => !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s))) return null
  return parts.map(Number)
}

/** Nombre de composantes d'un type (float3 : 3, float : 1). */
export function componentCount(type: string | null): number {
  const m = /(\d)$/.exec(type ?? '')
  return m ? Number(m[1]) : 1
}

export type ParamKind = 'bool' | 'combo' | 'slider' | 'color' | 'number' | 'text'

/** Contrôle d'un paramètre d'après son `ui` et son `type` (comme le menu de ReShade). */
export function paramKind(p: BuilderParam): ParamKind {
  const count = componentCount(p.type)
  const type = p.type ?? ''
  if (type === 'bool') return 'bool'
  if (count === 1 && /^u?int$/.test(type) && p.items.length && ['combo', 'radio', 'list'].includes(p.ui ?? '')) return 'combo'
  if ((count === 3 || count === 4) && type.startsWith('float') && (p.ui === 'color' || (p.ui === null && p.min !== null && p.min >= 0 && p.max !== null && p.max <= 1)))
    return 'color'
  if (count === 1 && /^(u?int|float)$/.test(type)) return p.min !== null && p.max !== null && p.min < p.max ? 'slider' : 'number'
  return 'text'
}

/** Pas d'un curseur : celui de l'effet, sinon 1 pour un entier et un centième de l'écart pour un réel. */
export function paramStep(p: BuilderParam): number {
  if (p.step && p.step > 0) return p.step
  if (/^u?int$/.test(p.type ?? '')) return 1
  return p.min !== null && p.max !== null ? Math.max((p.max - p.min) / 100, 0.0001) : 0.01
}

const channel = (v: number): string =>
  Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16)
    .padStart(2, '0')

/** « 1.0,0.5,0.0 » → « #ff8000 » ; null si la valeur n'est pas une couleur. */
export function toHex(value: string): string | null {
  const n = numbers(value)
  return n && n.length >= 3 ? `#${channel(n[0])}${channel(n[1])}${channel(n[2])}` : null
}

/** « #ff8000 » → « 1.000000,0.501961,0.000000 », la transparence (float4) d'avant gardée. */
export function fromHex(hex: string, previous: string, count: number): string {
  const rgb = [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(6))
  const alpha = count === 4 ? ((numbers(previous)?.[3] ?? 1).toFixed(6)) : null
  return [...rgb, ...(alpha ? [alpha] : [])].join(',')
}

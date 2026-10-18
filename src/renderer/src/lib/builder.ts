// « Créer ton pack » côté interface : composition en cours (brouillon), règles de choix, conflits en direct, réglages
// ReShade (seulement ce que le joueur change) et contrôles des paramètres d'effets.

import type {
  BuilderBase,
  BuilderBuild,
  BuilderBuildComponent,
  BuilderCatalog,
  BuilderCategory,
  BuilderComponentCard,
  BuilderControl,
  BuilderControlValue,
  BuilderParam,
  BuilderPreset,
  BuilderReshade
} from '@shared/types'

/** Catégorie des presets ReShade : ses réglages s'affichent quand un preset est choisi. */
export const RESHADE = 'reshade'
/** Étape finale de l'assistant, après les groupes du catalogue. */
export const SUMMARY = 'summary'
/** Onglet des réglages ReShade, dans l'étape de la catégorie des presets. */
export const RESHADE_SETTINGS = '#reshade'
export const NAME_MAX = 80

/** Catégorie où choisir une base demandée (requires). */
export const BASE_CATEGORY: Record<BuilderBase, string> = { quantv: 'quantv', nve: 'nve', reshade: RESHADE }

export const emptyReshade = (): BuilderReshade => ({ controls: {}, techniques: {}, values: {} })

/** Composition en cours. `removed` : composants retirés depuis l'enregistrement (ni choisis, ni installables). */
export interface Draft {
  id: string | null
  name: string
  components: string[]
  reshade: BuilderReshade
  removed: BuilderBuildComponent[]
  /** Noms connus des composants (création ouverte), pour ceux absents du catalogue. */
  names: Record<string, string>
}

export function newDraft(name: string): Draft {
  return { id: null, name, components: [], reshade: emptyReshade(), removed: [], names: {} }
}

export function draftOf(build: BuilderBuild): Draft {
  const known = build.components.filter((c): c is BuilderBuildComponent & { id: string } => !!c.id)
  return {
    id: build.id,
    name: build.name,
    components: known.filter((c) => c.available).map((c) => c.id),
    reshade: build.reshade,
    removed: build.components.filter((c) => !c.available),
    names: Object.fromEntries(known.map((c) => [c.id, c.name]))
  }
}

/** Ce qui est enregistré d'une création : comparé pour savoir s'il reste des changements à enregistrer. */
export function snapshot(d: Pick<Draft, 'name' | 'components' | 'reshade'>): string {
  return JSON.stringify({ name: d.name.trim(), components: [...d.components].sort(), reshade: sortKeys(d.reshade) })
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

/** Bases que `card` demande et qu'aucun composant choisi ne fournit. */
export function missingBases(card: BuilderComponentCard, chosen: BuilderComponentCard[]): BuilderBase[] {
  return card.requires.filter((base) => !chosen.some((c) => c.id !== card.id && c.provides.includes(base)))
}

/**
 * Autre preset choisi : les réglages simples communs aux deux sont gardés, le mode avancé (effets, paramètres) propre
 * à l'ancien preset est oublié.
 */
export function keepCommonControls(reshade: BuilderReshade, preset: BuilderPreset): BuilderReshade {
  const keys = new Set(preset.controls.map((c) => c.key))
  return { controls: Object.fromEntries(Object.entries(reshade.controls).filter(([k]) => keys.has(k))), techniques: {}, values: {} }
}

// ---------------------------------------------------------------------------
// Réglages simples

/** Valeur affichée d'un réglage : celle du joueur, sinon celle du preset (curseur : 0). */
export function controlValue(control: BuilderControl, reshade: BuilderReshade): BuilderControlValue | null {
  const mine = reshade.controls[control.key]
  if (mine !== undefined) return mine
  return control.type === 'slider' ? 0 : control.value
}

/** Change un réglage simple ; revenir à la valeur du preset retire le réglage (seuls les changements sont envoyés). */
export function setControl(reshade: BuilderReshade, control: BuilderControl, value: BuilderControlValue | null): BuilderReshade {
  const controls = { ...reshade.controls }
  const neutral = control.type === 'slider' ? 0 : control.value
  if (value === null || value === neutral) delete controls[control.key]
  else controls[control.key] = value
  return { ...reshade, controls }
}

// ---------------------------------------------------------------------------
// Mode avancé

export function techniqueEnabled(name: string, presetEnabled: boolean, reshade: BuilderReshade): boolean {
  return reshade.techniques[name] ?? presetEnabled
}

export function setTechnique(reshade: BuilderReshade, name: string, presetEnabled: boolean, on: boolean): BuilderReshade {
  const techniques = { ...reshade.techniques }
  if (on === presetEnabled) delete techniques[name]
  else techniques[name] = on
  return { ...reshade, techniques }
}

/** Valeur du preset pour un paramètre (sinon celle par défaut de l'effet). */
export function presetValue(p: BuilderParam): string {
  return p.value ?? p.defaultValue ?? ''
}

export function paramValue(file: string, p: BuilderParam, reshade: BuilderReshade): string {
  return reshade.values[file]?.[p.name] ?? presetValue(p)
}

export function setParam(reshade: BuilderReshade, file: string, p: BuilderParam, value: string | null): BuilderReshade {
  const params = { ...reshade.values[file] }
  if (value === null || sameValue(value, presetValue(p))) delete params[p.name]
  else params[p.name] = value
  const values = { ...reshade.values }
  if (Object.keys(params).length) values[file] = params
  else delete values[file]
  return { ...reshade, values }
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

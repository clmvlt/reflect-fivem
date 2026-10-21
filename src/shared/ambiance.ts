// Outils d'ambiance de « Créer ton pack » : ReShade (filtres de l'image), QuantV (lumière et météo, a besoin de
// ReShade), NVE et ENB. Pour chacun, le joueur n'en prend aucun, le règle lui-même avec un style, ou l'importe d'un
// pack. Ici : choix rapide (Basique, Recommandé, Personnalisé), règles entre outils, conversion des créations
// enregistrées avant les outils, et aperçu d'un style dessiné sur une image de référence en jeu (celle choisie par le
// joueur, sinon celle par défaut) ou, faute d'image en jeu, sur l'image de référence de son outil.
// Fonctions pures, partagées entre le processus principal et l'interface.

import type {
  BuilderAdjustments,
  BuilderCatalog,
  BuilderControlValue,
  BuilderImageRef,
  BuilderReference,
  BuilderStyle,
  BuilderStylePreview,
  BuilderTool,
  BuilderToolSettings,
  BuilderTools,
  ToolKey,
  ToolMode
} from './types'

/** Ordre des outils (celui du catalogue). */
export const TOOL_KEYS: readonly ToolKey[] = ['reshade', 'quantv', 'nve', 'enb']
export const TOOL_MODES: readonly ToolMode[] = ['none', 'custom', 'pack']

export const isToolKey = (x: unknown): x is ToolKey => typeof x === 'string' && (TOOL_KEYS as readonly string[]).includes(x)
export const isToolMode = (x: unknown): x is ToolMode => typeof x === 'string' && (TOOL_MODES as readonly string[]).includes(x)

/** Outil dont une catégorie donne les choix « Importé d'un pack » : mêmes clés (reshade, quantv, nve, enb). */
export function toolOfCategory(category: string | null | undefined): ToolKey | null {
  return isToolKey(category) ? category : null
}

export const noAdjustments = (): BuilderAdjustments => ({ controls: {}, techniques: {}, values: {} })
export const toolOff = (): BuilderToolSettings => ({ mode: 'none', component: null, style: null, ...noAdjustments() })
/** « Basique » : aucun outil, le jeu d'origine. */
export const noTools = (): BuilderTools => ({ reshade: toolOff(), quantv: toolOff(), nve: toolOff(), enb: toolOff() })

export function hasAdjustments(a: BuilderAdjustments): boolean {
  return Object.keys(a.controls).length + Object.keys(a.techniques).length + Object.keys(a.values).length > 0
}

/** Nombre de réglages changés par le joueur (simples et avancés). */
export function adjustmentCount(a: BuilderAdjustments): number {
  return Object.keys(a.controls).length + Object.keys(a.techniques).length + Object.values(a.values).reduce((s, v) => s + Object.keys(v).length, 0)
}

/** Choix d'un outil reçu (API, brouillon) : valeurs du bon type seulement ; un choix incomplet devient « Aucun ». */
export function cleanTool(raw: unknown): BuilderToolSettings {
  const o = isObj(raw) ? raw : {}
  const mode = isToolMode(o.mode) ? o.mode : 'none'
  const component = typeof o.component === 'string' && o.component ? o.component : null
  const style = typeof o.style === 'string' && o.style ? o.style : null
  if (mode === 'none' || (mode === 'pack' && !component)) return toolOff()
  const controls: Record<string, BuilderControlValue> = {}
  for (const [k, v] of Object.entries(isObj(o.controls) ? o.controls : {}))
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') controls[k] = v
  const techniques: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(isObj(o.techniques) ? o.techniques : {})) if (typeof v === 'boolean') techniques[k] = v
  const values: Record<string, Record<string, string>> = {}
  for (const [section, params] of Object.entries(isObj(o.values) ? o.values : {})) {
    const kept = Object.entries(isObj(params) ? params : {}).filter((e): e is [string, string] => typeof e[1] === 'string')
    if (kept.length) values[section] = Object.fromEntries(kept)
  }
  return { mode, component: mode === 'pack' ? component : null, style: mode === 'custom' ? style : null, controls, techniques, values }
}

/** Choix des quatre outils (un outil absent : « Aucun »). */
export function cleanTools(raw: unknown): BuilderTools {
  const o = isObj(raw) ? raw : {}
  return { reshade: cleanTool(o.reshade), quantv: cleanTool(o.quantv), nve: cleanTool(o.nve), enb: cleanTool(o.enb) }
}

/**
 * Création (ou brouillon) d'avant les outils d'ambiance : ses composants d'outils (preset ReShade, base QuantV, NVE,
 * ENB) deviennent le choix « Importé d'un pack » de leur outil, avec ses réglages ReShade pour le preset. Les autres
 * composants restent des composants. `tools` : choix déjà connus, gardés.
 */
export function fromLegacy(
  components: string[],
  categoryOf: (id: string) => string | null | undefined,
  reshade: unknown,
  tools: BuilderTools = noTools()
): { components: string[]; tools: BuilderTools } {
  const next = { ...tools }
  const rest: string[] = []
  for (const id of components) {
    const tool = toolOfCategory(categoryOf(id))
    if (!tool) rest.push(id)
    else if (next[tool].mode === 'none') next[tool] = cleanTool({ ...(tool === 'reshade' && isObj(reshade) ? reshade : {}), mode: 'pack', component: id })
  }
  return { components: rest, tools: next }
}

/**
 * Style appliqué d'un outil réglé par le joueur : le sien, ou celui par défaut (aucun choisi, ou le sien a été retiré
 * du catalogue : l'API applique alors le style par défaut).
 */
export function styleOf(tool: BuilderTool, settings: BuilderToolSettings): BuilderStyle | null {
  if (settings.mode !== 'custom') return null
  return tool.styles.find((s) => s.id === settings.style) ?? tool.styles.find((s) => s.id === tool.defaultStyle) ?? null
}

/**
 * Choix à enregistrer : un style retiré du catalogue (création ancienne) est remplacé par le style par défaut (null),
 * que l'API appliquait déjà ; elle refuserait sinon l'enregistrement. Catalogue hors ligne : rien n'est changé.
 */
export function withKnownStyles(tools: BuilderTools, catalog: BuilderCatalog): BuilderTools {
  if (catalog.offline) return tools
  const next = { ...tools }
  for (const tool of catalog.tools) {
    const s = next[tool.key]
    if (s.mode === 'custom' && s.style && !tool.styles.some((x) => x.id === s.style)) next[tool.key] = { ...s, style: null }
  }
  return next
}

// ---------------------------------------------------------------------------
// Choix rapide

/** Composants « Importé d'un pack » d'un outil, dans l'ordre du catalogue. */
export function packsOf(catalog: BuilderCatalog, tool: ToolKey): string[] {
  const t = catalog.tools.find((x) => x.key === tool)
  const category = catalog.categories.find((c) => c.tool === tool || (!!t && c.key === t.category))
  return category?.components.map((c) => c.id) ?? []
}

/** Choix « Réglé par moi » d'un outil (style par défaut), ou « Importé » du premier pack ; null s'il n'y a ni l'un ni l'autre. */
export function activeTool(tool: BuilderTool, packs: string[]): BuilderToolSettings | null {
  if (tool.custom) return { ...toolOff(), mode: 'custom', style: tool.defaultStyle }
  if (packs.length) return { ...toolOff(), mode: 'pack', component: packs[0] }
  return null
}

/** Choix par défaut d'un outil (mode et style proposés par le catalogue). */
export function defaultTool(tool: BuilderTool, packs: string[]): BuilderToolSettings {
  if (tool.defaultMode === 'custom' && tool.custom) return { ...toolOff(), mode: 'custom', style: tool.defaultStyle }
  if (tool.defaultMode === 'pack' && packs.length) return { ...toolOff(), mode: 'pack', component: packs[0] }
  return toolOff()
}

/** « Recommandé » : chaque outil proposé avec son choix par défaut (QuantV entraîne ReShade). */
export function recommendedTools(catalog: BuilderCatalog): BuilderTools {
  let tools = noTools()
  for (const tool of catalog.tools) tools = { ...tools, [tool.key]: defaultTool(tool, packsOf(catalog, tool.key)) }
  return applyRules(tools, 'quantv', catalog).tools
}

export type AmbianceChoice = 'basic' | 'recommended' | 'custom'

const sameTool = (a: BuilderToolSettings, b: BuilderToolSettings): boolean =>
  a.mode === b.mode && a.component === b.component && (a.style ?? null) === (b.style ?? null) && !hasAdjustments(a) && !hasAdjustments(b)

/** Choix rapide qui correspond à ces outils : aucun outil (Basique), ceux par défaut (Recommandé), sinon Personnalisé. */
export function ambianceChoice(tools: BuilderTools, catalog: BuilderCatalog): AmbianceChoice {
  if (TOOL_KEYS.every((k) => tools[k].mode === 'none')) return 'basic'
  const recommended = recommendedTools(catalog)
  if (TOOL_KEYS.every((k) => sameTool(tools[k], recommended[k]))) return 'recommended'
  return 'custom'
}

// ---------------------------------------------------------------------------
// Règles entre outils

/**
 * Règle appliquée après un changement : reshade-on (QuantV activé alors que ReShade était sur Aucun : ReShade réglé par
 * le joueur avec son style par défaut), quantv-off (ReShade sur Aucun : QuantV, qui en a besoin, est coupé),
 * reshade-missing (QuantV sans ReShade possible).
 */
export type ToolNote = 'reshade-on' | 'quantv-off' | 'reshade-missing'

function applyRules(tools: BuilderTools, changed: ToolKey, catalog: BuilderCatalog): { tools: BuilderTools; note: ToolNote | null } {
  if (changed === 'reshade' && tools.reshade.mode === 'none' && tools.quantv.mode !== 'none') return { tools: { ...tools, quantv: toolOff() }, note: 'quantv-off' }
  if (changed !== 'reshade' && tools.quantv.mode !== 'none' && tools.reshade.mode === 'none') {
    const reshade = catalog.tools.find((t) => t.key === 'reshade')
    const on = reshade ? activeTool(reshade, packsOf(catalog, 'reshade')) : null
    return on ? { tools: { ...tools, reshade: on }, note: 'reshade-on' } : { tools, note: 'reshade-missing' }
  }
  return { tools, note: null }
}

/** Change le choix d'un outil, puis applique les règles entre outils (la règle appliquée est renvoyée pour l'expliquer). */
export function setTool(tools: BuilderTools, key: ToolKey, settings: BuilderToolSettings, catalog: BuilderCatalog): { tools: BuilderTools; note: ToolNote | null } {
  return applyRules({ ...tools, [key]: settings }, key, catalog)
}

/**
 * Change le mode d'un outil : « Réglé par moi » avec son style par défaut, « Importé d'un pack » avec le premier pack
 * (ou celui déjà choisi), « Aucun ». Les réglages faits pour l'ancien mode sont oubliés.
 */
export function setToolMode(tools: BuilderTools, key: ToolKey, mode: ToolMode, catalog: BuilderCatalog): { tools: BuilderTools; note: ToolNote | null } {
  const tool = catalog.tools.find((t) => t.key === key)
  const current = tools[key]
  if (current.mode === mode) return { tools, note: null }
  let next = toolOff()
  if (mode === 'custom' && tool?.custom) next = { ...toolOff(), mode, style: tool.defaultStyle }
  if (mode === 'pack') {
    const packs = packsOf(catalog, key)
    if (packs.length) next = { ...toolOff(), mode, component: packs[0] }
  }
  return setTool(tools, key, next, catalog)
}

/** Active un outil demandé (base manquante, QuantV sans ReShade) : son choix « Réglé par moi » ou un pack. */
export function enableTool(tools: BuilderTools, key: ToolKey, catalog: BuilderCatalog): { tools: BuilderTools; note: ToolNote | null } {
  if (tools[key].mode !== 'none') return { tools, note: null }
  const tool = catalog.tools.find((t) => t.key === key)
  const on = tool ? activeTool(tool, packsOf(catalog, key)) : null
  return on ? setTool(tools, key, on, catalog) : { tools, note: null }
}

/** Bases fournies par les outils actifs (un outil actif fournit sa propre base, QuantV fournit aussi ReShade). */
export function toolBases(tools: BuilderTools): string[] {
  const out = TOOL_KEYS.filter((k) => tools[k].mode !== 'none') as string[]
  if (tools.quantv.mode !== 'none') out.push('reshade')
  return out
}

// ---------------------------------------------------------------------------
// Aperçu d'un style

/**
 * Image de référence en jeu à montrer : celle choisie par le joueur (`chosen`) si le catalogue l'a encore, sinon celle
 * par défaut, sinon la première ; null sans image en jeu.
 */
export function pickReference(references: BuilderReference[], chosen: string | null = null): BuilderReference | null {
  return references.find((r) => r.id === chosen) ?? references.find((r) => r.byDefault) ?? references[0] ?? null
}

/**
 * Images sur lesquelles dessiner l'aperçu d'un style, dans l'ordre (la suivante sert quand une image ne se charge pas) :
 * celle du style (qui le montre déjà), l'image de référence en jeu choisie, celle par défaut, puis l'image du composant
 * de base de l'outil (catalogue sans image en jeu).
 */
export function lookImages(tool: BuilderTool, style: BuilderStyle | null, references: BuilderReference[], chosen: string | null): BuilderImageRef[] {
  const out: BuilderImageRef[] = []
  if (style?.imageVersion) out.push({ kind: 'style', styleId: style.id, version: style.imageVersion })
  const picked = pickReference(references, chosen)
  const fallback = pickReference(references)
  for (const r of picked === fallback ? [picked] : [picked, fallback]) if (r) out.push({ kind: 'reference', referenceId: r.id, version: r.version })
  if (tool.referenceComponent && tool.reference) out.push({ kind: 'component', componentId: tool.referenceComponent, imageId: tool.reference.id })
  return out
}

/** Réglages simples pris en compte par l'aperçu (curseurs de −100 à 100). */
export interface LookAdjust {
  brightness?: number
  contrast?: number
  saturation?: number
  temperature?: number
}

/**
 * Aperçu d'un style dessiné sur l'image de référence : filtres CSS, calque de couleur du style, calque de température
 * (chaud ou froid), vignettage et grain. Valeurs bornées (comme l'API les accepte), réglages simples compris.
 */
export interface PreviewLook {
  filter: string
  tint: { color: string; opacity: number } | null
  warmth: { color: string; opacity: number } | null
  vignette: number
  grain: number
}

const WARM = '#ff9a3c'
const COLD = '#4c9bff'

export function previewLook(preview: BuilderStylePreview | null | undefined, adjust: LookAdjust = {}): PreviewLook {
  const p = preview ?? null
  const slider = (v: number | undefined): number => clamp(typeof v === 'number' ? v : 0, -100, 100) / 100
  const factor = (v: number | null | undefined): number => clamp(typeof v === 'number' && Number.isFinite(v) ? v : 1, 0, 3)
  const unit = (v: number | null | undefined): number => clamp(typeof v === 'number' && Number.isFinite(v) ? v : 0, 0, 1)
  const brightness = clamp(factor(p?.brightness) * (1 + slider(adjust.brightness) * 0.4), 0, 3)
  const contrast = clamp(factor(p?.contrast) * (1 + slider(adjust.contrast) * 0.5), 0, 3)
  const saturate = clamp(factor(p?.saturate) * (1 + slider(adjust.saturation)), 0, 3)
  const sepia = unit(p?.sepia)
  const grayscale = unit(p?.grayscale)
  const hue = clamp(typeof p?.hueRotate === 'number' && Number.isFinite(p.hueRotate) ? p.hueRotate : 0, -360, 360)
  const round = (v: number): number => Math.round(v * 1000) / 1000
  const filter = [
    `brightness(${round(brightness)})`,
    `contrast(${round(contrast)})`,
    `saturate(${round(saturate)})`,
    `sepia(${round(sepia)})`,
    `grayscale(${round(grayscale)})`,
    `hue-rotate(${round(hue)}deg)`
  ].join(' ')
  const tint = p?.tint && /^#[0-9a-f]{6}$/i.test(p.tint) && unit(p.tintOpacity) > 0 ? { color: p.tint, opacity: unit(p.tintOpacity) } : null
  const t = slider(adjust.temperature)
  const warmth = t ? { color: t > 0 ? WARM : COLD, opacity: round(Math.abs(t) * 0.35) } : null
  return { filter, tint, warmth, vignette: unit(p?.vignette), grain: unit(p?.grain) }
}

function clamp(v: number, min: number, max: number): number {
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

// Poids des packs et des mods sur les performances, comparé à la machine de l'utilisateur.
//
// L'API estime le poids de chaque pack à partir de ses fichiers (`performance` dans les fiches, détail à
// GET /{packs|mods}/{id}/performance) et sert le modèle de comparaison (GET /app/performance) : classes de cartes
// graphiques, résolutions, seuils. La comparaison se fait ici, sur le poste : la configuration de la machine n'est
// jamais envoyée à l'API. Une copie du modèle est embarquée pour le mode hors ligne.
// Fonctions pures, partagées entre le processus principal et l'interface.

import { t } from 'i18next'

export type PerfTier = 'light' | 'medium' | 'heavy' | 'extreme'

/**
 * Résumé du poids d'un pack (besoins donnés pour la 1080p). `effectsMs` et `worldMs` : millisecondes ajoutées à chaque
 * image sur la carte de référence (classe 3) en 1080p, par les effets (ReShade, ENB, NVE) et la distance d'affichage.
 * `estimated` : une partie du pack, illisible (archives chiffrées), est estimée d'après sa taille.
 */
export interface PackPerformance {
  tier: PerfTier
  vramMb: number
  effectsMs: number
  worldMs: number
  minVramMb: number
  recommendedVramMb: number
  minGpuClass: number
  recommendedGpuClass: number
  estimated: boolean
}

export interface PerfGpuClass {
  /** 0 (graphiques intégrés) à 5 (très haut de gamme) ; 3 = carte de référence. */
  level: number
  label: string
  /** Vitesse par rapport à la carte de référence. */
  speed: number
  examples: string
  /** Noms de cartes (en minuscules), expressions régulières. */
  patterns: string[]
}

export interface PerfResolution {
  key: string
  /** Nombre de pixels au plus (largeur × hauteur) ; null : toutes les résolutions plus grandes. */
  maxPixels: number | null
  /** Temps d'une image du jeu seul sur la carte de référence. */
  baseFrameMs: number
  /** Coût des effets par rapport à la 1080p (proportionnel au nombre de pixels). */
  effectsScale: number
  /** Mémoire vidéo à ajouter aux besoins du pack (donnés pour la 1080p). */
  extraVramMb: number
}

/** Modèle de comparaison (GET /app/performance). */
export interface PerformanceModel {
  version: number
  /** Temps d'une image jouable (40 images par seconde) et visé (60). */
  minFrameMs: number
  targetFrameMs: number
  tiers: { key: PerfTier; label: string }[]
  gpuClasses: PerfGpuClass[]
  /** Carte d'ordinateur portable : `mobilePenalty` classe(s) de moins. */
  mobilePattern: string
  mobilePenalty: number
  resolutions: PerfResolution[]
}

/**
 * Copie du modèle de l'API (PerformanceModel, version 1), utilisée tant que l'API n'a pas répondu ou hors ligne. Les
 * libellés sont lus au moment de les afficher (accesseurs) : ils suivent la langue courante.
 */
export const EMBEDDED_PERFORMANCE_MODEL: PerformanceModel = {
  version: 1,
  minFrameMs: 25,
  targetFrameMs: 16.7,
  tiers: [
    {
      key: 'light',
      get label() {
        return t('performance.tier.light')
      }
    },
    {
      key: 'medium',
      get label() {
        return t('performance.tier.medium')
      }
    },
    {
      key: 'heavy',
      get label() {
        return t('performance.tier.heavy')
      }
    },
    {
      key: 'extreme',
      get label() {
        return t('performance.tier.extreme')
      }
    }
  ],
  gpuClasses: [
    {
      level: 0,
      get label() {
        return t('performance.gpuClass.level0.label')
      },
      speed: 0.2,
      get examples() {
        return t('performance.gpuClass.level0.examples')
      },
      patterns: ['intel.*(uhd|hd graphics|iris)', 'vega\\s*\\d{1,2}(?!\\d)', 'radeon\\s*(\\(tm\\)\\s*)?(r[2-7]\\s*)?graphics', 'microsoft basic']
    },
    {
      level: 1,
      get label() {
        return t('performance.gpuClass.level1.label')
      },
      speed: 0.45,
      examples: 'GTX 1050 Ti, GTX 960, RX 560, GT 1030',
      patterns: [
        'gtx\\s*(750|950|960|1050|1630)(?!\\d)',
        'gt\\s*1030(?!\\d)',
        'rx\\s*(460|550|560|6300)(?!\\d)',
        'mx\\s*\\d{3}(?!\\d)',
        'radeon\\s*(680m|660m|760m)',
        'arc(\\(tm\\))?\\s*(a3[15]0|graphics)'
      ]
    },
    {
      level: 2,
      get label() {
        return t('performance.gpuClass.level2.label')
      },
      speed: 0.7,
      examples: 'GTX 1060, GTX 1650, RX 580, GTX 970',
      patterns: [
        'gtx\\s*(780|970|980|1060|1650)(?!\\d)',
        'rx\\s*(470|480|570|580|590|5500|6400|6500)(?!\\d)',
        'arc(\\(tm\\))?\\s*a380(?!\\d)',
        'radeon\\s*(780m|880m|890m)'
      ]
    },
    {
      level: 3,
      get label() {
        return t('performance.gpuClass.level3.label')
      },
      speed: 1.0,
      examples: 'GTX 1070, GTX 1660 Super, RTX 2060, RTX 3050, RX 5600 XT, RX 6600',
      patterns: [
        'gtx\\s*(980\\s*ti|1070|1080|1660)(?!\\d)',
        'rtx\\s*(2060|3050|4050)(?!\\d)',
        'rx\\s*(5600|6600)(?!\\d)',
        'vega\\s*(56|64)(?!\\d)',
        'arc(\\(tm\\))?\\s*a(580|750)(?!\\d)'
      ]
    },
    {
      level: 4,
      get label() {
        return t('performance.gpuClass.level4.label')
      },
      speed: 1.6,
      examples: 'RTX 3060 / 3060 Ti / 3070, RTX 4060, RX 6700 XT, RX 7600',
      patterns: [
        'gtx\\s*1080\\s*ti',
        'rtx\\s*(2070|2080|3060|3070|4060|5060)(?!\\d)',
        'titan\\s*(xp|x|v)(?![a-z0-9])',
        'rx\\s*(5700|6600\\s*xt|6650|6700|6750|7600)(?!\\d)',
        'arc(\\(tm\\))?\\s*(a770|b570|b580)(?!\\d)'
      ]
    },
    {
      level: 5,
      get label() {
        return t('performance.gpuClass.level5.label')
      },
      speed: 2.6,
      get examples() {
        return t('performance.gpuClass.level5.examples')
      },
      patterns: ['rtx\\s*(2080\\s*ti|3070\\s*ti|3080|3090|40[789]0|50[789]0)(?!\\d)', 'titan\\s*rtx', 'rx\\s*(6800|6900|6950|7700|7800|7900|9060|9070)(?!\\d)']
    }
  ],
  mobilePattern: 'laptop|mobile|max-q|notebook',
  mobilePenalty: 1,
  resolutions: [
    { key: '1080p', maxPixels: 2_600_000, baseFrameMs: 9, effectsScale: 1.0, extraVramMb: 0 },
    { key: '1440p', maxPixels: 5_000_000, baseFrameMs: 12.5, effectsScale: 1.78, extraVramMb: 512 },
    { key: '2160p', maxPixels: null, baseFrameMs: 22, effectsScale: 4.0, extraVramMb: 1536 }
  ]
}

// ---------------------------------------------------------------------------
// Lecture des réponses de l'API (champs vérifiés : une réponse inattendue ne doit rien casser)

const TIERS: PerfTier[] = ['light', 'medium', 'heavy', 'extreme']
type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x)
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
const str = (x: unknown): string | null => (typeof x === 'string' ? x : null)
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])

/** Résumé reçu de l'API ; null s'il manque ou s'il est incomplet (pack pas encore analysé). */
export function parsePackPerformance(raw: unknown): PackPerformance | null {
  if (!isObj(raw)) return null
  const tier = TIERS.find((t) => t === raw.tier)
  const fields = ['vramMb', 'effectsMs', 'worldMs', 'minVramMb', 'recommendedVramMb', 'minGpuClass', 'recommendedGpuClass'] as const
  if (!tier || fields.some((f) => num(raw[f]) === null)) return null
  return {
    tier,
    vramMb: num(raw.vramMb)!,
    effectsMs: num(raw.effectsMs)!,
    worldMs: num(raw.worldMs)!,
    minVramMb: num(raw.minVramMb)!,
    recommendedVramMb: num(raw.recommendedVramMb)!,
    minGpuClass: num(raw.minGpuClass)!,
    recommendedGpuClass: num(raw.recommendedGpuClass)!,
    estimated: raw.estimated === true
  }
}

/** Modèle reçu de l'API ; null s'il est inutilisable (on garde alors celui qu'on a). */
export function parsePerformanceModel(raw: unknown): PerformanceModel | null {
  if (!isObj(raw)) return null
  const minFrameMs = num(raw.minFrameMs)
  const targetFrameMs = num(raw.targetFrameMs)
  const gpuClasses = list(raw.gpuClasses)
    .filter(isObj)
    .map((c) => ({
      level: num(c.level) ?? -1,
      label: str(c.label) ?? '',
      speed: num(c.speed) ?? 0,
      examples: str(c.examples) ?? '',
      patterns: list(c.patterns).filter((p): p is string => typeof p === 'string')
    }))
    .filter((c) => Number.isInteger(c.level) && c.level >= 0 && c.speed > 0)
    .sort((a, b) => a.level - b.level)
  const resolutions = list(raw.resolutions)
    .filter(isObj)
    .map((r) => ({
      key: str(r.key) ?? '',
      // null : au-delà de toutes les autres ; absent ou invalide : résolution écartée.
      maxPixels: r.maxPixels === null ? null : (num(r.maxPixels) ?? undefined),
      baseFrameMs: num(r.baseFrameMs) ?? 0,
      effectsScale: num(r.effectsScale) ?? 0,
      extraVramMb: num(r.extraVramMb) ?? 0
    }))
    .filter((r): r is PerfResolution => !!r.key && r.maxPixels !== undefined && r.baseFrameMs > 0 && r.effectsScale > 0)
  if (!minFrameMs || !targetFrameMs || !gpuClasses.length || !resolutions.length) return null
  const tiers = list(raw.tiers)
    .filter(isObj)
    .map((t) => ({ key: TIERS.find((k) => k === t.key), label: str(t.label) }))
    .filter((t): t is { key: PerfTier; label: string } => !!t.key && !!t.label)
  return {
    version: num(raw.version) ?? 0,
    minFrameMs,
    targetFrameMs,
    tiers: tiers.length ? tiers : EMBEDDED_PERFORMANCE_MODEL.tiers,
    gpuClasses,
    mobilePattern: str(raw.mobilePattern) ?? '',
    mobilePenalty: Math.max(0, Math.round(num(raw.mobilePenalty) ?? 0)),
    resolutions
  }
}

// ---------------------------------------------------------------------------
// Machine de l'utilisateur

/** Expression régulière de l'API ; null si elle ne se compile pas en JavaScript. */
function regex(pattern: string): RegExp | null {
  if (!pattern) return null
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}

/**
 * Classe d'une carte graphique d'après son nom : première expression qui correspond au nom en minuscules, de la classe
 * la plus haute à la plus basse ; une carte de portable perd `mobilePenalty` classe(s), sans descendre sous 0. Null si
 * la carte n'est pas reconnue.
 */
export function gpuClassOf(model: PerformanceModel, name: string | null | undefined): { level: number; mobile: boolean } | null {
  const n = (name ?? '').toLowerCase().trim()
  if (!n) return null
  const classes = [...model.gpuClasses].sort((a, b) => b.level - a.level)
  for (const c of classes) {
    if (!c.patterns.some((p) => regex(p)?.test(n))) continue
    const mobile = !!regex(model.mobilePattern)?.test(n)
    return {
      level: Math.max(0, mobile ? c.level - model.mobilePenalty : c.level),
      mobile
    }
  }
  return null
}

/** Résolution du modèle : la première dont `maxPixels` n'est pas dépassé (null : toutes les plus grandes). */
export function resolutionOf(model: PerformanceModel, width: number | null, height: number | null): PerfResolution {
  const sorted = [...model.resolutions].sort((a, b) => (a.maxPixels ?? Infinity) - (b.maxPixels ?? Infinity))
  if (!width || !height) return sorted[0]
  const pixels = width * height
  return sorted.find((r) => r.maxPixels === null || pixels <= r.maxPixels) ?? sorted[sorted.length - 1]
}

/** Carte graphique détectée sur la machine. */
export interface DetectedGpu {
  name: string
  /** Mémoire vidéo dédiée (null si elle n'a pas pu être lue). */
  vramMb: number | null
  /** registry : pilote (mémoire exacte) ; wmi : Win32_VideoController (mémoire plafonnée à 4 Go). */
  source: 'registry' | 'wmi'
}

/** Configuration de la machine, lue sur le poste (jamais envoyée à l'API). */
export interface HardwareInfo {
  gpu: DetectedGpu | null
  ramMb: number
  /** Résolution du jeu (gta5_settings.xml), sinon celle de l'écran principal. */
  screen: { width: number; height: number; source: 'game' | 'display' } | null
  /** Date de la détection de la carte graphique. */
  detectedAt: string | null
}

/** Corrections de l'utilisateur, quand la carte n'est pas reconnue ou que sa mémoire est mal lue (null : détectée). */
export interface HardwareOverride {
  gpuClass?: number | null
  vramMb?: number | null
}

/** Ce que l'interface reçoit pour comparer les packs à la machine. */
export interface MachineProfile {
  model: PerformanceModel
  hardware: HardwareInfo
  override: HardwareOverride
}

/** Machine telle qu'elle est comparée aux packs. */
export interface Machine {
  gpuName: string | null
  /** Classe de la carte (null : non reconnue et non corrigée). */
  gpuClass: number | null
  gpuClassSource: 'detected' | 'manual' | null
  mobile: boolean
  vramMb: number | null
  vramSource: 'detected' | 'manual' | null
  ramMb: number
  width: number | null
  height: number | null
  resolution: PerfResolution
}

export function machineOf(profile: MachineProfile): Machine {
  const { model, hardware, override } = profile
  const detected = gpuClassOf(model, hardware.gpu?.name)
  const manualClass = typeof override.gpuClass === 'number' && model.gpuClasses.some((c) => c.level === override.gpuClass) ? override.gpuClass : null
  const manualVram = typeof override.vramMb === 'number' && override.vramMb > 0 ? override.vramMb : null
  const detectedVram = hardware.gpu?.vramMb ?? null
  return {
    gpuName: hardware.gpu?.name ?? null,
    gpuClass: manualClass ?? detected?.level ?? null,
    gpuClassSource: manualClass !== null ? 'manual' : detected ? 'detected' : null,
    mobile: manualClass === null && !!detected?.mobile,
    vramMb: manualVram ?? detectedVram,
    vramSource: manualVram !== null ? 'manual' : detectedVram !== null ? 'detected' : null,
    ramMb: hardware.ramMb,
    width: hardware.screen?.width ?? null,
    height: hardware.screen?.height ?? null,
    resolution: resolutionOf(model, hardware.screen?.width ?? null, hardware.screen?.height ?? null)
  }
}

// ---------------------------------------------------------------------------
// Comparaison d'un pack à la machine

/**
 * smooth : fluide (60 images par seconde et mémoire recommandée) ; playable : jouable (40 images par seconde et mémoire
 * minimale) ; too-heavy : trop lourd ; not-analyzed : pack pas encore analysé ; unknown : machine inconnue (ni la carte
 * ni sa mémoire n'ont pu être lues).
 */
export type PerfVerdict = 'smooth' | 'playable' | 'too-heavy' | 'not-analyzed' | 'unknown'

/** Libellés des verdicts, dans la langue courante (lus au moment de les afficher). */
export const VERDICT_LABEL: Record<PerfVerdict, string> = {
  get smooth() {
    return t('performance.verdict.smooth')
  },
  get playable() {
    return t('performance.verdict.playable')
  },
  get 'too-heavy'() {
    return t('performance.verdict.tooHeavy')
  },
  get 'not-analyzed'() {
    return t('performance.verdict.notAnalyzed')
  },
  get unknown() {
    return t('performance.verdict.unknown')
  }
}

export interface PerfEstimate {
  verdict: PerfVerdict
  /** Temps d'une image estimé (null : carte non reconnue, ou pack non analysé). */
  frameMs: number | null
  fps: number | null
  /** Mémoire vidéo nécessaire à la résolution de l'utilisateur. */
  vram: { min: number; recommended: number } | null
  /** Seule la mémoire vidéo a été comparée : la carte n'est pas reconnue. */
  gpuUnknown: boolean
  /** Seul le temps d'une image a été comparé : la mémoire vidéo n'a pas pu être lue. */
  vramUnknown: boolean
}

/** Temps d'une image = (baseFrameMs + effectsMs × effectsScale + worldMs) / speed de la classe. */
export function frameMsOf(model: PerformanceModel, gpuClass: number, resolution: PerfResolution, effectsMs: number, worldMs: number): number | null {
  const speed = model.gpuClasses.find((c) => c.level === gpuClass)?.speed
  if (!speed) return null
  return (resolution.baseFrameMs + effectsMs * resolution.effectsScale + worldMs) / speed
}

export function estimate(model: PerformanceModel, machine: Machine, perf: PackPerformance | null | undefined): PerfEstimate {
  const none: PerfEstimate = {
    verdict: 'not-analyzed',
    frameMs: null,
    fps: null,
    vram: null,
    gpuUnknown: false,
    vramUnknown: false
  }
  if (!perf) return none
  const extra = machine.resolution.extraVramMb
  const vram = {
    min: perf.minVramMb + extra,
    recommended: perf.recommendedVramMb + extra
  }
  const frameMs = machine.gpuClass === null ? null : frameMsOf(model, machine.gpuClass, machine.resolution, perf.effectsMs, perf.worldMs)
  const fps = frameMs ? 1000 / frameMs : null
  const gpuUnknown = frameMs === null
  const vramUnknown = machine.vramMb === null
  if (gpuUnknown && vramUnknown) return { ...none, verdict: 'unknown', vram, gpuUnknown, vramUnknown }
  // Ce qu'on ne connaît pas de la machine n'est pas compté contre le pack.
  const fast = (limit: number): boolean => frameMs === null || frameMs <= limit
  const enough = (needed: number): boolean => machine.vramMb === null || machine.vramMb >= needed
  const verdict: PerfVerdict =
    fast(model.targetFrameMs) && enough(vram.recommended) ? 'smooth' : fast(model.minFrameMs) && enough(vram.min) ? 'playable' : 'too-heavy'
  return { verdict, frameMs, fps, vram, gpuUnknown, vramUnknown }
}

/** Libellé d'un niveau (« Moyen ») d'après le modèle. */
export function tierLabel(model: PerformanceModel, tier: PerfTier): string {
  return model.tiers.find((t) => t.key === tier)?.label ?? EMBEDDED_PERFORMANCE_MODEL.tiers.find((t) => t.key === tier)!.label
}

/**
 * Pack avec des éléments en plus (dossiers optionnels activés) ou un autre preset ReShade : coûts additionnés, mémoire
 * vidéo du pack ajoutée aux besoins. `effectsDelta` peut être négatif (preset plus léger que celui compté par l'API).
 */
export function adjustPerformance(perf: PackPerformance, extras: { effectsMs?: number; worldMs?: number; vramMb?: number }[]): PackPerformance {
  let { effectsMs, worldMs, vramMb, minVramMb, recommendedVramMb } = perf
  for (const e of extras) {
    effectsMs += e.effectsMs ?? 0
    worldMs += e.worldMs ?? 0
    vramMb += e.vramMb ?? 0
    minVramMb += e.vramMb ?? 0
    recommendedVramMb += e.vramMb ?? 0
  }
  return {
    ...perf,
    effectsMs: Math.max(0, effectsMs),
    worldMs: Math.max(0, worldMs),
    vramMb,
    minVramMb,
    recommendedVramMb
  }
}

/**
 * Coût d'effets (ms sur la référence en 1080p) ramené à la machine : à sa résolution et avec sa carte. Carte non
 * reconnue : à sa résolution, sur la carte de référence.
 */
export function costOnMachine(model: PerformanceModel, machine: Machine, effectsMs: number, worldMs = 0): number {
  const speed = (machine.gpuClass !== null && model.gpuClasses.find((c) => c.level === machine.gpuClass)?.speed) || 1
  return (effectsMs * machine.resolution.effectsScale + worldMs) / speed
}

// ---------------------------------------------------------------------------
// Analyse détaillée (GET /{packs|mods}/{id}/performance)

export type PerfImpact = 'low' | 'medium' | 'high'

export interface PerfHighlight {
  impact: PerfImpact
  text: string
}

export interface PerfTechnique {
  name: string
  costMs: number
  label: string
}

export interface PerfPreset {
  /** Chemin dans le pack. */
  path: string
  costMs: number
  techniques: PerfTechnique[]
}

export interface PerformanceReport {
  summary: PackPerformance | null
  textures: {
    totalMb: number
    vramMb: number
    archives: { path: string; texturesMb: number }[]
    unreadable: { path: string }[]
  } | null
  effects: {
    costMs: number
    /** `preset` : preset compté (chemin dans le pack) ; `chosenBy` : reshade-ini, only ou heaviest. */
    reshade: {
      preset: string | null
      chosenBy: string | null
      presets: PerfPreset[]
    } | null
  } | null
  highlights: PerfHighlight[]
  /** Dossiers optionnels (désactivés par défaut), comptés chacun seul. */
  options: {
    path: string
    summary: PackPerformance | null
    highlights: PerfHighlight[]
  }[]
}

export interface PerformanceDetail {
  status: 'none' | 'pending' | 'ready' | 'failed'
  tier: PerfTier | null
  report: PerformanceReport | null
}

const IMPACTS: PerfImpact[] = ['low', 'medium', 'high']

function parseHighlights(raw: unknown): PerfHighlight[] {
  return list(raw)
    .filter(isObj)
    .map((h) => ({
      impact: IMPACTS.find((i) => i === h.impact) ?? 'low',
      text: str(h.text) ?? ''
    }))
    .filter((h) => h.text.trim())
}

function parseTechniques(raw: unknown): PerfTechnique[] {
  return list(raw)
    .filter(isObj)
    .map((t) => ({
      name: str(t.name) ?? '',
      costMs: num(t.costMs) ?? 0,
      label: str(t.label) ?? ''
    }))
}

/** Réponse de GET /…/performance ; null si elle est inutilisable. */
export function parsePerformanceDetail(raw: unknown): PerformanceDetail | null {
  if (!isObj(raw)) return null
  const status = (['none', 'pending', 'ready', 'failed'] as const).find((s) => s === raw.status) ?? 'none'
  const tier = TIERS.find((t) => t === raw.tier) ?? null
  const r = raw.report
  let report: PerformanceReport | null = null
  if (isObj(r)) {
    const tex = isObj(r.textures) ? r.textures : null
    const eff = isObj(r.effects) ? r.effects : null
    const rs = eff && isObj(eff.reshade) ? eff.reshade : null
    report = {
      summary: parsePackPerformance(r.summary),
      textures: tex && {
        totalMb: num(tex.totalMb) ?? 0,
        vramMb: num(tex.vramMb) ?? 0,
        archives: list(tex.archives)
          .filter(isObj)
          .map((a) => ({
            path: str(a.path) ?? '',
            texturesMb: num(a.texturesMb) ?? 0
          })),
        unreadable: list(tex.unreadable)
          .filter(isObj)
          .map((u) => ({ path: str(u.path) ?? '' }))
      },
      effects: eff && {
        costMs: num(eff.costMs) ?? 0,
        reshade: rs && {
          preset: str(rs.preset),
          chosenBy: str(rs.chosenBy),
          presets: list(rs.presets)
            .filter(isObj)
            .map((p) => ({
              path: str(p.path) ?? '',
              costMs: num(p.costMs) ?? 0,
              techniques: parseTechniques(p.techniques)
            }))
            .filter((p) => p.path)
        }
      },
      highlights: parseHighlights(r.highlights),
      options: list(r.options)
        .filter(isObj)
        .map((o) => ({
          path: str(o.path) ?? '',
          summary: parsePackPerformance(o.summary),
          highlights: parseHighlights(o.highlights)
        }))
        .filter((o) => o.path)
    }
  }
  return { status, tier, report }
}

/** Preset ReShade de l'analyse qui correspond à un preset de la bibliothèque (chemin dans le contenu du pack). */
export function presetFor(report: PerformanceReport, rel: string | null | undefined): PerfPreset | null {
  if (!rel) return null
  return report.effects?.reshade?.presets.find((p) => samePackPath(p.path, rel)) ?? null
}

/** Dossier optionnel de l'analyse qui correspond à un composant de la bibliothèque (source dans le contenu du pack). */
export function optionFor(report: PerformanceReport, source: string): { path: string; summary: PackPerformance } | null {
  const o = report.options.find((x) => x.summary && samePackPath(x.path, source))
  return o ? { path: o.path, summary: o.summary! } : null
}

/**
 * Poids du pack tel qu'il sera installé : avec le preset ReShade choisi (à la place de celui compté par l'analyse) et
 * les dossiers optionnels activés (`components` : sources des composants installés). Null sans analyse.
 */
export function installedPerformance(report: PerformanceReport, choice: { preset: string | null | undefined; components: string[] }): PackPerformance | null {
  if (!report.summary) return null
  const extras: { effectsMs?: number; worldMs?: number; vramMb?: number }[] = []
  const counted = report.effects?.reshade?.preset ? report.effects.reshade.presets.find((p) => p.path === report.effects!.reshade!.preset) : null
  const chosen = presetFor(report, choice.preset)
  if (counted && chosen && chosen.path !== counted.path) extras.push({ effectsMs: chosen.costMs - counted.costMs })
  const seen = new Set<string>()
  for (const source of choice.components) {
    const o = optionFor(report, source)
    if (!o || seen.has(o.path)) continue
    seen.add(o.path)
    extras.push(o.summary)
  }
  return extras.length ? adjustPerformance(report.summary, extras) : report.summary
}

/**
 * Chemins de l'analyse (dans l'archive) et de la bibliothèque (dans le contenu du pack) : le dossier racine de
 * l'archive peut avoir été retiré à l'ajout. Deux chemins correspondent si l'un se termine par l'autre.
 */
export function samePackPath(a: string, b: string): boolean {
  const norm = (p: string): string =>
    p
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .toLowerCase()
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`)
}

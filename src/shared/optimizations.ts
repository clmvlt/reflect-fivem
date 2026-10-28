// Optimisations pour les PC modestes : réglages du jeu (gta5_settings.xml, fivem.cfg) et de Windows, appliqués en un
// clic et annulables. Définitions et fonctions pures, partagées entre le processus principal (qui lit et change le
// système : core/optimizations.ts) et l'interface.
//
// Seules les techniques dont l'effet est établi sont proposées : les réglages réseau « anti-ping », la planification GPU
// matérielle, les réglages du planificateur multimédia, du minuteur (bcdedit) ou de SysMain, commandline.txt (ignoré par
// FiveM) et les options de compatibilité (effacées par FiveM à chaque lancement) n'y sont pas.

export const OPTIMIZATION_GROUPS = ['game', 'windows'] as const
export type OptimizationGroup = (typeof OPTIMIZATION_GROUPS)[number]

export type OptimizationId =
  | 'graphics'
  | 'distance'
  | 'scaling'
  | 'vehicle-textures'
  | 'texture-budget'
  | 'nui-gpu'
  | 'power'
  | 'gpu'
  | 'game-dvr'
  | 'game-mode'
  | 'windowed'
  | 'pagefile'
  | 'priority'
  | 'defender'

export type Gain = 'high' | 'medium' | 'low'

export interface OptimizationDef {
  id: OptimizationId
  group: OptimizationGroup
  gain: Gain
  /** Au choix : change l'image, la sécurité ou un comportement visible ; pas compris dans « Tout appliquer ». */
  optional?: boolean
  /** Demande l'autorisation administrateur (une seule demande pour toutes celles appliquées ensemble). */
  admin?: boolean
  /** Prend effet au redémarrage du PC (sinon au prochain lancement du jeu). */
  reboot?: boolean
  /** Modifie des fichiers que FiveM réécrit en quittant : le jeu doit être fermé. */
  gameClosed?: boolean
}

export const OPTIMIZATIONS: OptimizationDef[] = [
  { id: 'graphics', group: 'game', gain: 'high', gameClosed: true },
  { id: 'distance', group: 'game', gain: 'high', gameClosed: true },
  { id: 'scaling', group: 'game', gain: 'high', optional: true, gameClosed: true },
  { id: 'vehicle-textures', group: 'game', gain: 'medium', gameClosed: true },
  { id: 'texture-budget', group: 'game', gain: 'medium', gameClosed: true },
  { id: 'nui-gpu', group: 'game', gain: 'low', gameClosed: true },
  { id: 'power', group: 'windows', gain: 'medium' },
  { id: 'gpu', group: 'windows', gain: 'high' },
  { id: 'game-dvr', group: 'windows', gain: 'low' },
  { id: 'game-mode', group: 'windows', gain: 'low' },
  { id: 'pagefile', group: 'windows', gain: 'medium', admin: true, reboot: true },
  { id: 'windowed', group: 'windows', gain: 'low', optional: true },
  { id: 'priority', group: 'windows', gain: 'low', optional: true },
  { id: 'defender', group: 'windows', gain: 'low', optional: true, admin: true }
]

export const optimizationDef = (id: OptimizationId): OptimizationDef => OPTIMIZATIONS.find((o) => o.id === id)!

/**
 * on : en place, changée par l'application (annulable) ; native : déjà en place sur ce PC, sans l'application ;
 * partial : changée par l'application, mais une partie n'est plus (ou pas encore) en place ; off : pas en place ;
 * na : ne s'applique pas à ce PC (raison dans `note`).
 */
export type OptimizationStatus = 'on' | 'native' | 'partial' | 'off' | 'na'

export interface OptimizationState {
  id: OptimizationId
  status: OptimizationStatus
  /** Changée par l'application : « Annuler » remet les valeurs d'avant. */
  undoable: boolean
  /** Détail dans la langue affichée : raison (na), ce qui sera fait sur ce PC, ce qui manque (partial). */
  note: string | null
}

/** Vérifications et conseils (rien n'est changé automatiquement). */
export type CheckId = 'power-source' | 'memory-integrity' | 'driver' | 'disk' | 'ram' | 'single-channel' | 'startup' | 'overlays'

/** ok : rien à faire ; warn : à corriger ; info : conseil. */
export type CheckLevel = 'ok' | 'warn' | 'info'

/** Pages ouvertes par les boutons des vérifications (l'adresse est choisie par le processus principal). */
export type GuideLink =
  | 'startup-apps'
  | 'core-isolation'
  | 'driver-nvidia'
  | 'driver-amd'
  | 'driver-intel'
  | 'driver-update'
  | 'power-settings'
  | 'game-bar'

export interface CheckState {
  id: CheckId
  level: CheckLevel
  /** Constat dans la langue affichée (« Pilote du 12 mars 2024 »). */
  detail: string | null
  link: GuideLink | null
}

export interface OptimizationsOverview {
  items: OptimizationState[]
  checks: CheckState[]
  /** FiveM lancé : les réglages du jeu ne peuvent pas être changés. */
  gameRunning: boolean
}

/** Résultat de « Appliquer » ou « Annuler ». */
export interface OptimizationsResult {
  overview: OptimizationsOverview
  done: OptimizationId[]
  failed: { id: OptimizationId; error: string }[]
  /** Autorisation administrateur refusée (les optimisations qui la demandaient n'ont pas été faites). */
  denied: boolean
  /** Un redémarrage du PC est nécessaire pour terminer. */
  reboot: boolean
}

/** Optimisations de « Tout appliquer » : les recommandées qui peuvent encore être appliquées. */
export function recommendedToApply(items: OptimizationState[]): OptimizationId[] {
  return items.filter((i) => (i.status === 'off' || i.status === 'partial') && !optimizationDef(i.id).optional).map((i) => i.id)
}

/** Optimisations de « Tout annuler ». */
export function undoableIds(items: OptimizationState[]): OptimizationId[] {
  return items.filter((i) => i.undoable).map((i) => i.id)
}

// ---------------------------------------------------------------------------
// Réglages du jeu (gta5_settings.xml)

/**
 * Valeurs visées par une optimisation du fichier de réglages : `max` pour les nombres (une valeur déjà plus basse est
 * gardée), `value` pour une valeur exacte (booléens).
 */
export type GraphicsTarget = Record<string, { max: number } | { value: string }>

/** Machine telle que l'optimisation des réglages la prend en compte. */
export interface GraphicsMachine {
  /** Classe de la carte (0 : graphiques intégrés ; null : non reconnue). */
  gpuClass: number | null
  vramMb: number | null
  /** Effets du pack installé (NVE, QuantV...) : ils ont besoin de certains réglages. */
  features: string[]
}

const integrated = (m: GraphicsMachine): boolean => m.gpuClass === 0

/** NVE et QuantV demandent shaders et post-traitement au moins en « Très élevé » (voir recommendationsFor). */
const needsShaders = (m: GraphicsMachine): boolean => m.features.includes('NVE') || m.features.includes('QuantV')

/**
 * Graphismes allégés : chaque réglage au plus bas qui garde une image correcte. Textures « Élevé » si la carte a au
 * moins 3,5 Go de mémoire vidéo (sinon « Normal ») ; shaders et post-traitement gardés pour NVE et QuantV. Jamais la
 * version de DirectX, le mode d'affichage ni la synchronisation verticale.
 */
export function graphicsTarget(m: GraphicsMachine): GraphicsTarget {
  const lowVram = integrated(m) || (m.vramMb !== null && m.vramMb < 3584)
  const off = { value: 'false' }
  return {
    TextureQuality: { max: lowVram ? 0 : 1 },
    ShaderQuality: { max: needsShaders(m) ? 2 : 0 },
    PostFX: { max: needsShaders(m) ? 2 : 0 },
    ShadowQuality: { max: 1 },
    Shadow_SoftShadows: { max: 1 },
    UltraShadows_Enabled: off,
    Shadow_LongShadows: off,
    Shadow_ParticleShadows: off,
    ReflectionQuality: { max: 0 },
    ReflectionMSAA: { max: 0 },
    WaterQuality: { max: 0 },
    ParticleQuality: { max: 0 },
    GrassQuality: { max: 0 },
    SSAO: { max: 0 },
    Tessellation: { max: 0 },
    AnisotropicFiltering: { max: integrated(m) ? 0 : 4 },
    MSAA: { max: 0 },
    TXAA_Enabled: off,
    DoF: off,
    MotionBlurStrength: { max: 0 },
    Lighting_FogVolumes: off,
    Reflection_MipBlur: off,
    HdStreamingInFlight: off
  }
}

/** Distance d'affichage et population : la distance étendue est le réglage le plus coûteux du jeu. */
export function distanceTarget(): GraphicsTarget {
  return {
    LodScale: { max: 0 },
    MaxLodScale: { max: 0 },
    PedLodBias: { max: 0 },
    VehicleLodBias: { max: 0 },
    Shadow_Distance: { max: 1 },
    CityDensity: { max: 0.2 },
    PedVarietyMultiplier: { max: 0.2 },
    VehicleVarietyMultiplier: { max: 0.2 }
  }
}

/**
 * Mise à l'échelle de l'image (SamplingMode) : 0 = taille réelle, 1 = 1/2, 2 = 2/3, 3 = 3/4, 4 = 5/6, 5 à 9 = au-delà
 * (5/4 à 5/2). Échelle par côté de chaque valeur.
 */
export const SAMPLING_SCALE = [1, 0.5, 2 / 3, 0.75, 5 / 6, 1.25, 1.5, 1.75, 2, 2.5]

/** Résolution de rendu visée : 2/3 sur des graphiques intégrés, 3/4 sinon. */
export function scalingValue(m: GraphicsMachine): number {
  return integrated(m) ? 2 : 3
}

/** Valeurs à écrire pour atteindre la cible (vide : déjà en place). Les réglages absents du fichier sont ignorés. */
export function graphicsChanges(values: Record<string, string>, target: GraphicsTarget): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, want] of Object.entries(target)) {
    const current = values[key]
    if (current === undefined) continue
    if ('value' in want) {
      if (current !== want.value) out[key] = want.value
    } else {
      const n = Number(current)
      if (!Number.isFinite(n) || n > want.max + 1e-6) out[key] = String(want.max)
    }
  }
  return out
}

/** Changement de la mise à l'échelle (vide si l'image est déjà rendue à l'échelle visée ou plus bas). */
export function scalingChanges(values: Record<string, string>, wanted: number): Record<string, string> {
  const current = values.SamplingMode
  if (current === undefined) return {}
  const scale = SAMPLING_SCALE[Number(current)]
  return scale !== undefined && scale <= SAMPLING_SCALE[wanted] + 1e-6 ? {} : { SamplingMode: String(wanted) }
}

// ---------------------------------------------------------------------------
// Réglages de FiveM (fivem.cfg : une ligne « seta "nom" "valeur" » par réglage)

const CFG_LINE = /^\s*seta\s+"([^"]+)"\s+"([^"]*)"\s*$/

/** Réglages du fichier fivem.cfg. */
export function parseCfg(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = CFG_LINE.exec(line)
    if (m && !(m[1] in out)) out[m[1]] = m[2]
  }
  return out
}

/**
 * Fichier fivem.cfg modifié : valeurs remplacées sur leur ligne, réglages absents ajoutés à la fin, `null` retire la
 * ligne (FiveM reprend sa valeur par défaut). Le reste du fichier et ses fins de ligne sont gardés.
 */
export function applyCfg(text: string, changes: Record<string, string | null>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const done = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    const m = CFG_LINE.exec(line)
    if (m && m[1] in changes && !done.has(m[1])) {
      done.add(m[1])
      const v = changes[m[1]]
      if (v !== null) out.push(`seta "${m[1]}" "${v}"`)
      continue
    }
    out.push(line)
  }
  const added = Object.entries(changes).filter(([k, v]) => !done.has(k) && v !== null)
  if (added.length) {
    // Avant la dernière ligne vide (fin de fichier).
    const end = out.length && out[out.length - 1] === '' ? out.pop() : undefined
    for (const [k, v] of added) out.push(`seta "${k}" "${v}"`)
    if (end !== undefined) out.push(end)
  }
  return out.join(eol)
}

/** Textures des véhicules : 512 (256 pour les formats non compressés) ; une valeur déjà plus basse est gardée. */
export const VEHICLE_TEXTURES: Record<string, number> = { str_maxVehicleTextureRes: 512, str_maxVehicleTextureResRgba: 256 }

/** Réglages de fivem.cfg à changer pour ne pas dépasser `max` (absents : valeur par défaut de FiveM, `defaults`). */
export function cfgMaxChanges(values: Record<string, string>, max: Record<string, number>, defaults: Record<string, number>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, limit] of Object.entries(max)) {
    const raw = values[key]
    const n = raw === undefined ? defaults[key] : Number(raw)
    if (!Number.isFinite(n) || n > limit) out[key] = String(limit)
  }
  return out
}

/** Valeurs par défaut de FiveM des réglages touchés. */
export const CFG_DEFAULTS: Record<string, number> = { str_maxVehicleTextureRes: 1024, str_maxVehicleTextureResRgba: 512, vid_budgetScale: 0 }

// ---------------------------------------------------------------------------
// Windows

/**
 * Préférences DirectX d'un programme (« GpuPreference=2;AppStatus=0; ») : valeurs remplacées ou ajoutées, les autres
 * gardées dans leur ordre.
 */
export function mergeDirectXPrefs(current: string | null | undefined, set: Record<string, string>): string {
  const pairs: [string, string][] = []
  for (const part of (current ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    pairs.push([part.slice(0, i).trim(), part.slice(i + 1).trim()])
  }
  for (const [k, v] of Object.entries(set)) {
    const found = pairs.find((p) => p[0].toLowerCase() === k.toLowerCase())
    if (found) found[1] = v
    else pairs.push([k, v])
  }
  return pairs.map(([k, v]) => `${k}=${v};`).join('')
}

/** Valeur d'une préférence DirectX (null si absente). */
export function directXPref(current: string | null | undefined, key: string): string | null {
  for (const part of (current ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim().toLowerCase() === key.toLowerCase()) return part.slice(i + 1).trim()
  }
  return null
}

/** Plans d'alimentation et modes de Windows 11. */
export const POWER = {
  balanced: '381b4222-f694-41f0-9685-ff5bb260df2e',
  high: '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c',
  /** Mode d'alimentation « Meilleures performances » de Windows 11 (sur secteur). */
  bestPerformanceMode: 'ded574b5-45a0-4f42-8737-46345c09c238'
} as const

/** Mémoire virtuelle suffisante : gérée par Windows, ou fichiers dont la taille maximale atteint la mémoire vive. */
export function pagefileOk(p: { auto: boolean | null; files: { initial: number; maximum: number }[] }, ramMb: number): boolean | null {
  if (p.auto === null) return null
  if (p.auto) return true
  if (!p.files.length) return false
  // 0 et 0 : taille gérée par Windows pour ce fichier.
  if (p.files.some((f) => f.initial === 0 && f.maximum === 0)) return true
  return p.files.reduce((s, f) => s + f.maximum, 0) >= ramMb
}

/** Pilote « vieux » au-delà d'un an. */
export function driverAgeDays(date: string | null, now: Date = new Date()): number | null {
  if (!date) return null
  const d = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  return Math.floor((now.getTime() - d.getTime()) / 86_400_000)
}

/** Fabricant d'une carte graphique d'après son nom. */
export function gpuVendor(name: string): 'nvidia' | 'amd' | 'intel' | null {
  if (/nvidia|geforce|quadro|rtx|gtx/i.test(name)) return 'nvidia'
  if (/amd|radeon/i.test(name)) return 'amd'
  if (/intel/i.test(name)) return 'intel'
  return null
}

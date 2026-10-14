// Réglages graphiques de GTA V (gta5_settings.xml pour FiveM, settings.xml pour le mode solo).
// Valeurs : correspondance du menu Graphismes du jeu (0 = Normal, 1 = Élevé, 2 = Très élevé, 3 = Ultra...).

import { t } from 'i18next'
import type fr from './locales/fr.json'

type Texts = (typeof fr)['graphics']

export type GraphicsKind = 'choice' | 'bool' | 'range'

/** Groupes de réglages : identifiants stables, libellés traduits (GRAPHICS_GROUP_LABEL). */
export const GRAPHICS_GROUPS = ['display', 'quality', 'antialiasing', 'distance', 'effects'] as const
export type GraphicsGroup = (typeof GRAPHICS_GROUPS)[number]

export const GRAPHICS_GROUP_LABEL: Record<GraphicsGroup, string> = {
  get display() {
    return t('graphics.groups.display')
  },
  get quality() {
    return t('graphics.groups.quality')
  },
  get antialiasing() {
    return t('graphics.groups.antialiasing')
  },
  get distance() {
    return t('graphics.groups.distance')
  },
  get effects() {
    return t('graphics.groups.effects')
  }
}

export interface GraphicsSettingDef {
  key: string
  /** Libellé dans la langue affichée (lu au moment de l'affichage). */
  readonly label: string
  group: GraphicsGroup
  kind: GraphicsKind
  options?: { value: string; readonly label: string }[]
  min?: number
  max?: number
  step?: number
}

type Option = { value: string; readonly label: string }

/** Valeur dont le libellé est traduit à la lecture. */
const opt = (value: string, text: keyof Texts['values']): Option => ({
  value,
  get label() {
    return t(`graphics.values.${text}`)
  }
})
/** Valeur dont le libellé ne se traduit pas (noms techniques). */
const raw = (value: string, label: string): Option => ({ value, label })

/** Réglage : libellé traduit à la lecture (clé graphics.settings.<text>) ou nom technique non traduit. */
function setting(
  key: string,
  text: keyof Texts['settings'] | { raw: string },
  group: GraphicsGroup,
  kind: GraphicsKind,
  extra: Pick<GraphicsSettingDef, 'options' | 'min' | 'max' | 'step'> = {}
): GraphicsSettingDef {
  return {
    key,
    group,
    kind,
    ...extra,
    get label() {
      return typeof text === 'string' ? t(`graphics.settings.${text}`) : text.raw
    }
  }
}

const q3 = [opt('0', 'normal'), opt('1', 'high'), opt('2', 'veryHigh')]
const q4 = [...q3, raw('3', 'Ultra')]
const aa = [opt('0', 'off'), raw('2', 'x2'), raw('4', 'x4'), raw('8', 'x8')]
const range = (max: number): Pick<GraphicsSettingDef, 'min' | 'max' | 'step'> => ({ min: 0, max, step: 0.1 })

export const GRAPHICS_SETTINGS: GraphicsSettingDef[] = [
  setting('DX_Version', 'dxVersion', 'display', 'choice', {
    options: [raw('0', 'DirectX 10'), raw('1', 'DirectX 10.1'), raw('2', 'DirectX 11')]
  }),
  setting('Windowed', 'windowed', 'display', 'choice', {
    options: [opt('0', 'fullscreen'), opt('1', 'windowed'), opt('2', 'borderless')]
  }),
  setting('VSync', 'vsync', 'display', 'choice', {
    options: [opt('0', 'offFeminine'), opt('1', 'onFeminine'), opt('2', 'half')]
  }),

  setting('TextureQuality', 'textures', 'quality', 'choice', { options: q3 }),
  setting('ShaderQuality', 'shaders', 'quality', 'choice', { options: q3 }),
  setting('ShadowQuality', 'shadows', 'quality', 'choice', {
    options: [opt('0', 'offFemininePlural'), opt('1', 'normal'), opt('2', 'high'), opt('3', 'veryHigh')]
  }),
  setting('Shadow_SoftShadows', 'softShadows', 'quality', 'choice', {
    options: [opt('0', 'sharp'), opt('1', 'soft'), opt('2', 'softer'), opt('3', 'softest'), raw('4', 'AMD CHS'), raw('5', 'NVIDIA PCSS')]
  }),
  setting('ReflectionQuality', 'reflections', 'quality', 'choice', { options: q4 }),
  setting('WaterQuality', 'water', 'quality', 'choice', { options: q3 }),
  setting('ParticleQuality', 'particles', 'quality', 'choice', { options: q3 }),
  setting('GrassQuality', 'grass', 'quality', 'choice', { options: q4 }),
  setting('PostFX', 'postFx', 'quality', 'choice', { options: q4 }),
  setting('SSAO', 'ssao', 'quality', 'choice', {
    options: [opt('0', 'offFeminine'), opt('1', 'normal'), opt('2', 'high')]
  }),
  setting('Tessellation', 'tessellation', 'quality', 'choice', {
    options: [opt('0', 'offFeminine'), opt('1', 'normal'), opt('2', 'high'), opt('3', 'veryHigh')]
  }),
  setting('AnisotropicFiltering', 'anisotropic', 'quality', 'choice', {
    options: [opt('0', 'off'), ...aa.slice(1), raw('16', 'x16')]
  }),

  setting('MSAA', { raw: 'MSAA' }, 'antialiasing', 'choice', { options: aa }),
  setting('ReflectionMSAA', 'reflectionMsaa', 'antialiasing', 'choice', { options: aa }),
  setting('FXAA_Enabled', { raw: 'FXAA' }, 'antialiasing', 'bool'),
  setting('TXAA_Enabled', { raw: 'TXAA (NVIDIA)' }, 'antialiasing', 'bool'),

  setting('LodScale', 'lodScale', 'distance', 'range', range(1)),
  setting('MaxLodScale', 'maxLodScale', 'distance', 'range', range(1)),
  setting('Shadow_Distance', 'shadowDistance', 'distance', 'range', range(2)),
  setting('CityDensity', 'cityDensity', 'distance', 'range', range(1)),
  setting('PedVarietyMultiplier', 'pedVariety', 'distance', 'range', range(1)),
  setting('VehicleVarietyMultiplier', 'vehicleVariety', 'distance', 'range', range(1)),

  setting('DoF', 'dof', 'effects', 'bool'),
  setting('MotionBlurStrength', 'motionBlur', 'effects', 'range', range(1)),
  setting('UltraShadows_Enabled', 'ultraShadows', 'effects', 'bool'),
  setting('Shadow_LongShadows', 'longShadows', 'effects', 'bool'),
  setting('HdStreamingInFlight', 'hdStreaming', 'effects', 'bool')
]

export const GRAPHICS_KEYS = new Set(GRAPHICS_SETTINGS.map((s) => s.key))

/** Préréglages : ne touchent qu'à la qualité (jamais à l'affichage ni à DirectX). */
export type GraphicsPresetId = 'performance' | 'balanced' | 'quality' | 'ultra'

/** Libellés traduits à la lecture. */
export const GRAPHICS_PRESETS: { id: GraphicsPresetId; readonly label: string; values: Record<string, string> }[] = [
  {
    id: 'performance',
    get label() {
      return t('graphics.preset.performance')
    },
    values: {
      TextureQuality: '1',
      ShaderQuality: '1',
      ShadowQuality: '1',
      Shadow_SoftShadows: '1',
      ReflectionQuality: '0',
      ReflectionMSAA: '0',
      WaterQuality: '0',
      ParticleQuality: '0',
      GrassQuality: '0',
      PostFX: '1',
      SSAO: '0',
      Tessellation: '0',
      AnisotropicFiltering: '4',
      MSAA: '0',
      FXAA_Enabled: 'true',
      TXAA_Enabled: 'false',
      LodScale: '0.500000',
      MaxLodScale: '0.000000',
      Shadow_Distance: '1.000000',
      CityDensity: '0.600000',
      PedVarietyMultiplier: '0.600000',
      VehicleVarietyMultiplier: '0.600000',
      DoF: 'false',
      UltraShadows_Enabled: 'false',
      Shadow_LongShadows: 'false'
    }
  },
  {
    id: 'balanced',
    get label() {
      return t('graphics.preset.balanced')
    },
    values: {
      TextureQuality: '2',
      ShaderQuality: '2',
      ShadowQuality: '2',
      Shadow_SoftShadows: '2',
      ReflectionQuality: '1',
      ReflectionMSAA: '0',
      WaterQuality: '1',
      ParticleQuality: '1',
      GrassQuality: '1',
      PostFX: '2',
      SSAO: '1',
      Tessellation: '2',
      AnisotropicFiltering: '16',
      MSAA: '0',
      FXAA_Enabled: 'true',
      TXAA_Enabled: 'false',
      LodScale: '0.800000',
      MaxLodScale: '0.000000',
      Shadow_Distance: '1.000000',
      CityDensity: '0.800000',
      PedVarietyMultiplier: '0.800000',
      VehicleVarietyMultiplier: '0.800000',
      DoF: 'false',
      UltraShadows_Enabled: 'false',
      Shadow_LongShadows: 'false'
    }
  },
  {
    id: 'quality',
    get label() {
      return t('graphics.preset.quality')
    },
    values: {
      TextureQuality: '2',
      ShaderQuality: '2',
      ShadowQuality: '3',
      Shadow_SoftShadows: '3',
      ReflectionQuality: '2',
      ReflectionMSAA: '2',
      WaterQuality: '2',
      ParticleQuality: '2',
      GrassQuality: '2',
      PostFX: '2',
      SSAO: '2',
      Tessellation: '3',
      AnisotropicFiltering: '16',
      MSAA: '0',
      FXAA_Enabled: 'true',
      TXAA_Enabled: 'false',
      LodScale: '1.000000',
      MaxLodScale: '0.300000',
      Shadow_Distance: '1.300000',
      CityDensity: '1.000000',
      PedVarietyMultiplier: '1.000000',
      VehicleVarietyMultiplier: '1.000000',
      DoF: 'true',
      UltraShadows_Enabled: 'false',
      Shadow_LongShadows: 'true'
    }
  },
  {
    id: 'ultra',
    get label() {
      return t('graphics.preset.ultra')
    },
    values: {
      TextureQuality: '2',
      ShaderQuality: '2',
      ShadowQuality: '3',
      Shadow_SoftShadows: '3',
      ReflectionQuality: '3',
      ReflectionMSAA: '4',
      WaterQuality: '2',
      ParticleQuality: '2',
      GrassQuality: '3',
      PostFX: '3',
      SSAO: '2',
      Tessellation: '3',
      AnisotropicFiltering: '16',
      MSAA: '0',
      FXAA_Enabled: 'true',
      TXAA_Enabled: 'false',
      LodScale: '1.000000',
      MaxLodScale: '1.000000',
      Shadow_Distance: '2.000000',
      CityDensity: '1.000000',
      PedVarietyMultiplier: '1.000000',
      VehicleVarietyMultiplier: '1.000000',
      DoF: 'true',
      UltraShadows_Enabled: 'true',
      Shadow_LongShadows: 'true'
    }
  }
]

export interface GraphicsRecommendation {
  key: string
  /** Valeur minimale acceptée (comparaison numérique) ou valeur exacte. */
  min?: number
  exact?: string
  /** Valeur appliquée par « Appliquer les recommandations ». */
  value: string
  /** Raison affichée, dans la langue courante au moment de l'appel à recommendationsFor. */
  reason: string
}

/**
 * Réglages nécessaires au bon rendu des mods graphiques présents dans un pack :
 * ENB et ReShade exigent DirectX 11 ; NVE et QuantV demandent post-traitement et shaders au moins en « Très élevé » ;
 * le MSAA empêche ReShade et NVE d'accéder à la profondeur de l'image.
 */
export function recommendationsFor(features: string[]): GraphicsRecommendation[] {
  const f = new Set(features)
  const out: GraphicsRecommendation[] = []
  if (f.has('ENB') || f.has('ReShade') || f.has('NVE') || f.has('QuantV'))
    out.push({ key: 'DX_Version', exact: '2', value: '2', reason: t('graphics.reco.dx11') })
  if (f.has('NVE') || f.has('QuantV')) {
    out.push({ key: 'PostFX', min: 2, value: '3', reason: t('graphics.reco.postFx') })
    out.push({ key: 'ShaderQuality', min: 2, value: '2', reason: t('graphics.reco.shaders') })
  }
  if (f.has('ReShade') || f.has('NVE')) out.push({ key: 'MSAA', exact: '0', value: '0', reason: t('graphics.reco.msaa') })
  return out
}

export function unmet(recos: GraphicsRecommendation[], values: Record<string, string>): GraphicsRecommendation[] {
  return recos.filter((r) => {
    const v = values[r.key]
    if (v === undefined) return false
    if (r.exact !== undefined) return v !== r.exact
    return Number(v) < (r.min ?? 0)
  })
}

export interface GraphicsTarget {
  id: 'fivem' | 'gta'
  /** Nom du jeu, traduit quand la cible est construite (GraphicsManager.targets). */
  label: string
  path: string
}

export interface GraphicsState {
  target: GraphicsTarget
  targets: GraphicsTarget[]
  values: Record<string, string>
  videoCard: string | null
  resolution: string | null
  hasBackup: boolean
  readOnly: boolean
}

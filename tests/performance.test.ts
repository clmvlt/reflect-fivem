// Poids des packs et machine : classe de la carte graphique, résolution, coûts ramenés à la machine, lecture des
// réponses de l'API, preset et options de l'analyse retrouvés dans la bibliothèque.
import { describe, expect, it } from 'vitest'
import {
  costOnMachine,
  EMBEDDED_PERFORMANCE_MODEL as MODEL,
  gpuClassOf,
  machineOf,
  optionFor,
  parsePackPerformance,
  parsePerformanceDetail,
  parsePerformanceModel,
  presetFor,
  resolutionOf,
  samePackPath,
  type HardwareInfo,
  type HardwareOverride,
  type Machine,
  type PackPerformance,
  type PerformanceReport
} from '../src/shared/performance'

const perf = (extra: Partial<PackPerformance> = {}): PackPerformance => ({
  tier: 'medium',
  vramMb: 800,
  effectsMs: 2,
  worldMs: 1,
  minVramMb: 3584,
  recommendedVramMb: 5120,
  minGpuClass: 2,
  recommendedGpuClass: 3,
  estimated: false,
  ...extra
})

const hardware = (name: string | null, vramMb: number | null, width = 1920, height = 1080): HardwareInfo => ({
  gpu: name ? { name, vramMb, source: 'registry' } : null,
  ramMb: 32768,
  screen: { width, height, source: 'game' },
  detectedAt: '2026-10-14T10:00:00Z'
})

const machine = (name: string | null, vramMb: number | null, width = 1920, height = 1080, override: HardwareOverride = {}): Machine =>
  machineOf({ model: MODEL, hardware: hardware(name, vramMb, width, height), override })

describe('classe de la carte graphique', () => {
  it('reconnaît les cartes de bureau, de la classe la plus haute à la plus basse', () => {
    expect(gpuClassOf(MODEL, 'NVIDIA GeForce RTX 3080')).toEqual({ level: 5, mobile: false })
    expect(gpuClassOf(MODEL, 'NVIDIA GeForce RTX 3070 Ti')?.level).toBe(5)
    expect(gpuClassOf(MODEL, 'NVIDIA GeForce RTX 3070')?.level).toBe(4)
    // « 1080 Ti » est en classe 4, avant la « 1080 » de la classe 3.
    expect(gpuClassOf(MODEL, 'NVIDIA GeForce GTX 1080 Ti')?.level).toBe(4)
    expect(gpuClassOf(MODEL, 'NVIDIA GeForce GTX 1080')?.level).toBe(3)
    expect(gpuClassOf(MODEL, 'NVIDIA GeForce GTX 1660 SUPER')?.level).toBe(3)
    expect(gpuClassOf(MODEL, 'Radeon RX 580 Series')?.level).toBe(2)
    expect(gpuClassOf(MODEL, 'NVIDIA GeForce GTX 1050 Ti')?.level).toBe(1)
    expect(gpuClassOf(MODEL, 'AMD Radeon(TM) Graphics')?.level).toBe(0)
    expect(gpuClassOf(MODEL, 'Intel(R) UHD Graphics 620')?.level).toBe(0)
  })

  it('carte de portable : une classe de moins, jamais sous 0', () => {
    expect(gpuClassOf(MODEL, 'NVIDIA GeForce RTX 3080 Laptop GPU')).toEqual({ level: 4, mobile: true })
    expect(gpuClassOf(MODEL, 'NVIDIA GeForce GTX 1060 with Max-Q Design')).toEqual({ level: 1, mobile: true })
    expect(gpuClassOf(MODEL, 'Intel(R) Iris(R) Xe Graphics Mobile')).toEqual({ level: 0, mobile: true })
  })

  it('carte inconnue ou nom vide : non reconnue', () => {
    expect(gpuClassOf(MODEL, 'Matrox G200eW')).toBeNull()
    expect(gpuClassOf(MODEL, '')).toBeNull()
    expect(gpuClassOf(MODEL, null)).toBeNull()
  })

  it('expression invalide dans le modèle : ignorée', () => {
    const model = { ...MODEL, gpuClasses: [{ ...MODEL.gpuClasses[5], patterns: ['rtx (', 'rtx\\s*3080'] }] }
    expect(gpuClassOf(model, 'RTX 3080')?.level).toBe(5)
  })
})

describe('résolution', () => {
  it('la première dont le nombre de pixels n’est pas dépassé', () => {
    expect(resolutionOf(MODEL, 1920, 1080).key).toBe('1080p')
    expect(resolutionOf(MODEL, 1280, 720).key).toBe('1080p')
    expect(resolutionOf(MODEL, 2560, 1080).key).toBe('1440p')
    expect(resolutionOf(MODEL, 2560, 1440).key).toBe('1440p')
    expect(resolutionOf(MODEL, 3440, 1440).key).toBe('1440p')
    expect(resolutionOf(MODEL, 3840, 1600).key).toBe('2160p')
    expect(resolutionOf(MODEL, 7680, 4320).key).toBe('2160p')
  })

  it('inconnue : 1080p', () => {
    expect(resolutionOf(MODEL, null, null).key).toBe('1080p')
  })
})

describe('machine', () => {
  it('classe et mémoire corrigées à la main', () => {
    const m = machine('Matrox G200eW', null, 1920, 1080, { gpuClass: 3, vramMb: 6144 })
    expect(m).toMatchObject({ gpuClass: 3, gpuClassSource: 'manual', vramMb: 6144, vramSource: 'manual' })
  })

  it('correction invalide : valeur détectée', () => {
    const m = machine('NVIDIA GeForce RTX 3080', 10240, 1920, 1080, { gpuClass: 12, vramMb: -1 })
    expect(m).toMatchObject({ gpuClass: 5, gpuClassSource: 'detected', vramMb: 10240, vramSource: 'detected' })
  })

  it('carte de portable signalée', () => {
    expect(machine('NVIDIA GeForce RTX 4060 Laptop GPU', 8192)).toMatchObject({ gpuClass: 3, mobile: true })
  })

  it('coût ramené à la résolution et à la carte ; carte non reconnue : carte de référence', () => {
    expect(costOnMachine(MODEL, machine('NVIDIA GeForce RTX 3060', 12288), 2, 1)).toBeCloseTo(3 / 1.6)
    expect(costOnMachine(MODEL, machine('NVIDIA GeForce RTX 3060', 12288, 2560, 1440), 2)).toBeCloseTo((2 * 1.78) / 1.6)
    expect(costOnMachine(MODEL, machine('Matrox G200eW', 4096), 2)).toBeCloseTo(2)
  })
})

describe('réponses de l’API', () => {
  it('modèle : celui de l’API, une fois sérialisé, se relit à l’identique', () => {
    expect(parsePerformanceModel(JSON.parse(JSON.stringify(MODEL)))).toEqual(MODEL)
  })

  it('modèle inutilisable : null', () => {
    expect(parsePerformanceModel(null)).toBeNull()
    expect(parsePerformanceModel({ ...MODEL, gpuClasses: [] })).toBeNull()
    expect(parsePerformanceModel({ ...MODEL, resolutions: [{ key: '1080p', baseFrameMs: 9, effectsScale: 1 }] })).toBeNull()
    expect(parsePerformanceModel({ ...MODEL, minFrameMs: 'vite' })).toBeNull()
  })

  it('résumé d’un pack : null s’il manque ou s’il est incomplet', () => {
    expect(parsePackPerformance(perf())).toEqual(perf())
    expect(parsePackPerformance(null)).toBeNull()
    expect(parsePackPerformance({ ...perf(), tier: 'énorme' })).toBeNull()
    expect(parsePackPerformance({ ...perf(), minVramMb: null })).toBeNull()
  })

  it('analyse détaillée', () => {
    const d = parsePerformanceDetail({
      status: 'ready',
      tier: 'heavy',
      report: {
        summary: perf({ tier: 'heavy' }),
        textures: { totalMb: 2000, vramMb: 700, archives: [{ path: 'mods/x.rpf', texturesMb: 500 }], unreadable: [] },
        effects: { costMs: 3, reshade: { preset: 'p/a.ini', chosenBy: 'reshade-ini', presets: [{ path: 'p/a.ini', costMs: 3, techniques: [] }] }, enb: null },
        world: { lodMultiplier: 1.5 },
        highlights: [{ impact: 'high', text: 'Illumination globale' }, { impact: '?', text: '' }],
        options: [{ path: 'Optional/Arbres', summary: perf({ effectsMs: 0, worldMs: 1, vramMb: 300 }), highlights: [] }]
      }
    })
    expect(d?.status).toBe('ready')
    expect(d?.report?.highlights).toEqual([{ impact: 'high', text: 'Illumination globale' }])
    expect(d?.report?.effects?.reshade?.presets).toHaveLength(1)
    expect(d?.report?.options[0].path).toBe('Optional/Arbres')
    expect(parsePerformanceDetail({ status: 'pending', tier: null, report: null })).toEqual({ status: 'pending', tier: null, report: null })
    expect(parsePerformanceDetail('erreur')).toBeNull()
  })
})

describe('analyse et bibliothèque', () => {
  const report: PerformanceReport = {
    summary: perf({ effectsMs: 3 }),
    textures: null,
    effects: {
      costMs: 3,
      reshade: {
        preset: 'Pack v2/reshade-presets/Ultra.ini',
        chosenBy: 'reshade-ini',
        presets: [
          { path: 'Pack v2/reshade-presets/Ultra.ini', costMs: 3, techniques: [] },
          { path: 'Pack v2/reshade-presets/Lite.ini', costMs: 0.5, techniques: [] }
        ]
      }
    },
    highlights: [],
    options: [{ path: 'Pack v2/Optional/Arbres denses', summary: perf({ effectsMs: 0, worldMs: 1.5, vramMb: 400 }), highlights: [] }]
  }

  it('preset et dossier optionnel retrouvés par leur chemin dans le pack', () => {
    expect(presetFor(report, 'reshade-presets/Lite.ini')?.costMs).toBe(0.5)
    expect(presetFor(report, null)).toBeNull()
    expect(optionFor(report, 'Optional/Arbres denses')?.summary.worldMs).toBe(1.5)
    expect(optionFor(report, 'mods')).toBeNull()
  })

  it('chemins de l’archive et de la bibliothèque', () => {
    expect(samePackPath('Pack v2/Optional/Arbres', 'Optional/Arbres')).toBe(true)
    expect(samePackPath('Optional\\Arbres\\', 'optional/arbres')).toBe(true)
    expect(samePackPath('Pack v2/Optional/Arbres', 'Arbres denses')).toBe(false)
    expect(samePackPath('Pack/MonArbres', 'Arbres')).toBe(false)
    expect(samePackPath('', 'Arbres')).toBe(false)
  })
})

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzePack, resolveInstallMap } from '../src/main/core/analyzer'
import { stripWrapper } from '../src/main/core/wrapper'

const fixture = (name: string): { rel: string; size: number }[] =>
  JSON.parse(readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))

const files = (...rels: string[]): { rel: string; size: number }[] => rels.map((rel) => ({ rel, size: 100 }))

const destOf = (map: ReturnType<typeof resolveInstallMap>, rel: string): string | undefined => {
  const m = map.find((x) => x.rel === rel)
  return m ? `${m.dest.root}:${m.dest.path}` : undefined
}

describe('analyzePack - pack réel BH 1960 (enb / mods / plugins)', () => {
  const raw = fixture('bh1960-listing.json')
  const { entries } = stripWrapper(raw)
  const result = analyzePack(entries)
  const map = resolveInstallMap(result.components)

  it('retire le dossier racine « BH\' 1960 »', () => {
    expect(entries[0].rel.startsWith("BH' 1960/")).toBe(false)
  })

  it('envoie les .rpf dans FiveM.app/mods', () => {
    expect(destOf(map, 'mods/aQuantV.rpf')).toBe('fivem:mods/aQuantV.rpf')
    expect(destOf(map, 'mods/California Roads M.rpf')).toBe('fivem:mods/California Roads M.rpf')
  })

  it('envoie ReShade / ENB d3d11 / NVE dans FiveM.app/plugins', () => {
    expect(destOf(map, 'plugins/dxgi.dll')).toBe('fivem:plugins/dxgi.dll')
    expect(destOf(map, 'plugins/d3d11.dll')).toBe('fivem:plugins/d3d11.dll')
    expect(destOf(map, 'plugins/NVE.asi')).toBe('fivem:plugins/NVE.asi')
    expect(destOf(map, 'plugins/reshade-shaders/Shaders/ReShade.fxh')).toBe('fivem:plugins/reshade-shaders/Shaders/ReShade.fxh')
  })

  it('envoie la configuration ENB à la racine de GTA V', () => {
    expect(destOf(map, 'enb/enbseries.ini')).toBe('gta:enbseries.ini')
    expect(destOf(map, 'enb/d3dcompiler_46e.dll')).toBe('gta:d3dcompiler_46e.dll')
    expect(destOf(map, 'enb/enbseries/enbeffect.fx.bin')).toBe('gta:enbseries/enbeffect.fx.bin')
  })

  it('place enbfeeder (plugin .asi) et son .ini dans plugins, pas dans GTA V', () => {
    expect(destOf(map, 'enb/enbfeeder.asi')).toBe('fivem:plugins/enbfeeder.asi')
    expect(destOf(map, 'enb/enbfeeder.ini')).toBe('fivem:plugins/enbfeeder.ini')
    expect(destOf(map, 'enb/QuantV.ini')).toBe('gta:QuantV.ini')
  })

  it("n'installe pas le journal ReShade.log de l'auteur", () => {
    expect(destOf(map, 'plugins/ReShade.log')).toBeUndefined()
  })

  it('installe tous les autres fichiers et détecte les technologies', () => {
    expect(map.length).toBe(raw.length - 1)
    expect(result.features).toEqual(expect.arrayContaining(['NVE', 'QuantV', 'ENB', 'ReShade', 'RPF']))
    expect(result.components.filter((c) => c.kind === 'unknown')).toHaveLength(0)
  })
})

describe('analyzePack - structures courantes', () => {
  it('pack « tout en vrac » : rpf, ReShade, ENB et readme mélangés', () => {
    const { entries } = stripWrapper(
      files(
        'Mon Pack/veg.rpf',
        'Mon Pack/roads.rpf',
        'Mon Pack/dxgi.dll',
        'Mon Pack/ReShade.ini',
        'Mon Pack/Preset.ini',
        'Mon Pack/reshade-shaders/Shaders/a.fx',
        'Mon Pack/enbseries.ini',
        'Mon Pack/enblocal.ini',
        'Mon Pack/enbseries/enbeffect.fx',
        'Mon Pack/LISEZMOI.txt'
      )
    )
    const r = analyzePack(entries, { isPreset: (rel) => rel.endsWith('Preset.ini') })
    const map = resolveInstallMap(r.components)
    expect(destOf(map, 'veg.rpf')).toBe('fivem:mods/veg.rpf')
    expect(destOf(map, 'dxgi.dll')).toBe('fivem:plugins/dxgi.dll')
    expect(destOf(map, 'Preset.ini')).toBe('fivem:plugins/Preset.ini')
    expect(destOf(map, 'reshade-shaders/Shaders/a.fx')).toBe('fivem:plugins/reshade-shaders/Shaders/a.fx')
    expect(destOf(map, 'enbseries.ini')).toBe('gta:enbseries.ini')
    expect(destOf(map, 'enbseries/enbeffect.fx')).toBe('gta:enbseries/enbeffect.fx')
    expect(destOf(map, 'LISEZMOI.txt')).toBeUndefined()
  })

  it('dossier « FiveM Application Data » + dossier « GTA V »', () => {
    const r = analyzePack(
      files(
        'FiveM Application Data/mods/a.rpf',
        'FiveM Application Data/plugins/d3d11.dll',
        'FiveM Application Data/citizen/common/data/visualsettings.dat',
        'GTA V/enbseries.ini',
        'GTA V/d3d11.dll',
        'GTA V/dinput8.dll'
      )
    )
    const map = resolveInstallMap(r.components)
    expect(destOf(map, 'FiveM Application Data/mods/a.rpf')).toBe('fivem:mods/a.rpf')
    expect(destOf(map, 'FiveM Application Data/plugins/d3d11.dll')).toBe('fivem:plugins/d3d11.dll')
    expect(destOf(map, 'FiveM Application Data/citizen/common/data/visualsettings.dat')).toBe(
      'fivem:citizen/common/data/visualsettings.dat'
    )
    expect(destOf(map, 'GTA V/enbseries.ini')).toBe('gta:enbseries.ini')
    // d3d11.dll placé dans « GTA V » : doublon de celui de plugins → le premier gagne, et il ne va jamais à la racine GTA.
    expect(map.filter((m) => m.dest.root === 'gta' && m.dest.path === 'd3d11.dll')).toHaveLength(0)
    expect(destOf(map, 'GTA V/dinput8.dll')).toBeUndefined()
  })

  it('dossier « Addons » isolé = extras optionnels ; à côté de mods = dossier addons de FiveM', () => {
    const extras = analyzePack(files('mods/a.rpf', 'Extras/Addons/b.rpf'))
    expect(resolveInstallMap(extras.components).map((m) => m.rel)).toEqual(['mods/a.rpf'])
    const fivem = analyzePack(files('mods/a.rpf', 'addons/QuantV_3_0_0.rpf'))
    expect(destOf(resolveInstallMap(fivem.components), 'addons/QuantV_3_0_0.rpf')).toBe('fivem:addons/QuantV_3_0_0.rpf')
  })

  it("collecte les images d'aperçu fournies par l'auteur", () => {
    const r = analyzePack([
      { rel: 'mods/a.rpf', size: 100 },
      { rel: 'Screenshots/2.jpg', size: 300_000 },
      { rel: 'Screenshots/1.jpg', size: 300_000 },
      { rel: 'preview.png', size: 500_000 },
      { rel: 'petite.png', size: 500 }
    ])
    expect(r.gallery).toEqual(['preview.png', 'Screenshots/1.jpg', 'Screenshots/2.jpg'])
  })

  it('dossier optionnel désactivé par défaut', () => {
    const r = analyzePack(files('mods/a.rpf', 'Optionnel/No Blood/mods/noblood.rpf'))
    const map = resolveInstallMap(r.components)
    expect(destOf(map, 'mods/a.rpf')).toBe('fivem:mods/a.rpf')
    expect(destOf(map, 'Optionnel/No Blood/mods/noblood.rpf')).toBeUndefined()
    const opt = r.components.find((c) => c.source === 'Optionnel/No Blood/mods')
    expect(opt?.optional).toBe(true)
    expect(opt?.destination).toEqual({ root: 'fivem', path: 'mods' })
  })

  it('refuse un dossier mods au format solo (OpenIV)', () => {
    const r = analyzePack(files('mods/update/update.rpf', 'mods/x64/levels/gta5/a.rpf'))
    expect(resolveInstallMap(r.components)).toHaveLength(0)
    expect(r.components[0].kind).toBe('unsupported')
  })

  it('.oiv signalé comme non compatible', () => {
    const r = analyzePack(files('Pack NVE.oiv', 'mods/a.rpf'))
    expect(r.components.some((c) => c.kind === 'unsupported')).toBe(true)
    expect(r.warnings.join(' ')).toMatch(/OpenIV/)
  })

  it('variantes : deux dossiers mods installant les mêmes fichiers', () => {
    const r = analyzePack(files('Version A/mods/x.rpf', 'Version B/mods/x.rpf'))
    const enabled = r.components.filter((c) => c.enabled)
    expect(enabled).toHaveLength(1)
    expect(r.warnings.join(' ')).toMatch(/variante/)
  })
})

// Test d'intégration de bout en bout sur de faux dossiers FiveM / GTA V (jamais sur le vrai jeu).
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppState, GamesInfo } from '../src/shared/types'

// L'extraction passe normalement par un worker thread Electron : ici on l'exécute directement.
vi.mock('../src/main/archive', async () => {
  const ex = await import('../src/main/archive/extractors')
  return {
    sevenZipPath: () => null,
    extractInWorker: (file: string, target: string, onProgress: (p: unknown) => void) => ex.extractArchive(file, target, onProgress, null)
  }
})
vi.mock('../src/main/util/win', () => ({
  runningGameProcesses: async () => [],
  readRegistry: async () => ({ rockstarPaths: [], steamPath: null, fivemLastRun: null, fivemProtocol: null, uninstall: [] }),
  listProcesses: async () => [],
  runPowerShell: async () => ''
}))

const { Library } = await import('../src/main/core/library')
const { Installer, ensureReshadeAck, PREVIOUS_INSTALL_NAME } = await import('../src/main/core/installer')
const { JsonStore, emptyState } = await import('../src/main/core/stores')
const { inspectFiveM, inspectGta } = await import('../src/main/core/games')
const { executePlan } = await import('../src/main/core/executor')

let root: string
let fivem: string
let gta: string
let installer: InstanceType<typeof Installer>
let library: InstanceType<typeof Library>
let state: InstanceType<typeof JsonStore<AppState>>
let fpsLimit: number | null = null

const write = async (p: string, content: string | Buffer = 'x'): Promise<void> => {
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, content)
}
const read = (p: string): Promise<string> => fs.readFile(p, 'utf8')
const report = (): void => undefined

async function games(): Promise<GamesInfo> {
  const f = await inspectFiveM(fivem, 'test')
  const g = await inspectGta(gta, 'test')
  return { fivem: f, gta: g, fivemCandidates: [], gtaCandidates: [], mismatch: false, runningProcesses: [] }
}

async function makePackFolder(dir: string, tag: string): Promise<void> {
  // Structure identique au pack réel « BH' 1960 » : enb/ (racine GTA), mods/, plugins/
  await write(path.join(dir, tag, 'enb', 'enbseries.ini'), `[${tag}]`)
  await write(path.join(dir, tag, 'enb', 'enblocal.ini'), '[PROXY]')
  await write(path.join(dir, tag, 'enb', 'd3dcompiler_46e.dll'), 'dll')
  await write(path.join(dir, tag, 'enb', 'enbseries', 'enbeffect.fx'), `fx-${tag}`)
  await write(path.join(dir, tag, 'mods', `${tag}_roads.rpf`), Buffer.alloc(4096, 1))
  await write(path.join(dir, tag, 'plugins', 'dxgi.dll'), `reshade-${tag}`)
  await write(path.join(dir, tag, 'plugins', 'ReShade.ini'), 'EffectSearchPaths=C:\\Users\\auteur\\reshade-shaders\\Shaders\\**\r\nPresetPath=C:\\Users\\auteur\\Preset.ini\r\n')
  await write(path.join(dir, tag, 'plugins', 'Preset.ini'), `Techniques=A@a.fx\r\n; ${tag}`)
  await write(path.join(dir, tag, 'plugins', 'reshade-shaders', 'Shaders', 'a.fx'), 'shader')
  await write(path.join(dir, tag, 'plugins', 'ReShade.log'), 'log auteur')
  await write(path.join(dir, tag, 'Lisez-moi.txt'), 'docs')
}

const trashLeft = async (): Promise<string[]> =>
  [...(await fs.readdir(fivem)), ...(await fs.readdir(gta))].filter((e) => e.startsWith('.fpm-trash-'))

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-test-'))
  fivem = path.join(root, 'FiveM', 'FiveM.app')
  gta = path.join(root, 'GTA V')
  await write(path.join(fivem, 'CoreRT.dll'))
  await write(path.join(fivem, 'citizen', 'version.txt'))
  await write(path.join(fivem, 'CitizenFX.ini'), `[Game]\r\nIVPath=${gta}\r\nSavedBuildNumber=3095\r\n`)
  for (const f of ['GTA5.exe', 'common.rpf', 'x64a.rpf', 'x64b.rpf', 'update/update.rpf', 'x64/audio/audio_rel.rpf', 'd3dcompiler_46.dll'])
    await write(path.join(gta, ...f.split('/')))
  // Installation faite à la main avant l'application + une capture d'écran à ne jamais toucher
  await write(path.join(fivem, 'plugins', 'FiveM_b3095_GTAProcess 2026-01-01.png'), 'capture')
  await write(path.join(fivem, 'plugins', 'dxgi.dll'), 'ancien reshade')
  await write(path.join(fivem, 'plugins', 'QuantV.asi'), 'ancien asi')
  await write(path.join(fivem, 'plugins', 'reshade-shaders', 'Shaders', 'old.fx'), 'ancien shader')
  await write(path.join(fivem, 'mods', 'old.rpf'), 'ancien rpf')
  await write(path.join(gta, 'enbseries.ini'), 'ancien enb')

  state = new JsonStore<AppState>(path.join(root, 'data', 'state.json'), emptyState())
  await state.load(emptyState())
  library = new Library(path.join(root, 'Bibliotheque'))
  installer = new Installer({
    jobsDir: path.join(root, 'data', 'jobs'),
    library: () => library,
    state,
    detectGames: games,
    fpsLimit: () => fpsLimit,
    saveCover: async (src, dir) => {
      const name = `cover-t${Date.now()}.png`
      await fs.copyFile(src, path.join(dir, name))
      return name
    }
  })
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('parcours complet', () => {
  let packA = ''
  let packB = ''
  let previous = ''

  it('détecte les faux dossiers FiveM et GTA V comme valides', async () => {
    const g = await games()
    expect(g.fivem.valid).toBe(true)
    expect(g.gta.valid).toBe(true)
    expect(g.fivem.gtaPathFromIni).toBe(gta)
  })

  it("importe un dossier et corrige le ReShade.ini de l'auteur", async () => {
    const src = path.join(root, 'sources')
    await makePackFolder(src, 'Pack A')
    const m = await library.import(path.join(src, 'Pack A'), () => undefined)
    packA = m.id
    expect(m.name).toBe('Pack A')
    const ini = await read(path.join(library.contentDir(m.id), 'plugins', 'ReShade.ini'))
    expect(ini).toContain('EffectSearchPaths=.\\reshade-shaders\\Shaders\\**')
    expect(ini).toContain('PresetPath=.\\Preset.ini')
  })

  it('importe une archive .zip et refuse un doublon', async () => {
    const src = path.join(root, 'sources')
    await makePackFolder(src, 'Pack B')
    const zip = path.join(root, 'Pack B.zip')
    execFileSync(path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', src, 'Pack B'])
    const m = await library.import(zip, () => undefined)
    packB = m.id
    expect(m.fileCount).toBe(11)
    await expect(library.import(zip, () => undefined)).rejects.toThrow(/déjà dans la liste/)
  })

  it('voit les mods installés à la main (sans la capture d’écran)', async () => {
    const f = await installer.foreignSummary()
    expect(f?.files).toBe(5)
  })

  it("installe le pack A et range l'ancienne installation dans un pack", async () => {
    const res = await installer.apply(packA, report)
    expect(res.installed).toBe(9) // 11 fichiers moins Lisez-moi.txt et ReShade.log
    expect(res.captured).toBe(PREVIOUS_INSTALL_NAME)
    expect(await read(path.join(fivem, 'plugins', 'dxgi.dll'))).toBe('reshade-Pack A')
    expect(await read(path.join(gta, 'enbseries.ini'))).toBe('[Pack A]')
    expect(existsSync(path.join(fivem, 'plugins', 'QuantV.asi'))).toBe(false)
    expect(existsSync(path.join(fivem, 'plugins', 'reshade-shaders', 'Shaders', 'old.fx'))).toBe(false)
    expect(existsSync(path.join(fivem, 'mods', 'old.rpf'))).toBe(false)
    expect(existsSync(path.join(fivem, 'plugins', 'FiveM_b3095_GTAProcess 2026-01-01.png'))).toBe(true)
    const prev = (await library.list()).find((p) => p.captured)!
    previous = prev.id
    expect(prev.fileCount).toBe(5)
    // Pas d'image dans le pack : la capture ReShade la plus récente devient son image.
    expect(prev.cover).toMatch(/^cover-/)
    expect(await read(path.join(library.packDir(prev.id), prev.cover!))).toBe('capture')
    expect(await installer.foreignSummary()).toBeNull()
    const active = state.get().active!
    expect(active.files.find((f) => f.path.endsWith('.rpf'))?.linked).toBe(true)
    expect(active.files.find((f) => f.path === 'plugins/ReShade.ini')?.linked).toBe(false)
  })

  it('garde un réglage modifié en jeu en passant au pack B', async () => {
    await fs.writeFile(path.join(fivem, 'plugins', 'Preset.ini'), 'Techniques=A@a.fx\r\n; réglé en jeu')
    const later = new Date(Date.now() + 5000)
    await fs.utimes(path.join(fivem, 'plugins', 'Preset.ini'), later, later)
    const res = await installer.apply(packB, report)
    expect(res.captured).toBeNull()
    expect(state.get().active?.packId).toBe(packB)
    expect(existsSync(path.join(fivem, 'mods', 'Pack A_roads.rpf'))).toBe(false)
    expect(existsSync(path.join(fivem, 'mods', 'Pack B_roads.rpf'))).toBe(true)
    expect(await read(path.join(gta, 'enbseries.ini'))).toBe('[Pack B]')
    expect(await read(path.join(library.userDir(packA), 'fivem', 'plugins', 'Preset.ini'))).toContain('réglé en jeu')
    expect(await read(path.join(library.contentDir(packA), 'plugins', 'Preset.ini'))).toContain('Pack A')
    expect(await trashLeft()).toEqual([])
  })

  it('réinstaller le pack A remet le réglage personnalisé', async () => {
    await installer.apply(packA, report)
    expect(await read(path.join(fivem, 'plugins', 'Preset.ini'))).toContain('réglé en jeu')
  })

  it('réinstaller le même pack garde un réglage modifié entre-temps', async () => {
    await fs.writeFile(path.join(fivem, 'plugins', 'Preset.ini'), 'Techniques=A@a.fx\r\n; réglé une 2e fois')
    const later = new Date(Date.now() + 10000)
    await fs.utimes(path.join(fivem, 'plugins', 'Preset.ini'), later, later)
    await installer.apply(packA, report)
    expect(await read(path.join(fivem, 'plugins', 'Preset.ini'))).toContain('réglé une 2e fois')
  })

  it("en cas d'échec, l'ancien pack reste installé tel quel", async () => {
    const victim = path.join(library.contentDir(packB), 'plugins', 'reshade-shaders', 'Shaders', 'a.fx')
    await fs.rename(victim, `${victim}.bak`)
    await expect(installer.apply(packB, report)).rejects.toThrow(/Rien n'a été modifié/)
    await fs.rename(`${victim}.bak`, victim)
    expect(state.get().active?.packId).toBe(packA)
    expect(await read(path.join(gta, 'enbseries.ini'))).toBe('[Pack A]')
    expect(existsSync(path.join(fivem, 'mods', 'Pack A_roads.rpf'))).toBe(true)
    expect(existsSync(path.join(fivem, 'mods', 'Pack B_roads.rpf'))).toBe(false)
    expect(await trashLeft()).toEqual([])
    expect((await library.list()).filter((p) => p.captured)).toHaveLength(1)
  })

  it('retire le pack : le jeu redevient propre, les dossiers créés disparaissent', async () => {
    await installer.removeActive(report)
    expect(state.get().active).toBeNull()
    expect(existsSync(path.join(gta, 'enbseries'))).toBe(false)
    expect(existsSync(path.join(gta, 'enbseries.ini'))).toBe(false)
    expect(existsSync(path.join(fivem, 'plugins', 'reshade-shaders'))).toBe(false)
    expect(existsSync(path.join(fivem, 'plugins', 'dxgi.dll'))).toBe(false)
    expect(existsSync(path.join(gta, 'd3dcompiler_46.dll'))).toBe(true)
    expect(existsSync(path.join(fivem, 'plugins', 'FiveM_b3095_GTAProcess 2026-01-01.png'))).toBe(true)
    expect(existsSync(path.join(library.contentDir(packA), 'mods', 'Pack A_roads.rpf'))).toBe(true)
  })

  it("réinstaller « Ancienne installation » remet exactement l'installation d'origine", async () => {
    await installer.apply(previous, report)
    expect(await read(path.join(fivem, 'plugins', 'QuantV.asi'))).toBe('ancien asi')
    expect(await read(path.join(fivem, 'plugins', 'dxgi.dll'))).toBe('ancien reshade')
    expect(await read(path.join(fivem, 'plugins', 'reshade-shaders', 'Shaders', 'old.fx'))).toBe('ancien shader')
    expect(await read(path.join(fivem, 'mods', 'old.rpf'))).toBe('ancien rpf')
    expect(await read(path.join(gta, 'enbseries.ini'))).toBe('ancien enb')
    await installer.removeActive(report)
  })

  it('« Retirer » sur des mods installés à la main les range dans un pack', async () => {
    await write(path.join(fivem, 'plugins', 'NVE.asi'), 'nve manuel')
    await write(path.join(fivem, 'mods', 'manuel.rpf'), 'rpf manuel')
    const res = await installer.stashForeign(report)
    expect(res.captured).toBe(`${PREVIOUS_INSTALL_NAME} 2`)
    expect(existsSync(path.join(fivem, 'plugins', 'NVE.asi'))).toBe(false)
    expect(existsSync(path.join(fivem, 'mods', 'manuel.rpf'))).toBe(false)
    expect(await installer.foreignSummary()).toBeNull()
  })

  it("garde les fichiers d'origine du jeu remplacés par un pack et les remet en place", async () => {
    const m = await library.get(packB)
    const comp = m.components.find((c) => c.source === 'enb')!
    await library.update(packB, { components: [{ id: comp.id, destination: { root: 'gta', path: 'update' } }] })
    const game = path.join(gta, 'update', 'enbseries.ini')
    const kept = path.join(gta, '.fpm-originaux', 'update', 'enbseries.ini')
    await write(game, 'original')

    // Installation : l'original est mis de côté (et non rangé dans « Ancienne installation »).
    const res = await installer.apply(packB, report)
    expect(res.captured).toBeNull()
    expect(await read(game)).toBe('[Pack B]')
    expect(await read(kept)).toBe('original')
    expect(state.get().active?.originals).toEqual([{ root: 'gta', path: 'update/enbseries.ini' }])
    expect(state.get().active?.files.find((f) => f.path === 'update/d3dcompiler_46e.dll')?.linked).toBe(false)

    // Réinstaller le même pack : l'original reste de côté.
    await installer.apply(packB, report)
    expect(await read(game)).toBe('[Pack B]')
    expect(await read(kept)).toBe('original')

    // Bascule vers un pack qui ne remplace pas ce fichier : l'original revient.
    await installer.apply(packA, report)
    expect(await read(game)).toBe('original')
    expect(existsSync(path.join(gta, '.fpm-originaux'))).toBe(false)
    expect(state.get().active?.originals).toEqual([])

    // Retrait du pack : l'original revient, les fichiers ajoutés par le pack disparaissent.
    await installer.apply(packB, report)
    expect(await read(kept)).toBe('original')
    await installer.removeActive(report)
    expect(await read(game)).toBe('original')
    expect(existsSync(path.join(gta, 'update', 'enblocal.ini'))).toBe(false)
    expect(existsSync(path.join(gta, 'update', 'update.rpf'))).toBe(true)
    expect(existsSync(path.join(gta, '.fpm-originaux'))).toBe(false)
    expect(state.get().active).toBeNull()

    // Fichier remplacé par une mise à jour du jeu pendant que le pack est installé : laissé en place, l'ancien original est jeté.
    await installer.apply(packB, report)
    await fs.writeFile(game, 'mis à jour par le jeu')
    const later = new Date(Date.now() + 5000)
    await fs.utimes(game, later, later)
    await installer.removeActive(report)
    expect(await read(game)).toBe('mis à jour par le jeu')
    expect(existsSync(path.join(gta, '.fpm-originaux'))).toBe(false)
    expect(existsSync(path.join(library.userDir(packB), 'gta', 'update', 'enbseries.ini'))).toBe(false)

    await fs.rm(game)
    await library.update(packB, { resetComponents: true })
    expect(await trashLeft()).toEqual([])
  })
})

describe('nettoyage', () => {
  it("« Nettoyer le jeu » retire le pack installé et range les mods installés à la main", async () => {
    const packA = (await library.list()).find((p) => p.name === 'Pack A')!
    await installer.apply(packA.id, report)
    await write(path.join(fivem, 'plugins', 'Ajout.asi'), 'ajout manuel')
    const res = await installer.cleanGame(report)
    expect(res.removed).toBe('Pack A')
    expect(res.captured).toBe('Ajouts manuels')
    expect(state.get().active).toBeNull()
    expect(existsSync(path.join(gta, 'enbseries.ini'))).toBe(false)
    expect(existsSync(path.join(fivem, 'plugins', 'dxgi.dll'))).toBe(false)
    expect(existsSync(path.join(fivem, 'plugins', 'Ajout.asi'))).toBe(false)
    expect(existsSync(path.join(fivem, 'plugins', 'FiveM_b3095_GTAProcess 2026-01-01.png'))).toBe(true)
    expect(await trashLeft()).toEqual([])
    await expect(installer.cleanGame(report)).rejects.toThrow(/déjà d'origine/)
  })

  it('range seulement les éléments cochés', async () => {
    await write(path.join(fivem, 'plugins', 'Choisi.asi'), 'a')
    await write(path.join(fivem, 'mods', 'garde.rpf'), 'b')
    const res = await installer.stashForeign(report, [{ root: 'fivem', path: 'plugins/Choisi.asi', isDir: false }])
    expect(res.captured).toBeTruthy()
    expect(existsSync(path.join(fivem, 'plugins', 'Choisi.asi'))).toBe(false)
    expect(existsSync(path.join(fivem, 'mods', 'garde.rpf'))).toBe(true)
  })

  it("déplace les captures d'écran sans écraser celles déjà présentes", async () => {
    const target = path.join(root, 'Images', 'FiveM')
    await write(path.join(target, 'FiveM_b3095_GTAProcess 2026-01-01.png'), 'déjà là')
    const res = await installer.moveScreenshots(target, report)
    expect(res.moved).toBe(1)
    expect(existsSync(path.join(fivem, 'plugins', 'FiveM_b3095_GTAProcess 2026-01-01.png'))).toBe(false)
    expect(await read(path.join(target, 'FiveM_b3095_GTAProcess 2026-01-01.png'))).toBe('déjà là')
    expect(await read(path.join(target, 'FiveM_b3095_GTAProcess 2026-01-01 (2).png'))).toBe('capture')
  })

  it('vide le cache FiveM sans toucher aux fichiers du jeu téléchargés', async () => {
    await write(path.join(fivem, 'data', 'cache', 'a.bin'), '1234')
    await write(path.join(fivem, 'data', 'server-cache-priv', 'b.bin'), '12')
    await write(path.join(fivem, 'data', 'game-storage', 'jeu.bin'), 'garder')
    expect((await installer.cacheInfo())?.size).toBe(6)
    const res = await installer.clearCache(report)
    expect(res.freed).toBe(6)
    expect(existsSync(path.join(fivem, 'data', 'cache'))).toBe(false)
    expect(existsSync(path.join(fivem, 'data', 'server-cache-priv'))).toBe(false)
    expect(await read(path.join(fivem, 'data', 'game-storage', 'jeu.bin'))).toBe('garder')
  })
})

describe('preset ReShade', () => {
  it("installe le preset choisi, sans ouvrir ReShade, et retient un choix fait en jeu", async () => {
    const src = path.join(root, 'sources', 'Pack Presets')
    await write(path.join(src, 'plugins', 'dxgi.dll'), 'reshade')
    await write(path.join(src, 'plugins', 'ReShade.ini'), '[GENERAL]\r\nPresetPath=.\\Jour.ini\r\n\r\n[OVERLAY]\r\nKeyOverlay=36,0,0,0\r\n')
    await write(path.join(src, 'plugins', 'Jour.ini'), 'Techniques=A@a.fx\r\n')
    await write(path.join(src, 'plugins', 'presets', 'Nuit.ini'), 'Techniques=B@b.fx\r\n')
    await write(path.join(src, 'mods', 'x.rpf'), 'rpf')
    const m = await library.import(src, () => undefined)
    expect(m.reshadePresets).toEqual(['plugins/Jour.ini', 'plugins/presets/Nuit.ini'])
    expect(m.reshadePreset).toBe('plugins/Jour.ini')

    // Choix d'un autre preset dans l'application : ReShade.ini installé pointe dessus.
    await library.setReshadePreset(m.id, 'plugins/presets/Nuit.ini')
    await installer.apply(m.id, report)
    const installed = await read(path.join(fivem, 'plugins', 'ReShade.ini'))
    expect(installed).toContain('PresetPath=.\\presets\\Nuit.ini')
    expect(installed).toContain('StartupPresetPath=.\\presets\\Nuit.ini')
    expect(installed).toContain('KeyOverlay=36,0,0,0')
    // Le contenu d'origine du pack n'est pas modifié.
    expect(await read(path.join(library.contentDir(m.id), 'plugins', 'ReShade.ini'))).toContain('PresetPath=.\\Jour.ini')

    // Preset changé dans le menu de ReShade en jeu : retenu au retrait du pack.
    await fs.writeFile(path.join(fivem, 'plugins', 'ReShade.ini'), installed.replace(/PresetPath=\.\\presets\\Nuit\.ini/g, 'PresetPath=.\\Jour.ini'))
    const later = new Date(Date.now() + 20000)
    await fs.utimes(path.join(fivem, 'plugins', 'ReShade.ini'), later, later)
    await installer.removeActive(report)
    expect((await library.get(m.id)).reshadePreset).toBe('plugins/Jour.ini')
  })

  it('crée ReShade.ini quand le pack fournit ReShade sans son fichier de configuration', async () => {
    const src = path.join(root, 'sources', 'Pack Sans Ini')
    await write(path.join(src, 'plugins', 'dxgi.dll'), 'reshade')
    await write(path.join(src, 'plugins', 'Mon preset.ini'), 'Techniques=A@a.fx\r\n')
    const m = await library.import(src, () => undefined)
    const stored = await library.get(m.id)
    stored.reshadeVersion = '6.5.1' // le faux dxgi.dll du test n'est pas un vrai binaire ReShade
    await library.save(stored)
    await installer.apply(m.id, report)
    const ini = await read(path.join(fivem, 'plugins', 'ReShade.ini'))
    expect(ini).toContain('PresetPath=.\\Mon preset.ini')
    expect(ini).toContain('EffectSearchPaths=.\\reshade-shaders\\Shaders\\**')
    await installer.removeActive(report)
    expect(existsSync(path.join(fivem, 'plugins', 'ReShade.ini'))).toBe(false)
  })
})

describe('preset QuantV', () => {
  it('recopie le preset choisi dans QuantV.preset.ini, garde les retouches en jeu et suit un changement de preset', async () => {
    const src = path.join(root, 'sources', 'Pack QuantV')
    await write(path.join(src, 'plugins', 'dxgi.dll'), 'reshade')
    await write(path.join(src, 'plugins', 'QuantV.addon'), 'addon')
    await write(path.join(src, 'plugins', 'QuantV.asi'), 'asi')
    await write(path.join(src, 'plugins', 'QuantV.preset.ini'), 'Techniques=QuantV@QuantV.fx,QuantV_PostFX@QuantV_Post.fx\r\n')
    await write(path.join(src, 'plugins', 'ReShade.ini'), '[GENERAL]\r\nPresetPath=.\\PRESET BH.ini\r\n')
    const bh = 'Techniques=QuantV@QuantV.fx,QuantV_PostFX@QuantV_Post.fx,CAS@CAS.fx\r\n\r\n[QuantV.fx]\r\nBrighter_Nights=0\r\n'
    await write(path.join(src, 'plugins', 'PRESET BH.ini'), bh)
    await write(path.join(src, 'plugins', 'Nuit.ini'), 'Techniques=CAS@CAS.fx\r\n')
    await write(path.join(src, 'mods', 'x.rpf'), 'rpf')
    const m = await library.import(src, () => undefined)
    // QuantV.preset.ini est le fichier de travail de QuantV, pas un preset à proposer.
    expect(m.reshadePresets).not.toContain('plugins/QuantV.preset.ini')
    expect(m.reshadePreset).toBe('plugins/PRESET BH.ini')

    const quantvPreset = path.join(fivem, 'plugins', 'QuantV.preset.ini')
    await installer.apply(m.id, report)
    expect(await read(quantvPreset)).toBe(bh)
    expect(await read(path.join(fivem, 'plugins', 'ReShade.ini'))).toContain('PresetPath=.\\PRESET BH.ini')

    // Réglages QuantV retouchés en jeu : gardés en réinstallant le pack.
    const tweaked = bh.replace('Brighter_Nights=0', 'Brighter_Nights=1')
    await fs.writeFile(quantvPreset, tweaked)
    const later = new Date(Date.now() + 20000)
    await fs.utimes(quantvPreset, later, later)
    await installer.apply(m.id, report)
    expect(await read(quantvPreset)).toBe(tweaked)

    // Autre preset choisi dans l'application : QuantV le reçoit, avec ses effets.
    await library.setReshadePreset(m.id, 'plugins/Nuit.ini')
    await installer.apply(m.id, report)
    expect(await read(quantvPreset)).toBe('Techniques=QuantV@QuantV.fx,QuantV_PostFX@QuantV_Post.fx,CAS@CAS.fx\r\n')
    // Le contenu d'origine du pack n'est pas modifié.
    expect(await read(path.join(library.contentDir(m.id), 'plugins', 'QuantV.preset.ini'))).toBe('Techniques=QuantV@QuantV.fx,QuantV_PostFX@QuantV_Post.fx\r\n')

    await installer.removeActive(report)
    expect(existsSync(quantvPreset)).toBe(false)
  })
})

describe("limite d'images par seconde (ENB)", () => {
  it('écrit la limite dans enblocal.ini, tout de suite et à chaque installation, sans perdre les retouches en jeu', async () => {
    const src = path.join(root, 'sources', 'Pack FPS')
    const enblocal = '[PROXY]\r\nEnableProxyLibrary=false\r\n\r\n[LIMITER]\r\nWaitBusyRenderer=false\r\nEnableFPSLimit=true\r\nFPSLimit=60.0\r\n'
    await write(path.join(src, 'enb', 'enbseries.ini'), '[GLOBAL]')
    await write(path.join(src, 'enb', 'enblocal.ini'), enblocal)
    await write(path.join(src, 'mods', 'x.rpf'), 'rpf')
    const m = await library.import(src, () => undefined)
    const installed = path.join(gta, 'enblocal.ini')
    const userCopy = library.userFile(m.id, { root: 'gta', path: 'enblocal.ini' })

    fpsLimit = null
    await installer.apply(m.id, report)
    expect(await read(installed)).toBe(enblocal)

    // Limite choisie pendant que le pack est installé : appliquée tout de suite.
    fpsLimit = 120
    expect(await installer.applyFpsLimit(report)).toBe(1)
    const limited = enblocal.replace('FPSLimit=60.0', 'FPSLimit=120.0')
    expect(await read(installed)).toBe(limited)
    expect(await read(path.join(library.contentDir(m.id), 'enb', 'enblocal.ini'))).toBe(enblocal)
    // Réinstallation : même limite, et le fichier ne passe pas pour une retouche faite en jeu.
    await installer.apply(m.id, report)
    expect(await read(installed)).toBe(limited)
    expect(existsSync(userCopy)).toBe(false)
    expect(await trashLeft()).toEqual([])

    // Retouche en jeu, puis « aucune limite » : la retouche est gardée.
    await fs.writeFile(installed, limited.replace('EnableProxyLibrary=false', 'EnableProxyLibrary=true'))
    const later = new Date(Date.now() + 20000)
    await fs.utimes(installed, later, later)
    fpsLimit = 0
    expect(await installer.applyFpsLimit(report)).toBe(1)
    expect(await read(installed)).toBe(limited.replace('EnableProxyLibrary=false', 'EnableProxyLibrary=true').replace('EnableFPSLimit=true', 'EnableFPSLimit=false'))
    expect(existsSync(userCopy)).toBe(true)

    // « Celle du pack » : la limite d'origine revient, la retouche reste.
    fpsLimit = null
    await installer.applyFpsLimit(report)
    expect(await read(installed)).toBe(enblocal.replace('EnableProxyLibrary=false', 'EnableProxyLibrary=true'))

    await installer.removeActive(report)
    expect(existsSync(installed)).toBe(false)
    // Aucun pack installé : rien à faire.
    fpsLimit = 144
    expect(await installer.applyFpsLimit(report)).toBe(0)
    fpsLimit = null
  })
})

describe("suppression d'un pack", () => {
  it('rapporte la progression de 0 à 100 %', async () => {
    const src = path.join(root, 'sources')
    await makePackFolder(src, 'Pack C')
    const m = await library.import(path.join(src, 'Pack C'), () => undefined)
    const steps: number[] = []
    await library.remove(m.id, (done, total) => steps.push(Math.round((done / total) * 100)))
    expect(steps[0]).toBe(0)
    expect(steps[steps.length - 1]).toBe(100)
    expect(steps.length).toBeGreaterThan(5)
    expect(existsSync(library.packDir(m.id))).toBe(false)
  })

  it('termine au démarrage une suppression interrompue', async () => {
    const src = path.join(root, 'sources')
    await makePackFolder(src, 'Pack D')
    const m = await library.import(path.join(src, 'Pack D'), () => undefined)
    const stored = await library.get(m.id)
    stored.deleting = true
    await library.save(stored)
    await library.cleanupStaging()
    expect(existsSync(library.packDir(m.id))).toBe(false)
  })
})

describe('exécuteur de plans', () => {
  it('annule tout en cas d’échec (mode atomique)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-exec-'))
    await write(path.join(dir, 'src', 'a.txt'), 'a')
    await write(path.join(dir, 'dst', 'existant.txt'), 'garde-moi')
    const res = await executePlan(
      {
        id: 't',
        title: 't',
        mode: 'atomic',
        ops: [
          { t: 'mkdir', path: path.join(dir, 'dst', 'nouveau') },
          { t: 'place', from: path.join(dir, 'src', 'a.txt'), to: path.join(dir, 'dst', 'nouveau', 'a.txt'), link: false, size: 1 },
          { t: 'stash', path: path.join(dir, 'dst', 'existant.txt'), to: path.join(dir, 'bk', 'existant.txt'), size: 0 },
          { t: 'place', from: path.join(dir, 'src', 'absent.txt'), to: path.join(dir, 'dst', 'b.txt'), link: false, size: 1 }
        ]
      },
      () => undefined
    )
    expect(res.ok).toBe(false)
    expect(res.rolledBack).toBe(true)
    expect(existsSync(path.join(dir, 'dst', 'nouveau'))).toBe(false)
    expect(await read(path.join(dir, 'dst', 'existant.txt'))).toBe('garde-moi')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('annulé en cours de plan : ce qui a été fait est défait', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-exec-'))
    await write(path.join(dir, 'a.txt'), 'a')
    await write(path.join(dir, 'dst', 'existant.txt'), 'garde-moi')
    const abort = new AbortController()
    const res = await executePlan(
      {
        id: 't',
        title: 't',
        mode: 'atomic',
        ops: [
          { t: 'stash', path: path.join(dir, 'dst', 'existant.txt'), to: path.join(dir, 'bk', 'existant.txt'), size: 0 },
          { t: 'place', from: path.join(dir, 'a.txt'), to: path.join(dir, 'dst', 'a.txt'), link: false, size: 1 }
        ]
      },
      () => abort.abort(),
      abort.signal
    )
    expect(res).toMatchObject({ ok: false, rolledBack: true, cancelled: true })
    expect(existsSync(path.join(dir, 'dst', 'a.txt'))).toBe(false)
    expect(await read(path.join(dir, 'dst', 'existant.txt'))).toBe('garde-moi')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('copie : avance pendant un gros fichier, annulable, sans laisser de fichier incomplet', async () => {
    const { copyFileTracked } = await import('../src/main/util/fsx')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-exec-'))
    const size = 8 * 1024 * 1024
    await fs.writeFile(path.join(dir, 'gros.bin'), Buffer.alloc(size, 1))
    const abort = new AbortController()
    let copied = 0
    await expect(
      copyFileTracked(
        path.join(dir, 'gros.bin'),
        path.join(dir, 'annule.bin'),
        (n) => {
          copied += n
          abort.abort()
        },
        abort.signal
      )
    ).rejects.toThrow()
    expect(copied).toBeGreaterThan(0)
    expect(copied).toBeLessThan(size)
    expect(existsSync(path.join(dir, 'annule.bin'))).toBe(false)
    copied = 0
    await copyFileTracked(path.join(dir, 'gros.bin'), path.join(dir, 'copie.bin'), (n) => (copied += n))
    expect(copied).toBe(size)
    const [a, b] = await Promise.all([fs.stat(path.join(dir, 'gros.bin')), fs.stat(path.join(dir, 'copie.bin'))])
    expect(b.size).toBe(size)
    expect(Math.abs(a.mtimeMs - b.mtimeMs)).toBeLessThan(2)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('annulé avant de commencer : rien ne bouge ; copie intacte sinon', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-exec-'))
    await write(path.join(dir, 'a.txt'), 'a')
    const plan = (to: string) => ({ id: 't', title: 't', mode: 'atomic' as const, ops: [{ t: 'place' as const, from: path.join(dir, 'a.txt'), to: path.join(dir, to), link: false, size: 1 }] })
    const res = await executePlan(plan('annule.txt'), () => undefined, AbortSignal.abort())
    expect(res).toMatchObject({ ok: false, cancelled: true })
    expect(existsSync(path.join(dir, 'annule.txt'))).toBe(false)
    const ok = await executePlan(plan('copie.txt'), () => undefined, new AbortController().signal)
    expect(ok.ok).toBe(true)
    expect(await read(path.join(dir, 'copie.txt'))).toBe('a')
    const again = await executePlan(plan('copie.txt'), () => undefined)
    expect(again.ok).toBe(false)
    expect(await read(path.join(dir, 'copie.txt'))).toBe('a')
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('CitizenFX.ini : acceptation ReShade 5+', () => {
  it('ajoute la ligne une seule fois, sans toucher au reste', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-ini-'))
    await fs.writeFile(path.join(dir, 'CitizenFX.ini'), '[Game]\r\nIVPath=C:\\Jeux\\GTA V\r\n')
    expect(await ensureReshadeAck(dir)).toBe(true)
    expect(await ensureReshadeAck(dir)).toBe(false)
    const ini = await read(path.join(dir, 'CitizenFX.ini'))
    expect(ini).toMatch(/^\[Game\]\r\nIVPath=C:\\Jeux\\GTA V\r\n\r\n\[Addons\]\r\nReShade5=ID:[0-9a-f]{8} acknowledged that ReShade 5\.x has a bug that will lead to game crashes\r\n$/)
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('processus administrateur (UAC)', () => {
  it('exécute le plan signé et refuse un plan modifié après coup', async () => {
    const { runElevatedWorker, EXEC_FLAG, HASH_FLAG } = await import('../src/main/core/elevation')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-elev-'))
    await write(path.join(dir, 'src.txt'), 'contenu')
    const planFile = path.join(dir, 'job.plan.json')
    const body = JSON.stringify({ id: 'j', title: 'j', mode: 'atomic', ops: [{ t: 'place', from: path.join(dir, 'src.txt'), to: path.join(dir, 'out', 'dst.txt'), link: false, size: 7 }] })
    await fs.writeFile(planFile, body)
    const sha = createHash('sha256').update(body).digest('hex')
    expect(await runElevatedWorker([`${EXEC_FLAG}${planFile}`, `${HASH_FLAG}${sha}`])).toBe(0)
    expect(await read(path.join(dir, 'out', 'dst.txt'))).toBe('contenu')
    expect(JSON.parse(await read(`${planFile}.result.json`)).ok).toBe(true)
    await fs.writeFile(planFile, body.replace('dst.txt', 'pirate.txt'))
    expect(await runElevatedWorker([`${EXEC_FLAG}${planFile}`, `${HASH_FLAG}${sha}`])).toBe(3)
    expect(existsSync(path.join(dir, 'out', 'pirate.txt'))).toBe(false)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("s'arrête si l'application a demandé l'annulation, ou a abandonné le plan", async () => {
    const { runElevatedWorker, EXEC_FLAG, HASH_FLAG } = await import('../src/main/core/elevation')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-elev-'))
    await write(path.join(dir, 'src.txt'), 'contenu')
    const planFile = path.join(dir, 'job.plan.json')
    const body = JSON.stringify({ id: 'j', title: 'j', mode: 'atomic', ops: [{ t: 'place', from: path.join(dir, 'src.txt'), to: path.join(dir, 'dst.txt'), link: false, size: 7 }] })
    await fs.writeFile(planFile, body)
    await fs.writeFile(`${planFile}.cancel`, '')
    const sha = createHash('sha256').update(body).digest('hex')
    expect(await runElevatedWorker([`${EXEC_FLAG}${planFile}`, `${HASH_FLAG}${sha}`])).toBe(1)
    expect(JSON.parse(await read(`${planFile}.result.json`)).cancelled).toBe(true)
    expect(existsSync(path.join(dir, 'dst.txt'))).toBe(false)
    await fs.rm(planFile)
    await fs.rm(`${planFile}.result.json`)
    expect(await runElevatedWorker([`${EXEC_FLAG}${planFile}`, `${HASH_FLAG}${sha}`])).toBe(4)
    expect(existsSync(`${planFile}.result.json`)).toBe(false)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("ne demande les droits que pour un dossier touché par le plan", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-elev-'))
    await write(path.join(dir, 'libre', 'a.txt'), 'a')
    // Racine impossible à écrire (son parent est un fichier) : un plan qui n'y touche pas passe sans élévation.
    const blocked = path.join(dir, 'libre', 'a.txt', 'gta')
    const installer = new Installer({} as never)
    const plan = { id: 'p', title: 'p', mode: 'atomic' as const, ops: [{ t: 'mkdir' as const, path: path.join(dir, 'libre', 'sous') }] }
    const phases: string[] = []
    const res = await installer.runPlan(plan, [path.join(dir, 'libre'), blocked], (phase) => phases.push(phase))
    expect(res.ok).toBe(true)
    expect(phases.filter((p) => p.includes('autorisation'))).toEqual([])
    expect(existsSync(path.join(dir, 'libre', 'sous'))).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  })
})

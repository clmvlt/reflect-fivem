// Instances FiveM sur de faux dossiers (jamais sur le vrai jeu) : deux dossiers FiveM qui partagent le même GTA V.
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppState, GamesInfo, InstalledFile, Settings } from '../src/shared/types'

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
const { Installer } = await import('../src/main/core/installer')
type OtherInstall = import('../src/main/core/installer').OtherInstall
const { JsonStore, emptyState } = await import('../src/main/core/stores')
const { inspectFiveM, inspectGta } = await import('../src/main/core/games')
const { copyPlan, currentInstanceId, instanceStateFile, listInstances, MAIN_INSTANCE, runCopy, safeFileName, suggestedName } = await import(
  '../src/main/core/instances'
)

const settings = (p: Partial<Settings>): Settings => ({ libraryDir: 'D:\\Bibliotheque', fivemPath: null, gtaPath: null, ...p })

describe('liste des instances', () => {
  it("sans liste : l'instance principale seule, avec les dossiers des réglages", () => {
    const s = settings({ fivemPath: 'D:\\FiveM\\FiveM.app' })
    expect(currentInstanceId(s)).toBe(MAIN_INSTANCE)
    expect(listInstances(s, 'FiveM principal')).toEqual([{ id: MAIN_INSTANCE, name: 'FiveM principal', fivemPath: 'D:\\FiveM\\FiveM.app', gtaPath: null }])
  })

  it("l'instance active prend les dossiers des réglages, les autres ceux de leur fiche", () => {
    const s = settings({
      fivemPath: 'E:\\RP\\FiveM.app',
      gtaPath: 'E:\\GTA V',
      instance: 'rp',
      instances: [
        { id: MAIN_INSTANCE, name: 'Principal', fivemPath: 'D:\\FiveM\\FiveM.app', gtaPath: null },
        { id: 'rp', name: 'RP', fivemPath: 'ancien', gtaPath: null }
      ]
    })
    expect(currentInstanceId(s)).toBe('rp')
    const list = listInstances(s, 'x')
    expect(list[0].fivemPath).toBe('D:\\FiveM\\FiveM.app')
    expect(list[1]).toEqual({ id: 'rp', name: 'RP', fivemPath: 'E:\\RP\\FiveM.app', gtaPath: 'E:\\GTA V' })
  })

  it('instance active disparue : la première', () => {
    expect(currentInstanceId(settings({ instance: 'supprimee', instances: [{ id: 'a', name: 'A', fivemPath: null, gtaPath: null }] }))).toBe('a')
  })

  it("état : state.json pour l'instance principale, un dossier par autre instance", () => {
    expect(instanceStateFile('D:\\Data', MAIN_INSTANCE)).toBe(path.join('D:\\Data', 'state.json'))
    expect(instanceStateFile('D:\\Data', 'rp')).toBe(path.join('D:\\Data', 'Instances', 'rp', 'state.json'))
  })

  it('noms : dossier qui contient FiveM.app, caractères interdits retirés', () => {
    expect(suggestedName('D:\\Jeux\\FiveM RP\\FiveM.app')).toBe('FiveM RP')
    expect(suggestedName('D:\\Jeux\\FiveM Test\\')).toBe('FiveM Test')
    expect(safeFileName('FiveM : RP/2?')).toBe('FiveM  RP2')
  })
})

let root: string
let gta: string
const fivem = { a: '', b: '' }
let library: InstanceType<typeof Library>
const states: Record<'a' | 'b', InstanceType<typeof JsonStore<AppState>>> = {} as never
const installers: Record<'a' | 'b', InstanceType<typeof Installer>> = {} as never
const packs = { x: '', y: '' }
const report = (): void => undefined

const write = async (p: string, content: string | Buffer = 'x'): Promise<void> => {
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, content)
}
const read = (p: string): Promise<string> => fs.readFile(p, 'utf8')

async function games(which: 'a' | 'b'): Promise<GamesInfo> {
  return { fivem: await inspectFiveM(fivem[which], 'test'), gta: await inspectGta(gta, 'test'), fivemCandidates: [], gtaCandidates: [], mismatch: false, runningProcesses: [] }
}

/** Fichiers posés par l'autre instance (comme Service.installsExcept). */
function othersOf(which: 'a' | 'b'): () => Promise<OtherInstall[]> {
  return async () => {
    const other = which === 'a' ? 'b' : 'a'
    const s = states[other].get()
    return s.active ? [{ instance: other.toUpperCase(), packId: s.active.packId, packName: s.active.packName, roots: s.active.roots, files: s.active.files }] : []
  }
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-instances-'))
  gta = path.join(root, 'GTA V')
  for (const f of ['GTA5.exe', 'common.rpf', 'x64a.rpf', 'x64b.rpf', 'update/update.rpf', 'x64/audio/audio_rel.rpf']) await write(path.join(gta, ...f.split('/')))
  for (const which of ['a', 'b'] as const) {
    fivem[which] = path.join(root, `FiveM ${which}`, 'FiveM.app')
    await write(path.join(fivem[which], 'CoreRT.dll'))
    await write(path.join(fivem[which], 'citizen', 'version.txt'))
    await write(path.join(fivem[which], 'CitizenFX.ini'), `[Game]\r\nIVPath=${gta}\r\n`)
  }
  library = new Library(path.join(root, 'Bibliotheque'))
  for (const tag of ['X', 'Y'] as const) {
    const src = path.join(root, 'sources', `Pack ${tag}`)
    await write(path.join(src, 'enb', 'enbseries.ini'), `[${tag}]`)
    await write(path.join(src, 'plugins', 'dxgi.dll'), `reshade-${tag}`)
    packs[tag === 'X' ? 'x' : 'y'] = (await library.import(src, () => undefined)).id
  }
  for (const which of ['a', 'b'] as const) {
    states[which] = new JsonStore<AppState>(path.join(root, 'data', which, 'state.json'), emptyState())
    installers[which] = new Installer({
      jobsDir: path.join(root, 'data', 'jobs'),
      library: () => library,
      state: states[which],
      detectGames: () => games(which),
      others: othersOf(which)
    })
  }
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('packs dans deux instances qui partagent GTA V', () => {
  it('le même pack dans les deux instances partage ses fichiers de GTA V', async () => {
    await installers.a.apply(packs.x, report)
    await installers.b.apply(packs.x, report)
    expect(await read(path.join(gta, 'enbseries.ini'))).toBe('[X]')
    expect(await read(path.join(fivem.b, 'plugins', 'dxgi.dll'))).toBe('reshade-X')
    expect(states.b.get().active?.files.some((f) => f.root === 'gta' && f.path === 'enbseries.ini')).toBe(true)
    // Rien de l'autre instance n'est pris pour un mod installé à la main.
    expect(await installers.a.scanForeign()).toEqual([])
    expect(await installers.b.scanForeign()).toEqual([])
  })

  it("retirer le pack d'une instance laisse les fichiers de GTA V que l'autre utilise", async () => {
    await installers.a.removeActive(report)
    expect(existsSync(path.join(fivem.a, 'plugins', 'dxgi.dll'))).toBe(false)
    expect(await read(path.join(gta, 'enbseries.ini'))).toBe('[X]')
  })

  it('refuse un autre pack qui remplacerait les fichiers de GTA V de l’autre instance', async () => {
    await expect(installers.a.apply(packs.y, report)).rejects.toThrow(/instance\s«\sB\s»/)
    expect(await read(path.join(gta, 'enbseries.ini'))).toBe('[X]')
    expect(states.a.get().active).toBeNull()
  })

  it("« Nettoyer le jeu » d'une instance ne range pas les fichiers de l'autre", async () => {
    await write(path.join(fivem.a, 'plugins', 'manuel.asi'), 'asi')
    await installers.a.cleanGame(report)
    expect(existsSync(path.join(fivem.a, 'plugins', 'manuel.asi'))).toBe(false)
    expect(await read(path.join(gta, 'enbseries.ini'))).toBe('[X]')
  })

  it("le pack retiré de la dernière instance qui l'utilise quitte GTA V ; l'autre pack s'installe", async () => {
    await installers.b.removeActive(report)
    expect(existsSync(path.join(gta, 'enbseries.ini'))).toBe(false)
    await installers.a.apply(packs.y, report)
    expect(await read(path.join(gta, 'enbseries.ini'))).toBe('[Y]')
  })
})

describe('copie d’une instance', () => {
  it('copie FiveM sans le cache, ni les fichiers posés par l’application (l’original du jeu à leur place)', async () => {
    const src = path.join(root, 'Source', 'FiveM.app')
    await write(path.join(root, 'Source', 'FiveM.exe'), 'exe')
    await write(path.join(src, 'CoreRT.dll'), 'core')
    await write(path.join(src, 'data', 'game-storage', 'ros.dat'), 'jeu')
    await write(path.join(src, 'data', 'cache', 'gros.bin'), 'cache')
    await write(path.join(src, 'logs', 'CitizenFX.log'), 'log')
    await write(path.join(src, 'plugins', 'manuel.asi'), 'à moi')
    await write(path.join(src, 'plugins', 'dxgi.dll'), 'du pack')
    await write(path.join(src, 'citizen', 'common', 'data', 'gameconfig.xml'), 'du pack')
    await write(path.join(src, '.fpm-originaux', 'citizen', 'common', 'data', 'gameconfig.xml'), 'd’origine')
    const file = (rel: string): InstalledFile => ({ root: 'fivem', path: rel, size: 1, mtimeMs: 0, linked: false, source: '' })
    const dest = path.join(root, 'Copie')
    const plan = await copyPlan(src, dest, [file('plugins/dxgi.dll'), file('citizen/common/data/gameconfig.xml')])
    await runCopy(plan, () => undefined)
    expect(await read(path.join(dest, 'FiveM.exe'))).toBe('exe')
    expect(await read(path.join(dest, 'FiveM.app', 'data', 'game-storage', 'ros.dat'))).toBe('jeu')
    expect(await read(path.join(dest, 'FiveM.app', 'plugins', 'manuel.asi'))).toBe('à moi')
    expect(await read(path.join(dest, 'FiveM.app', 'citizen', 'common', 'data', 'gameconfig.xml'))).toBe('d’origine')
    for (const gone of ['data/cache', 'logs', 'plugins/dxgi.dll', '.fpm-originaux']) expect(existsSync(path.join(dest, 'FiveM.app', ...gone.split('/')))).toBe(false)
  })
})

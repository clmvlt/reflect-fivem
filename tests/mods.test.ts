// Mods : bibliothèque des mods et leur état dans le jeu (AppState.mods), sur de faux dossiers FiveM / GTA V.
// Plusieurs mods à la fois, en plus du pack graphique actif et indépendants de lui : un mod ne remplace jamais le fichier
// d'un autre mod, il peut remplacer un fichier du pack (remis en place quand le mod est retiré), et changer de pack ne
// touche pas aux mods.
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppState, GamesInfo, InstalledMod } from '../src/shared/types'

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

const sealed = await import('../src/main/core/sealed')
const { KeyRing } = await import('../src/main/core/keys')
const { Library, ImportError } = await import('../src/main/core/library')
const { Installer } = await import('../src/main/core/installer')
const { JsonStore, emptyState, normalizeState } = await import('../src/main/core/stores')
const { analyzePack, resolveInstallMap, restrictToFiveM } = await import('../src/main/core/analyzer')
const { inspectFiveM, inspectGta } = await import('../src/main/core/games')

let root: string
let fivem: string
let gta: string
let library: InstanceType<typeof Library>
let mods: InstanceType<typeof Library>
let installer: InstanceType<typeof Installer>
let state: InstanceType<typeof JsonStore<AppState>>
const report = (): void => undefined

const write = async (p: string, content: string | Buffer = 'x'): Promise<void> => {
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, content)
}
const read = (p: string): Promise<string> => fs.readFile(p, 'utf8')
const inGame = (...rel: string[]): string => path.join(fivem, ...rel)

async function games(): Promise<GamesInfo> {
  return { fivem: await inspectFiveM(fivem, 'test'), gta: await inspectGta(gta, 'test'), fivemCandidates: [], gtaCandidates: [], mismatch: false, runningProcesses: [] }
}

const modState = (id: string): InstalledMod | undefined => state.get().mods.find((m) => m.id === id)

/** Paquet chiffré au format de l'API (voir protected.test.ts). */
function writePackage(files: { path: string; data: Buffer }[], key: Buffer): { bytes: Buffer; id: string } {
  const id = randomBytes(16)
  const parts: Buffer[] = [Buffer.concat([Buffer.from('FPMPACK1', 'latin1'), id, Buffer.alloc(8)])]
  let offset = 32
  const entries = files.map((f, i) => {
    const stream = sealed.sealBytes(f.data, sealed.hkdf(key, id, `fpm-pack/file/${i}`))
    parts.push(stream)
    const entry = { p: f.path, s: f.data.length, o: offset, l: stream.length }
    offset += stream.length
    return entry
  })
  const index = sealed.sealBytes(Buffer.from(JSON.stringify({ v: 1, files: entries })), sealed.hkdf(key, id, 'fpm-pack/index'))
  const trailer = Buffer.alloc(16)
  trailer.writeBigUInt64BE(BigInt(offset), 0)
  trailer.writeBigUInt64BE(BigInt(index.length), 8)
  return { bytes: Buffer.concat([...parts, index, trailer]), id: id.toString('hex') }
}

/** Dossier d'un pack ou d'un mod : { chemin relatif: contenu }. */
async function folder(name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(root, 'sources', name)
  for (const [rel, content] of Object.entries(files)) await write(path.join(dir, ...rel.split('/')), content)
  return dir
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-mods-'))
  fivem = path.join(root, 'FiveM', 'FiveM.app')
  gta = path.join(root, 'GTA V')
  await write(path.join(fivem, 'CoreRT.dll'))
  await write(path.join(fivem, 'citizen', 'version.txt'))
  await write(path.join(fivem, 'CitizenFX.ini'), `[Game]\r\nIVPath=${gta}\r\nSavedBuildNumber=3095\r\n`)
  for (const f of ['GTA5.exe', 'common.rpf', 'x64a.rpf', 'update/update.rpf', 'd3dcompiler_46.dll']) await write(path.join(gta, ...f.split('/')))

  state = new JsonStore<AppState>(path.join(root, 'data', 'state.json'), emptyState())
  await state.load(emptyState())
  const keys = new KeyRing(path.join(root, 'data', 'protection.key'), { available: () => true, protect: (b) => b, unprotect: (b) => b }, async () => {
    throw new Error('hors ligne')
  })
  library = new Library(path.join(root, 'Bibliotheque'), keys)
  mods = new Library(path.join(root, 'Bibliotheque', '.mods'), keys)
  installer = new Installer({ jobsDir: path.join(root, 'data', 'jobs'), library: () => library, modLibrary: () => mods, state, detectGames: games })
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('analyse d’un mod', () => {
  it('limite un mod à FiveM.app : la racine de GTA V est ignorée', () => {
    const analysis = analyzePack([
      { rel: 'mods/armes.rpf', size: 10 },
      { rel: 'enb/enbseries.ini', size: 10 },
      { rel: 'Lisez-moi.txt', size: 10 }
    ])
    expect(restrictToFiveM(analysis)).toBe(1)
    expect(resolveInstallMap(analysis.components).map((m) => `${m.dest.root}:${m.dest.path}`)).toEqual(['fivem:mods/armes.rpf'])
    expect(analysis.warnings.some((w) => /ignoré/.test(w))).toBe(true)
  })

  it('importe un .rpf seul dans FiveM.app/mods', async () => {
    const file = path.join(root, 'sources', 'Fusil doré.rpf')
    await write(file, 'RPF-FUSIL')
    const m = await mods.import(file, () => undefined, undefined, { kind: 'mod' })
    expect(m).toMatchObject({ name: 'Fusil doré', kind: 'mod', category: null, fileCount: 1 })
    expect(resolveInstallMap(m.components).map((x) => x.dest)).toEqual([{ root: 'fivem', path: 'mods/Fusil doré.rpf' }])
    // Un .rpf seul n'est pas un pack graphique.
    await expect(library.import(file, () => undefined)).rejects.toThrow(/Format non pris en charge/)
  })

  it('importe une archive avec un dossier mods/, sans les fichiers pour GTA V', async () => {
    const src = await folder('Pack voitures', {
      'Pack voitures/mods/voitures.rpf': 'RPF-VOITURES',
      'Pack voitures/mods/sons.rpf': 'RPF-SONS',
      'Pack voitures/enb/enbseries.ini': '[ENB]',
      'Pack voitures/Lisez-moi.txt': 'docs'
    })
    const zip = path.join(root, 'Pack voitures.zip')
    execFileSync(path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', src, 'Pack voitures'])
    const m = await mods.import(zip, () => undefined, undefined, { kind: 'mod' })
    expect(m.kind).toBe('mod')
    expect(resolveInstallMap(m.components).map((x) => x.dest.path).sort()).toEqual(['mods/sons.rpf', 'mods/voitures.rpf'])
    expect(m.components.find((c) => c.kind === 'gta-root')).toMatchObject({ enabled: false, destination: null })
  })

  it('refuse un mod qui n’a rien à installer dans FiveM.app', async () => {
    const src = await folder('ENB seul', { 'enb/enbseries.ini': '[ENB]', 'enb/enblocal.ini': '[PROXY]' })
    await expect(mods.import(src, () => undefined, undefined, { kind: 'mod' })).rejects.toThrow(ImportError)
    expect((await mods.list()).some((m) => m.name === 'ENB seul')).toBe(false)
  })
})

describe('mods dans le jeu', () => {
  let packA = ''
  let packB = ''
  let armes = ''
  let armesBis = ''
  let ciel = ''

  it('active un mod en plus du pack graphique', async () => {
    packA = (await library.import(await folder('Pack A', { 'mods/routes.rpf': 'A-ROUTES', 'mods/ciel.rpf': 'A-CIEL', 'plugins/dxgi.dll': 'A-RESHADE' }), () => undefined)).id
    packB = (await library.import(await folder('Pack B', { 'mods/routes.rpf': 'B-ROUTES', 'mods/ciel.rpf': 'B-CIEL', 'plugins/dxgi.dll': 'B-RESHADE' }), () => undefined)).id
    await installer.apply(packA, report)

    armes = (await mods.import(await folder('Armes', { 'mods/armes.rpf': 'ARMES-1', 'citizen/common/data/weapons.meta': '<armes/>' }), () => undefined, undefined, { kind: 'mod' })).id
    await installer.setModEnabled(armes, true, report)
    expect(await read(inGame('mods', 'armes.rpf'))).toBe('ARMES-1')
    expect(await read(inGame('citizen', 'common', 'data', 'weapons.meta'))).toBe('<armes/>')
    expect(modState(armes)).toMatchObject({ enabled: true, shadowed: [] })
    expect(modState(armes)!.files.map((f) => f.path).sort()).toEqual(['citizen/common/data/weapons.meta', 'mods/armes.rpf'])
    // Ni le pack, ni le mod ne passent pour des ajouts manuels.
    expect(await installer.scanForeign()).toEqual([])
    expect(state.get().active?.packId).toBe(packA)
  })

  it('deux mods en conflit : jamais d’écrasement sans le dire, l’autre mod peut être désactivé', async () => {
    armesBis = (await mods.import(await folder('Armes bis', { 'mods/armes.rpf': 'ARMES-BIS' }), () => undefined, undefined, { kind: 'mod' })).id
    const pre = await installer.modPreflight(armesBis)
    expect(pre.conflicts).toEqual([{ id: armes, name: 'Armes', files: ['mods/armes.rpf'] }])
    expect(pre.blockers).toEqual([])

    await expect(installer.setModEnabled(armesBis, true, report)).rejects.toThrow(/remplacent les mêmes fichiers/)
    expect(await read(inGame('mods', 'armes.rpf'))).toBe('ARMES-1')
    expect(modState(armesBis)?.enabled ?? false).toBe(false)

    // Désactivation de l'autre mod et activation, en une seule opération.
    await installer.setModEnabled(armesBis, true, report, [armes])
    expect(await read(inGame('mods', 'armes.rpf'))).toBe('ARMES-BIS')
    expect(existsSync(inGame('citizen', 'common', 'data', 'weapons.meta'))).toBe(false)
    expect(modState(armes)).toMatchObject({ enabled: false, files: [] })
    expect(modState(armesBis)?.enabled).toBe(true)

    await installer.setModEnabled(armesBis, false, report)
    await installer.setModEnabled(armes, true, report)
    expect(await read(inGame('mods', 'armes.rpf'))).toBe('ARMES-1')
  })

  it('refuse d’écraser un fichier installé à la main', async () => {
    await write(inGame('mods', 'maison.rpf'), 'FAIT MAIN')
    const id = (await mods.import(await folder('Maison', { 'mods/maison.rpf': 'MOD-MAISON' }), () => undefined, undefined, { kind: 'mod' })).id
    expect((await installer.modPreflight(id)).blockers[0]).toMatch(/installé à la main/)
    await expect(installer.setModEnabled(id, true, report)).rejects.toThrow(/Nettoyage/)
    expect(await read(inGame('mods', 'maison.rpf'))).toBe('FAIT MAIN')
    await fs.rm(inGame('mods', 'maison.rpf'))
  })

  it('remplace un fichier du pack actif et le remet en place quand le mod est retiré', async () => {
    ciel = (await mods.import(await folder('Ciel', { 'mods/ciel.rpf': 'MOD-CIEL' }), () => undefined, undefined, { kind: 'mod' })).id
    const pre = await installer.modPreflight(ciel)
    expect(pre.pack).toEqual({ name: 'Pack A', files: ['mods/ciel.rpf'] })
    expect(pre.conflicts).toEqual([])

    await installer.setModEnabled(ciel, true, report)
    expect(await read(inGame('mods', 'ciel.rpf'))).toBe('MOD-CIEL')
    expect(state.get().active!.files.some((f) => f.path === 'mods/ciel.rpf')).toBe(false)
    expect(modState(ciel)!.shadowed).toMatchObject([{ packId: packA, file: { path: 'mods/ciel.rpf' } }])

    await installer.setModEnabled(ciel, false, report)
    expect(await read(inGame('mods', 'ciel.rpf'))).toBe('A-CIEL')
    expect(state.get().active!.files.some((f) => f.path === 'mods/ciel.rpf')).toBe(true)
    expect(modState(ciel)).toMatchObject({ enabled: false, shadowed: [] })
  })

  it('changer de pack graphique ne touche pas aux mods', async () => {
    await installer.setModEnabled(ciel, true, report)
    const result = await installer.apply(packB, report)
    // Les fichiers des mods restent en place, et ne sont pas rangés dans un pack « Ajouts manuels ».
    expect(result.captured).toBeNull()
    expect((await library.list()).filter((m) => m.captured)).toEqual([])
    expect(await read(inGame('mods', 'armes.rpf'))).toBe('ARMES-1')
    expect(await read(inGame('mods', 'ciel.rpf'))).toBe('MOD-CIEL')
    expect(await read(inGame('mods', 'routes.rpf'))).toBe('B-ROUTES')
    expect(await read(inGame('plugins', 'dxgi.dll'))).toBe('B-RESHADE')
    // Le mod reste prioritaire : le fichier du nouveau pack sera posé quand il sera retiré.
    expect(modState(ciel)!.shadowed).toMatchObject([{ packId: packB, file: { path: 'mods/ciel.rpf' } }])
    expect(state.get().active!.files.some((f) => f.path === 'mods/ciel.rpf')).toBe(false)
    expect(await installer.scanForeign()).toEqual([])

    await installer.setModEnabled(ciel, false, report)
    expect(await read(inGame('mods', 'ciel.rpf'))).toBe('B-CIEL')
  })

  it('met à jour un mod activé en une seule opération, et le garde activé', async () => {
    const next = await mods.import(await folder('Armes v2', { 'mods/armes.rpf': 'ARMES-2', 'mods/munitions.rpf': 'MUNITIONS' }), () => undefined, undefined, {
      kind: 'mod'
    })
    expect(await installer.replaceMod(armes, next, report)).toBe(true)
    expect(await read(inGame('mods', 'armes.rpf'))).toBe('ARMES-2')
    expect(await read(inGame('mods', 'munitions.rpf'))).toBe('MUNITIONS')
    // Fichier de l'ancienne version absent de la nouvelle : retiré, et son dossier vidé aussi.
    expect(existsSync(inGame('citizen', 'common', 'data', 'weapons.meta'))).toBe(false)
    expect(existsSync(inGame('citizen', 'common'))).toBe(false)
    expect(modState(armes)).toBeUndefined()
    expect(modState(next.id)?.enabled).toBe(true)
    armes = next.id
  })

  it('désactive tous les mods d’un coup (mode pur), sans toucher au pack graphique', async () => {
    await installer.apply(packA, report)
    await installer.setModEnabled(ciel, true, report)
    expect(state.get().mods.filter((m) => m.enabled).length).toBe(2)

    expect(await installer.disableAllMods(report)).toEqual({ disabled: 2 })
    expect(state.get().mods.every((m) => !m.enabled && !m.files.length)).toBe(true)
    expect(existsSync(inGame('mods', 'armes.rpf'))).toBe(false)
    expect(existsSync(inGame('mods', 'munitions.rpf'))).toBe(false)
    // Le pack reste actif, et le fichier que le mod remplaçait est remis en place.
    expect(state.get().active?.packId).toBe(packA)
    expect(await read(inGame('mods', 'ciel.rpf'))).toBe('A-CIEL')
    expect(await read(inGame('plugins', 'dxgi.dll'))).toBe('A-RESHADE')
    expect(await installer.disableAllMods(report)).toEqual({ disabled: 0 })

    await installer.setModEnabled(armes, true, report)
  })

  it('nettoyer le jeu garde les mods, sauf si on demande de les retirer aussi', async () => {
    await installer.cleanGame(report)
    expect(state.get().active).toBeNull()
    expect(await read(inGame('mods', 'armes.rpf'))).toBe('ARMES-2')
    expect(existsSync(inGame('plugins', 'dxgi.dll'))).toBe(false)

    await installer.apply(packA, report)
    const result = await installer.cleanGame(report, true)
    expect(result.mods).toBe(1)
    expect(state.get().active).toBeNull()
    expect(existsSync(inGame('mods', 'armes.rpf'))).toBe(false)
    expect(state.get().mods.every((m) => !m.enabled && !m.files.length)).toBe(true)
    expect((await fs.readdir(inGame('mods')).catch(() => [])).length).toBe(0)
  })

  it('supprime un mod activé : retiré du jeu puis oublié', async () => {
    await installer.setModEnabled(armes, true, report)
    await installer.forgetMod(armes, report)
    expect(existsSync(inGame('mods', 'armes.rpf'))).toBe(false)
    expect(modState(armes)).toBeUndefined()
  })
})

describe('mod qui remplace un fichier d’un pack protégé', () => {
  it('le fichier du pack revient, déchiffré, quand le mod est retiré', async () => {
    const key = randomBytes(32)
    const routes = Buffer.concat([Buffer.from('SECRET-ROUTES'), randomBytes(4096)])
    const { bytes } = writePackage(
      [
        { path: 'Protégé/mods/routes.rpf', data: routes },
        { path: 'Protégé/plugins/dxgi.dll', data: Buffer.from('SECRET-RESHADE') }
      ],
      key
    )
    const fpk = path.join(root, 'protege.fpk')
    await fs.writeFile(fpk, bytes)
    const pack = await library.importPackage(fpk, key, { name: 'Protégé.zip', size: bytes.length }, () => undefined)
    await installer.apply(pack.id, report)
    expect((await fs.readFile(inGame('mods', 'routes.rpf'))).equals(routes)).toBe(true)

    const mod = (await mods.import(await folder('Routes', { 'mods/routes.rpf': 'MOD-ROUTES' }), () => undefined, undefined, { kind: 'mod' })).id
    await installer.setModEnabled(mod, true, report)
    expect(await read(inGame('mods', 'routes.rpf'))).toBe('MOD-ROUTES')
    // Rien du pack protégé n'est gardé en clair ailleurs que dans le jeu.
    expect(existsSync(path.join(library.packDir(pack.id), 'content'))).toBe(false)

    await installer.setModEnabled(mod, false, report)
    expect((await fs.readFile(inGame('mods', 'routes.rpf'))).equals(routes)).toBe(true)
    expect(state.get().active!.files.some((f) => f.path === 'mods/routes.rpf')).toBe(true)
    await installer.removeActive(report)
  })
})

describe('state.json', () => {
  it('un state.json d’avant les mods se charge sans perte', async () => {
    const file = path.join(root, 'ancien', 'state.json')
    const old = {
      schema: 1,
      active: { id: 'inst-1', packId: 'p', packName: 'Ancien', appliedAt: '2026-01-01T00:00:00Z', roots: { fivem: 'F', gta: 'G' }, files: [], createdDirs: [], partial: false },
      history: [{ at: '2026-01-01T00:00:00Z', action: 'apply', packName: 'Ancien', summary: '3 fichiers', ok: true }]
    }
    await write(file, JSON.stringify(old))
    const store = new JsonStore<AppState>(file, emptyState())
    const loaded = normalizeState(await store.load(emptyState()))
    expect(loaded.mods).toEqual([])
    expect(loaded.active).toEqual(old.active)
    expect(loaded.history).toEqual(old.history)
  })

  it('complète une entrée incomplète et écarte une entrée illisible', () => {
    const s = { schema: 1, active: null, history: [], mods: [{ id: 'm1', files: [], enabled: true }, { nom: 'cassé' }] } as unknown as AppState
    const out = normalizeState(s)
    expect(out.mods).toEqual([{ id: 'm1', name: 'm1', files: [], enabled: true, appliedAt: null, roots: { fivem: '', gta: '' }, createdDirs: [], shadowed: [] }])
    // Rien à corriger : même objet (state.json n'est pas réécrit).
    expect(normalizeState(out)).toBe(out)
  })
})

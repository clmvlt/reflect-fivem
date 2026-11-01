// Réglages d'un mod (couleur des flammes) : recoloration d'une archive .rpf, puis application de bout en bout sur de faux
// dossiers FiveM / GTA V, mod activé ou non, protégé ou non, et reprise des choix quand le mod est mis à jour.
import { randomBytes } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppState, GamesInfo, ModOption } from '../src/shared/types'
import { colorsOf, fakeRpf, fakeYpt, readRpf } from './fixtures/rpf'

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, app: { getVersion: () => '1.0.0', getLocale: () => 'fr', isPackaged: false } }))
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
const { Library } = await import('../src/main/core/library')
const { Installer } = await import('../src/main/core/installer')
const { JsonStore, emptyState } = await import('../src/main/core/stores')
const { inspectFiveM, inspectGta } = await import('../src/main/core/games')
const { carryModOptions } = await import('../src/main/core/modOptions')
const { recolorRpf, RecolorError, particleKey } = await import('../src/main/core/rpfRecolor')
const { colorCss, colorStops, paintOf, parseModOptions, usableValues, isUsableColor, optionLabel } = await import('../src/shared/modOptions')

// ------------------------------------------------------------------ fausses archives

const near = (a: number[], b: number[]): void => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 5))
const ORANGE: [number, number, number, number] = [1, 0.57, 0, 0.3]
const SMOKE: [number, number, number, number] = [0.28, 0.28, 0.28, 0.5]
const GREEN: [number, number, number] = [0, 1, 0]

function backfireYpt(): Buffer {
  return fakeYpt([
    { name: 'veh_exhaust_backfire', rgba: ORANGE },
    { name: 'veh_exhaust_smoke', rgba: SMOKE }
  ])
}

const OPTION: ModOption = {
  id: 'flames',
  type: 'color',
  label: { fr: 'Couleur des flammes', en: 'Flame colour' },
  targets: [{ file: 'core.ypt', particles: ['veh_exhaust_backfire'] }]
}

/** Archive d'un mod : trois archives internes, comme un vrai mod (core.ypt en trois exemplaires). */
function backfireMod(ypt = backfireYpt()): Buffer {
  const inner = (): Buffer => fakeRpf([{ name: 'core.ypt', resource: ypt }, { name: 'autre.ypt', resource: fakeYpt([{ name: 'autre', rgba: ORANGE }]) }])
  const x64 = fakeRpf([{ name: 'setup2.xml', plain: Buffer.from('<SSetupData/>') }, { name: 'ptfx.rpf', rpf: inner() }, { name: 'ptfx_hi.rpf', rpf: inner() }, { name: 'ptfx_lo.rpf', rpf: inner() }])
  return fakeRpf([{ name: 'assembly.xml', plain: Buffer.from('<package/>') }, { name: 'vfx.rpf', rpf: x64 }])
}

describe('recoloration d’une archive .rpf', () => {
  const recolors = [{ file: 'core.ypt', particles: ['veh_exhaust_backfire'], rgb: GREEN }]

  it('change le rouge, le vert et le bleu des particules visées, dans tous les exemplaires', async () => {
    const source = backfireMod()
    const copy = Buffer.from(source)
    const { data, found } = await recolorRpf(source, recolors)
    expect(source.equals(copy)).toBe(true)
    expect(found).toEqual(new Set([particleKey('core.ypt', 'veh_exhaust_backfire')]))
    const files = readRpf(data!)
    for (const name of ['ptfx', 'ptfx_hi', 'ptfx_lo']) {
      const ypt = files.get(`vfx.rpf/${name}.rpf/core.ypt`)!
      for (const color of colorsOf(ypt, 0)) near(color, [0, 1, 0, ORANGE[3]])
      for (const color of colorsOf(ypt, 1)) near(color, SMOKE)
    }
    // Le reste de l'archive est identique.
    const before = readRpf(source)
    expect(files.get('assembly.xml')!.equals(before.get('assembly.xml')!)).toBe(true)
    expect(files.get('vfx.rpf/setup2.xml')!.equals(before.get('vfx.rpf/setup2.xml')!)).toBe(true)
    expect(files.get('vfx.rpf/ptfx.rpf/autre.ypt')!.equals(before.get('vfx.rpf/ptfx.rpf/autre.ypt')!)).toBe(true)
    expect(data!.length % 512).toBe(0)
  })

  it('dégradé : chaque image clé prend la teinte de son moment dans la vie de la particule', async () => {
    const { data } = await recolorRpf(backfireMod(), [{ file: 'core.ypt', particles: ['veh_exhaust_backfire'], rgb: GREEN, rgbEnd: [1, 0, 0] }])
    const ypt = readRpf(data!).get('vfx.rpf/ptfx.rpf/core.ypt')!
    const [minStart, minEnd, maxStart, maxEnd] = colorsOf(ypt, 0)
    near(minStart, [0, 1, 0, ORANGE[3]])
    near(maxStart, [0, 1, 0, ORANGE[3]])
    near(minEnd, [1, 0, 0, ORANGE[3]])
    near(maxEnd, [1, 0, 0, ORANGE[3]])
    for (const color of colorsOf(ypt, 1)) near(color, SMOKE)
  })

  it('garde la taille dans l’en-tête d’une ressource qui l’y avait', async () => {
    const source = fakeRpf([{ name: 'core.ypt', resource: backfireYpt(), big: true }])
    const { data } = await recolorRpf(source, recolors)
    expect(data!.readUIntLE(16 + 16 + 2, 3)).toBe(0xffffff)
    for (const color of colorsOf(readRpf(data!).get('core.ypt')!, 0)) near(color, [0, 1, 0, ORANGE[3]])
  })

  it('ne touche à rien quand la particule n’y est pas', async () => {
    const { data, found } = await recolorRpf(backfireMod(), [{ file: 'core.ypt', particles: ['inconnue'], rgb: GREEN }])
    expect(data).toBeNull()
    expect(found.size).toBe(0)
  })

  it('refuse une archive chiffrée ou endommagée', async () => {
    await expect(recolorRpf(fakeRpf([{ name: 'a.xml', plain: Buffer.from('x') }], 0x50584643), recolors)).rejects.toThrow(RecolorError)
    await expect(recolorRpf(Buffer.from('pas une archive du tout'), recolors)).rejects.toThrow(RecolorError)
    // Pointeur hors de la ressource.
    const broken = backfireYpt()
    broken.writeUInt32LE(0x5fffffff, 0x38)
    await expect(recolorRpf(fakeRpf([{ name: 'core.ypt', resource: broken }]), recolors)).rejects.toThrow(RecolorError)
    // Ressource tronquée.
    const truncated = fakeRpf([{ name: 'core.ypt', resource: backfireYpt() }])
    await expect(recolorRpf(truncated.subarray(0, 600), recolors)).rejects.toThrow(RecolorError)
  })
})

describe('options d’une fiche', () => {
  it('ignore ce qui est inconnu ou incomplet', () => {
    expect(parseModOptions(undefined)).toEqual([])
    expect(
      parseModOptions([
        OPTION,
        OPTION,
        { ...OPTION, id: 'autre', type: 'slider' },
        { ...OPTION, id: 'sans-nom', label: { en: 'x' } },
        { ...OPTION, id: 'chemin', targets: [{ file: '../core.ypt', particles: ['a'] }] }
      ])
    ).toEqual([OPTION])
  })

  it('garde les couleurs utilisables de ce que le mod propose', () => {
    expect(isUsableColor('#2020ff')).toBe(true)
    expect(isUsableColor('#000000')).toBe(false)
    expect(isUsableColor('rouge')).toBe(false)
    expect(isUsableColor('#a020ff,#2020ff')).toBe(true)
    expect(isUsableColor('#a020ff,#000000')).toBe(false)
    expect(isUsableColor('#a020ff,#2020ff,#ffffff')).toBe(false)
    expect(usableValues([OPTION], { flames: '#A020FF,#2020FF' })).toEqual({ flames: '#a020ff,#2020ff' })
    expect(colorStops('#a020ff,#2020ff')).toEqual(['#a020ff', '#2020ff'])
    expect(colorStops('#a020ff')).toEqual(['#a020ff', '#a020ff'])
    expect(colorCss('#a020ff')).toBe('#a020ff')
    expect(colorCss('#a020ff,#2020ff')).toBe('linear-gradient(to right, #a020ff, #2020ff)')
    expect(paintOf('#ff0000')).toEqual({ rgb: [1, 0, 0] })
    expect(paintOf('#ff0000,#0000ff')).toEqual({ rgb: [1, 0, 0], rgbEnd: [0, 0, 1] })
    expect(usableValues([OPTION], { flames: '#FF0000', autre: '#00ff00' })).toEqual({ flames: '#ff0000' })
    expect(usableValues([OPTION], { flames: '#101010' })).toEqual({})
    expect(optionLabel(OPTION, 'en-US')).toBe('Flame colour')
    expect(optionLabel(OPTION, 'de')).toBe('Couleur des flammes')
  })
})

// ------------------------------------------------------------------ dans le jeu

describe('réglages d’un mod dans le jeu', () => {
  let root: string
  let fivem: string
  let gta: string
  let mods: InstanceType<typeof Library>
  let installer: InstanceType<typeof Installer>
  let state: InstanceType<typeof JsonStore<AppState>>
  const report = (): void => undefined

  const write = async (p: string, content: string | Buffer = 'x'): Promise<void> => {
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, content)
  }
  const games = async (): Promise<GamesInfo> => ({ fivem: await inspectFiveM(fivem, 'test'), gta: await inspectGta(gta, 'test'), fivemCandidates: [], gtaCandidates: [], mismatch: false, runningProcesses: [] })
  const inGame = (name: string): string => path.join(fivem, 'mods', name)
  const flameColors = async (file: string): Promise<number[][]> => colorsOf(readRpf(await fs.readFile(file)).get('vfx.rpf/ptfx.rpf/core.ypt')!, 0)
  const addMod = async (name: string, archive: Buffer): Promise<string> => {
    const file = path.join(root, 'sources', `${name}.rpf`)
    await write(file, archive)
    const m = await mods.import(file, () => undefined, undefined, { kind: 'mod' })
    await mods.save({ ...(await mods.get(m.id)), options: [OPTION] })
    return m.id
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-mod-options-'))
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
    const library = new Library(path.join(root, 'Bibliotheque'), keys)
    mods = new Library(path.join(root, 'Bibliotheque', '.mods'), keys)
    installer = new Installer({ jobsDir: path.join(root, 'data', 'jobs'), library: () => library, modLibrary: () => mods, state, detectGames: games })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('mod activé : remplacé dans le jeu, le contenu d’origine reste intact, et revient sans réglage', async () => {
    const source = backfireMod()
    const id = await addMod('Flammes', source)
    await installer.setModEnabled(id, true, report)
    const file = inGame('Flammes.rpf')
    for (const color of await flameColors(file)) near(color, ORANGE)

    await installer.setModOptions(id, { flames: '#00ff00' }, report)
    for (const color of await flameColors(file)) near(color, [0, 1, 0, ORANGE[3]])
    const applied = await mods.get(id)
    expect(applied.optionValues).toEqual({ flames: '#00ff00' })
    expect(applied.optionsDir).toMatch(/^options-/)
    expect((await (await mods.content(applied)).read(applied.files[0].rel))!.equals(source)).toBe(true)
    // Rien ne passe pour un ajout manuel, et le mod reste activé.
    expect(await installer.scanForeign()).toEqual([])
    expect(state.get().mods.find((m) => m.id === id)).toMatchObject({ enabled: true })

    // Nouveau réglage : repart du contenu d'origine, l'ancien dossier disparaît.
    const previous = path.join(mods.packDir(id), 'generated', applied.optionsDir!)
    await installer.setModOptions(id, { flames: '#ff0000' }, report)
    for (const color of await flameColors(file)) near(color, [1, 0, 0, ORANGE[3]])
    expect(existsSync(previous)).toBe(false)

    // Désactivé puis réactivé : le réglage reste.
    await installer.setModEnabled(id, false, report)
    expect(existsSync(file)).toBe(false)
    await installer.setModEnabled(id, true, report)
    for (const color of await flameColors(file)) near(color, [1, 0, 0, ORANGE[3]])

    // Sans réglage : le fichier du mod, à l'identique.
    await installer.setModOptions(id, {}, report)
    expect((await fs.readFile(file)).equals(source)).toBe(true)
    expect((await mods.get(id)).optionsDir).toBeUndefined()
    await installer.setModEnabled(id, false, report)
  })

  it('applique un dégradé dans le jeu, puis le garde à la réactivation', async () => {
    const id = await addMod('Flammes degrade', backfireMod())
    await installer.setModEnabled(id, true, report)
    await installer.setModOptions(id, { flames: '#00ff00,#ff0000' }, report)
    const file = inGame('Flammes degrade.rpf')
    const check = async (): Promise<void> => {
      const [start, end] = await flameColors(file)
      near(start, [0, 1, 0, ORANGE[3]])
      near(end, [1, 0, 0, ORANGE[3]])
    }
    await check()
    await installer.setModEnabled(id, false, report)
    await installer.setModEnabled(id, true, report)
    await check()
    await installer.setModEnabled(id, false, report)
  })

  it('mod désactivé : le réglage attend son activation', async () => {
    const id = await addMod('Flammes attente', backfireMod())
    await installer.setModOptions(id, { flames: '#00ffff' }, report)
    expect(existsSync(inGame('Flammes attente.rpf'))).toBe(false)
    await installer.setModEnabled(id, true, report)
    for (const color of await flameColors(inGame('Flammes attente.rpf'))) near(color, [0, 1, 1, ORANGE[3]])
    await installer.setModEnabled(id, false, report)
  })

  it('refuse une couleur inutilisable et un mod sans la particule, sans rien changer', async () => {
    const id = await addMod('Flammes refus', backfireMod())
    await expect(installer.setModOptions(id, { flames: '#000000' }, report)).rejects.toThrow()
    await mods.save({ ...(await mods.get(id)), options: [{ ...OPTION, targets: [{ file: 'core.ypt', particles: ['inconnue'] }] }] })
    await expect(installer.setModOptions(id, { flames: '#ff0000' }, report)).rejects.toThrow(/inconnue/)
    const m = await mods.get(id)
    expect(m.optionValues).toBeUndefined()
    expect(existsSync(path.join(mods.packDir(id), 'generated'))).toBe(false)
  })

  it('une nouvelle version reprend les choix, appliqués à ses propres fichiers', async () => {
    const from = await mods.get(await addMod('Flammes v1', backfireMod()))
    await installer.setModOptions(from.id, { flames: '#00ff00' }, report)
    const old = await mods.get(from.id)
    const ypt = fakeYpt([
      { name: 'veh_exhaust_backfire', rgba: [0.5, 0.5, 0.5, 0.9] },
      { name: 'veh_exhaust_smoke', rgba: SMOKE }
    ])
    const to = await mods.get(await addMod('Flammes v2', backfireMod(ypt)))
    await carryModOptions(mods, old, to, report)
    expect(to.optionValues).toEqual({ flames: '#00ff00' })
    await mods.save(to)
    await installer.setModEnabled(to.id, true, report)
    for (const color of await flameColors(inGame('Flammes v2.rpf'))) near(color, [0, 1, 0, 0.9])
    await installer.setModEnabled(to.id, false, report)

    // La nouvelle version ne contient plus la particule : échec, à signaler par l'appelant.
    const without = await mods.get(await addMod('Flammes v3', backfireMod(fakeYpt([{ name: 'autre', rgba: ORANGE }]))))
    await expect(carryModOptions(mods, old, without, report)).rejects.toThrow(/veh_exhaust_backfire/)
    expect(without.optionValues).toBeUndefined()
  })

  it('mod protégé : le fichier réglé reste chiffré dans la bibliothèque', async () => {
    const key = randomBytes(32)
    const archive = backfireMod()
    const id = randomBytes(16)
    const stream = sealed.sealBytes(archive, sealed.hkdf(key, id, 'fpm-pack/file/0'))
    const index = sealed.sealBytes(Buffer.from(JSON.stringify({ v: 1, files: [{ p: 'mods/Flammes protegees.rpf', s: archive.length, o: 32, l: stream.length }] })), sealed.hkdf(key, id, 'fpm-pack/index'))
    const trailer = Buffer.alloc(16)
    trailer.writeBigUInt64BE(BigInt(32 + stream.length), 0)
    trailer.writeBigUInt64BE(BigInt(index.length), 8)
    const file = path.join(root, 'sources', 'protege.fpk')
    await write(file, Buffer.concat([Buffer.from('FPMPACK1', 'latin1'), id, Buffer.alloc(8), stream, index, trailer]))
    const m = await mods.importPackage(file, key, { name: 'Flammes protegees.zip', size: archive.length }, () => undefined, 'mod')
    await mods.save({ ...(await mods.get(m.id)), options: [OPTION] })

    await installer.setModOptions(m.id, { flames: '#00ff00' }, report)
    const saved = await mods.get(m.id)
    const stored = await fs.readFile(path.join(mods.packDir(m.id), 'generated', saved.optionsDir!, 'fivem', 'mods', 'Flammes protegees.rpf'))
    expect(stored.subarray(0, 8).toString('latin1')).toBe('FPMSEAL1')
    await installer.setModEnabled(m.id, true, report)
    for (const color of await flameColors(inGame('Flammes protegees.rpf'))) near(color, [0, 1, 0, ORANGE[3]])
    await installer.setModEnabled(m.id, false, report)
  })
})

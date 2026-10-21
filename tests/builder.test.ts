// « Créer ton pack » : catalogue gardé sur le disque (ETag, 304), contrôle des chemins du manifeste et des entrées des
// zips, téléchargement des fichiers (SHA-256 vérifié, reprise d'un fichier partiel), construction du pack dans la
// bibliothèque (zips, puis fichiers, puis fichiers écrits, dont ceux de chaque outil d'ambiance sous leur racine), et
// nouvelle révision proposée comme une mise à jour. Droit « Peut créer un pack » : sans lui, aucune requête. Outils
// d'ambiance : conversion des créations d'avant les outils, règles QuantV / ReShade, choix rapide (Basique, Recommandé)
// et aperçu d'un style. Images de référence en jeu : lues dans le catalogue et gardées sur le disque.
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { crc32 } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILDER_NOT_ALLOWED, canUseBuilder, SIGNED_OUT } from '@shared/api'
import type { AccountMe } from '@shared/types'
import type { BuilderAccount } from '../src/main/core/builder'
import type { InstallHooks } from '../src/main/core/marketplace'

// Extraction des archives dans le processus des tests (pas de worker).
vi.mock('../src/main/archive', async () => {
  const ex = await import('../src/main/archive/extractors')
  return {
    sevenZipPath: () => null,
    extractInWorker: (file: string, target: string, onProgress: (p: unknown) => void) => ex.extractArchive(file, target, onProgress, null)
  }
})

const { Builder, checkManifest, extractBundle, isSafeInstallPath, styleImageVersion, toCatalog } = await import('../src/main/core/builder')
const { ambianceChoice, cleanTools, enableTool, fromLegacy, noTools, previewLook, recommendedTools, setTool, setToolMode, styleOf, toolOff, withKnownStyles } =
  await import('@shared/ambiance')
const { ApiError } = await import('../src/main/core/http')
const { Library } = await import('../src/main/core/library')

const API = 'https://api.test/api'
const BUILD = '11111111-2222-4333-8444-555555555555'
const PRESET_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const ROADS_ID = 'aaaaaaaa-0000-4000-8000-000000000002'
const IMAGE_ID = 'bbbbbbbb-0000-4000-8000-000000000001'
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')
const json = (body: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init })

/** Zip minimal (entrées stockées, noms en UTF-8), comme les dossiers de shaders livrés par l'API. */
function zip(entries: Record<string, string>): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text)
    const fileName = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(fileName.length, 26)
    parts.push(local, fileName, data)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x800, 8)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(fileName.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, fileName)
    offset += local.length + fileName.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, end])
}

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-builder-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('chemins du manifeste', () => {
  it('limite FiveM.app à mods, plugins, addons et citizen', () => {
    expect(isSafeInstallPath('fivem', 'mods/routes.rpf')).toBe(true)
    expect(isSafeInstallPath('fivem', 'plugins/reshade-shaders/Shaders/Bloom.fx')).toBe(true)
    expect(isSafeInstallPath('fivem', 'citizen/common/data/timecycle.xml')).toBe(true)
    expect(isSafeInstallPath('fivem', 'CitizenFX.ini')).toBe(false)
    expect(isSafeInstallPath('fivem', 'data/cache/x.bin')).toBe(false)
  })

  it('refuse les fichiers du jeu sous GTA V', () => {
    expect(isSafeInstallPath('gta', 'enbseries.ini')).toBe(true)
    expect(isSafeInstallPath('gta', 'enbseries/enbbloom.fx')).toBe(true)
    expect(isSafeInstallPath('gta', 'x64a.rpf')).toBe(false)
    expect(isSafeInstallPath('gta', 'update/update.rpf')).toBe(false)
    expect(isSafeInstallPath('gta', 'GTA5.exe')).toBe(false)
  })

  it('refuse « .. », les chemins absolus et les caractères interdits', () => {
    for (const bad of ['mods/../../x.rpf', '/mods/x.rpf', 'mods/', 'mods//x.rpf', 'mods\\x.rpf', 'mods/a?.rpf', 'mods/x.rpf.', 'mods/con.rpf', 'C:/mods/x.rpf'])
      expect(isSafeInstallPath('fivem', bad), bad).toBe(false)
    expect(isSafeInstallPath('other', 'mods/x.rpf')).toBe(false)
  })

  const file = (extra: Record<string, unknown>): Record<string, unknown> => ({
    componentId: ROADS_ID,
    root: 'fivem',
    path: 'mods/routes.rpf',
    kind: 'file',
    size: 3,
    sha256: sha('abc'),
    url: `/builder/files/${sha('abc')}`,
    entryCount: 1,
    ...extra
  })

  it('refuse tout le manifeste au premier chemin refusé', () => {
    const ok = { revision: 'r', files: [file({})], generated: [] }
    expect(checkManifest(ok).files).toHaveLength(1)
    expect(() => checkManifest({ ...ok, files: [file({}), file({ path: '../FiveM.exe' })] })).toThrow(/chemin refusé/)
    expect(() => checkManifest({ ...ok, files: [file({ root: 'gta', path: 'x64b.rpf' })] })).toThrow(/chemin refusé/)
    expect(() => checkManifest({ ...ok, generated: [{ root: 'fivem', path: 'ReShade.ini', content: '' }] })).toThrow(/chemin refusé/)
    expect(() => checkManifest({ ...ok, preset: '../Preset.ini' })).toThrow(/chemin refusé/)
    // Adresse vers un autre serveur, empreinte invalide, zip sans entrée : réponse refusée.
    expect(() => checkManifest({ ...ok, files: [file({ url: '//ailleurs.test/x' })] })).toThrow()
    expect(() => checkManifest({ ...ok, files: [file({ sha256: 'abc' })] })).toThrow()
    expect(() => checkManifest({ ...ok, files: [file({ kind: 'bundle', entryCount: 0 })] })).toThrow()
  })

  it('met les zips avant les fichiers', () => {
    const m = checkManifest({ revision: 'r', files: [file({}), file({ kind: 'bundle', path: 'plugins/reshade-shaders', entryCount: 2 })], generated: [] })
    expect(m.files.map((f) => f.kind)).toEqual(['bundle', 'file'])
  })
})

describe('zips des composants', () => {
  it('extrait les entrées sous le dossier du zip', async () => {
    const file = path.join(dir, 'shaders.zip')
    await fs.writeFile(file, zip({ 'Shaders/a.fx': 'A', 'Textures/b.png': 'B' }))
    const target = path.join(dir, 'out')
    const out = await extractBundle(file, target, 'fivem', 'plugins/reshade-shaders', 2)
    expect(out.map((e) => e.rel).sort()).toEqual(['Shaders/a.fx', 'Textures/b.png'])
    expect(await fs.readFile(path.join(target, 'Shaders', 'a.fx'), 'utf8')).toBe('A')
  })

  it('refuse un zip qui sort de son dossier (zip slip) sans rien écrire', async () => {
    const file = path.join(dir, 'slip.zip')
    await fs.writeFile(file, zip({ 'Shaders/a.fx': 'A', '../../../evil.dll': 'X' }))
    const target = path.join(dir, 'out')
    await expect(extractBundle(file, target, 'fivem', 'plugins/reshade-shaders', 2)).rejects.toThrow(/chemin refusé/)
    await expect(fs.stat(target)).rejects.toThrow()
  })

  it('refuse un zip qui n’a pas le nombre de fichiers annoncé', async () => {
    const file = path.join(dir, 'count.zip')
    await fs.writeFile(file, zip({ 'Shaders/a.fx': 'A' }))
    await expect(extractBundle(file, path.join(dir, 'out'), 'fivem', 'plugins/reshade-shaders', 3)).rejects.toThrow(/endommagé/)
  })
})

// ---------------------------------------------------------------------------

interface Served {
  data: Buffer
  /** Contenu envoyé à la place (fichier abîmé en route). */
  corrupt?: Buffer
}

/** API de test : compte connecté, créations, manifestes et fichiers servis (avec Range). */
function setup() {
  const blobs = new Map<string, Served>()
  const routes = new Map<string, unknown>()
  const requests: { url: string; headers: Record<string, string> }[] = []
  const me = { id: 7, admin: false, canBuildPacks: true } as AccountMe
  const account = {
    signedIn: true,
    current: () => (account.signedIn ? me : null),
    refresh: vi.fn(async () => (account.signedIn ? me : null)),
    call: vi.fn(async (method: string, pathname: string) => {
      const body = routes.get(`${method} ${pathname}`)
      if (body === undefined) throw new ApiError('Introuvable.', 404)
      return body
    }),
    fetchAuthed: vi.fn(async (): Promise<Response> => new Response(null, { status: 500 })),
    accessToken: async () => 'jeton',
    renewRejected: async () => 'jeton2'
  }
  const fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    requests.push({ url, headers })
    if (url.includes('/images/') || url.includes('/builder/styles/') || url.includes('/builder/references/')) return new Response(new Uint8Array(JPEG), { status: 200 })
    const m = /\/builder\/files\/([0-9a-f]{64})$/.exec(url)
    const served = m && blobs.get(m[1])
    if (!served) return json({ detail: 'Fichier introuvable.' }, { status: 404 })
    if (headers.authorization !== 'Bearer jeton') return json({ code: 'token-invalid' }, { status: 401 })
    const body = served.corrupt ?? served.data
    const range = /^bytes=(\d+)-$/.exec(headers.range ?? '')
    if (range && headers['if-range'] === `"${m[1]}"`) {
      const start = Number(range[1])
      return new Response(new Uint8Array(body.subarray(start)), { status: 206, headers: { 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}` } })
    }
    return new Response(new Uint8Array(body), { status: 200 })
  })
  const library = new Library(path.join(dir, 'Bibliotheque'))
  const builder = new Builder({
    apiUrl: API,
    dir: path.join(dir, 'builder'),
    account: account as unknown as BuilderAccount,
    library: () => library,
    fetch,
    retryDelayMs: 1
  })
  const serve = (data: Buffer | string): { sha256: string; size: number } => {
    const buffer = Buffer.from(data)
    blobs.set(sha(buffer), { data: buffer })
    return { sha256: sha(buffer), size: buffer.length }
  }
  return { account, me, fetch, requests, routes, blobs, serve, library, builder }
}

type Setup = ReturnType<typeof setup>

const PRESET_V1 = 'Techniques=Bloom@Bloom.fx\r\n\r\n[Bloom.fx]\r\nIntensity=0.500000\r\n'
const PRESET_V2 = 'Techniques=Bloom@Bloom.fx\r\n\r\n[Bloom.fx]\r\nIntensity=0.800000\r\n'

/** Une création : un zip de shaders, un fichier qui en remplace un du zip, un .rpf, un fichier de GTA V et le preset réglé. */
function publish(s: Setup, opts: { revision: string; preset: string; roads?: string }) {
  const bundle = s.serve(zip({ 'Shaders/Bloom.fx': 'bloom du zip', 'Shaders/Vignette.fx': 'vignette du zip' }))
  const bloom = s.serve('bloom corrigé')
  const roads = s.serve(opts.roads ?? 'RPF7 routes')
  const enb = s.serve('enb bloom')
  const old = s.serve('ancien preset')
  const entry = (f: { sha256: string; size: number }, extra: Record<string, unknown>) => ({ ...f, url: `/builder/files/${f.sha256}`, entryCount: 1, kind: 'file', ...extra })
  s.routes.set(`GET /builder/builds/${BUILD}/manifest`, {
    buildId: BUILD,
    name: 'Mon pack',
    revision: opts.revision,
    // Dans le désordre : les zips sont installés d'abord quoi qu'il arrive.
    files: [
      entry(bloom, { componentId: PRESET_ID, root: 'fivem', path: 'plugins/reshade-shaders/Shaders/Bloom.fx' }),
      entry(bundle, { componentId: PRESET_ID, root: 'fivem', path: 'plugins/reshade-shaders', kind: 'bundle', entryCount: 2 }),
      entry(roads, { componentId: ROADS_ID, root: 'fivem', path: 'mods/routes.rpf' }),
      entry(enb, { componentId: PRESET_ID, root: 'gta', path: 'enbseries/enbbloom.fx' }),
      entry(old, { componentId: PRESET_ID, root: 'fivem', path: 'plugins/Preset.ini' })
    ],
    generated: [{ componentId: PRESET_ID, root: 'fivem', path: 'plugins/Preset.ini', content: opts.preset }],
    preset: 'plugins/Preset.ini',
    unavailable: [],
    problems: [],
    totalSize: 100
  })
  s.routes.set(`GET /builder/builds/${BUILD}`, {
    id: BUILD,
    name: 'Mon pack',
    components: [
      { id: PRESET_ID, name: 'Preset Réaliste', category: 'reshade', available: true },
      { id: ROADS_ID, name: 'Routes HD', category: 'roads', available: true }
    ],
    reshade: { controls: {}, techniques: {}, values: {} },
    problems: [],
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z'
  })
  s.routes.set(`GET /builder/components/${PRESET_ID}`, { id: PRESET_ID, slug: 'preset', category: 'reshade', name: 'Preset Réaliste', images: [{ id: IMAGE_ID, width: 1920, height: 1080 }] })
  return { bundle, bloom, roads, enb }
}

const hooks = (over: Partial<InstallHooks> = {}): InstallHooks & { apply: ReturnType<typeof vi.fn> } => ({
  activeId: () => null,
  apply: vi.fn(async () => undefined),
  lock: vi.fn(async () => undefined),
  ...over
}) as InstallHooks & { apply: ReturnType<typeof vi.fn> }

const content = (s: Setup, packId: string, ...parts: string[]): Promise<string> => fs.readFile(path.join(s.library.contentDir(packId), ...parts), 'utf8')

describe('droit « Peut créer un pack »', () => {
  it('« Créer ton pack » seulement pour un compte connecté qui a le droit, ou l’admin', () => {
    expect(canUseBuilder(null)).toBe(false)
    expect(canUseBuilder(undefined)).toBe(false)
    expect(canUseBuilder({ admin: false, canBuildPacks: false })).toBe(false)
    expect(canUseBuilder({ admin: false, canBuildPacks: true })).toBe(true)
    expect(canUseBuilder({ admin: true, canBuildPacks: false })).toBe(true)
    // Compte enregistré par une version qui ne connaissait pas le droit.
    expect(canUseBuilder({ id: 3, admin: false } as AccountMe)).toBe(false)
  })
})

describe('catalogue', () => {
  const body = (version: string) => ({
    version,
    groups: [{ key: 'world', label: 'Monde', categories: ['roads'] }],
    categories: [{ key: 'roads', label: 'Routes', group: 'world', single: true, components: [{ id: ROADS_ID, slug: 'routes', category: 'roads', name: `Routes ${version}`, conflictsWith: [], provides: [], requires: [] }] }],
    controls: []
  })

  it('le garde sur le disque et le revérifie avec son ETag (304 : rien à faire)', async () => {
    const s = setup()
    s.account.fetchAuthed.mockResolvedValueOnce(json(body('v1'), { headers: { ETag: '"v1"' } }))
    const first = await s.builder.catalog(true)
    expect(first.checked).toBe(true)
    expect(first.categories[0].components[0].name).toBe('Routes v1')
    expect(s.account.fetchAuthed).toHaveBeenLastCalledWith('GET', '/builder/catalog', {})
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'builder', 'catalog-fr.json'), 'utf8')) as { etag: string }
    expect(saved.etag).toBe('"v1"')

    // Copie du disque, sans requête.
    s.account.fetchAuthed.mockClear()
    const cached = await s.builder.catalog()
    expect(s.account.fetchAuthed).not.toHaveBeenCalled()
    expect(cached).toMatchObject({ checked: false, offline: false, version: 'v1' })

    // Revérifiée : rien n'a changé.
    s.account.fetchAuthed.mockResolvedValueOnce(new Response(null, { status: 304 }))
    const same = await s.builder.catalog(true)
    expect(s.account.fetchAuthed).toHaveBeenLastCalledWith('GET', '/builder/catalog', { headers: { 'If-None-Match': '"v1"' } })
    expect(same).toMatchObject({ checked: true, version: 'v1' })

    // Nouveau catalogue : remplace la copie.
    s.account.fetchAuthed.mockResolvedValueOnce(json(body('v2'), { headers: { ETag: '"v2"' } }))
    expect((await s.builder.catalog(true)).categories[0].components[0].name).toBe('Routes v2')
    expect((await s.builder.catalog()).version).toBe('v2')
  })

  it('reste consultable hors ligne', async () => {
    const s = setup()
    s.account.fetchAuthed.mockResolvedValueOnce(json(body('v1'), { headers: { ETag: '"v1"' } }))
    await s.builder.catalog(true)
    s.account.fetchAuthed.mockRejectedValueOnce(new Error('Serveur injoignable.'))
    expect(await s.builder.catalog(true)).toMatchObject({ offline: true, version: 'v1' })
  })

  it('demande un compte connecté', async () => {
    const s = setup()
    s.account.signedIn = false
    await expect(s.builder.catalog()).rejects.toMatchObject({ status: 401, code: SIGNED_OUT })
    expect(s.account.fetchAuthed).not.toHaveBeenCalled()
  })
})

describe('installation d’une création', () => {
  it('construit un pack : zips, puis fichiers, puis fichiers écrits, avec le preset réglé', async () => {
    const s = setup()
    publish(s, { revision: 'rev-1', preset: PRESET_V1 })
    const report = vi.fn()
    const h = hooks({
      // La bibliothèque n'est modifiée qu'après l'attente de son tour.
      lock: vi.fn(async () => expect(await s.library.list()).toEqual([]))
    })
    const result = await s.builder.install(BUILD, report, new AbortController().signal, h)
    expect(result).toMatchObject({ kind: 'build', status: 'added', name: 'Mon pack', unavailable: [] })
    expect(h.lock).toHaveBeenCalledOnce()

    const pack = await s.library.get(result.packId)
    expect(pack.built).toMatchObject({ buildId: BUILD, revision: 'rev-1', components: [{ id: PRESET_ID, name: 'Preset Réaliste' }, { id: ROADS_ID, name: 'Routes HD' }] })
    expect(pack.reshadePreset).toBe('FiveM Application Data/plugins/Preset.ini')
    expect(pack.reshadePresets).toContain('FiveM Application Data/plugins/Preset.ini')
    expect(pack.cover).toBe(`builder-${IMAGE_ID}.jpg`)
    expect(pack.files.map((f) => f.rel).sort()).toEqual([
      'FiveM Application Data/mods/routes.rpf',
      'FiveM Application Data/plugins/Preset.ini',
      'FiveM Application Data/plugins/reshade-shaders/Shaders/Bloom.fx',
      'FiveM Application Data/plugins/reshade-shaders/Shaders/Vignette.fx',
      'GTA V/enbseries/enbbloom.fx'
    ])
    const fivem = 'FiveM Application Data'
    // Un fichier remplace celui du zip au même endroit ; le preset écrit par l'API remplace le fichier.
    expect(await content(s, pack.id, fivem, 'plugins', 'reshade-shaders', 'Shaders', 'Bloom.fx')).toBe('bloom corrigé')
    expect(await content(s, pack.id, fivem, 'plugins', 'reshade-shaders', 'Shaders', 'Vignette.fx')).toBe('vignette du zip')
    expect(await content(s, pack.id, fivem, 'plugins', 'Preset.ini')).toBe(PRESET_V1)
    expect(await content(s, pack.id, 'GTA V', 'enbseries', 'enbbloom.fx')).toBe('enb bloom')
    // Installé à sa place sous chaque racine.
    expect(pack.components.map((c) => [c.destination, c.files.length])).toEqual([
      [{ root: 'fivem', path: '' }, 4],
      [{ root: 'gta', path: '' }, 1]
    ])

    // Progression globale en octets, jusqu'au bout.
    const bytes = report.mock.calls.filter((c) => c[4] === true)
    expect(bytes.at(-1)![1]).toBe(bytes.at(-1)![2])
    // Chaque contenu téléchargé une fois, avec le jeton du compte, et gardé en cache.
    const files = s.requests.filter((r) => r.url.includes('/builder/files/'))
    expect(files).toHaveLength(5)
    expect(files.every((r) => r.headers.authorization === 'Bearer jeton')).toBe(true)
    for (const sha256 of pack.builtBlobs!) await expect(fs.stat(s.builder.blobFile(sha256))).resolves.toBeTruthy()

    // Même révision : rien à refaire, rien de téléchargé.
    s.requests.length = 0
    expect((await s.builder.install(BUILD, vi.fn(), new AbortController().signal, hooks())).status).toBe('up-to-date')
    expect(s.requests.filter((r) => r.url.includes('/builder/files/'))).toEqual([])
  })

  it('jette un fichier abîmé (SHA-256 différent) et n’ajoute rien', async () => {
    const s = setup()
    const { roads } = publish(s, { revision: 'rev-1', preset: PRESET_V1 })
    s.blobs.get(roads.sha256)!.corrupt = Buffer.from('RPF7 r0utes')
    await expect(s.builder.install(BUILD, vi.fn(), new AbortController().signal, hooks())).rejects.toThrow(/endommagé/)
    await expect(fs.stat(s.builder.blobFile(roads.sha256))).rejects.toThrow()
    await expect(fs.stat(`${s.builder.blobFile(roads.sha256)}.part`)).rejects.toThrow()
    expect(await s.library.list()).toEqual([])
  })

  it('reprend un téléchargement partiel là où il s’était arrêté', async () => {
    const s = setup()
    const data = Buffer.from(Array.from({ length: 50_000 }, (_, i) => (i * 7) % 251))
    const { roads } = publish(s, { revision: 'rev-1', preset: PRESET_V1, roads: data.toString('latin1') })
    const served = s.blobs.get(roads.sha256)!.data
    const part = `${s.builder.blobFile(roads.sha256)}.part`
    await fs.mkdir(path.dirname(part), { recursive: true })
    await fs.writeFile(part, served.subarray(0, 20_000))
    const report = vi.fn()

    const result = await s.builder.install(BUILD, report, new AbortController().signal, hooks())
    const request = s.requests.find((r) => r.url.endsWith(roads.sha256))!
    expect(request.headers.range).toBe('bytes=20000-')
    expect(request.headers['if-range']).toBe(`"${roads.sha256}"`)
    expect(sha(await fs.readFile(s.builder.blobFile(roads.sha256)))).toBe(roads.sha256)
    await expect(fs.stat(part)).rejects.toThrow()
    expect(sha(await fs.readFile(path.join(s.library.contentDir(result.packId), 'FiveM Application Data', 'mods', 'routes.rpf')))).toBe(roads.sha256)
  })

  it('refuse un manifeste avec un chemin interdit sans rien télécharger', async () => {
    const s = setup()
    publish(s, { revision: 'rev-1', preset: PRESET_V1 })
    const manifest = s.routes.get(`GET /builder/builds/${BUILD}/manifest`) as { files: { path: string }[] }
    manifest.files[2].path = 'mods/../../../FiveM.exe'
    await expect(s.builder.install(BUILD, vi.fn(), new AbortController().signal, hooks())).rejects.toThrow(/chemin refusé/)
    expect(s.requests).toEqual([])
    expect(await s.library.list()).toEqual([])
  })
})

describe('mises à jour', () => {
  it('propose la nouvelle révision et la reconstruit (même nom, réglages gardés, réinstallée)', async () => {
    const s = setup()
    publish(s, { revision: 'rev-1', preset: PRESET_V1 })
    const first = await s.builder.install(BUILD, vi.fn(), new AbortController().signal, hooks())
    // Pack renommé dans la bibliothèque, et réglages modifiés en jeu : le preset, et un autre fichier.
    await s.library.update(first.packId, { name: 'Mon pack du soir' })
    const user = s.library.userDir(first.packId)
    await fs.mkdir(path.join(user, 'fivem', 'plugins'), { recursive: true })
    await fs.writeFile(path.join(user, 'fivem', 'plugins', 'Preset.ini'), 'retouché en jeu')
    await fs.writeFile(path.join(user, 'fivem', 'plugins', 'Bloom.ini'), 'touche perso')

    await s.builder.refreshStatus()
    expect(await s.builder.status()).toEqual({ updates: [], gone: [] })

    // Réglages ReShade modifiés : nouvelle révision.
    publish(s, { revision: 'rev-2', preset: PRESET_V2 })
    await s.builder.refreshStatus()
    expect(await s.builder.status()).toEqual({ updates: [first.packId], gone: [] })

    const h = hooks({ activeId: () => first.packId })
    const result = await s.builder.install(BUILD, vi.fn(), new AbortController().signal, h)
    expect(result).toMatchObject({ status: 'updated', name: 'Mon pack du soir' })
    expect(h.apply).toHaveBeenCalledWith(result.packId, expect.any(Function))
    const packs = await s.library.list()
    expect(packs.map((p) => p.id)).toEqual([result.packId])
    expect(packs[0].built?.revision).toBe('rev-2')
    expect(await content(s, result.packId, 'FiveM Application Data', 'plugins', 'Preset.ini')).toBe(PRESET_V2)
    // Réglage personnel gardé ; l'ancienne copie du preset, réécrit autrement par l'API, oubliée.
    const userNext = s.library.userDir(result.packId)
    expect(await fs.readFile(path.join(userNext, 'fivem', 'plugins', 'Bloom.ini'), 'utf8')).toBe('touche perso')
    await expect(fs.stat(path.join(userNext, 'fivem', 'plugins', 'Preset.ini'))).rejects.toThrow()
    expect(await s.builder.status()).toEqual({ updates: [], gone: [] })
  })

  it('signale une création supprimée du compte', async () => {
    const s = setup()
    publish(s, { revision: 'rev-1', preset: PRESET_V1 })
    const first = await s.builder.install(BUILD, vi.fn(), new AbortController().signal, hooks())
    s.routes.delete(`GET /builder/builds/${BUILD}/manifest`)
    await s.builder.refreshStatus()
    expect(await s.builder.status()).toEqual({ updates: [], gone: [first.packId] })
  })

  it('sans le droit « Peut créer un pack » : rien n’est demandé à l’API, rien à signaler, le pack construit reste', async () => {
    const s = setup()
    publish(s, { revision: 'rev-1', preset: PRESET_V1 })
    const first = await s.builder.install(BUILD, vi.fn(), new AbortController().signal, hooks())
    publish(s, { revision: 'rev-2', preset: PRESET_V2 })
    await s.builder.refreshStatus()
    expect(await s.builder.status()).toEqual({ updates: [first.packId], gone: [] })

    s.me.canBuildPacks = false
    s.account.call.mockClear()
    s.fetch.mockClear()
    await s.builder.refreshStatus()
    // Révision déjà connue : plus signalée non plus.
    expect(await s.builder.status()).toEqual({ updates: [], gone: [] })
    await expect(s.builder.catalog(true)).rejects.toMatchObject({ status: 403, code: BUILDER_NOT_ALLOWED })
    await expect(s.builder.builds()).rejects.toMatchObject({ code: BUILDER_NOT_ALLOWED })
    expect(s.account.call).not.toHaveBeenCalled()
    expect(s.account.fetchAuthed).not.toHaveBeenCalled()
    expect(s.fetch).not.toHaveBeenCalled()
    expect(s.account.refresh).not.toHaveBeenCalled()
    expect((await s.library.list()).map((p) => p.id)).toEqual([first.packId])
  })

  it('droit retiré sur le serveur (403 « builder-not-allowed ») : le compte est relu', async () => {
    const s = setup()
    s.account.call.mockRejectedValueOnce(new ApiError('Ce compte ne peut pas créer de pack.', 403, BUILDER_NOT_ALLOWED))
    await expect(s.builder.builds()).rejects.toMatchObject({ status: 403, code: BUILDER_NOT_ALLOWED })
    expect(s.account.refresh).toHaveBeenCalledTimes(1)
    // Autre refus : le compte n'est pas relu pour rien.
    s.account.call.mockRejectedValueOnce(new ApiError('Interdit.', 403, 'app-only'))
    await expect(s.builder.builds()).rejects.toMatchObject({ code: 'app-only' })
    expect(s.account.refresh).toHaveBeenCalledTimes(1)
  })

  it('garde les fichiers des packs construits et retire les autres du cache', async () => {
    const s = setup()
    publish(s, { revision: 'rev-1', preset: PRESET_V1 })
    const first = await s.builder.install(BUILD, vi.fn(), new AbortController().signal, hooks())
    const stray = s.builder.blobFile(sha('plus utilisé'))
    await fs.mkdir(path.dirname(stray), { recursive: true })
    await fs.writeFile(stray, 'plus utilisé')
    await s.builder.pruneBlobs()
    await expect(fs.stat(stray)).rejects.toThrow()
    const pack = await s.library.get(first.packId)
    for (const sha256 of pack.builtBlobs!) await expect(fs.stat(s.builder.blobFile(sha256))).resolves.toBeTruthy()
    expect((await s.builder.cacheInfo()).size).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Outils d'ambiance

const QUANTV_ID = 'aaaaaaaa-0000-4000-8000-000000000003'
const ENB_ID = 'aaaaaaaa-0000-4000-8000-000000000004'
const REFERENCE_ID = 'aaaaaaaa-0000-4000-8000-000000000005'
const STYLE_REAL = 'cccccccc-0000-4000-8000-000000000001'
const STYLE_CINEMA = 'cccccccc-0000-4000-8000-000000000002'
const STYLE_QUANTV = 'cccccccc-0000-4000-8000-000000000003'
const REF_CAR = 'dddddddd-0000-4000-8000-000000000001'
const REF_CITY = 'dddddddd-0000-4000-8000-000000000002'
const REF_NIGHT = 'dddddddd-0000-4000-8000-000000000003'

const referenceImage = (id: string, version: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  imageUrl: `/builder/references/${id}/image?v=${version}`,
  thumbUrl: `/builder/references/${id}/image?v=${version}&size=thumb`,
  width: 1920,
  height: 1080,
  byDefault: false,
  ...extra
})

/** Images de référence en jeu publiées, dans l'ordre de l'admin : Voiture, Centre-ville (par défaut), Ville la nuit. */
const references = (): Record<string, unknown>[] => [
  referenceImage(REF_CAR, 4, { label: 'Voiture', credits: 'Capture : Dimzou' }),
  referenceImage(REF_CITY, 2, { label: 'Centre-ville', credits: null, byDefault: true }),
  referenceImage(REF_NIGHT, 7, { label: 'Ville la nuit', width: undefined, height: undefined })
]

const card = (id: string, category: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  slug: category,
  category,
  name: `Élément ${category}`,
  conflictsWith: [],
  provides: [],
  requires: [],
  ...extra
})

/**
 * Catalogue avec les quatre outils : ReShade et QuantV réglables, NVE sans rien, ENB importé d'un pack. Sans
 * `references` : catalogue d'une API d'avant les images de référence en jeu.
 */
const toolsCatalog = (opts: { reshadeCustom?: boolean; reshadePacks?: boolean; references?: unknown[] } = {}): Record<string, unknown> => ({
  version: 'v-outils',
  groups: [{ key: 'ambiance', label: 'Ambiance graphique', categories: ['quantv', 'reshade', 'nve', 'enb', 'timecycle'] }],
  categories: [
    { key: 'quantv', label: 'Base QuantV', group: 'ambiance', single: true, tool: 'quantv', components: [card(QUANTV_ID, 'quantv', { provides: ['quantv', 'reshade'] })] },
    {
      key: 'reshade',
      label: 'Preset ReShade',
      group: 'ambiance',
      single: true,
      tool: 'reshade',
      components: opts.reshadePacks === false ? [] : [card(PRESET_ID, 'reshade', { requires: ['quantv'] })]
    },
    { key: 'nve', label: 'NVE', group: 'ambiance', single: true, tool: 'nve', components: [] },
    { key: 'enb', label: 'ENB', group: 'ambiance', single: true, tool: 'enb', components: [card(ENB_ID, 'enb')] },
    { key: 'timecycle', label: 'Météo et lumière', group: 'ambiance', single: false, tool: null, components: [] }
  ],
  tools: [
    {
      key: 'reshade',
      label: 'ReShade (filtres de l’image)',
      description: 'Couleurs et contraste.',
      category: 'reshade',
      defaultMode: opts.reshadeCustom === false ? 'pack' : 'custom',
      defaultStyle: STYLE_REAL,
      custom: opts.reshadeCustom !== false,
      packs: opts.reshadePacks === false ? 0 : 1,
      referenceComponent: REFERENCE_ID,
      reference: { id: IMAGE_ID, width: 1280, height: 720 },
      styles: [
        {
          id: STYLE_REAL,
          key: 'realiste',
          label: 'Réaliste',
          description: 'Couleurs justes.',
          imageUrl: `/builder/styles/${STYLE_REAL}/image?v=3`,
          thumbUrl: `/builder/styles/${STYLE_REAL}/image?v=3&size=thumb`,
          costMs: 1.2,
          costLabel: 'Léger',
          byDefault: true
        },
        { id: STYLE_CINEMA, key: 'cinema', label: 'Cinéma', preview: { brightness: 0.95, contrast: 1.2, tint: '#ffaa55', tintOpacity: 0.2 }, costMs: 2, costLabel: 'Moyen', byDefault: false }
      ],
      requires: []
    },
    {
      key: 'quantv',
      label: 'QuantV (lumière et météo)',
      category: 'quantv',
      defaultMode: 'custom',
      defaultStyle: STYLE_QUANTV,
      custom: true,
      packs: 1,
      styles: [{ id: STYLE_QUANTV, key: 'equilibre', label: 'Équilibré', byDefault: true }],
      requires: ['reshade']
    },
    { key: 'nve', label: 'NVE', category: 'nve', defaultMode: 'none', custom: false, packs: 0, styles: [], requires: [] },
    { key: 'enb', label: 'ENB', category: 'enb', defaultMode: 'pack', custom: false, packs: 1, styles: [], requires: [] }
  ],
  controls: [{ key: 'brightness', label: 'Luminosité', type: 'slider', min: -100, max: 100, step: 1, group: 'image', groupLabel: 'Image', tool: 'reshade' }],
  ...(opts.references ? { references: opts.references } : {})
})

const parsed = (opts?: Parameters<typeof toolsCatalog>[0]) => toCatalog(toolsCatalog(opts), { offline: false, checked: true })

describe('catalogue des outils d’ambiance', () => {
  it('lit les outils, leurs styles et l’adresse de leurs images', () => {
    const catalog = parsed()
    expect(catalog.tools.map((t) => [t.key, t.defaultMode, t.custom])).toEqual([
      ['reshade', 'custom', true],
      ['quantv', 'custom', true],
      ['nve', 'none', false],
      ['enb', 'pack', false]
    ])
    expect(catalog.categories.find((c) => c.key === 'reshade')?.tool).toBe('reshade')
    expect(catalog.categories.find((c) => c.key === 'timecycle')?.tool).toBeNull()
    expect(catalog.controls[0].tool).toBe('reshade')
    const [real, cinema] = catalog.tools[0].styles
    expect(real.imageVersion).toBe('3')
    expect(cinema).toMatchObject({ imageVersion: null, preview: { brightness: 0.95, contrast: 1.2, tint: '#ffaa55', tintOpacity: 0.2, sepia: null } })
    // Adresse d'un autre style ou d'un autre serveur : pas d'image.
    expect(styleImageVersion(STYLE_REAL, `/builder/styles/${STYLE_CINEMA}/image?v=3`)).toBeNull()
    expect(styleImageVersion(STYLE_REAL, `https://ailleurs.test/builder/styles/${STYLE_REAL}/image?v=3`)).toBeNull()
    expect(styleImageVersion(STYLE_REAL, `/builder/references/${STYLE_REAL}/image?v=3`)).toBeNull()
  })

  it('lit les images de référence en jeu dans l’ordre de l’admin, sans celles qui n’ont pas d’image valable', () => {
    const other = 'dddddddd-0000-4000-8000-000000000009'
    const catalog = parsed({
      references: [
        ...references(),
        // Sans image, adresse d'une autre image ou d'un autre serveur, identifiant invalide, en double : ignorées.
        { id: other, label: 'Sans image', imageUrl: null },
        referenceImage(other, 1, { imageUrl: `/builder/references/${REF_CAR}/image?v=4` }),
        referenceImage(other, 1, { imageUrl: `https://ailleurs.test/builder/references/${other}/image?v=1` }),
        referenceImage('pas-un-identifiant', 1),
        referenceImage(REF_CAR, 4, { label: 'Voiture en double' }),
        'pas un objet'
      ]
    })
    expect(catalog.references).toEqual([
      { id: REF_CAR, label: 'Voiture', credits: 'Capture : Dimzou', version: '4', width: 1920, height: 1080, byDefault: false },
      { id: REF_CITY, label: 'Centre-ville', credits: '', version: '2', width: 1920, height: 1080, byDefault: true },
      { id: REF_NIGHT, label: 'Ville la nuit', credits: '', version: '7', width: 0, height: 0, byDefault: false }
    ])
    // API d'avant les images en jeu : aucune, l'image du composant de base de l'outil reste le repli.
    const old = parsed()
    expect(old.references).toEqual([])
    expect(old.tools[0]).toMatchObject({ referenceComponent: REFERENCE_ID, reference: { id: IMAGE_ID } })
  })

  it('sert les images de référence en jeu sans jeton et les garde sur le disque, comme celles des styles', async () => {
    const s = setup()
    const thumb = await s.builder.referenceImage(REF_CAR, '4', true)
    expect(thumb.status).toBe(200)
    expect(thumb.headers.get('Content-Type')).toBe('image/jpeg')
    expect(Buffer.from(await thumb.arrayBuffer())).toEqual(JPEG)
    expect(s.requests).toEqual([{ url: `${API}/builder/references/${REF_CAR}/image?v=4&size=thumb`, headers: {} }])
    await expect(fs.stat(path.join(dir, 'builder', 'images', `reference-${REF_CAR}-4-thumb.jpg`))).resolves.toBeTruthy()
    // Déjà sur le disque : pas de nouvelle requête ; la grande image est un autre fichier.
    expect((await s.builder.referenceImage(REF_CAR, '4', true)).status).toBe(200)
    expect((await s.builder.referenceImage(REF_CAR, '4', false)).status).toBe(200)
    expect(s.requests.map((r) => r.url)).toEqual([`${API}/builder/references/${REF_CAR}/image?v=4&size=thumb`, `${API}/builder/references/${REF_CAR}/image?v=4`])
    // Identifiant ou version refusés : rien n'est demandé.
    expect((await s.builder.referenceImage('../secret', '4', false)).status).toBe(403)
    expect((await s.builder.referenceImage(REF_CAR, '4&size=x', false)).status).toBe(403)
    expect(s.requests).toHaveLength(2)
  })
})

describe('conversion des créations d’avant les outils', () => {
  const categories: Record<string, string> = { [PRESET_ID]: 'reshade', [QUANTV_ID]: 'quantv', [ENB_ID]: 'enb', [ROADS_ID]: 'roads' }

  it('le preset et les bases deviennent « Importé d’un pack », avec les réglages ReShade', () => {
    const reshade = { controls: { brightness: 20 }, techniques: { 'Bloom@Bloom.fx': false }, values: { 'Bloom.fx': { Intensity: '0.8' } } }
    const { components, tools } = fromLegacy([PRESET_ID, ROADS_ID, QUANTV_ID, ENB_ID], (id) => categories[id], reshade)
    expect(components).toEqual([ROADS_ID])
    expect(tools.reshade).toEqual({ mode: 'pack', component: PRESET_ID, style: null, ...reshade })
    expect(tools.quantv).toMatchObject({ mode: 'pack', component: QUANTV_ID, controls: {} })
    expect(tools.enb).toMatchObject({ mode: 'pack', component: ENB_ID })
    expect(tools.nve).toEqual(toolOff())
  })

  it('garde un choix d’outil déjà fait', () => {
    const known = { ...noTools(), reshade: { ...toolOff(), mode: 'custom' as const, style: STYLE_CINEMA } }
    const { components, tools } = fromLegacy([PRESET_ID, ROADS_ID], (id) => categories[id], null, known)
    expect(components).toEqual([ROADS_ID])
    expect(tools.reshade).toMatchObject({ mode: 'custom', style: STYLE_CINEMA })
  })

  it('choix reçus nettoyés : outil absent ou incomplet sur « Aucun », valeurs du bon type seulement', () => {
    const tools = cleanTools({ reshade: { mode: 'custom', style: STYLE_REAL, controls: { brightness: 10, bad: {} } }, quantv: { mode: 'pack' }, enb: { mode: 'bizarre' } })
    expect(tools.reshade).toEqual({ mode: 'custom', component: null, style: STYLE_REAL, controls: { brightness: 10 }, techniques: {}, values: {} })
    expect(tools.quantv).toEqual(toolOff())
    expect(tools.enb).toEqual(toolOff())
    expect(tools.nve).toEqual(toolOff())
  })

  it('une création vue par une API d’avant les outils : son preset est importé d’un pack', async () => {
    const s = setup()
    s.routes.set(`GET /builder/builds/${BUILD}`, {
      id: BUILD,
      name: 'Ancien pack',
      components: [
        { id: PRESET_ID, name: 'Preset', category: 'reshade', available: true },
        { id: ROADS_ID, name: 'Routes', category: 'roads', available: true }
      ],
      reshade: { controls: { brightness: 20 }, techniques: {}, values: {} },
      problems: []
    })
    const build = await s.builder.build(BUILD)
    expect(build.tools.reshade).toMatchObject({ mode: 'pack', component: PRESET_ID, controls: { brightness: 20 } })
    expect(build.tools.quantv.mode).toBe('none')
  })
})

describe('règles entre outils et choix rapide', () => {
  it('« Recommandé » prend le choix par défaut de chaque outil', () => {
    const tools = recommendedTools(parsed())
    expect(tools.reshade).toMatchObject({ mode: 'custom', style: STYLE_REAL, component: null })
    expect(tools.quantv).toMatchObject({ mode: 'custom', style: STYLE_QUANTV })
    expect(tools.nve.mode).toBe('none')
    expect(tools.enb).toMatchObject({ mode: 'pack', component: ENB_ID })
  })

  it('reconnaît Basique, Recommandé et Personnalisé', () => {
    const catalog = parsed()
    expect(ambianceChoice(noTools(), catalog)).toBe('basic')
    const recommended = recommendedTools(catalog)
    expect(ambianceChoice(recommended, catalog)).toBe('recommended')
    expect(ambianceChoice({ ...recommended, reshade: { ...recommended.reshade, controls: { brightness: 10 } } }, catalog)).toBe('custom')
    expect(ambianceChoice({ ...recommended, reshade: { ...recommended.reshade, style: STYLE_CINEMA } }, catalog)).toBe('custom')
  })

  it('activer QuantV active ReShade (réglé par le joueur, style par défaut)', () => {
    const catalog = parsed()
    const on = setToolMode(noTools(), 'quantv', 'custom', catalog)
    expect(on.note).toBe('reshade-on')
    expect(on.tools.quantv).toMatchObject({ mode: 'custom', style: STYLE_QUANTV })
    expect(on.tools.reshade).toMatchObject({ mode: 'custom', style: STYLE_REAL })
    // Un preset importé qui demande QuantV : l'activer active aussi ReShade s'il le faut.
    expect(enableTool(noTools(), 'quantv', catalog).tools.reshade.mode).toBe('custom')
    // ReShade déjà choisi : rien d'autre ne change.
    const pack = { ...noTools(), reshade: { ...toolOff(), mode: 'pack' as const, component: PRESET_ID } }
    const kept = setToolMode(pack, 'quantv', 'pack', catalog)
    expect(kept.note).toBeNull()
    expect(kept.tools.reshade).toMatchObject({ mode: 'pack', component: PRESET_ID })
    expect(kept.tools.quantv).toMatchObject({ mode: 'pack', component: QUANTV_ID })
  })

  it('ReShade sur Aucun coupe QuantV', () => {
    const catalog = parsed()
    const off = setToolMode(recommendedTools(catalog), 'reshade', 'none', catalog)
    expect(off.note).toBe('quantv-off')
    expect(off.tools.reshade.mode).toBe('none')
    expect(off.tools.quantv.mode).toBe('none')
    expect(off.tools.enb.mode).toBe('pack')
  })

  it('ReShade importé d’un pack quand il ne se règle pas, signalé quand il n’existe pas', () => {
    const packOnly = parsed({ reshadeCustom: false })
    expect(setToolMode(noTools(), 'quantv', 'custom', packOnly).tools.reshade).toMatchObject({ mode: 'pack', component: PRESET_ID })
    const none = parsed({ reshadeCustom: false, reshadePacks: false })
    const missing = setTool(noTools(), 'quantv', { ...toolOff(), mode: 'custom', style: STYLE_QUANTV }, none)
    expect(missing.note).toBe('reshade-missing')
    expect(missing.tools.reshade.mode).toBe('none')
  })

  it('un style retiré est remplacé par le style par défaut', () => {
    const catalog = parsed()
    const reshade = catalog.tools.find((x) => x.key === 'reshade')!
    const retired = 'cccccccc-0000-4000-8000-000000000999'
    const tools = { ...noTools(), reshade: { ...toolOff(), mode: 'custom' as const, style: retired, controls: { brightness: 10 } } }
    expect(styleOf(reshade, tools.reshade)?.id).toBe(STYLE_REAL)
    expect(styleOf(reshade, { ...tools.reshade, style: STYLE_CINEMA })?.id).toBe(STYLE_CINEMA)
    expect(styleOf(reshade, toolOff())).toBeNull()
    // À l'enregistrement : null (style par défaut de l'API), réglages gardés ; hors ligne, rien ne change.
    expect(withKnownStyles(tools, catalog).reshade).toMatchObject({ mode: 'custom', style: null, controls: { brightness: 10 } })
    expect(withKnownStyles({ ...tools, reshade: { ...tools.reshade, style: STYLE_CINEMA } }, catalog).reshade.style).toBe(STYLE_CINEMA)
    expect(withKnownStyles(tools, { ...catalog, offline: true }).reshade.style).toBe(retired)
  })
})

describe('aperçu d’un style', () => {
  it('sans style : l’image telle quelle', () => {
    expect(previewLook(null)).toEqual({
      filter: 'brightness(1) contrast(1) saturate(1) sepia(0) grayscale(0) hue-rotate(0deg)',
      tint: null,
      warmth: null,
      vignette: 0,
      grain: 0
    })
  })

  it('valeurs bornées, curseurs du joueur compris', () => {
    const look = previewLook(
      {
        brightness: 5,
        contrast: -1,
        saturate: 1.5,
        sepia: 2,
        grayscale: -1,
        hueRotate: 999,
        tint: '#ff0000',
        tintOpacity: 3,
        vignette: 0.5,
        grain: 9
      },
      { brightness: 500, saturation: 50, temperature: -50 }
    )
    expect(look.filter).toBe('brightness(3) contrast(0) saturate(2.25) sepia(1) grayscale(0) hue-rotate(360deg)')
    expect(look.tint).toEqual({ color: '#ff0000', opacity: 1 })
    expect(look.warmth).toEqual({ color: '#4c9bff', opacity: 0.175 })
    expect(look.vignette).toBe(0.5)
    expect(look.grain).toBe(1)
    // Couleur mal formée : pas de calque.
    const flat = { brightness: null, contrast: null, saturate: null, sepia: null, grayscale: null, hueRotate: null, vignette: null, grain: null }
    expect(previewLook({ ...flat, tint: 'red', tintOpacity: 0.5 }).tint).toBeNull()
  })
})

describe('création avec des outils d’ambiance', () => {
  it('envoie les choix d’outils à l’aperçu et lit l’état d’un outil', async () => {
    const s = setup()
    s.routes.set('POST /builder/preview', { components: [ROADS_ID], valid: true, problems: [{ type: 'needs-tool', severity: 'error', message: 'QuantV a besoin de ReShade.', requires: 'reshade' }], estimate: { size: 10 } })
    const tools = { ...noTools(), quantv: { ...toolOff(), mode: 'custom' as const, style: STYLE_QUANTV } }
    const preview = await s.builder.preview([ROADS_ID], tools)
    expect(preview.problems[0]).toMatchObject({ type: 'needs-tool', requires: 'reshade' })
    const sent = s.account.call.mock.calls.at(-1) as unknown as [string, string, { json: { components: string[]; tools: Record<string, { mode: string }> } }]
    expect(sent[2].json.components).toEqual([ROADS_ID])
    expect(Object.keys(sent[2].json.tools)).toEqual(['reshade', 'quantv', 'nve', 'enb'])
    expect(sent[2].json.tools.quantv.mode).toBe('custom')

    s.routes.set('POST /builder/tools/view', {
      tool: 'reshade',
      mode: 'custom',
      componentId: REFERENCE_ID,
      styleId: STYLE_REAL,
      path: 'plugins/Reflect.ini',
      techniques: [{ name: 'Bloom@Bloom.fx', effect: 'Bloom.fx', enabled: true, costMs: 0.4, costLabel: 'Léger' }],
      available: ['Bloom@Bloom.fx', 'Vignette@Vignette.fx'],
      effects: [{ file: 'Bloom.fx', params: [{ name: 'Intensity', type: 'float', value: '0.6', defaultValue: '0.3', baseValue: '0.5' }] }],
      controls: [{ key: 'brightness', label: 'Luminosité', type: 'slider', value: 0, tool: 'reshade' }],
      problems: []
    })
    const view = await s.builder.toolView('reshade', recommendedTools(parsed()))
    expect(view).toMatchObject({ mode: 'custom', styleId: STYLE_REAL, available: ['Bloom@Bloom.fx', 'Vignette@Vignette.fx'] })
    expect(view.effects[0].params[0]).toMatchObject({ value: '0.6', baseValue: '0.5', defaultValue: '0.3' })
    expect(view.controls[0].tool).toBe('reshade')

    // Effet inconnu : réponse vide.
    s.account.fetchAuthed.mockResolvedValueOnce(new Response('', { status: 200 }))
    expect(await s.builder.toolEffect(REFERENCE_ID, 'Inconnu.fx')).toBeNull()
    s.account.fetchAuthed.mockResolvedValueOnce(json({ file: 'Vignette.fx', params: [{ name: 'Amount', type: 'float', min: 0, max: 1 }] }))
    expect(await s.builder.toolEffect(REFERENCE_ID, 'Vignette.fx')).toMatchObject({ file: 'Vignette.fx', params: [{ name: 'Amount', min: 0, max: 1 }] })
    expect(s.account.fetchAuthed).toHaveBeenLastCalledWith('GET', `/builder/tools/reshade/effects?file=Vignette.fx&component=${REFERENCE_ID}`)
    // Nom de fichier refusé : pas de requête.
    expect(await s.builder.toolEffect(null, '../secret.fx')).toBeNull()
  })

  it('écrit chaque fichier de réglages sous sa racine, après les fichiers des composants', async () => {
    const s = setup()
    // Catalogue gardé sur ce PC : image du style ReShade choisi pour la couverture.
    s.account.fetchAuthed.mockResolvedValueOnce(json(toolsCatalog(), { headers: { ETag: '"v-outils"' } }))
    await s.builder.catalog(true)
    const quantvBase = s.serve('RPF7 quantv')
    const quantvIni = s.serve('[LIGHTS]\r\nCoronas=1\r\n')
    const enbIni = s.serve('[EFFECT]\r\nEnableBloom=false\r\n')
    const entry = (f: { sha256: string; size: number }, extra: Record<string, unknown>) => ({ ...f, url: `/builder/files/${f.sha256}`, entryCount: 1, kind: 'file', ...extra })
    const preset = 'Techniques=QuantV@QuantV.fx,Lightroom@qUINT_lightroom.fx\r\n\r\n[qUINT_lightroom.fx]\r\nLIGHTROOM_GLOBAL_CONTRAST=0.080000\r\n'
    s.routes.set(`GET /builder/builds/${BUILD}/manifest`, {
      buildId: BUILD,
      name: 'Nuit bleue',
      revision: 'rev-outils',
      files: [
        entry(quantvBase, { componentId: QUANTV_ID, root: 'fivem', path: 'mods/aQuantV.rpf' }),
        entry(quantvIni, { componentId: QUANTV_ID, root: 'fivem', path: 'plugins/QuantV.ini' }),
        entry(enbIni, { componentId: ENB_ID, root: 'gta', path: 'enbseries.ini' })
      ],
      generated: [
        { componentId: REFERENCE_ID, root: 'fivem', path: 'plugins/Reflect.ini', content: preset },
        { componentId: QUANTV_ID, root: 'fivem', path: 'plugins/QuantV.ini', content: '[LIGHTS]\r\nCoronas=0\r\n' },
        { componentId: null, root: 'fivem', path: 'plugins/NVE.ini', content: 'Techniques=NVE@NVE.fx\r\n' },
        { componentId: ENB_ID, root: 'gta', path: 'enbseries.ini', content: '[EFFECT]\r\nEnableBloom=true\r\n' }
      ],
      preset: 'plugins/Reflect.ini',
      unavailable: [],
      problems: [],
      totalSize: 100
    })
    s.routes.set(`GET /builder/builds/${BUILD}`, {
      id: BUILD,
      name: 'Nuit bleue',
      components: [
        { id: QUANTV_ID, name: 'Base QuantV', category: 'quantv', available: true },
        { id: ENB_ID, name: 'ENB du soir', category: 'enb', available: true }
      ],
      tools: {
        reshade: { mode: 'custom', style: STYLE_REAL, controls: { brightness: -20 } },
        quantv: { mode: 'pack', component: QUANTV_ID },
        enb: { mode: 'pack', component: ENB_ID }
      },
      problems: []
    })

    const result = await s.builder.install(BUILD, vi.fn(), new AbortController().signal, hooks())
    const pack = await s.library.get(result.packId)
    const fivem = 'FiveM Application Data'
    expect(await content(s, pack.id, fivem, 'plugins', 'Reflect.ini')).toBe(preset)
    // Le fichier écrit par l'API remplace celui du composant, à sa racine (GTA V pour ENB).
    expect(await content(s, pack.id, fivem, 'plugins', 'QuantV.ini')).toBe('[LIGHTS]\r\nCoronas=0\r\n')
    expect(await content(s, pack.id, fivem, 'plugins', 'NVE.ini')).toBe('Techniques=NVE@NVE.fx\r\n')
    expect(await content(s, pack.id, 'GTA V', 'enbseries.ini')).toBe('[EFFECT]\r\nEnableBloom=true\r\n')
    expect(pack.files.map((f) => f.rel).sort()).toEqual([
      `${fivem}/mods/aQuantV.rpf`,
      `${fivem}/plugins/NVE.ini`,
      `${fivem}/plugins/QuantV.ini`,
      `${fivem}/plugins/Reflect.ini`,
      'GTA V/enbseries.ini'
    ])
    expect(pack.reshadePreset).toBe(`${fivem}/plugins/Reflect.ini`)
    // Couverture : l'image du style ReShade choisi.
    expect(pack.cover).toBe(`builder-style-${STYLE_REAL}-3.jpg`)
    expect(s.requests.some((r) => r.url === `${API}/builder/styles/${STYLE_REAL}/image?v=3`)).toBe(true)
  })
})

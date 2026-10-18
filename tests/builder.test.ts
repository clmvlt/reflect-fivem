// « Créer ton pack » : catalogue gardé sur le disque (ETag, 304), contrôle des chemins du manifeste et des entrées des
// zips, téléchargement des fichiers (SHA-256 vérifié, reprise d'un fichier partiel), construction du pack dans la
// bibliothèque (zips, puis fichiers, puis fichiers écrits), et nouvelle révision proposée comme une mise à jour.
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { crc32 } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SIGNED_OUT } from '@shared/api'
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

const { Builder, checkManifest, extractBundle, isSafeInstallPath } = await import('../src/main/core/builder')
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
  const me = { id: 7 } as AccountMe
  const account = {
    signedIn: true,
    current: () => (account.signedIn ? me : null),
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
    if (url.includes('/images/')) return new Response(new Uint8Array(JPEG), { status: 200 })
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
  return { account, fetch, requests, routes, blobs, serve, library, builder }
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

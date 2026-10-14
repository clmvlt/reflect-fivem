// Téléchargement de la Marketplace interrompu par une maintenance : arrêté sans nouvelles tentatives (fichier partiel
// gardé), puis repris là où il s'était arrêté (requête Range) une fois la maintenance terminée. Catalogue pendant une
// maintenance : erreur de maintenance (pas « serveur injoignable »), et l'admin connecté n'est pas bloqué.
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
vi.mock('electron', () => ({ net: { fetch: (url: string, init?: RequestInit) => fetchMock(url, init) } }))

const { Marketplace } = await import('../src/main/core/marketplace')
const { MaintenanceError } = await import('../src/main/core/http')
type Library = import('../src/main/core/library').Library
type StoredManifest = import('../src/main/core/library').StoredManifest

const API = 'https://api.test/api'
const ID = 'aa665074-b72c-498a-b3b5-f90f78957a65'
const DATA = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 31) % 251))
const SHA = createHash('sha256').update(DATA).digest('hex')

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const maintenance503 = (): Response =>
  new Response(
    JSON.stringify({
      code: 'maintenance',
      detail: 'Reflect FiveM est en maintenance.',
      maintenance: { id: 'm-1', startsAt: '2026-10-20T20:00:00Z', endsAt: '2026-10-20T22:00:00Z', message: '', status: 'active' }
    }),
    { status: 503, headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '3600' } }
  )

const detail = {
  id: ID,
  kind: 'pack',
  slug: 'bh-1960',
  name: "BH' 1960",
  summary: '',
  description: '',
  author: 'Auteur',
  version: '1.0',
  tags: [],
  archiveName: 'BH 1960.zip',
  archiveSize: DATA.length,
  sha256: SHA,
  downloadCount: 0,
  publishedAt: null,
  updatedAt: '2026-10-01T00:00:00Z',
  archiveUpdatedAt: null,
  cover: null,
  images: []
}

/** Corps qui envoie `chunk`, puis coupe la connexion. */
const cutAfter = (chunk: Buffer): ReadableStream<Uint8Array> => {
  let sent = false
  return new ReadableStream({
    async pull(controller) {
      if (!sent) {
        sent = true
        controller.enqueue(new Uint8Array(chunk))
        return
      }
      await new Promise((r) => setTimeout(r, 100))
      controller.error(new Error('connexion coupée'))
    }
  })
}

describe('téléchargement pendant une maintenance', () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-maintenance-download-'))
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  beforeEach(() => {
    fetchMock.mockReset()
  })

  /** Bibliothèque minimale : garde le contenu de l'archive importée. */
  const fakeLibrary = (): { lib: Library; imported: Buffer[] } => {
    const imported: Buffer[] = []
    const manifest = { id: 'local-1', name: 'BH 1960', gallery: [], cover: null } as unknown as StoredManifest
    const lib = {
      dir,
      list: async () => [],
      findDuplicate: async () => null,
      import: async (file: string) => {
        imported.push(await fs.readFile(file))
        return manifest
      },
      get: async () => ({ ...manifest, gallery: [] }),
      packDir: () => path.join(dir, 'local-1'),
      save: async () => undefined
    } as unknown as Library
    return { lib, imported }
  }
  const hooks = { activeId: () => null, apply: async () => undefined }
  const report = (): void => undefined

  it('se met en pause sans nouvelles tentatives, puis reprend avec Range à la fin de la maintenance', async () => {
    const { lib, imported } = fakeLibrary()
    const market = new Marketplace(API, path.join(dir, 'cache'), () => lib)
    const half = DATA.subarray(0, 80_000)
    const downloads: (Record<string, string> | undefined)[] = []
    let phase: 'cut' | 'maintenance' | 'over' = 'cut'
    fetchMock.mockImplementation(async (url, init) => {
      if (url === `${API}/packs/${ID}`) return phase === 'maintenance' ? maintenance503() : json(200, detail)
      expect(url).toBe(`${API}/packs/${ID}/download`)
      downloads.push(init?.headers ? Object.fromEntries(new Headers(init.headers)) : undefined)
      if (phase === 'cut') {
        // Connexion coupée en plein téléchargement, puis la maintenance commence avant la nouvelle tentative.
        phase = 'maintenance'
        return new Response(cutAfter(half), { status: 200 })
      }
      if (phase === 'maintenance') return maintenance503()
      const start = Number(/^bytes=(\d+)-$/.exec(new Headers(init?.headers).get('Range') ?? '')?.[1] ?? 0)
      return new Response(new Uint8Array(DATA.subarray(start)), { status: 206 })
    })

    const err = await market.install(ID, report, new AbortController().signal, hooks).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MaintenanceError)
    // Première requête coupée, une seule nouvelle tentative refusée pour maintenance : pas de boucle.
    expect(downloads).toHaveLength(2)
    const part = path.join(dir, '.downloads', ID, 'BH 1960.zip.part')
    const kept = (await fs.stat(part)).size
    expect(kept).toBe(half.length)
    expect(imported).toEqual([])

    // Fin de la maintenance : reprise du fichier partiel.
    phase = 'over'
    const result = await market.install(ID, report, new AbortController().signal, hooks)
    expect(result).toMatchObject({ status: 'added', packId: 'local-1' })
    expect(downloads).toHaveLength(3)
    expect(downloads[2]).toMatchObject({ range: `bytes=${kept}-`, 'if-range': `"${SHA}"` })
    expect(imported).toHaveLength(1)
    expect(imported[0].equals(DATA)).toBe(true)
    await expect(fs.stat(path.join(dir, '.downloads', ID))).rejects.toThrow()
  })

  it('catalogue : erreur de maintenance plutôt que « serveur injoignable »', async () => {
    const { lib } = fakeLibrary()
    const market = new Marketplace(API, path.join(dir, 'cache'), () => lib)
    fetchMock.mockImplementation(async () => maintenance503())
    await expect(market.list({})).rejects.toBeInstanceOf(MaintenanceError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('l’admin connecté n’est pas bloqué : la requête refusée est refaite avec son jeton', async () => {
    const { lib } = fakeLibrary()
    const auth = { accessToken: async () => 'at_admin', renewRejected: async () => 'at_admin', isAdmin: () => true }
    const market = new Marketplace(API, path.join(dir, 'cache'), () => lib, auth)
    fetchMock.mockImplementation(async (_url, init) =>
      new Headers(init?.headers).get('Authorization') === 'Bearer at_admin' ? json(200, { items: [], page: 0, size: 24, total: 0, totalPages: 0 }) : maintenance503()
    )
    await expect(market.list({})).resolves.toMatchObject({ items: [], total: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

// Marketplace : packs du moment (champ `featured` et GET /packs/featured), y compris avec une API plus ancienne.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn<(url: string) => Promise<Response>>()
vi.mock('electron', () => ({ net: { fetch: (url: string) => fetchMock(url) } }))

const { Marketplace, toMarketPack } = await import('../src/main/core/marketplace')
type RemoteSummary = import('../src/main/core/marketplace').RemoteSummary
type Library = import('../src/main/core/library').Library

const remote = (extra: Partial<RemoteSummary> = {}): RemoteSummary => ({
  id: 'aa665074-b72c-498a-b3b5-f90f78957a65',
  slug: 'bh-1960',
  name: "BH' 1960",
  summary: 'Ambiance années 60.',
  author: '',
  version: '1.0',
  tags: ['ENB'],
  archiveName: "BH' 1960.zip",
  archiveSize: 1000,
  sha256: 'b46a',
  downloadCount: 4,
  publishedAt: null,
  updatedAt: '2026-09-26T20:59:13Z',
  archiveUpdatedAt: null,
  cover: null,
  ...extra
})

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('pack du moment', () => {
  it('reprend `featured` quand l’API le donne', () => {
    expect(toMarketPack(remote({ featured: true }), undefined).featured).toBe(true)
    expect(toMarketPack(remote({ featured: false }), undefined).featured).toBe(false)
  })

  it('vaut false quand le champ est absent (API plus ancienne)', () => {
    const pack = toMarketPack(remote(), undefined)
    expect(pack.featured).toBe(false)
    expect(pack.localId).toBeNull()
  })

  describe('GET /packs/featured', () => {
    const market = new Marketplace('https://api.test/api', 'cache', () => ({ list: async () => [] }) as unknown as Library)
    beforeEach(() => fetchMock.mockReset())

    it('liste les packs mis en avant dans l’ordre de l’API', async () => {
      fetchMock.mockResolvedValue(json(200, [remote({ featured: true, slug: 'b' }), remote({ id: 'x', featured: true, slug: 'a' })]))
      const items = await market.featured()
      expect(fetchMock).toHaveBeenCalledWith('https://api.test/api/packs/featured')
      expect(items.map((p) => [p.slug, p.featured])).toEqual([
        ['b', true],
        ['a', true]
      ])
    })

    it('liste vide : rien à afficher', async () => {
      fetchMock.mockResolvedValue(json(200, []))
      expect(await market.featured()).toEqual([])
    })

    it('404 (API plus ancienne), erreur ou réponse inattendue : liste vide', async () => {
      fetchMock.mockResolvedValue(json(404, { detail: "Ce pack n'existe pas ou n'est plus disponible." }))
      expect(await market.featured()).toEqual([])
      fetchMock.mockResolvedValue(json(500, {}))
      expect(await market.featured()).toEqual([])
      fetchMock.mockRejectedValue(new Error('réseau'))
      expect(await market.featured()).toEqual([])
      fetchMock.mockResolvedValue(json(200, { items: [] }))
      expect(await market.featured()).toEqual([])
    })
  })
})

describe('catalogue des mods', () => {
  const library = (items: unknown[] = []): Library => ({ list: async () => items }) as unknown as Library
  // Sans valeur de retour : une fonction renvoyée serait appelée par vitest à la fin du test.
  beforeEach(() => {
    fetchMock.mockReset()
  })
  const page = (items: RemoteSummary[]): Response => json(200, { items, page: 0, size: 24, total: items.length, totalPages: 1 })

  it('genre et catégorie d’un mod ; un pack n’a pas de catégorie', () => {
    expect(toMarketPack(remote({ kind: 'mod', category: 'weapons' }), undefined)).toMatchObject({ kind: 'mod', category: 'weapons' })
    expect(toMarketPack(remote({ category: 'weapons' }), undefined)).toMatchObject({ kind: 'pack', category: null })
  })

  it('les mods sont demandés à /mods, jamais à /packs', async () => {
    const market = new Marketplace('https://api.test/api', 'cache', () => library(), () => library())
    fetchMock.mockImplementation(async () => page([]))
    await market.list({ kind: 'mod', category: 'weapons', q: 'fusil' })
    const url = new URL(fetchMock.mock.calls[0][0])
    expect(url.pathname).toBe('/api/mods')
    expect(url.searchParams.get('category')).toBe('weapons')
    // Catégorie ignorée pour les packs.
    await market.list({ category: 'weapons' })
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.has('category')).toBe(false)

    fetchMock.mockResolvedValue(json(200, [{ key: 'weapons', label: 'Armes', count: 3 }, { key: 'other', label: '', count: 0 }]))
    expect(await market.categories()).toEqual([
      { key: 'weapons', label: 'Armes', count: 3 },
      { key: 'other', label: 'other', count: 0 }
    ])
    expect(fetchMock.mock.calls.at(-1)![0]).toBe('https://api.test/api/mods/categories')

    fetchMock.mockResolvedValue(json(200, { packageId: 'c'.repeat(32), key: Buffer.alloc(32, 1).toString('base64') }))
    await market.packageKey('m1', 'mod')
    expect(fetchMock.mock.calls.at(-1)![0]).toBe('https://api.test/api/mods/m1/package/key')

    fetchMock.mockResolvedValue(json(404, {}))
    await expect(market.detail('m1', 'mod')).rejects.toThrow('Ce mod n’est plus disponible sur la Marketplace.')
    expect(fetchMock.mock.calls.at(-1)![0]).toBe('https://api.test/api/mods/m1')
  })

  it('mises à jour : les mods sont suivis comme les packs ; une API sans mods ne les marque pas retirés', async () => {
    const mod = { id: 'mod-local', marketplace: { id: 'm1', sha256: 'ancien', downloadedAt: '2026-01-01' } }
    const pack = { id: 'pack-local', marketplace: { id: 'p1', sha256: 'b46a', downloadedAt: '2026-01-01' } }
    const market = new Marketplace('https://api.test/api', 'cache', () => library([pack]), () => library([mod]))
    fetchMock.mockImplementation(async (url) =>
      url.includes('/mods?') ? page([remote({ id: 'm1', kind: 'mod', sha256: 'nouveau' })]) : page([remote({ id: 'p1', sha256: 'b46a' })])
    )
    await market.refreshCatalog()
    expect(fetchMock.mock.calls.map((c) => new URL(c[0]).pathname)).toEqual(['/api/packs', '/api/mods'])
    expect(await market.status()).toEqual({ updates: ['mod-local'], gone: [] })

    fetchMock.mockImplementation(async (url) => (url.includes('/mods?') ? json(404, {}) : page([remote({ id: 'p1', sha256: 'b46a' })])))
    await market.refreshCatalog()
    expect(await market.status()).toEqual({ updates: [], gone: [] })
  })
})

describe('poids sur les performances', () => {
  const library = { list: async () => [] } as unknown as Library
  beforeEach(() => fetchMock.mockReset())
  const summary = {
    tier: 'heavy',
    vramMb: 900,
    effectsMs: 4,
    worldMs: 1.5,
    minVramMb: 3584,
    recommendedVramMb: 5120,
    minGpuClass: 2,
    recommendedGpuClass: 4,
    estimated: false
  }

  it('dans les cartes : analysé, pas encore analysé, ou API plus ancienne sans le champ', () => {
    expect(toMarketPack(remote({ performance: summary }), undefined).performance).toMatchObject({ tier: 'heavy', effectsMs: 4 })
    expect(toMarketPack(remote({ performance: null }), undefined).performance).toBeNull()
    expect('performance' in toMarketPack(remote(), undefined)).toBe(false)
  })

  it('« Compatibles avec mon PC » : mémoire vidéo et classe envoyées seulement sur demande', async () => {
    fetchMock.mockImplementation(async () => json(200, { items: [], page: 0, size: 24, total: 0, totalPages: 0 }))
    const market = new Marketplace('https://api.test/api', 'cache', () => library)
    await market.list({})
    await market.list({ vram: 8192, gpuClass: 3 })
    await market.list({ kind: 'mod', vram: 4096 })
    const params = fetchMock.mock.calls.map((c) => new URL(c[0]).searchParams)
    expect([params[0].get('vram'), params[0].get('gpuClass')]).toEqual([null, null])
    expect([params[1].get('vram'), params[1].get('gpuClass')]).toEqual(['8192', '3'])
    expect(new URL(fetchMock.mock.calls[2][0]).pathname).toBe('/api/mods')
    expect([params[2].get('vram'), params[2].get('gpuClass')]).toEqual(['4096', null])
  })

  it('analyse détaillée ; null avec une API qui ne la fournit pas', async () => {
    const id = 'aa665074-b72c-498a-b3b5-f90f78957a65'
    const market = new Marketplace('https://api.test/api', 'cache', () => library)
    fetchMock.mockResolvedValueOnce(json(200, { status: 'ready', tier: 'heavy', report: { summary, highlights: [{ impact: 'high', text: 'Lourd' }], options: [] } }))
    const detail = await market.performance(id, 'mod')
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.test/api/mods/${id}/performance`)
    expect(detail?.report?.highlights).toEqual([{ impact: 'high', text: 'Lourd' }])
    fetchMock.mockResolvedValueOnce(json(404, { detail: 'Introuvable' }))
    expect(await market.performance(id)).toBeNull()
  })
})

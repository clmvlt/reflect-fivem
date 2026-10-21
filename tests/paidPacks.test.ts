// Packs et mods payants du catalogue : `price` absent lu comme gratuit, bouton d'installation selon le droit de
// télécharger et la connexion, refus 401 et 402 du téléchargement (archive, clé) gardés avec leur code et traduits en
// proposition de connexion ou d'achat, mise à jour d'un pack devenu payant (le pack installé reste), badges « Acheté » et
// « Offert », packs à soi relus (connexion, achat, focus au plus une fois par minute) et gardés sur le disque.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PACK_LOGIN_REQUIRED, PACK_PURCHASE_REQUIRED } from '@shared/api'
import { installChoice, itemBadge, paidProposal } from '@shared/billing'
import type { AccountMe } from '@shared/types'

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
vi.mock('electron', () => ({ net: { fetch: (url: string, init?: RequestInit) => fetchMock(url, init) } }))

const { Marketplace, toMarketPack } = await import('../src/main/core/marketplace')
const { DownloadQueue } = await import('../src/main/core/downloads')
const { ApiError } = await import('../src/main/core/http')
const { Purchases, toAccess } = await import('../src/main/core/purchases')
type Library = import('../src/main/core/library').Library
type StoredManifest = import('../src/main/core/library').StoredManifest
type RemoteSummary = import('../src/main/core/marketplace').RemoteSummary
type PurchasesAccount = import('../src/main/core/purchases').PurchasesAccount

const API = 'https://api.test/api'
const ID = 'aa665074-b72c-498a-b3b5-f90f78957a65'
const PURCHASE = '99999999-2222-4333-8444-555555555555'
const SHA_OLD = 'a'.repeat(64)
const SHA_NEW = 'b'.repeat(64)

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/problem+json' } })

const summary = (extra: Partial<RemoteSummary> = {}): RemoteSummary => ({
  id: ID,
  slug: 'bh-1960',
  name: "BH' 1960",
  summary: '',
  author: '',
  version: '2.0',
  tags: [],
  archiveName: 'BH 1960.zip',
  archiveSize: 1000,
  sha256: SHA_NEW,
  downloadCount: 0,
  publishedAt: null,
  updatedAt: '2026-10-01T00:00:00Z',
  archiveUpdatedAt: null,
  cover: null,
  ...extra
})

describe('prix des packs du catalogue', () => {
  it('`price` absent (API plus ancienne), nul ou illisible : gratuit', () => {
    expect(toMarketPack(summary(), undefined).price).toBeNull()
    expect(toMarketPack(summary({ price: null }), undefined).price).toBeNull()
    expect(toMarketPack(summary({ price: 0 }), undefined).price).toBeNull()
    expect(toMarketPack(summary({ price: '400' as unknown as number }), undefined).price).toBeNull()
    expect(toMarketPack(summary({ price: 400 }), undefined).price).toBe(400)
  })

  it('droit de télécharger : réponse incomplète, téléchargeable seulement s’il est gratuit', () => {
    expect(toAccess({ price: 400, currency: 'eur', owned: true, canDownload: true }, ID)).toEqual({ packId: ID, price: 400, currency: 'eur', owned: true, canDownload: true })
    expect(toAccess({ price: 400 }, ID)).toMatchObject({ price: 400, owned: false, canDownload: false })
    expect(toAccess({}, ID)).toMatchObject({ price: null, canDownload: true })
  })
})

describe('bouton d’installation', () => {
  it('gratuit, ou téléchargeable par le compte : Télécharger', () => {
    expect(installChoice({ price: null, canDownload: false, signedIn: false })).toBe('download')
    expect(installChoice({ price: 400, canDownload: true, signedIn: true })).toBe('download')
  })

  it('payant, pas à soi : Acheter avec un compte, Se connecter pour acheter sans compte', () => {
    expect(installChoice({ price: 400, canDownload: false, signedIn: true })).toBe('buy')
    expect(installChoice({ price: 400, canDownload: false, signedIn: false })).toBe('signIn')
  })
})

describe('badge d’un pack payant', () => {
  it('son prix, puis « Acheté » ou « Offert » quand il est à soi', () => {
    expect(itemBadge(400, null)).toEqual({ kind: 'price', price: 400 })
    expect(itemBadge(400, { source: 'purchase' })).toEqual({ kind: 'purchase' })
    expect(itemBadge(400, { source: 'admin' })).toEqual({ kind: 'admin' })
    // Bibliothèque (prix inconnu) : badge seulement pour un pack à soi ; gratuit : rien.
    expect(itemBadge(null, { source: 'purchase' })).toEqual({ kind: 'purchase' })
    expect(itemBadge(null, null)).toBeNull()
  })
})

describe('téléchargement refusé d’un pack payant', () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-paid-'))
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  beforeEach(() => fetchMock.mockReset())

  /** Bibliothèque minimale ; `linked` : version déjà téléchargée (relié à sa fiche). */
  const fakeLibrary = (linked: StoredManifest | null) => {
    const changes: string[] = []
    const lib = {
      dir,
      list: async () => (linked ? [linked] : []),
      findDuplicate: async () => null,
      import: async () => {
        changes.push('import')
        throw new Error('ne doit pas être importé')
      },
      remove: async (id: string) => changes.push(`remove ${id}`),
      save: async () => changes.push('save')
    } as unknown as Library
    return { lib, changes }
  }
  const hooks = { activeId: () => 'local-1', apply: async () => undefined }
  const detail = { ...summary({ price: 400 }), description: '', images: [] }

  it('402 avec un compte : erreur « pack-purchase-required » sans nouvel essai, proposée comme un achat', async () => {
    const { lib, changes } = fakeLibrary(null)
    const market = new Marketplace(API, path.join(dir, 'cache'), () => lib)
    let downloads = 0
    fetchMock.mockImplementation(async (url) => {
      if (url === `${API}/packs/${ID}`) return json(200, detail)
      downloads++
      return json(402, { detail: 'Ce pack est payant.', code: PACK_PURCHASE_REQUIRED, price: 400, currency: 'eur' })
    })
    const err = await market.install(ID, () => undefined, new AbortController().signal, hooks).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 402, code: PACK_PURCHASE_REQUIRED })
    expect(downloads).toBe(1)
    expect(changes).toEqual([])
    expect(paidProposal({ ok: false, code: PACK_PURCHASE_REQUIRED })).toBe('buy')
  })

  it('401 sans compte : erreur « pack-login-required », proposée comme une connexion', async () => {
    const { lib } = fakeLibrary(null)
    const market = new Marketplace(API, path.join(dir, 'cache'), () => lib)
    fetchMock.mockImplementation(async (url) =>
      url === `${API}/packs/${ID}` ? json(200, detail) : json(401, { detail: 'Connectez-vous.', code: PACK_LOGIN_REQUIRED, price: 400, currency: 'eur' })
    )
    const err = await market.install(ID, () => undefined, new AbortController().signal, hooks).catch((e: unknown) => e)
    expect(err).toMatchObject({ status: 401, code: PACK_LOGIN_REQUIRED })
    expect(paidProposal({ ok: false, code: PACK_LOGIN_REQUIRED })).toBe('signIn')
  })

  it('clé d’un paquet chiffré refusée : même code (pack déjà dans la bibliothèque sur un autre PC)', async () => {
    const { lib } = fakeLibrary(null)
    const market = new Marketplace(API, path.join(dir, 'cache'), () => lib)
    fetchMock.mockResolvedValue(json(402, { detail: 'Ce pack est payant.', code: PACK_PURCHASE_REQUIRED }))
    await expect(market.packageKey(ID)).rejects.toMatchObject({ status: 402, code: PACK_PURCHASE_REQUIRED })
    fetchMock.mockResolvedValue(json(402, { detail: 'Ce mod est payant.', code: PACK_PURCHASE_REQUIRED }))
    await expect(market.packageKey(ID, 'mod')).rejects.toMatchObject({ code: PACK_PURCHASE_REQUIRED })
  })

  it('mise à jour d’un pack devenu payant : refusée avant de toucher la bibliothèque, le pack installé reste', async () => {
    const linked = {
      id: 'local-1',
      name: 'BH 1960',
      gallery: [],
      cover: null,
      marketplace: { id: ID, slug: 'bh-1960', sha256: SHA_OLD, version: '1.0', downloadedAt: '2026-09-01T00:00:00Z' }
    } as unknown as StoredManifest
    const { lib, changes } = fakeLibrary(linked)
    const market = new Marketplace(API, path.join(dir, 'cache'), () => lib)
    fetchMock.mockImplementation(async (url) =>
      url === `${API}/packs/${ID}` ? json(200, detail) : json(402, { detail: 'Ce pack est payant.', code: PACK_PURCHASE_REQUIRED })
    )
    const err = await market.install(ID, () => undefined, new AbortController().signal, hooks).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: PACK_PURCHASE_REQUIRED })
    // Ni import, ni retrait, ni réinstallation : l'ancienne version reste en place et utilisable.
    expect(changes).toEqual([])
    expect(await lib.list()).toEqual([linked])
    expect(paidProposal({ ok: false, code: PACK_PURCHASE_REQUIRED, update: true })).toBe('buyUpdate')
  })

  it('la file des téléchargements garde le code de l’erreur et signale une mise à jour', async () => {
    const done: unknown[] = []
    const queue = new DownloadQueue({
      run: async () => {
        throw new ApiError('Ce pack est payant.', 402, PACK_PURCHASE_REQUIRED)
      },
      onChange: () => undefined,
      onDone: (d) => done.push(d)
    })
    queue.add({ id: ID, kind: 'pack', name: 'BH 1960', coverId: null, claim: false, title: 'Mise à jour', localId: 'local-1' })
    await vi.waitFor(() => expect(done).toHaveLength(1))
    expect(done[0]).toMatchObject({ ok: false, code: PACK_PURCHASE_REQUIRED, update: true })
    expect(paidProposal(done[0] as { ok: boolean; code?: string; update?: boolean })).toBe('buyUpdate')
    // Toute autre fin : rien à proposer.
    expect(paidProposal({ ok: false, code: 'pack-gone' })).toBeNull()
    expect(paidProposal({ ok: true })).toBeNull()
  })
})

describe('packs à soi et achats du catalogue', () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-owned-'))
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const owned = (source: string) => [{ packId: ID, kind: 'mod', slug: 'bh-1960', name: 'BH 1960', available: true, source, purchaseId: PURCHASE, since: '2026-10-21T10:00:00Z' }]

  function setup(file = path.join(dir, `owned-${Math.random().toString(36).slice(2)}.json`)) {
    let me: AccountMe | null = { id: 7 } as AccountMe
    let now = 1_000_000
    const routes: Record<string, unknown> = { 'GET /me/packs/owned': owned('purchase') }
    const call = vi.fn(async (method: string, pathname: string, _opts?: unknown) => {
      const body = routes[`${method} ${pathname}`]
      if (body === undefined) throw new ApiError('Introuvable.', 404)
      return body
    })
    const account = { current: () => me, call } as unknown as PurchasesAccount
    const onOwnedChange = vi.fn()
    const purchases = new Purchases({
      account,
      file,
      siteUrl: (p) => `https://site.test${p}`,
      supportUrl: () => 'https://discord.gg/exemple',
      kindOf: () => null,
      onOwnedChange,
      now: () => now
    })
    return {
      purchases,
      call,
      routes,
      file,
      onOwnedChange,
      signIn: (next: AccountMe | null) => {
        me = next
      },
      wait: (ms: number) => {
        now += ms
      }
    }
  }

  it('relus à la connexion, gardés sur le disque, oubliés à la déconnexion', async () => {
    const s = setup()
    s.purchases.accountChanged({ id: 7 } as AccountMe)
    await vi.waitFor(() => expect(s.purchases.ownedPacks()).toHaveLength(1))
    expect(s.purchases.ownedPacks()[0]).toMatchObject({ packId: ID, kind: 'mod', source: 'purchase' })
    expect(s.onOwnedChange).toHaveBeenCalledTimes(1)
    // Relancé hors ligne : la liste gardée sur le disque.
    const again = setup(s.file)
    await again.purchases.load()
    expect(again.purchases.ownedPacks().map((o) => o.packId)).toEqual([ID])
    // Un autre compte ne voit pas cette liste.
    again.signIn({ id: 8 } as AccountMe)
    expect(again.purchases.ownedPacks()).toEqual([])
    again.signIn(null)
    again.purchases.accountChanged(null)
    expect(again.purchases.ownedPacks()).toEqual([])
  })

  it('retour du focus : relus au plus une fois par minute', async () => {
    const s = setup()
    await s.purchases.refreshOwned(true)
    await s.purchases.refreshOwned()
    expect(s.call).toHaveBeenCalledTimes(1)
    s.wait(61_000)
    s.routes['GET /me/packs/owned'] = owned('admin')
    await s.purchases.refreshOwned()
    expect(s.call).toHaveBeenCalledTimes(2)
    expect(s.purchases.ownedPacks()[0].source).toBe('admin')
  })

  it('droit de télécharger demandé avec le compte s’il y en a un ; vente en public', async () => {
    const s = setup()
    s.routes[`GET /mods/${ID}/access`] = { packId: ID, price: 400, currency: 'eur', owned: false, canDownload: false }
    s.routes['GET /billing/info'] = { currency: 'eur', checkout: true, testMode: true }
    expect(await s.purchases.access('mod', ID)).toMatchObject({ price: 400, canDownload: false })
    expect(s.call).toHaveBeenLastCalledWith('GET', `/mods/${ID}/access`, { auth: 'optional' })
    expect(await s.purchases.saleInfo()).toEqual({ currency: 'eur', checkout: true, testMode: true, termsUrl: 'https://site.test/cgv', supportUrl: 'https://discord.gg/exemple' })
  })

  it('achat offert par un code ou payé : packs à soi relus, catalogue du pack connu', async () => {
    const s = setup()
    s.routes[`POST /mods/${ID}/checkout`] = { id: PURCHASE, product: 'item', packId: ID, packName: 'BH 1960', status: 'free', promoCode: 'OFFERT' }
    const free = await s.purchases.checkout('mod', ID, { promoCode: ' offert ', acceptTerms: true, waiveWithdrawal: true })
    expect(free).toMatchObject({ product: 'item', packId: ID, packKind: 'mod', status: 'free' })
    expect(s.call).toHaveBeenCalledWith('POST', `/mods/${ID}/checkout`, { json: { promoCode: 'offert', acceptTerms: true, waiveWithdrawal: true }, auth: 'required' })
    expect(s.call).toHaveBeenCalledWith('GET', '/me/packs/owned', { auth: 'required' })

    const other = setup()
    other.routes[`GET /me/purchases/${PURCHASE}`] = { id: PURCHASE, product: 'item', packId: ID, packName: 'BH 1960', status: 'paid' }
    const paid = await other.purchases.purchase(PURCHASE)
    expect(paid).toMatchObject({ status: 'paid', packKind: 'mod' })
    expect(other.purchases.ownedPacks().map((o) => o.packId)).toEqual([ID])
  })
})

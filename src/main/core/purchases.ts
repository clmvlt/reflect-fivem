// Achats du compte et packs payants du catalogue.
//
// L'admin peut rendre payant un pack ou un mod de la Marketplace (`price`, centimes TTC ; gratuit par défaut). Son
// archive, son paquet chiffré et sa clé ne se téléchargent alors que par ceux qui l'ont (acheteurs, comptes à qui l'admin
// l'a offert, son auteur et les admins) : sinon 401 « pack-login-required » sans compte, 402 « pack-purchase-required »
// avec un compte (voir marketplace.ts). Tout compte connecté peut l'acheter, même sans accès à « Créer ton pack » :
// prix avec un code promo, puis commande (page Stripe Checkout ouverte dans le navigateur, comme pour « Créer ton
// pack »). Le suivi de tous les achats (catalogue et « Créer ton pack ») passe par /me/purchases.
//
// Packs à soi (GET /me/packs/owned : achetés ou offerts) : gardés en mémoire et sur le disque (<données>/owned-packs.json,
// avec le compte), pour les badges de la bibliothèque et de la Marketplace hors ligne aussi ; relus à la connexion, après
// un achat et quand la fenêtre reprend le focus (au plus une fois par minute).
//
// Aucune dépendance à Electron ici (testé avec vitest) : le service fournit le compte et l'adresse du site.

import { t } from 'i18next'
import { httpsUrl } from '@shared/links'
import type {
  AccountMe,
  BillingProduct,
  ItemAccess,
  ItemCheckoutInput,
  MarketKind,
  OwnedPack,
  Purchase,
  PurchaseStatus,
  Quote,
  SaleInfo
} from '@shared/types'
import { readJson, writeJsonAtomic } from '../util/fsx'
import { log } from '../util/log'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PURCHASE_STATUSES: readonly string[] = ['pending', 'paid', 'free', 'expired', 'failed', 'canceled', 'refunded']
const PRODUCTS: readonly string[] = ['pack', 'unlock', 'item']
/** Packs à soi relus au plus une fois par minute (retour du focus). */
const OWNED_REFRESH_MS = 60_000

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const obj = (x: unknown): Obj => (isObj(x) ? x : {})
const str = (x: unknown): string => (typeof x === 'string' ? x : '')
const strOrNull = (x: unknown): string | null => (typeof x === 'string' && x ? x : null)
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
const uuidOrNull = (x: unknown): string | null => (typeof x === 'string' && UUID.test(x) ? x : null)
/** Entier positif ou nul (montant en centimes). */
const count = (x: unknown): number => Math.max(0, Math.round(num(x) ?? 0))
const product = (x: unknown): BillingProduct => (typeof x === 'string' && PRODUCTS.includes(x) ? (x as BillingProduct) : 'pack')
const kindOf = (x: unknown): MarketKind => (x === 'mod' ? 'mod' : 'pack')
const catalogPath = (kind: MarketKind): string => (kind === 'mod' ? '/mods' : '/packs')
const badResponse = (): Error => new Error(t('builder.errors.badResponse'))

/** Prix (centimes TTC) d'un pack du catalogue ; null : gratuit (absent, ou illisible). */
export function priceOf(x: unknown): number | null {
  const n = num(x)
  return n !== null && n > 0 ? Math.round(n) : null
}

/** Code promo nettoyé (32 caractères au plus) ; null s'il est vide. */
export function promoCode(x: unknown): string | null {
  const code = typeof x === 'string' ? x.trim().slice(0, 32) : ''
  return code || null
}

export function toQuote(raw: unknown): Quote {
  const o = obj(raw)
  const promo = isObj(o.promo) && typeof o.promo.code === 'string' ? o.promo : null
  return {
    product: product(o.product),
    currency: str(o.currency) || 'eur',
    baseAmount: count(o.baseAmount),
    discount: count(o.discount),
    amount: count(o.amount),
    promo: promo ? { code: promo.code as string, percentOff: num(promo.percentOff), amountOff: num(promo.amountOff) } : null
  }
}

/** Achat ; statut inconnu : échoué (l'attente d'un paiement ne dure jamais sans fin). */
export function toPurchase(raw: unknown): Purchase {
  const o = obj(raw)
  if (typeof o.id !== 'string' || !UUID.test(o.id)) throw badResponse()
  return {
    id: o.id,
    product: product(o.product),
    buildId: uuidOrNull(o.buildId),
    buildName: strOrNull(o.buildName),
    packId: uuidOrNull(o.packId),
    packName: strOrNull(o.packName),
    packKind: null,
    currency: str(o.currency) || 'eur',
    baseAmount: count(o.baseAmount),
    discount: count(o.discount),
    amount: count(o.amount),
    promoCode: strOrNull(o.promoCode),
    status: typeof o.status === 'string' && PURCHASE_STATUSES.includes(o.status) ? (o.status as PurchaseStatus) : 'failed',
    checkoutUrl: strOrNull(o.checkoutUrl),
    expiresAt: strOrNull(o.expiresAt),
    createdAt: str(o.createdAt),
    paidAt: strOrNull(o.paidAt)
  }
}

export function toAccess(raw: unknown, id: string): ItemAccess {
  const o = obj(raw)
  const price = priceOf(o.price)
  return {
    packId: uuidOrNull(o.packId) ?? id,
    price,
    currency: str(o.currency) || 'eur',
    owned: o.owned === true,
    // Réponse incomplète : téléchargeable s'il est gratuit (l'API refusera sinon, et l'achat sera proposé).
    canDownload: typeof o.canDownload === 'boolean' ? o.canDownload : price === null
  }
}

function toOwned(raw: unknown): OwnedPack | null {
  const o = obj(raw)
  const packId = uuidOrNull(o.packId)
  if (!packId) return null
  return {
    packId,
    kind: kindOf(o.kind),
    slug: str(o.slug),
    name: str(o.name),
    available: o.available !== false,
    source: o.source === 'admin' ? 'admin' : 'purchase',
    purchaseId: uuidOrNull(o.purchaseId),
    since: str(o.since)
  }
}

/** Compte connecté (voir Account) : requêtes au nom du compte, ou anonymes (`optional`). */
export interface PurchasesAccount {
  current(): AccountMe | null
  call<T>(method: string, pathname: string, opts?: { json?: unknown; auth?: 'optional' | 'required' }): Promise<T>
}

export interface PurchasesDeps {
  account: PurchasesAccount
  /** Packs à soi gardés sur le disque (<données>/owned-packs.json). */
  file: string
  /** Adresse d'une page du site (CGV). */
  siteUrl: (sitePath: string) => string
  /** Lien du support (Discord), null sans lien. */
  supportUrl: () => string | null
  /** Catalogue d'un pack connu de l'application (catalogue de la Marketplace lu) ; null sinon. */
  kindOf?: (packId: string) => MarketKind | null
  /** Packs à soi changés (badges à mettre à jour). */
  onOwnedChange?: () => void
  now?: () => number
}

interface OwnedFile {
  accountId: number
  savedAt: string
  items: unknown[]
}

export class Purchases {
  private owned: OwnedPack[] = []
  /** Compte dont {@link owned} est la liste (null : aucun). */
  private ownedAccount: number | null = null
  private ownedAt = 0
  private refreshing: Promise<OwnedPack[]> | null = null

  constructor(private deps: PurchasesDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Packs à soi du compte connecté gardés sur le disque (badges tout de suite, hors ligne aussi). */
  async load(): Promise<void> {
    const me = this.deps.account.current()
    const saved = await readJson<OwnedFile | null>(this.deps.file, null)
    if (!me || !isObj(saved) || saved.accountId !== me.id || !Array.isArray(saved.items)) return
    this.owned = saved.items.map(toOwned).filter((x): x is OwnedPack => x !== null)
    this.ownedAccount = me.id
  }

  /** Packs et mods payants du compte connecté (achetés ou offerts), derniers connus ; vide sans compte. */
  ownedPacks(): OwnedPack[] {
    const me = this.deps.account.current()
    return me && me.id === this.ownedAccount ? this.owned : []
  }

  /**
   * Relit les packs à soi (`force` : tout de suite ; sinon au plus une fois par minute). Sans compte : liste vidée.
   * Hors ligne : la liste connue est gardée.
   */
  refreshOwned(force = false): Promise<OwnedPack[]> {
    const me = this.deps.account.current()
    if (!me) {
      this.clearOwned()
      return Promise.resolve([])
    }
    if (!force && me.id === this.ownedAccount && this.now() - this.ownedAt < OWNED_REFRESH_MS) return Promise.resolve(this.owned)
    this.refreshing ??= this.fetchOwned(me.id).finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async fetchOwned(accountId: number): Promise<OwnedPack[]> {
    this.ownedAt = this.now()
    let items: OwnedPack[]
    try {
      const raw = await this.deps.account.call<unknown>('GET', '/me/packs/owned', { auth: 'required' })
      items = (Array.isArray(raw) ? raw : []).map(toOwned).filter((x): x is OwnedPack => x !== null)
    } catch (err) {
      log.info(`Packs achetés non relus : ${(err as Error).message}`)
      return this.ownedPacks()
    }
    // Compte changé pendant la requête : la réponse ne vaut plus.
    if (this.deps.account.current()?.id !== accountId) return this.ownedPacks()
    const changed = accountId !== this.ownedAccount || JSON.stringify(items) !== JSON.stringify(this.owned)
    this.owned = items
    this.ownedAccount = accountId
    if (changed) {
      await writeJsonAtomic(this.deps.file, { accountId, savedAt: new Date().toISOString(), items } satisfies OwnedFile).catch((err: unknown) =>
        log.warn(`Packs achetés non enregistrés : ${(err as Error).message}`)
      )
      this.deps.onOwnedChange?.()
    }
    return items
  }

  /** Connexion (autre compte) : packs à soi relus ; déconnexion : oubliés. */
  accountChanged(me: AccountMe | null): void {
    if (!me) return this.clearOwned()
    if (me.id !== this.ownedAccount) void this.refreshOwned(true)
  }

  private clearOwned(): void {
    const had = this.ownedAccount !== null || this.owned.length > 0
    this.owned = []
    this.ownedAccount = null
    this.ownedAt = 0
    if (!had) return
    void writeJsonAtomic(this.deps.file, { accountId: -1, savedAt: new Date().toISOString(), items: [] }).catch(() => undefined)
    this.deps.onOwnedChange?.()
  }

  // ---------------------------------------------------------------- packs payants du catalogue

  /** Vente en public : monnaie, paiement possible, mode test ; CGV et support connus de l'application. */
  async saleInfo(): Promise<SaleInfo> {
    const o = obj(await this.deps.account.call<unknown>('GET', '/billing/info', { auth: 'optional' }))
    return {
      currency: str(o.currency) || 'eur',
      checkout: o.checkout === true,
      testMode: o.testMode === true,
      termsUrl: this.deps.siteUrl('/cgv'),
      supportUrl: httpsUrl(this.deps.supportUrl())
    }
  }

  /** Prix et droit de télécharger pour le compte connecté (sans compte aussi), jamais en cache. */
  async access(kind: MarketKind, id: string): Promise<ItemAccess> {
    if (!UUID.test(id)) throw new Error(t(kind === 'mod' ? 'market.modGone' : 'market.packGone'))
    return toAccess(await this.deps.account.call<unknown>('GET', `${catalogPath(kind)}/${id}/access`, { auth: 'optional' }), id)
  }

  /** Prix d'un pack payant avec un code promo (refusé : 422 avec un code « promo-… »). */
  async quote(kind: MarketKind, id: string, code: string | null): Promise<Quote> {
    if (!UUID.test(id)) throw new Error(t(kind === 'mod' ? 'market.modGone' : 'market.packGone'))
    return toQuote(await this.deps.account.call<unknown>('POST', `${catalogPath(kind)}/${id}/quote`, { json: { promoCode: promoCode(code) }, auth: 'required' }))
  }

  /**
   * Commande d'un pack payant (CGV acceptées et droit de rétractation abandonné) : `pending` avec la page de paiement,
   * ou `free` (offert par un code : il est déjà à lui).
   */
  async checkout(kind: MarketKind, id: string, input: ItemCheckoutInput): Promise<Purchase> {
    if (!UUID.test(id)) throw new Error(t(kind === 'mod' ? 'market.modGone' : 'market.packGone'))
    const body = { promoCode: promoCode(input.promoCode), acceptTerms: input.acceptTerms === true, waiveWithdrawal: input.waiveWithdrawal === true }
    const purchase = this.withKind(toPurchase(await this.deps.account.call<unknown>('POST', `${catalogPath(kind)}/${id}/checkout`, { json: body, auth: 'required' })), kind)
    log.info(`Marketplace : achat commandé (${purchase.status})`)
    if (purchase.status === 'free') await this.refreshOwned(true)
    return purchase
  }

  // ---------------------------------------------------------------- suivi de tous les achats

  /** Un achat ; l'API relit chez Stripe un paiement en cours (au plus toutes les 3 s). Payé : packs à soi relus. */
  async purchase(id: string): Promise<Purchase> {
    if (!UUID.test(id)) throw new Error(t('builder.errors.purchaseNotFound'))
    const purchase = toPurchase(await this.deps.account.call<unknown>('GET', `/me/purchases/${id}`, { auth: 'required' }))
    if (purchase.product === 'item' && (purchase.status === 'paid' || purchase.status === 'free') && !this.ownedPacks().some((o) => o.packId === purchase.packId))
      await this.refreshOwned(true)
    return this.withKind(purchase)
  }

  /** Abandon d'un paiement en cours (la page Stripe est fermée) ; un paiement déjà fait reste acquis. */
  async cancel(id: string): Promise<Purchase> {
    if (!UUID.test(id)) throw new Error(t('builder.errors.purchaseNotFound'))
    const purchase = toPurchase(await this.deps.account.call<unknown>('POST', `/me/purchases/${id}/cancel`, { auth: 'required' }))
    log.info(`Paiement abandonné (${purchase.status})`)
    return this.withKind(purchase)
  }

  /** Tous les achats du compte, le plus récent d'abord (ceux qui sont illisibles sont laissés de côté). */
  async list(): Promise<Purchase[]> {
    const raw = await this.deps.account.call<unknown>('GET', '/me/purchases', { auth: 'required' })
    return (Array.isArray(raw) ? raw : []).flatMap((x) => {
      try {
        return [this.withKind(toPurchase(x))]
      } catch {
        return []
      }
    })
  }

  /** Catalogue du pack d'un achat `item` : celui de la commande, des packs à soi, ou du catalogue lu. */
  private withKind(p: Purchase, kind?: MarketKind): Purchase {
    if (p.product !== 'item' || !p.packId) return p
    const packKind = kind ?? this.owned.find((o) => o.packId === p.packId)?.kind ?? this.deps.kindOf?.(p.packId) ?? null
    return { ...p, packKind }
  }
}

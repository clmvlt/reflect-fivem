// Vente de « Créer ton pack » : lecture tolérante des formules et de l'état du compte (ancienne API : tout offert),
// appels de l'API (prix, commande, suivi, abandon, déblocage), refus 402 transmis à l'interface, badge et bandeaux selon
// la formule, adresse de la page de paiement (checkout.stripe.com seulement hors développement), fin de l'attente d'un
// paiement selon son statut, et bouton « Payer » inactif sans les deux cases.
import { describe, expect, it, vi } from 'vitest'
import { BUILDER_EDIT_LOCKED, BUILDER_PAYMENT_REQUIRED, readApiError, tagApiError } from '@shared/api'
import { canPay, deleteNote, failureOf, formatPrice, isCheckoutUrl, needsPack, planBadge, planBanner, purchaseOutcome, saleActive } from '@shared/billing'
import type { AccountBilling, AccountMe, BuildPlan, PurchaseStatus } from '@shared/types'
import i18next from 'i18next'
import { Builder, toBilling, toPlan, toPurchase, type BuilderAccount } from '../src/main/core/builder'
import { ApiError } from '../src/main/core/http'
import type { Library } from '../src/main/core/library'

const BUILD = '11111111-2222-4333-8444-555555555555'
const PURCHASE = '99999999-2222-4333-8444-555555555555'

/** API de test : réponses par « MÉTHODE /chemin » (une ApiError est levée telle quelle). */
function setup(routes: Record<string, unknown>) {
  const me = { id: 7, admin: false, canBuildPacks: true } as AccountMe
  const call = vi.fn(async (method: string, pathname: string, _opts?: unknown) => {
    const body = routes[`${method} ${pathname}`]
    if (body instanceof ApiError) throw body
    if (body === undefined) throw new ApiError('Introuvable.', 404)
    return body
  })
  const account = { current: () => me, refresh: vi.fn(async () => me), call, fetchAuthed: vi.fn(), accessToken: async () => 'jeton', renewRejected: async () => 'jeton' }
  const builder = new Builder({
    apiUrl: 'https://api.test/api',
    dir: 'inutilisé',
    account: account as unknown as BuilderAccount,
    library: () => ({ list: async () => [] }) as unknown as Library,
    fetch: vi.fn()
  })
  return { builder, call }
}

const billing = (over: Partial<AccountBilling> = {}): AccountBilling => ({
  enabled: true,
  unlimited: false,
  currency: 'eur',
  prices: { pack: 400, unlock: 400 },
  free: { packs: 1, used: 1, remaining: 0, edits: 1 },
  credits: { total: 0, used: 0, available: 0 },
  nextPlan: null,
  canCreate: false,
  builds: 1,
  maxBuilds: 50,
  checkout: true,
  termsUrl: 'https://reflect-fivem.com/cgv',
  supportUrl: null,
  ...over
})

const plan = (over: Partial<BuildPlan> = {}): BuildPlan => ({ type: 'free', unlimited: false, editsAllowed: 1, editsUsed: 0, editsLeft: 1, locked: false, ...over })

describe('lecture des réponses de la vente', () => {
  it('formule absente (ancienne API) : offerte, illimitée', () => {
    expect(toPlan(undefined)).toEqual({ type: 'open', unlimited: true, editsAllowed: 0, editsUsed: 0, editsLeft: null, locked: false })
    expect(toPlan({ type: 'autre' })).toMatchObject({ type: 'open', unlimited: true, locked: false })
  })

  it('lit un pack gratuit, et ne le dit jamais à débloquer quand il est illimité', () => {
    expect(toPlan({ type: 'free', unlimited: false, editsAllowed: 1, editsUsed: 1, editsLeft: 0, locked: true })).toEqual({
      type: 'free',
      unlimited: false,
      editsAllowed: 1,
      editsUsed: 1,
      editsLeft: 0,
      locked: true
    })
    expect(toPlan({ type: 'free', unlimited: true, editsLeft: 0, locked: true })).toMatchObject({ unlimited: true, editsLeft: null, locked: false })
    expect(toPlan({ type: 'credit' })).toMatchObject({ type: 'credit', unlimited: true, editsLeft: null })
  })

  it('créations sans formule (ancienne API) : offertes, illimitées', async () => {
    const s = setup({
      'GET /builder/builds': [{ id: BUILD, name: 'Mon pack', componentCount: 2, unavailableCount: 0 }],
      [`GET /builder/builds/${BUILD}`]: { id: BUILD, name: 'Mon pack', components: [], tools: {} }
    })
    const [summary] = await s.builder.builds()
    expect(summary.plan).toMatchObject({ type: 'open', unlimited: true, locked: false })
    expect((await s.builder.build(BUILD)).plan).toMatchObject({ type: 'open', unlimited: true })
  })

  it('état du compte incomplet : rien de limité, aucune offre', () => {
    const b = toBilling({})
    expect(b).toMatchObject({ enabled: false, unlimited: true, canCreate: true, currency: 'eur', maxBuilds: 50, checkout: false, termsUrl: null, supportUrl: null })
    expect(saleActive(b)).toBe(false)
    expect(toBilling({ enabled: true, unlimited: false, nextPlan: 'free', supportUrl: 'javascript:alert(1)', termsUrl: 'https://reflect-fivem.com/cgv' })).toMatchObject({
      nextPlan: 'free',
      supportUrl: null,
      termsUrl: 'https://reflect-fivem.com/cgv'
    })
  })

  it('achat : statut inconnu lu comme échoué, identifiant obligatoire', () => {
    expect(toPurchase({ id: PURCHASE, product: 'unlock', buildId: BUILD, status: 'bizarre', amount: 400 })).toMatchObject({ product: 'unlock', buildId: BUILD, status: 'failed', amount: 400 })
    expect(() => toPurchase({ id: 'pas-un-uuid', status: 'paid' })).toThrow()
  })
})

describe('appels de la vente', () => {
  it('prix et commande : produit connu, code promo nettoyé, cases transmises', async () => {
    const s = setup({
      'POST /builder/billing/quote': { product: 'pack', currency: 'eur', baseAmount: 400, discount: 200, amount: 200, promo: { code: 'MOITIE', percentOff: 50 } },
      'POST /builder/billing/checkout': { id: PURCHASE, product: 'pack', status: 'pending', checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1', expiresAt: '2026-10-21T12:00:00Z' }
    })
    expect(await s.builder.quote({ product: 'pack', promoCode: '  MOITIE ' })).toMatchObject({ amount: 200, discount: 200, promo: { code: 'MOITIE', percentOff: 50, amountOff: null } })
    expect(s.call).toHaveBeenLastCalledWith('POST', '/builder/billing/quote', { json: { product: 'pack', buildId: null, promoCode: 'MOITIE' }, auth: 'required' })
    const p = await s.builder.checkout({ product: 'unlock', buildId: BUILD, promoCode: '', acceptTerms: true, waiveWithdrawal: true })
    expect(p).toMatchObject({ id: PURCHASE, status: 'pending', checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1' })
    expect(s.call).toHaveBeenLastCalledWith('POST', '/builder/billing/checkout', {
      json: { product: 'unlock', buildId: BUILD, promoCode: null, acceptTerms: true, waiveWithdrawal: true },
      auth: 'required'
    })
  })

  it('suivi, abandon, historique et déblocage avec un crédit', async () => {
    const s = setup({
      [`GET /builder/billing/purchases/${PURCHASE}`]: { id: PURCHASE, product: 'pack', status: 'paid' },
      [`POST /builder/billing/purchases/${PURCHASE}/cancel`]: { id: PURCHASE, product: 'pack', status: 'canceled' },
      'GET /builder/billing/purchases': [{ id: PURCHASE, status: 'free', promoCode: 'OFFERT' }, { id: 'illisible' }],
      [`POST /builder/builds/${BUILD}/unlock`]: { id: BUILD, name: 'Mon pack', components: [], tools: {}, plan: { type: 'credit', unlimited: true } }
    })
    expect((await s.builder.purchase(PURCHASE)).status).toBe('paid')
    expect((await s.builder.cancelPurchase(PURCHASE)).status).toBe('canceled')
    expect((await s.builder.purchases()).map((p) => [p.status, p.promoCode])).toEqual([['free', 'OFFERT']])
    expect((await s.builder.unlockBuild(BUILD)).plan).toMatchObject({ type: 'credit', unlimited: true, locked: false })
    // Identifiant invalide : rien n'est demandé.
    s.call.mockClear()
    await expect(s.builder.purchase('../admin')).rejects.toThrow()
    expect(s.call).not.toHaveBeenCalled()
  })

  it('refus 402 transmis à l’interface avec leur code', async () => {
    const s = setup({
      'POST /builder/builds': new ApiError('Il te faut un pack de plus.', 402, BUILDER_PAYMENT_REQUIRED),
      [`PUT /builder/builds/${BUILD}`]: new ApiError('Ce pack gratuit a déjà été modifié.', 402, BUILDER_EDIT_LOCKED)
    })
    const input = { name: 'Mon pack', components: [], tools: {} as never }
    await expect(s.builder.save(null, input)).rejects.toMatchObject({ status: 402, code: BUILDER_PAYMENT_REQUIRED })
    await expect(s.builder.save(BUILD, input)).rejects.toMatchObject({ status: 402, code: BUILDER_EDIT_LOCKED })
    expect(readApiError(tagApiError('Refusé.', 402, BUILDER_EDIT_LOCKED))).toEqual({ message: 'Refusé.', status: 402, code: BUILDER_EDIT_LOCKED })
  })
})

describe('badge et bandeaux selon la formule', () => {
  it('badge de chaque création', () => {
    const b = billing()
    expect(planBadge(plan(), b)).toEqual({ kind: 'free', editsLeft: 1 })
    expect(planBadge(plan({ editsUsed: 1, editsLeft: 0, locked: true }), b)).toEqual({ kind: 'locked' })
    expect(planBadge(plan({ type: 'credit', unlimited: true, editsLeft: null }), b)).toEqual({ kind: 'unlimited' })
    expect(planBadge(plan({ type: 'open', unlimited: true, editsLeft: null }), b)).toEqual({ kind: 'open' })
  })

  it('admin ou vente coupée : ni badge, ni bandeau, ni offre', () => {
    for (const b of [billing({ unlimited: true }), billing({ enabled: false, unlimited: true }), null]) {
      expect(planBadge(plan({ locked: true }), b)).toBeNull()
      expect(planBanner(plan({ locked: true }), b)).toBeNull()
      expect(needsPack(b)).toBe(false)
      expect(deleteNote(plan(), b)).toBeNull()
    }
  })

  it('bandeau de l’assistant : modification restante, ou à débloquer (avec les crédits libres)', () => {
    expect(planBanner(plan(), billing())).toEqual({ kind: 'edit', editsLeft: 1 })
    expect(planBanner(plan({ locked: true, editsLeft: 0 }), billing({ credits: { total: 2, used: 1, available: 1 } }))).toEqual({ kind: 'locked', credits: 1 })
    expect(planBanner(plan({ type: 'credit', unlimited: true, editsLeft: null }), billing())).toBeNull()
    // Nouvelle création : pas encore de formule.
    expect(planBanner(null, billing())).toBeNull()
  })

  it('un pack de plus à acheter seulement sans pack libre, et pas au maximum de créations', () => {
    expect(needsPack(billing())).toBe(true)
    expect(needsPack(billing({ canCreate: true, nextPlan: 'credit' }))).toBe(false)
    expect(needsPack(billing({ builds: 50 }))).toBe(false)
  })

  it('confirmation de suppression : pack gratuit pas rendu, crédit de nouveau libre', () => {
    expect(deleteNote(plan(), billing())).toBe('free')
    expect(deleteNote(plan({ type: 'credit', unlimited: true }), billing())).toBe('credit')
    expect(deleteNote(plan({ type: 'open', unlimited: true }), billing())).toBeNull()
  })

  it('prix formaté dans la langue affichée, à partir des centimes', async () => {
    expect(formatPrice(400, 'eur')).toMatch(/^4,00\s€$/u)
    await i18next.changeLanguage('en')
    try {
      expect(formatPrice(1250, 'eur')).toBe('€12.50')
    } finally {
      await i18next.changeLanguage('fr')
    }
  })
})

describe('page de paiement', () => {
  it('seulement checkout.stripe.com en production', () => {
    expect(isCheckoutUrl('https://checkout.stripe.com/c/pay/cs_live_a1#fid', false)).toBe(true)
    for (const url of [
      'http://checkout.stripe.com/c/pay/cs_live_a1',
      'https://checkout.stripe.com.evil.test/c/pay',
      'https://evilcheckout.stripe.com/c/pay',
      'https://checkout.stripe.com@evil.test/c/pay',
      'https://user:pass@checkout.stripe.com/c/pay',
      'https://checkout.stripe.com:8443/c/pay',
      'https://reflect-fivem.com/paiement',
      'javascript:alert(1)',
      'file:///C:/Windows/System32/cmd.exe',
      'pas une adresse',
      null
    ])
      expect(isCheckoutUrl(url, false), String(url)).toBe(false)
  })

  it('en développement, une autre adresse https aussi (jamais http)', () => {
    expect(isCheckoutUrl('https://paiement.test/session/1', true)).toBe(true)
    expect(isCheckoutUrl('http://localhost:5173/paiement', true)).toBe(false)
    expect(isCheckoutUrl('https://user@paiement.test/', true)).toBe(false)
  })
})

describe('attente d’un paiement', () => {
  const now = Date.parse('2026-10-21T12:00:00Z')
  const outcomes: Record<PurchaseStatus, string> = {
    pending: 'waiting',
    paid: 'success',
    free: 'success',
    expired: 'failure',
    failed: 'failure',
    canceled: 'failure',
    refunded: 'failure'
  }

  it('finit sur chaque statut', () => {
    for (const [status, outcome] of Object.entries(outcomes)) expect(purchaseOutcome({ status: status as PurchaseStatus, expiresAt: '2026-10-21T13:00:00Z' }, now), status).toBe(outcome)
    expect(failureOf({ status: 'canceled' })).toBe('canceled')
    expect(failureOf({ status: 'failed' })).toBe('failed')
    expect(failureOf({ status: 'refunded' })).toBe('refunded')
    expect(failureOf({ status: 'expired' })).toBe('expired')
  })

  it('finit à l’expiration de la page de paiement', () => {
    expect(purchaseOutcome({ status: 'pending', expiresAt: '2026-10-21T11:59:59Z' }, now)).toBe('failure')
    expect(failureOf({ status: 'pending' })).toBe('expired')
    // Sans date d'expiration : l'API dira quand c'est fini.
    expect(purchaseOutcome({ status: 'pending', expiresAt: null }, now)).toBe('waiting')
  })
})

describe('bouton « Payer »', () => {
  const ready = { acceptTerms: true, waiveWithdrawal: true, busy: false, checkout: true, amount: 400 }

  it('inactif tant que les deux cases ne sont pas cochées', () => {
    expect(canPay(ready)).toBe(true)
    expect(canPay({ ...ready, acceptTerms: false })).toBe(false)
    expect(canPay({ ...ready, waiveWithdrawal: false })).toBe(false)
    expect(canPay({ ...ready, acceptTerms: false, waiveWithdrawal: false })).toBe(false)
  })

  it('inactif pendant une requête, sans prix connu, ou sans paiement possible (sauf achat offert par un code)', () => {
    expect(canPay({ ...ready, busy: true })).toBe(false)
    expect(canPay({ ...ready, amount: null })).toBe(false)
    expect(canPay({ ...ready, checkout: false })).toBe(false)
    expect(canPay({ ...ready, checkout: false, amount: 0 })).toBe(true)
    expect(canPay({ ...ready, checkout: false, amount: 0, acceptTerms: false })).toBe(false)
  })
})

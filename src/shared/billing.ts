// Vente de « Créer ton pack » : règles de l'interface (fonctions pures, testées). Le serveur applique les règles
// (packs gratuits, crédits, déblocage) ; ici, ce qu'il faut montrer : badge de chaque création, bandeau de l'assistant,
// achat à proposer avant d'enregistrer, bouton « Payer », fin de l'attente d'un paiement, adresse de paiement acceptée.
// Pour l'admin, ou quand la vente est coupée, tout est illimité : aucune offre n'apparaît.

import { formatNumber } from './intl'
import type { AccountBilling, BuildPlan, Purchase } from './types'

/** Vente active pour ce compte : offres, badges et bandeaux à montrer (null : état inconnu, rien n'est montré). */
export function saleActive(billing: AccountBilling | null | undefined): billing is AccountBilling {
  return !!billing && billing.enabled && !billing.unlimited
}

/**
 * Paiements de test (API de dev, clés Stripe de test) : badge « Mode test » sur « Mon offre » et dans la fenêtre
 * d'achat, avec la carte de test à utiliser. Rien de tout cela pour des paiements réels.
 */
export function isTestMode(billing: AccountBilling | null | undefined): boolean {
  return !!billing && billing.testMode === true
}

/** Prix en centimes dans la langue affichée (« 4,00 € », « €4.00 »). */
export function formatPrice(cents: number, currency: string): string {
  const code = (currency || 'eur').toUpperCase()
  try {
    return formatNumber(cents / 100, { style: 'currency', currency: code })
  } catch {
    // Monnaie inconnue d'Intl.
    return `${formatNumber(cents / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${code}`
  }
}

/** Badge d'une création : pack gratuit (modifications restantes, ou à débloquer), illimité, ou offert. */
export type PlanBadge = { kind: 'free'; editsLeft: number } | { kind: 'locked' } | { kind: 'unlimited' } | { kind: 'open' }

export function planBadge(plan: BuildPlan, billing: AccountBilling | null | undefined): PlanBadge | null {
  if (!saleActive(billing)) return null
  if (plan.type === 'free' && !plan.unlimited) return plan.locked ? { kind: 'locked' } : { kind: 'free', editsLeft: plan.editsLeft ?? 0 }
  return plan.type === 'open' ? { kind: 'open' } : { kind: 'unlimited' }
}

/**
 * Bandeau de l'assistant sur un pack gratuit : la modification qu'il lui reste sera utilisée à l'enregistrement, ou il
 * est à débloquer (avec un crédit libre, s'il y en a, ou en achetant son déblocage).
 */
export type PlanBanner = { kind: 'edit'; editsLeft: number } | { kind: 'locked'; credits: number }

export function planBanner(plan: BuildPlan | null, billing: AccountBilling | null | undefined): PlanBanner | null {
  if (!plan || !saleActive(billing) || plan.type !== 'free' || plan.unlimited) return null
  return plan.locked ? { kind: 'locked', credits: billing.credits.available } : { kind: 'edit', editsLeft: plan.editsLeft ?? 0 }
}

/**
 * Nouvelle création impossible sans achat : ni crédit libre ni pack gratuit. Au maximum de créations, acheter n'y
 * change rien (il faut en supprimer une) : pas d'achat proposé.
 */
export function needsPack(billing: AccountBilling | null | undefined): boolean {
  return saleActive(billing) && !billing.canCreate && billing.nextPlan === null && billing.builds < billing.maxBuilds
}

/** Ce que précise la confirmation de suppression : pack gratuit pas rendu, ou crédit de nouveau libre. */
export function deleteNote(plan: BuildPlan, billing: AccountBilling | null | undefined): 'free' | 'credit' | null {
  if (!saleActive(billing)) return null
  return plan.type === 'free' ? 'free' : plan.type === 'credit' ? 'credit' : null
}

/**
 * « Payer » : les deux cases cochées (CGV, renonciation au droit de rétractation), rien en cours, et le paiement possible
 * (un achat offert par un code ne passe pas par Stripe).
 */
export function canPay(s: { acceptTerms: boolean; waiveWithdrawal: boolean; busy: boolean; checkout: boolean; amount: number | null }): boolean {
  return s.acceptTerms && s.waiveWithdrawal && !s.busy && s.amount !== null && (s.checkout || s.amount === 0)
}

/** Fin de l'attente d'un paiement : réussi (payé, offert), échoué (expiré, annulé, refusé, remboursé), ou toujours en cours. */
export type PurchaseOutcome = 'success' | 'failure' | 'waiting'

/** Un paiement en cours dont la page a expiré (`expiresAt` passé) est fini : échoué. */
export function purchaseOutcome(p: Pick<Purchase, 'status' | 'expiresAt'>, now = Date.now()): PurchaseOutcome {
  if (p.status === 'paid' || p.status === 'free') return 'success'
  if (p.status !== 'pending') return 'failure'
  const end = p.expiresAt ? Date.parse(p.expiresAt) : NaN
  return Number.isFinite(end) && now >= end ? 'failure' : 'waiting'
}

/** Raison de l'échec à afficher : un paiement en cours dont la page a expiré compte comme expiré. */
export function failureOf(p: Pick<Purchase, 'status'>): 'expired' | 'canceled' | 'failed' | 'refunded' {
  return p.status === 'canceled' || p.status === 'failed' || p.status === 'refunded' ? p.status : 'expired'
}

/**
 * Page de paiement à ouvrir dans le navigateur : https://checkout.stripe.com/… seulement (ni identifiant, ni port, ni
 * autre hôte). En développement (`dev`), une autre adresse https est acceptée (page de paiement de test).
 */
export function isCheckoutUrl(url: unknown, dev: boolean): url is string {
  if (typeof url !== 'string' || url.length > 4096) return false
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false
  return u.hostname === 'checkout.stripe.com' || dev
}

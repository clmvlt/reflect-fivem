// Vente de « Créer ton pack » côté interface : « Mon offre » (accueil), badge de la formule de chaque création, bandeau
// d'un pack gratuit dans l'assistant, et achat proposé quand l'enregistrement le demande. La fenêtre d'achat, l'attente
// du paiement et l'historique sont communs à tous les achats (voir Purchase.tsx). Règles : @shared/billing.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AccountBilling, BuildPlan } from '@shared/types'
import { BUILDER_EDIT_LOCKED, BUILDER_PAYMENT_REQUIRED } from '@shared/api'
import { formatPrice, isTestMode, planBadge, planBanner, saleActive } from '@shared/billing'
import { apiError, useStore } from '../store'
import { num, q } from '../lib/format'
import { notifyBilling, onBillingChanged, PurchaseHistory, purchaseDialog, TestBadge, type PurchaseRequest } from './Purchase'

// ---------------------------------------------------------------------------
// État de la vente

/**
 * État de la vente pour le compte, relu après un achat (et par `reload`). null tant qu'il n'est pas lu, ou si l'API ne
 * le donne pas (ancienne API, hors ligne) : aucune offre n'est montrée, et un refus 402 ouvre quand même l'achat.
 */
export function useBilling(): { billing: AccountBilling | null; reload: () => void } {
  const [billing, setBilling] = useState<AccountBilling | null>(null)
  const [attempt, setAttempt] = useState(0)
  const reload = useCallback(() => setAttempt((a) => a + 1), [])
  useEffect(() => onBillingChanged(reload), [reload])
  useEffect(() => {
    let live = true
    // Erreur : le dernier état connu reste.
    window.api.builderBilling().then(
      (b) => live && setBilling(b),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [attempt])
  return { billing, reload }
}

// ---------------------------------------------------------------------------
// Accueil, cartes, assistant

/** « Mon offre » : packs gratuits restants, crédits libres, achat d'un pack et historique. Caché sans vente. */
export function OfferPanel({ billing }: { billing: AccountBilling | null }) {
  const { t } = useTranslation()
  const [history, setHistory] = useState(false)
  if (!saleActive(billing)) return null
  const unavailable = t('builder.billing.offer.unavailable')
  return (
    <section className="builder-offer" aria-label={t('builder.billing.offer.title')}>
      <div className="builder-offer-text">
        <span className="builder-offer-title">
          {t('builder.billing.offer.title')}
          {isTestMode(billing) && <TestBadge />}
        </span>
        <span className="muted small" title={t('builder.billing.offer.creditsTitle')}>
          {t('builder.billing.offer.free', { count: billing.free.remaining, n: num(billing.free.remaining) })} ·{' '}
          {t('builder.billing.offer.credits', { count: billing.credits.available, n: num(billing.credits.available) })}
        </span>
      </div>
      <div className="spacer" />
      <button className="link" onClick={() => setHistory(true)}>
        {t('builder.billing.offer.history')}
      </button>
      <button onClick={() => void purchaseDialog({ product: 'pack' })} disabled={!billing.checkout} title={billing.checkout ? undefined : unavailable}>
        {t('builder.billing.offer.buy', { price: formatPrice(billing.prices.pack, billing.currency) })}
      </button>
      {!billing.checkout && <p className="hint builder-offer-note">{unavailable}</p>}
      {history && <PurchaseHistory onClose={() => setHistory(false)} />}
    </section>
  )
}

/** Formule d'une création : « Gratuit — 1 modification restante », « Gratuit — à débloquer », « Illimité », « Offert ». */
export function PlanBadge({ plan, billing }: { plan: BuildPlan; billing: AccountBilling | null }) {
  const { t } = useTranslation()
  const badge = planBadge(plan, billing)
  if (!badge) return null
  const text =
    badge.kind === 'free'
      ? t('builder.billing.plan.free', { count: badge.editsLeft, n: num(badge.editsLeft) })
      : badge.kind === 'locked'
        ? t('builder.billing.plan.locked')
        : badge.kind === 'open'
          ? t('builder.billing.plan.open')
          : t('builder.billing.plan.unlimited')
  return <span className={`badge plan-badge is-${badge.kind}`}>{text}</span>
}

/**
 * Bandeau de l'assistant sur un pack gratuit : sa modification sera utilisée à l'enregistrement, ou il est à débloquer
 * (avec un crédit libre, ou en achetant son déblocage). Renommer reste permis. `onChanged` : formule à relire.
 */
export function PlanBanner({
  plan,
  billing,
  build,
  onChanged
}: {
  plan: BuildPlan | null
  billing: AccountBilling | null
  build: { id: string; name: string } | null
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const { run, setMessage } = useStore()
  const [busy, setBusy] = useState(false)
  const banner = planBanner(plan, billing)
  if (!banner || !build || !billing) return null
  if (banner.kind === 'edit')
    return (
      <div className="bar builder-plan-bar">
        <span className="bar-text">{t('builder.billing.plan.edit', { count: banner.editsLeft, n: num(banner.editsLeft) })}</span>
      </div>
    )
  const spendCredit = async (): Promise<void> => {
    setBusy(true)
    const b = await run(() => window.api.builderUnlockBuild(build.id))
    setBusy(false)
    if (!b) return
    notifyBilling()
    onChanged()
    setMessage({ kind: 'info', text: t('builder.billing.dialog.unlocked', { name: q(b.name) }) })
  }
  const buy = async (): Promise<void> => {
    if (await purchaseDialog({ product: 'unlock', build })) onChanged()
  }
  return (
    <div className="bar bar-warning builder-plan-bar">
      <span className="bar-text">{t('builder.billing.plan.lockedText')}</span>
      {banner.credits > 0 && (
        <button onClick={() => void spendCredit()} disabled={busy}>
          {t('builder.billing.plan.useCredit')}
        </button>
      )}
      <button onClick={() => void buy()} disabled={busy || !billing.checkout} title={billing.checkout ? undefined : t('builder.billing.offer.unavailable')}>
        {t('builder.billing.plan.unlock', { price: formatPrice(billing.prices.unlock, billing.currency) })}
      </button>
    </div>
  )
}

/** Achat qui peut débloquer une action : un pack de plus (nouvelle création), ou le déblocage d'un pack gratuit. */
export type PurchaseNeed = 'pack' | 'unlock'

/**
 * Enregistrement qui peut demander un achat : sans pack libre pour une nouvelle création, ou sur un pack gratuit qui n'a
 * plus de modification, la fenêtre d'achat s'ouvre au lieu d'une erreur. `need` : achat déjà connu comme nécessaire
 * (vérifié avant) ; un refus 402 de l'API l'ouvre aussi (et l'état de la vente est relu). Une fois l'achat fait,
 * l'action reprend (`paid` d'abord, pour relire ce qui a changé) ; fenêtre fermée : undefined. Les autres erreurs sont
 * levées.
 */
export async function withPurchase<T>(
  action: () => Promise<T>,
  opts: { need: PurchaseNeed | null; request: (need: PurchaseNeed) => PurchaseRequest; paid?: (need: PurchaseNeed) => Promise<void> }
): Promise<T | undefined> {
  let need = opts.need
  for (;;) {
    if (need) {
      if (!(await purchaseDialog(opts.request(need)))) return undefined
      await opts.paid?.(need)
    }
    try {
      return await action()
    } catch (e) {
      const code = apiError(e).code
      if (code === BUILDER_PAYMENT_REQUIRED) need = 'pack'
      else if (code === BUILDER_EDIT_LOCKED) need = 'unlock'
      else throw e
      notifyBilling()
    }
  }
}

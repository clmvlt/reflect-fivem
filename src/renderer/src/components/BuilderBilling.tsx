// Vente de « Créer ton pack » côté interface : « Mon offre » (accueil), badge de la formule de chaque création, bandeau
// d'un pack gratuit dans l'assistant, fenêtre d'achat (un pack de plus, ou le déblocage d'un pack gratuit) avec l'attente
// du paiement, et historique des achats. Le paiement se fait sur une page Stripe Checkout ouverte dans le navigateur :
// l'application n'en voit que l'état, relu toutes les 3 s, quand la fenêtre reprend le focus et sur le lien
// « fivem-pack-manager://achat/<id> » de la page de fin de paiement du site. Règles : @shared/billing.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { AccountBilling, BillingProduct, BuildPlan, Purchase, Quote } from '@shared/types'
import { BUILDER_EDIT_LOCKED, BUILDER_PAYMENT_REQUIRED } from '@shared/api'
import { canPay, failureOf, formatPrice, isTestMode, planBadge, planBanner, purchaseOutcome, saleActive } from '@shared/billing'
import { formatDateTime } from '@shared/intl'
import { apiError, cleanError, useStore } from '../store'
import { fullDate, num, q } from '../lib/format'
import { Modal } from './Modal'

// ---------------------------------------------------------------------------
// État de la vente

const billingListeners = new Set<() => void>()

/** Achat fini, pack débloqué, refus 402 : l'état de la vente et les créations sont relus là où ils sont affichés. */
export function notifyBilling(): void {
  for (const cb of billingListeners) cb()
}

export function onBillingChanged(cb: () => void): () => void {
  billingListeners.add(cb)
  return () => {
    billingListeners.delete(cb)
  }
}

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

/** « Mode test » : paiements de test de l'API de dev (clés Stripe de test, rien n'est débité). */
function TestBadge() {
  const { t } = useTranslation()
  return <span className="badge test-badge">{t('builder.billing.test.badge')}</span>
}

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

// ---------------------------------------------------------------------------
// Historique

function purchaseLabel(t: TFunction, p: Purchase): string {
  return p.product === 'unlock' ? t('builder.billing.history.unlock', { name: q(p.buildName || t('builder.untitled')) }) : t('builder.billing.history.pack')
}

/** Achats du compte, le plus récent d'abord ; un paiement en cours se reprend (sa page se rouvre). */
function PurchaseHistory({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const { run } = useStore()
  const [items, setItems] = useState<Purchase[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    window.api.builderPurchases().then(
      (list) => live && setItems(list),
      (e) => live && setError(cleanError(e))
    )
    return () => {
      live = false
    }
  }, [])
  const resume = (p: Purchase): void => {
    onClose()
    if (p.checkoutUrl) void run(() => window.api.builderOpenCheckout(p.checkoutUrl!))
    void purchaseDialog({ product: p.product, build: p.buildId ? { id: p.buildId, name: p.buildName ?? '' } : null, resume: p })
  }
  return (
    <Modal
      title={t('builder.billing.history.title')}
      onClose={onClose}
      className="purchase-history"
      actions={
        <button data-autofocus onClick={onClose}>
          {t('common.close')}
        </button>
      }
    >
      {error ? (
        <p className="warn-text">{error}</p>
      ) : !items ? (
        <p className="muted loading">{t('common.loading')}</p>
      ) : !items.length ? (
        <p className="muted">{t('builder.billing.history.empty')}</p>
      ) : (
        <ul className="list compact">
          {items.map((p) => {
            const waiting = purchaseOutcome(p) === 'waiting'
            // Paiement en cours dont la page a expiré (pas encore relu par l'API) : expiré.
            const status = p.status === 'pending' && !waiting ? 'expired' : p.status
            const facts = [fullDate(p.createdAt), formatPrice(p.amount, p.currency), p.promoCode ? t('builder.billing.history.code', { code: p.promoCode }) : '']
            return (
              <li key={p.id} className="row">
                <div className="row-main">
                  <div className="name">{purchaseLabel(t, p)}</div>
                  <div className="meta">{facts.filter(Boolean).join(' · ')}</div>
                </div>
                <span className={`purchase-status is-${status}`}>{t(`builder.billing.history.status.${status}`)}</span>
                {waiting && <button onClick={() => resume(p)}>{t('builder.billing.history.resume')}</button>}
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Fenêtre d'achat

export interface PurchaseRequest {
  product: BillingProduct
  /** Pack gratuit à débloquer (achat « unlock »). */
  build?: { id: string; name: string } | null
  /** Ouverte à la place d'un refus (nouvelle création sans pack libre, pack gratuit déjà modifié) : la raison en tête. */
  blocked?: boolean
  /** Paiement déjà commencé (historique, lien du site) : la fenêtre attend sa fin. */
  resume?: Purchase
}

interface Shown extends PurchaseRequest {
  key: number
  resolve: (done: boolean) => void
}

/** Fenêtre affichée par PurchaseHost (null tant qu'il n'est pas monté). */
let show: ((r: Shown) => void) | null = null
let nextKey = 0
/** Achats dont une fenêtre attend la fin du paiement : un lien du site pour l'un d'eux est relu par elle. */
const awaited = new Set<string>()

/**
 * Ouvre la fenêtre d'achat. true une fois l'achat fait (payé, offert par un code, ou pack débloqué avec un crédit) :
 * l'action en attente peut reprendre ; false si la fenêtre est fermée avant.
 */
export function purchaseDialog(request: PurchaseRequest): Promise<boolean> {
  const open = show
  if (!open) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => open({ ...request, key: ++nextKey, resolve }))
}

/** Affiche les fenêtres d'achat, une à la fois. Monté une seule fois, dans App : l'attente d'un paiement survit à la page. */
export function PurchaseHost() {
  const [queue, setQueue] = useState<Shown[]>([])
  useEffect(() => {
    show = (r) => setQueue((list) => [...list, r])
    return () => {
      show = null
    }
  }, [])
  const current = queue[0]
  if (!current) return null
  const close = (done: boolean): void => {
    current.resolve(done)
    // Double clic : la fenêtre suivante n'est pas retirée avec celle-ci.
    setQueue((list) => (list[0]?.key === current.key ? list.slice(1) : list))
  }
  return <PurchaseDialog key={current.key} request={current} onClose={close} />
}

/** Code de refus d'un code promo (422) → texte de l'application. */
const PROMO_ERRORS: Record<string, 'invalid' | 'notStarted' | 'expired' | 'notApplicable' | 'exhausted' | 'alreadyUsed'> = {
  'promo-invalid': 'invalid',
  'promo-not-started': 'notStarted',
  'promo-expired': 'expired',
  'promo-not-applicable': 'notApplicable',
  'promo-exhausted': 'exhausted',
  'promo-already-used': 'alreadyUsed'
}

/** Achat réussi : « Paiement reçu, merci ! » (ou « Offert par le code … ») et ce qu'il donne. */
function doneText(t: TFunction, p: Purchase): string {
  const what = p.product === 'unlock' ? t('builder.billing.dialog.unlocked', { name: q(p.buildName || t('builder.untitled')) }) : t('builder.billing.dialog.gotPack')
  return `${p.status === 'free' ? t('builder.billing.dialog.freeBy', { code: p.promoCode ?? '' }) : t('builder.billing.dialog.paid')} ${what}`
}

type Phase = { kind: 'form' } | { kind: 'waiting'; purchase: Purchase } | { kind: 'done'; text: string }

/**
 * Ce qu'on achète, le prix (barré avec un code promo), le code promo, les deux cases obligatoires (CGV, accès immédiat
 * et renonciation au droit de rétractation), puis « Payer » : la page Stripe s'ouvre dans le navigateur et la fenêtre
 * attend la fin du paiement (« Rouvrir la page de paiement », « Annuler »). Achat fait : message, puis « Continuer ».
 */
function PurchaseDialog({ request, onClose }: { request: PurchaseRequest; onClose: (done: boolean) => void }) {
  const { t } = useTranslation()
  const { product, resume } = request
  const buildId = request.build?.id ?? resume?.buildId ?? null
  const name = q(request.build?.name || resume?.buildName || t('builder.untitled'))
  const [billing, setBilling] = useState<AccountBilling | null>(null)
  const [phase, setPhase] = useState<Phase>(() => (resume ? { kind: 'waiting', purchase: resume } : { kind: 'form' }))
  const [promo, setPromo] = useState('')
  const [quote, setQuote] = useState<Quote | null>(null)
  const [promoError, setPromoError] = useState<string | null>(null)
  const [acceptTerms, setAcceptTerms] = useState(false)
  const [waiveWithdrawal, setWaiveWithdrawal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  // Dernier état connu de l'achat attendu : son expiration met fin à l'attente, même sans réseau.
  const known = useRef<Purchase | null>(resume ?? null)

  useEffect(() => {
    let live = true
    window.api.builderBilling().then(
      (b) => live && setBilling(b),
      (e) => live && setNote({ kind: 'error', text: cleanError(e) })
    )
    return () => {
      live = false
    }
  }, [])

  /** Achat reçu (commande, relecture, abandon) : réussi, échoué (retour au formulaire avec la raison), ou à payer. */
  const settle = (p: Purchase): void => {
    known.current = p
    const outcome = purchaseOutcome(p)
    if (outcome === 'waiting') {
      setPhase({ kind: 'waiting', purchase: p })
    } else if (outcome === 'success') {
      notifyBilling()
      setPhase({ kind: 'done', text: doneText(t, p) })
    } else {
      setPhase({ kind: 'form' })
      setNote({ kind: 'info', text: t(`builder.billing.dialog.ended.${failureOf(p)}`) })
    }
  }
  const settleRef = useRef(settle)
  settleRef.current = settle

  // Attente du paiement : relu toutes les 3 s, au retour du focus et sur le lien du site, jusqu'à la fin ou l'expiration.
  const waitingId = phase.kind === 'waiting' ? phase.purchase.id : null
  useEffect(() => {
    if (!waitingId) return
    awaited.add(waitingId)
    let live = true
    let checking = false
    const check = async (): Promise<void> => {
      if (checking) return
      checking = true
      try {
        const p = await window.api.builderPurchase(waitingId)
        if (live) settleRef.current(p)
      } catch {
        // Réseau coupé : nouvel essai au prochain tour, sauf si la page a expiré.
        const last = known.current
        if (live && last && purchaseOutcome(last) === 'failure') settleRef.current(last)
      } finally {
        checking = false
      }
    }
    void check()
    const timer = window.setInterval(() => void check(), 3000)
    const onFocus = (): void => void check()
    window.addEventListener('focus', onFocus)
    const offLink = window.api.onOpenPurchase((id) => {
      if (id === waitingId) void check()
    })
    return () => {
      live = false
      awaited.delete(waitingId)
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      offLink()
    }
  }, [waitingId])

  const openLink = (url: string | null): void => {
    if (url) window.api.openLink(url).catch((e: unknown) => setNote({ kind: 'error', text: cleanError(e) }))
  }
  const openPage = async (url: string | null): Promise<void> => {
    try {
      if (!url) throw new Error(t('builder.errors.badCheckoutUrl'))
      await window.api.builderOpenCheckout(url)
    } catch (e) {
      setNote({ kind: 'error', text: cleanError(e) })
    }
  }

  const promoText = (e: unknown): string => {
    const { code, message } = apiError(e)
    const key = code ? PROMO_ERRORS[code] : undefined
    return key ? t(`builder.billing.dialog.promoErrors.${key}`) : message
  }
  const apply = async (): Promise<void> => {
    const code = promo.trim()
    setPromoError(null)
    if (!code) return setQuote(null)
    setBusy(true)
    try {
      setQuote(await window.api.builderQuote({ product, buildId, promoCode: code }))
    } catch (e) {
      setQuote(null)
      setPromoError(promoText(e))
    } finally {
      setBusy(false)
    }
  }

  const pay = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const p = await window.api.builderCheckout({ product, buildId, promoCode: promo.trim() || null, acceptTerms, waiveWithdrawal })
      if (p.status === 'pending') {
        try {
          if (!p.checkoutUrl) throw new Error(t('builder.errors.badCheckoutUrl'))
          await window.api.builderOpenCheckout(p.checkoutUrl)
        } catch (e) {
          // Page refusée (adresse inattendue) : le paiement est abandonné.
          void window.api.builderCancelPurchase(p.id).catch(() => undefined)
          throw e
        }
      }
      settle(p)
    } catch (e) {
      const { code, message } = apiError(e)
      if (code && PROMO_ERRORS[code]) setPromoError(promoText(e))
      else setNote({ kind: 'error', text: code === 'payments-unavailable' ? t('builder.billing.offer.unavailable') : message })
      // Vente coupée, pack déjà illimité : l'état du compte a changé.
      if (code === 'billing-disabled' || code === 'already-unlimited') notifyBilling()
    } finally {
      setBusy(false)
    }
  }

  /** Déblocage avec un crédit libre, sans payer. */
  const spendCredit = async (): Promise<void> => {
    if (!buildId) return
    setBusy(true)
    setNote(null)
    try {
      const b = await window.api.builderUnlockBuild(buildId)
      notifyBilling()
      setPhase({ kind: 'done', text: t('builder.billing.dialog.unlocked', { name: q(b.name) }) })
    } catch (e) {
      setNote({ kind: 'error', text: cleanError(e) })
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (p: Purchase): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.builderCancelPurchase(p.id)
      // Déjà payé : l'achat est acquis. Sinon, retour au formulaire.
      settle(purchaseOutcome(r) === 'waiting' ? { ...r, status: 'canceled' } : r)
    } catch (e) {
      setPhase({ kind: 'form' })
      setNote({ kind: 'error', text: cleanError(e) })
    } finally {
      setBusy(false)
    }
  }

  const title = product === 'unlock' ? t('builder.billing.dialog.unlockTitle', { name }) : t('builder.billing.dialog.packTitle')
  const notice = note && (
    <div className={`bar ${note.kind === 'error' ? 'bar-error' : ''} purchase-note`}>
      <span className="bar-text">{note.text}</span>
    </div>
  )
  // Paiement de test : la carte de test à saisir sur la page Stripe (copiable).
  const test = isTestMode(billing) && (
    <div className="purchase-test">
      <TestBadge />
      <span className="hint">{t('builder.billing.test.card')}</span>
    </div>
  )
  const support = billing?.supportUrl && (
    <p className="hint purchase-support">
      <Trans i18nKey="builder.billing.dialog.support" components={{ discord: <button className="link" onClick={() => openLink(billing.supportUrl)} /> }} />
    </p>
  )

  if (phase.kind === 'done')
    return (
      <Modal
        title={title}
        onClose={() => onClose(true)}
        className="purchase-dialog"
        actions={
          <button className="primary" data-autofocus onClick={() => onClose(true)}>
            {t('builder.billing.dialog.continue')}
          </button>
        }
      >
        <p className="ok-text">{phase.text}</p>
      </Modal>
    )

  if (phase.kind === 'waiting') {
    const p = phase.purchase
    return (
      // Échap ne ferme pas : le paiement se poursuit dans le navigateur, « Annuler » l'abandonne.
      <Modal
        title={title}
        onClose={() => undefined}
        className="purchase-dialog"
        actions={
          <>
            <button className="primary" data-autofocus onClick={() => void openPage(p.checkoutUrl)} disabled={busy}>
              {t('builder.billing.dialog.reopen')}
            </button>
            <button onClick={() => void cancel(p)} disabled={busy}>
              {t('common.cancel')}
            </button>
          </>
        }
      >
        <p className="purchase-waiting loading">{t('builder.billing.dialog.waiting')}</p>
        <p className="hint">{t('builder.billing.dialog.waitingHint')}</p>
        {p.expiresAt && <p className="hint">{t('builder.billing.dialog.expiresAt', { time: formatDateTime(p.expiresAt, { timeStyle: 'short' }) })}</p>}
        {test}
        {notice}
        {support}
      </Modal>
    )
  }

  // Vente coupée ou compte illimité depuis l'ouverture : rien à payer, l'action peut reprendre.
  const nothing = !!billing && !saleActive(billing)
  const amount = quote ? quote.amount : billing ? billing.prices[product] : null
  const currency = quote?.currency ?? billing?.currency ?? 'eur'
  const payable = canPay({ acceptTerms, waiveWithdrawal, busy, checkout: !!billing?.checkout, amount })
  const terms = billing?.termsUrl ? (
    <button
      className="link"
      onClick={(e) => {
        // Le lien seul, sans cocher la case.
        e.preventDefault()
        openLink(billing.termsUrl)
      }}
    />
  ) : (
    <span />
  )
  return (
    <Modal
      title={title}
      onClose={() => onClose(nothing)}
      className="purchase-dialog"
      actions={
        nothing ? (
          <button className="primary" data-autofocus onClick={() => onClose(true)}>
            {t('builder.billing.dialog.continue')}
          </button>
        ) : (
          <>
            <button className="primary" onClick={() => void pay()} disabled={!payable}>
              {amount === 0 ? t('builder.billing.dialog.getFree') : t('builder.billing.dialog.pay', { price: amount === null ? '' : formatPrice(amount, currency) })}
            </button>
            <button onClick={() => onClose(false)} disabled={busy}>
              {t('common.cancel')}
            </button>
          </>
        )
      }
    >
      <div className="purchase-body">
        {request.blocked && !nothing && <p className="purchase-reason">{product === 'unlock' ? t('builder.billing.dialog.needUnlock') : t('builder.billing.dialog.needPack')}</p>}
        <p>{product === 'unlock' ? t('builder.billing.dialog.unlockText', { name }) : t('builder.billing.dialog.packText')}</p>
        {nothing ? (
          <p>{t('builder.billing.dialog.nothingToPay')}</p>
        ) : !billing ? (
          !note && <p className="muted loading">{t('common.loading')}</p>
        ) : (
          <>
            {product === 'unlock' && buildId && billing.credits.available > 0 && (
              <div className="purchase-credit">
                <span>{t('builder.billing.dialog.credit', { count: billing.credits.available, n: num(billing.credits.available) })}</span>
                <button onClick={() => void spendCredit()} disabled={busy}>
                  {t('builder.billing.plan.useCredit')}
                </button>
              </div>
            )}
            <div className="purchase-price" aria-label={t('builder.billing.dialog.price')}>
              {quote && quote.discount > 0 && <s className="muted">{formatPrice(quote.baseAmount, currency)}</s>}
              <span>{formatPrice(amount ?? 0, currency)}</span>
            </div>
            {quote?.promo && quote.discount > 0 && (
              <p className="ok-text small">{t('builder.billing.dialog.discount', { amount: formatPrice(quote.discount, currency), code: quote.promo.code })}</p>
            )}
            <div className="purchase-promo">
              <input
                className="input"
                value={promo}
                maxLength={32}
                placeholder={t('builder.billing.dialog.promo')}
                aria-label={t('builder.billing.dialog.promo')}
                onChange={(e) => {
                  // Code changé : le prix revient à celui sans code, jusqu'à « Appliquer ».
                  setPromo(e.target.value)
                  setQuote(null)
                  setPromoError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  void apply()
                }}
              />
              <button onClick={() => void apply()} disabled={busy || !promo.trim()}>
                {t('builder.billing.dialog.apply')}
              </button>
            </div>
            {promoError && <p className="warn-text small">{promoError}</p>}
            <div className="purchase-checks">
              <label className="check-line small">
                <input type="checkbox" checked={acceptTerms} onChange={(e) => setAcceptTerms(e.target.checked)} />
                <span>
                  <Trans i18nKey="builder.billing.dialog.terms" components={{ terms }} />
                </span>
              </label>
              <label className="check-line small">
                <input type="checkbox" checked={waiveWithdrawal} onChange={(e) => setWaiveWithdrawal(e.target.checked)} />
                <span>{t('builder.billing.dialog.withdrawal')}</span>
              </label>
            </div>
            {test}
            {!billing.checkout && amount !== 0 && <p className="hint">{t('builder.billing.offer.unavailable')}</p>}
          </>
        )}
        {notice}
        {support}
      </div>
    </Modal>
  )
}

/**
 * Lien « fivem-pack-manager://achat/<id> » de la page de fin de paiement du site (la fenêtre est déjà au premier plan).
 * Achat attendu par une fenêtre d'achat : relu par elle. Sinon il est relu ici : fini, son résultat s'affiche (`onPaid`
 * ouvre « Créer ton pack ») ; toujours en cours, la fenêtre d'achat attend sa fin.
 */
export function usePurchaseLinks(onPaid: () => void): void {
  const { t } = useTranslation()
  const { setMessage } = useStore()
  const paid = useRef(onPaid)
  paid.current = onPaid
  useEffect(
    () =>
      window.api.onOpenPurchase((id) => {
        if (awaited.has(id)) return
        window.api.builderPurchase(id).then(
          (p) => {
            const outcome = purchaseOutcome(p)
            if (outcome === 'waiting') void purchaseDialog({ product: p.product, build: p.buildId ? { id: p.buildId, name: p.buildName ?? '' } : null, resume: p })
            else if (outcome === 'failure') setMessage({ kind: 'info', text: t(`builder.billing.dialog.ended.${failureOf(p)}`) })
            else {
              notifyBilling()
              setMessage({ kind: 'info', text: doneText(t, p) })
              paid.current()
            }
          },
          // Achat d'un autre compte, compte sans le droit : rien à montrer.
          () => undefined
        )
      }),
    [t, setMessage]
  )
}

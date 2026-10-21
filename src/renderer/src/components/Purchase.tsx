// Achats côté interface : fenêtre d'achat (« Créer ton pack » : un pack de plus ou le déblocage d'un pack gratuit ; pack
// ou mod payant du catalogue), attente du paiement, historique de tous les achats, badges de prix des packs payants et
// proposition d'achat (ou de connexion) quand leur téléchargement est refusé. Le paiement se fait sur une page Stripe
// Checkout ouverte dans le navigateur : l'application n'en voit que l'état, relu toutes les 3 s, quand la fenêtre
// reprend le focus et sur le lien « fivem-pack-manager://achat/<id> » de la page de fin de paiement du site.
// Règles : @shared/billing.
import { useEffect, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { BillingProduct, DownloadDone, ItemAccess, MarketKind, Purchase, Quote, SaleInfo } from '@shared/types'
import { canPay, failureOf, formatPrice, installChoice, isTestMode, itemBadge, paidProposal, purchaseOutcome, saleActive } from '@shared/billing'
import { formatDateTime } from '@shared/intl'
import { apiError, cleanError, useStore } from '../store'
import { fullDate, marketImageUrl, num, q } from '../lib/format'
import { confirmDialog } from './Confirm'
import { Modal } from './Modal'

// ---------------------------------------------------------------------------
// Événements et navigation

const billingListeners = new Set<() => void>()

/** Achat fini, pack débloqué, refus 402 : l'état de la vente et ce qui en dépend sont relus là où ils sont affichés. */
export function notifyBilling(): void {
  for (const cb of billingListeners) cb()
}

export function onBillingChanged(cb: () => void): () => void {
  billingListeners.add(cb)
  return () => {
    billingListeners.delete(cb)
  }
}

/** Navigation fournie par App (usePurchases) : fiche d'un pack de la Marketplace, page de connexion. */
const nav: { openItem: ((id: string, kind: MarketKind) => void) | null; signIn: (() => void) | null } = { openItem: null, signIn: null }

/** Page de connexion (bouton « Se connecter pour acheter ») ; la page ouverte est retrouvée une fois connecté. */
export function requestSignIn(): void {
  nav.signIn?.()
}

/** « Mode test » : paiements de test de l'API de dev (clés Stripe de test, rien n'est débité). */
export function TestBadge() {
  const { t } = useTranslation()
  return <span className="badge test-badge">{t('builder.billing.test.badge')}</span>
}

// ---------------------------------------------------------------------------
// Packs et mods payants du catalogue

/**
 * Badge d'un pack du catalogue : son prix (payant), « Acheté » ou « Offert » quand il est à soi ; rien pour un pack
 * gratuit qui n'est pas à soi. `price` : null dans la bibliothèque (seuls les packs à soi y ont un badge).
 */
export function ItemBadge({ id, price, currency, className = '' }: { id: string; price: number | null; currency?: string; className?: string }) {
  const { t } = useTranslation()
  const { overview } = useStore()
  const badge = itemBadge(price, overview?.owned.find((o) => o.packId === id))
  if (!badge) return null
  if (badge.kind === 'price') {
    const text = formatPrice(badge.price, currency)
    return (
      <span className={`badge item-badge is-price ${className}`} title={t('marketplace.paid.priceTitle', { price: text })}>
        {text}
      </span>
    )
  }
  const gifted = badge.kind === 'admin'
  return (
    <span className={`badge item-badge is-owned ${className}`} title={gifted ? t('marketplace.paid.giftedTitle') : t('marketplace.paid.purchasedTitle')}>
      {gifted ? t('marketplace.paid.gifted') : t('marketplace.paid.purchased')}
    </span>
  )
}

/** Pack (ou mod) du catalogue que la fenêtre d'achat vend : nom et image affichés, catalogue pour les requêtes. */
export interface PurchaseItem {
  kind: MarketKind
  id: string
  name: string
  coverId?: string | null
}

/**
 * Bouton d'installation d'un pack payant qu'on n'a pas : « Acheter - 4,00 € » (fenêtre d'achat, puis téléchargement)
 * ou « Se connecter pour acheter - 4,00 € ». Null quand il se télécharge (gratuit, ou à soi). `access` : relu à l'ouverture
 * de la fiche ; sur une carte, les packs à soi font foi. `update` : nouvelle version d'un pack de la bibliothèque.
 */
export function usePaidAction(
  item: { id: string; kind: MarketKind; name: string; price: number | null; cover?: { id: string } | null },
  opts: { access?: ItemAccess | null; update?: boolean } = {}
): { label: string; run: () => void } | null {
  const { t } = useTranslation()
  const { account, overview } = useStore()
  const price = opts.access ? opts.access.price : item.price
  const canDownload = opts.access ? opts.access.canDownload : !!overview?.owned.some((o) => o.packId === item.id)
  const choice = installChoice({ price, canDownload, signedIn: !!account })
  if (choice === 'download' || price === null) return null
  // Le prix aussi sans compte : « Se connecter pour acheter - 4,00 € ».
  const text = formatPrice(price, opts.access?.currency)
  if (choice === 'signIn') return { label: t('marketplace.paid.signInToBuy', { price: text }), run: requestSignIn }
  return {
    label: t('marketplace.paid.buy', { price: text }),
    run: () =>
      void purchaseDialog({ product: 'item', item: { kind: item.kind, id: item.id, name: item.name, coverId: item.cover?.id ?? null }, install: true, update: opts.update })
  }
}

/** Prix et droit de télécharger d'un pack (fiche) : relus à l'ouverture, à la connexion et quand les packs à soi changent. */
export function useItemAccess(kind: MarketKind, id: string | null | undefined): ItemAccess | null {
  const { account, overview } = useStore()
  const [access, setAccess] = useState<ItemAccess | null>(null)
  const owned = overview?.owned.map((o) => o.packId).join() ?? ''
  useEffect(() => {
    if (!id) return
    let live = true
    window.api.itemAccess(kind, id).then(
      (a) => live && setAccess(a),
      // API plus ancienne (404) ou hors ligne : le prix des listes fait foi.
      () => live && setAccess(null)
    )
    return () => {
      live = false
    }
  }, [kind, id, account?.id, owned])
  return access
}

// ---------------------------------------------------------------------------
// Historique

function purchaseLabel(t: TFunction, p: Purchase): string {
  if (p.product === 'item') return p.packName || t('builder.billing.history.itemUnknown')
  return p.product === 'unlock' ? t('builder.billing.history.unlock', { name: q(p.buildName || t('builder.untitled')) }) : t('builder.billing.history.pack')
}

/** Pack du catalogue d'un achat `item` (catalogue inconnu de l'application : celui des packs). */
function itemOf(p: Purchase): PurchaseItem | null {
  return p.product === 'item' && p.packId ? { kind: p.packKind ?? 'pack', id: p.packId, name: p.packName ?? '' } : null
}

/**
 * Tous les achats du compte (« Créer ton pack » et catalogue), le plus récent d'abord : date, achat, montant, code
 * promo, état. Un paiement en cours se reprend (sa page se rouvre) ; un achat du catalogue mène à sa fiche.
 */
export function PurchaseList({ onLeave }: { onLeave?: () => void }) {
  const { t } = useTranslation()
  const { run } = useStore()
  const [items, setItems] = useState<Purchase[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    window.api.purchaseList().then(
      (list) => live && setItems(list),
      (e) => live && setError(cleanError(e))
    )
    return () => {
      live = false
    }
  }, [])
  const resume = (p: Purchase): void => {
    onLeave?.()
    if (p.checkoutUrl) void run(() => window.api.openCheckout(p.checkoutUrl!))
    void purchaseDialog({ product: p.product, build: p.buildId ? { id: p.buildId, name: p.buildName ?? '' } : null, item: itemOf(p), resume: p })
  }
  const openItem = (item: PurchaseItem): void => {
    onLeave?.()
    nav.openItem?.(item.id, item.kind)
  }
  if (error) return <p className="warn-text">{error}</p>
  if (!items) return <p className="muted loading">{t('common.loading')}</p>
  if (!items.length) return <p className="muted">{t('builder.billing.history.empty')}</p>
  return (
    <ul className="list compact purchase-list">
      {items.map((p) => {
        const waiting = purchaseOutcome(p) === 'waiting'
        // Paiement en cours dont la page a expiré (pas encore relu par l'API) : expiré.
        const status = p.status === 'pending' && !waiting ? 'expired' : p.status
        const facts = [fullDate(p.createdAt), formatPrice(p.amount, p.currency), p.promoCode ? t('builder.billing.history.code', { code: p.promoCode }) : '']
        const item = itemOf(p)
        return (
          <li key={p.id} className="row">
            <div className="row-main">
              <div className="name">{purchaseLabel(t, p)}</div>
              <div className="meta">
                {facts.filter(Boolean).join(' · ')}
                {item && nav.openItem && (
                  <>
                    {' · '}
                    <button className="link" onClick={() => openItem(item)}>
                      {t('builder.billing.history.viewItem')}
                    </button>
                  </>
                )}
              </div>
            </div>
            <span className={`purchase-status is-${status}`}>{t(`builder.billing.history.status.${status}`)}</span>
            {waiting && <button onClick={() => resume(p)}>{t('builder.billing.history.resume')}</button>}
          </li>
        )
      })}
    </ul>
  )
}

/** Historique dans une fenêtre (« Mes achats » de « Mon offre »). */
export function PurchaseHistory({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
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
      <PurchaseList onLeave={onClose} />
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Fenêtre d'achat

export interface PurchaseRequest {
  product: BillingProduct
  /** Pack gratuit à débloquer (achat « unlock »). */
  build?: { id: string; name: string } | null
  /** Pack ou mod payant du catalogue (achat « item »). */
  item?: PurchaseItem | null
  /** Ouverte à la place d'un refus (nouvelle création sans pack libre, pack gratuit déjà modifié, téléchargement) : la raison en tête. */
  blocked?: boolean
  /** Pack (ou mod) de la bibliothèque devenu payant : seule sa mise à jour demande l'achat. */
  update?: boolean
  /** Achat demandé par le bouton d'installation : une fois fait, le téléchargement commence aussitôt. */
  install?: boolean
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
 * Ouvre la fenêtre d'achat. true une fois l'achat fait (payé, offert par un code, pack débloqué avec un crédit, ou
 * rien à payer) : l'action en attente peut reprendre ; false si la fenêtre est fermée avant.
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

/** Ce que l'achat réussi donne : un pack de plus, un pack débloqué, ou le pack du catalogue. */
function gotText(t: TFunction, p: Pick<Purchase, 'product' | 'buildName' | 'packName'>): string {
  if (p.product === 'item') return t('builder.billing.dialog.gotItem', { name: q(p.packName || t('builder.billing.history.itemUnknown')) })
  if (p.product === 'unlock') return t('builder.billing.dialog.unlocked', { name: q(p.buildName || t('builder.untitled')) })
  return t('builder.billing.dialog.gotPack')
}

/** Achat réussi : « Paiement reçu, merci ! » (ou « Offert par le code … ») et ce qu'il donne. */
function doneText(t: TFunction, p: Purchase): string {
  return `${p.status === 'free' ? t('builder.billing.dialog.freeBy', { code: p.promoCode ?? '' }) : t('builder.billing.dialog.paid')} ${gotText(t, p)}`
}

/** Conditions de vente et prix de ce qu'on achète ; `nothing` : rien à payer (vente coupée, pack déjà à soi ou gratuit). */
interface Offer {
  sale: SaleInfo
  price: number | null
  nothing: boolean
  /** Crédits libres (déblocage d'un pack gratuit sans payer). */
  credits: number
}

async function loadOffer(product: BillingProduct, item: PurchaseItem | null): Promise<Offer> {
  if (product === 'item') {
    // Achat d'un pack que l'application ne retrouve pas (historique d'une API plus ancienne) : pas de prix, rien à payer ici.
    if (!item) return { sale: await window.api.saleInfo(), price: null, nothing: false, credits: 0 }
    const [sale, access] = await Promise.all([window.api.saleInfo(), window.api.itemAccess(item.kind, item.id)])
    return { sale, price: access.price, nothing: access.price === null || access.canDownload, credits: 0 }
  }
  const billing = await window.api.builderBilling()
  return { sale: billing, price: billing.prices[product], nothing: !saleActive(billing), credits: billing.credits.available }
}

type Phase = { kind: 'form' } | { kind: 'waiting'; purchase: Purchase } | { kind: 'done'; text: string; offerInstall: boolean }

/**
 * Ce qu'on achète (avec l'image d'un pack du catalogue), le prix (barré avec un code promo), le code promo, les deux
 * cases obligatoires (CGV, accès immédiat et renonciation au droit de rétractation), puis « Payer » : la page Stripe
 * s'ouvre dans le navigateur et la fenêtre attend la fin du paiement (« Rouvrir la page de paiement », « Annuler »).
 * Achat fait : message, puis « Continuer » ; un pack du catalogue se télécharge aussitôt (achat demandé par le bouton
 * d'installation) ou sur « Installer maintenant ».
 */
function PurchaseDialog({ request, onClose }: { request: PurchaseRequest; onClose: (done: boolean) => void }) {
  const { t } = useTranslation()
  const { product, resume } = request
  const item = request.item ?? (resume ? itemOf(resume) : null)
  const buildId = request.build?.id ?? resume?.buildId ?? null
  const name = q(request.build?.name || resume?.buildName || item?.name || t('builder.untitled'))
  const [offer, setOffer] = useState<Offer | null>(null)
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
  const sale = offer?.sale ?? null

  /** Téléchargement du pack acheté (file des téléchargements) ; une erreur reste affichée dans la fenêtre. */
  const install = async (): Promise<boolean> => {
    if (!item) return true
    try {
      await window.api.marketInstall(item.id, item.kind)
      return true
    } catch (e) {
      setNote({ kind: 'error', text: cleanError(e) })
      return false
    }
  }

  /** Achat fait (ou rien à payer) : le pack du catalogue se télécharge aussitôt s'il a été acheté pour l'installer. */
  const succeed = async (text: string): Promise<void> => {
    notifyBilling()
    const started = item && request.install ? await install() : false
    setPhase({ kind: 'done', text: started ? `${text} ${t('builder.billing.dialog.installing')}` : text, offerInstall: !!item && !started })
  }

  useEffect(() => {
    let live = true
    loadOffer(product, item).then(
      (o) => live && setOffer(o),
      (e) => live && setNote({ kind: 'error', text: cleanError(e) })
    )
    return () => {
      live = false
    }
    // La fenêtre vend une seule chose : l'offre est lue à son ouverture.
  }, [])

  /** Achat reçu (commande, relecture, abandon) : réussi, échoué (retour au formulaire avec la raison), ou à payer. */
  const settle = (p: Purchase): void => {
    known.current = p
    const outcome = purchaseOutcome(p)
    if (outcome === 'waiting') {
      setPhase({ kind: 'waiting', purchase: p })
    } else if (outcome === 'success') {
      void succeed(doneText(t, { ...p, packName: p.packName ?? item?.name ?? null }))
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
        const p = await window.api.purchaseGet(waitingId)
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
      await window.api.openCheckout(url)
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
      setQuote(
        product === 'item' && item ? await window.api.itemQuote(item.kind, item.id, code) : await window.api.builderQuote({ product: product === 'unlock' ? 'unlock' : 'pack', buildId, promoCode: code })
      )
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
      const terms = { promoCode: promo.trim() || null, acceptTerms, waiveWithdrawal }
      const p =
        product === 'item' && item
          ? await window.api.itemCheckout(item.kind, item.id, terms)
          : await window.api.builderCheckout({ product: product === 'unlock' ? 'unlock' : 'pack', buildId, ...terms })
      if (p.status === 'pending') {
        try {
          if (!p.checkoutUrl) throw new Error(t('builder.errors.badCheckoutUrl'))
          await window.api.openCheckout(p.checkoutUrl)
        } catch (e) {
          // Page refusée (adresse inattendue) : le paiement est abandonné.
          void window.api.purchaseCancel(p.id).catch(() => undefined)
          throw e
        }
      }
      settle(p)
    } catch (e) {
      const { code, message } = apiError(e)
      // Pack redevenu gratuit, ou déjà à soi : rien à payer.
      if (code === 'pack-free' || code === 'already-owned') await succeed(t('builder.billing.dialog.owned', { name }))
      else if (code && PROMO_ERRORS[code]) setPromoError(promoText(e))
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
      setPhase({ kind: 'done', text: t('builder.billing.dialog.unlocked', { name: q(b.name) }), offerInstall: false })
    } catch (e) {
      setNote({ kind: 'error', text: cleanError(e) })
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (p: Purchase): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.purchaseCancel(p.id)
      // Déjà payé : l'achat est acquis. Sinon, retour au formulaire.
      settle(purchaseOutcome(r) === 'waiting' ? { ...r, status: 'canceled' } : r)
    } catch (e) {
      setPhase({ kind: 'form' })
      setNote({ kind: 'error', text: cleanError(e) })
    } finally {
      setBusy(false)
    }
  }

  const title = product === 'item' ? t('builder.billing.dialog.itemTitle', { name }) : product === 'unlock' ? t('builder.billing.dialog.unlockTitle', { name }) : t('builder.billing.dialog.packTitle')
  const notice = note && (
    <div className={`bar ${note.kind === 'error' ? 'bar-error' : ''} purchase-note`}>
      <span className="bar-text">{note.text}</span>
    </div>
  )
  // Paiement de test : la carte de test à saisir sur la page Stripe (copiable).
  const test = isTestMode(sale) && (
    <div className="purchase-test">
      <TestBadge />
      <span className="hint">{t('builder.billing.test.card')}</span>
    </div>
  )
  const support = sale?.supportUrl && (
    <p className="hint purchase-support">
      <Trans i18nKey="builder.billing.dialog.support" components={{ discord: <button className="link" onClick={() => openLink(sale.supportUrl)} /> }} />
    </p>
  )
  const cover = item?.coverId && <img className="purchase-cover" src={marketImageUrl(item.id, item.coverId, true, item.kind)} alt="" draggable={false} />

  if (phase.kind === 'done')
    return (
      <Modal
        title={title}
        onClose={() => onClose(true)}
        className="purchase-dialog"
        actions={
          phase.offerInstall ? (
            <>
              <button className="primary" data-autofocus onClick={() => void install().then((ok) => ok && onClose(true))}>
                {t('builder.billing.dialog.installNow')}
              </button>
              <button onClick={() => onClose(true)}>{t('builder.billing.dialog.later')}</button>
            </>
          ) : (
            <button className="primary" data-autofocus onClick={() => onClose(true)}>
              {t('builder.billing.dialog.continue')}
            </button>
          )
        }
      >
        <div className="purchase-body">
          {cover}
          <p className="ok-text">{phase.text}</p>
          {notice}
        </div>
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

  // Rien à payer depuis l'ouverture (vente coupée, compte illimité, pack déjà à soi ou redevenu gratuit) : l'action reprend.
  const nothing = !!offer?.nothing
  const amount = quote ? quote.amount : (offer?.price ?? null)
  const currency = quote?.currency ?? sale?.currency
  const payable = canPay({ acceptTerms, waiveWithdrawal, busy, checkout: !!sale?.checkout, amount })
  const terms = sale?.termsUrl ? (
    <button
      className="link"
      onClick={(e) => {
        // Le lien seul, sans cocher la case.
        e.preventDefault()
        openLink(sale.termsUrl)
      }}
    />
  ) : (
    <span />
  )
  const reason =
    product === 'item'
      ? request.update
        ? t(item?.kind === 'mod' ? 'marketplace.paid.updatePaidMod' : 'marketplace.paid.updatePaidPack')
        : t('builder.billing.dialog.needItem', { name })
      : product === 'unlock'
        ? t('builder.billing.dialog.needUnlock')
        : t('builder.billing.dialog.needPack')
  const what =
    product === 'item'
      ? t(item?.kind === 'mod' ? 'builder.billing.dialog.itemModText' : 'builder.billing.dialog.itemPackText')
      : product === 'unlock'
        ? t('builder.billing.dialog.unlockText', { name })
        : t('builder.billing.dialog.packText')
  return (
    <Modal
      title={title}
      onClose={() => onClose(false)}
      className="purchase-dialog"
      actions={
        nothing ? (
          <button className="primary" data-autofocus onClick={() => (product === 'item' ? void succeed(t('builder.billing.dialog.owned', { name })) : onClose(true))}>
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
        {(request.blocked || request.update) && !nothing && <p className="purchase-reason">{reason}</p>}
        <div className="purchase-what">
          {cover}
          <p>{what}</p>
        </div>
        {nothing ? (
          <p>{product === 'item' ? t('builder.billing.dialog.owned', { name }) : t('builder.billing.dialog.nothingToPay')}</p>
        ) : !offer ? (
          !note && <p className="muted loading">{t('common.loading')}</p>
        ) : (
          <>
            {product === 'unlock' && buildId && offer.credits > 0 && (
              <div className="purchase-credit">
                <span>{t('builder.billing.dialog.credit', { count: offer.credits, n: num(offer.credits) })}</span>
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
            {!offer.sale.checkout && amount !== 0 && <p className="hint">{t('builder.billing.offer.unavailable')}</p>}
          </>
        )}
        {notice}
        {support}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Branchement dans App

/**
 * Monté une fois dans App. Donne la navigation aux achats (fiche d'un pack, connexion) ; reçoit le lien
 * « fivem-pack-manager://achat/<id> » de la page de fin de paiement du site (achat attendu par une fenêtre d'achat :
 * relu par elle ; sinon relu ici : achat du catalogue montré dans la fenêtre d'achat avec « Installer maintenant »,
 * achat de « Créer ton pack » fini annoncé, puis `openBuilder`) ; et propose la connexion ou l'achat quand le
 * téléchargement d'un pack payant est refusé (401, 402), au lieu d'une erreur.
 */
export function usePurchases(opts: { openBuilder: () => void; openItem: (id: string, kind: MarketKind) => void; signIn: () => void }): void {
  const { t } = useTranslation()
  const { setMessage } = useStore()
  const latest = useRef(opts)
  latest.current = opts
  useEffect(() => {
    nav.openItem = (id, kind) => latest.current.openItem(id, kind)
    nav.signIn = () => latest.current.signIn()
    return () => {
      nav.openItem = null
      nav.signIn = null
    }
  }, [])

  useEffect(
    () =>
      window.api.onOpenPurchase((id) => {
        if (awaited.has(id)) return
        window.api.purchaseGet(id).then(
          (p) => {
            const outcome = purchaseOutcome(p)
            const item = itemOf(p)
            if (item) {
              latest.current.openItem(item.id, item.kind)
              void purchaseDialog({ product: 'item', item, resume: p })
            } else if (outcome === 'waiting') void purchaseDialog({ product: p.product, build: p.buildId ? { id: p.buildId, name: p.buildName ?? '' } : null, resume: p })
            else if (outcome === 'failure') setMessage({ kind: 'info', text: t(`builder.billing.dialog.ended.${failureOf(p)}`) })
            else {
              notifyBilling()
              setMessage({ kind: 'info', text: doneText(t, p) })
              latest.current.openBuilder()
            }
          },
          // Achat d'un autre compte, plus de compte : rien à montrer.
          () => undefined
        )
      }),
    [t, setMessage]
  )

  useEffect(
    () =>
      window.api.onDownloadDone((d: DownloadDone) => {
        const proposal = paidProposal(d)
        if (!proposal || d.kind === 'build') return
        if (proposal === 'signIn') {
          void confirmDialog(t('marketplace.paid.signInTitle', { name: q(d.name) }), t('marketplace.paid.signInDetail'), t('marketplace.paid.signIn')).then(
            (ok) => ok && latest.current.signIn()
          )
          return
        }
        void purchaseDialog({ product: 'item', item: { kind: d.kind, id: d.id, name: d.name }, blocked: true, update: proposal === 'buyUpdate', install: true })
      }),
    [t]
  )
}

// Notes et commentaires d'un pack ou d'un mod de la Marketplace (`kind` choisit le catalogue de l'API).
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import type { CommentPage, MarketKind, MarketPack, PackComment, PackRatings, RatingReason, ReplyPage } from '@shared/types'
import type { CommentQuery, MenuItem } from '@shared/api'
import { apiError, cleanError, useStore } from '../store'
import { ago, bytes, fullDate, num, ratingText } from '../lib/format'
import { Avatar } from './common'

const COMMENT_MAX = 2000

/** Libellé d'une note de 1 à 5 étoiles (vide pour 0). */
function starLabel(n: number): string {
  switch (n) {
    case 1:
      return i18next.t('reviews.starLabel.bad')
    case 2:
      return i18next.t('reviews.starLabel.fair')
    case 3:
      return i18next.t('reviews.starLabel.good')
    case 4:
      return i18next.t('reviews.starLabel.veryGood')
    case 5:
      return i18next.t('reviews.starLabel.excellent')
    default:
      return ''
  }
}

// ------------------------------------------------------------------ étoiles

const STAR_PATH = 'M12 2.2l2.9 6.4 7 .7-5.3 4.7 1.5 6.9L12 17.3l-6.1 3.6 1.5-6.9L2.1 9.3l7-.7z'

/** Une étoile remplie de jaune selon la note sur 5 (à moitié pour 2,5). */
function StarIcon({ value, size }: { value: number; size: number }) {
  // Identifiant du dégradé propre à chaque étoile (useId peut contenir des caractères refusés dans url(#…)).
  const id = `star-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`
  const pct = `${Math.max(0, Math.min(100, (value / 5) * 100))}%`
  return (
    <svg className="star-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id={id}>
          <stop offset={pct} style={{ stopColor: 'var(--star)' }} />
          <stop offset={pct} style={{ stopColor: 'var(--star-off)' }} />
        </linearGradient>
      </defs>
      <path d={STAR_PATH} fill={`url(#${id})`} />
    </svg>
  )
}

/** Note : une étoile remplie selon la note, et la note à côté (« ★ 2,5 »). */
export function Score({ value, size = 14 }: { value: number; size?: number }) {
  const { t } = useTranslation()
  return (
    <span className="score" role="img" aria-label={t('reviews.outOf5', { rating: ratingText(value) })}>
      <StarIcon value={value} size={size} />
      <span aria-hidden>{ratingText(value)}</span>
    </span>
  )
}

/** A reçu au moins une note. */
export const isRated = (pack: Pick<MarketPack, 'rating'>): boolean => pack.rating.count > 0 && pack.rating.average !== null

/** « ★ 4,3 (12) » (rien tant que personne n'a noté), puis le nombre de commentaires. */
export function RatingLine({ pack, comments = true }: { pack: Pick<MarketPack, 'rating' | 'commentCount'>; comments?: boolean }) {
  const { t } = useTranslation()
  const { average, count } = pack.rating
  if (!comments && !isRated(pack)) return null
  return (
    <span className="rating-line">
      {average !== null && count > 0 && (
        <span className="rating-value" title={t('reviews.ratingTitle', { rating: ratingText(average), count, n: num(count) })}>
          <Score value={average} size={14} />
          <span className="muted">({num(count)})</span>
        </span>
      )}
      {comments && (
        <span className="comment-count" title={t('reviews.comments', { count: pack.commentCount, n: num(pack.commentCount) })}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M2.5 2h11A1.5 1.5 0 0 1 15 3.5v7a1.5 1.5 0 0 1-1.5 1.5H8l-3.6 2.7a.5.5 0 0 1-.8-.4V12H2.5A1.5 1.5 0 0 1 1 10.5v-7A1.5 1.5 0 0 1 2.5 2zm0 1.5v7h2.6v1.8l2.4-1.8h6v-7z" />
          </svg>
          {num(pack.commentCount)}
        </span>
      )}
    </span>
  )
}

/** Cinq étoiles vides : elles se remplissent au survol, un clic envoie la note. */
function StarPicker({ value, disabled, onPick }: { value: number | null; disabled: boolean; onPick: (stars: number) => void }) {
  const { t } = useTranslation()
  const [hover, setHover] = useState<number | null>(null)
  const shown = disabled ? (value ?? 0) : (hover ?? value ?? 0)
  return (
    <div className="star-picker" role="radiogroup" aria-label={t('reviews.yourRating')} onMouseLeave={() => setHover(null)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={t('reviews.star', { count: n, label: starLabel(n) })}
          title={starLabel(n)}
          className={`star-btn ${n <= shown ? 'is-on' : ''}`}
          disabled={disabled}
          onMouseEnter={() => setHover(n)}
          onFocus={() => setHover(n)}
          onBlur={() => setHover(null)}
          onClick={() => onPick(n)}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden>
            <path d={STAR_PATH} />
          </svg>
        </button>
      ))}
      <span className="star-label">{starLabel(shown)}</span>
    </div>
  )
}

// ------------------------------------------------------------------ notes

function reasonText(reason: RatingReason, kind: MarketKind): string {
  const mod = kind === 'mod'
  switch (reason) {
    case 'login-required':
      return i18next.t(mod ? 'reviews.reason.loginMod' : 'reviews.reason.loginPack')
    case 'download-required':
      return i18next.t(mod ? 'reviews.reason.downloadMod' : 'reviews.reason.downloadPack')
    case 'own-pack':
      return i18next.t(mod ? 'reviews.reason.ownMod' : 'reviews.reason.ownPack')
    default:
      return i18next.t('reviews.reason.muted')
  }
}

/**
 * Notes et commentaires d'un pack. `installs` change à chaque téléchargement terminé du pack : les notes sont relues
 * (le compte peut alors le noter) et une note est proposée. `onChanged` relit la fiche (moyenne, nombre de commentaires).
 */
export function PackReviews({
  pack,
  local,
  installs,
  onChanged,
  onSignIn
}: {
  pack: MarketPack
  /** Le pack (ou le mod, pack.kind) est dans la bibliothèque. */
  local: boolean
  installs: number
  onChanged: () => void
  onSignIn: () => void
}) {
  const { account } = useStore()
  const { t, i18n } = useTranslation()
  const [ratings, setRatings] = useState<PackRatings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [invite, setInvite] = useState(false)
  // Connexion, déconnexion ou compte réduit au silence : notes relues.
  const accountKey = account === undefined ? null : account ? `${account.id}:${account.muted}` : 'anonyme'

  const load = useCallback(async (): Promise<PackRatings | null> => {
    try {
      const r = await window.api.packRatings(pack.id, pack.kind)
      setRatings(r)
      setError(null)
      return r
    } catch (e) {
      setError(cleanError(e))
      return null
    }
  }, [pack.id, pack.kind])

  // Langue changée : notes relues (messages d'erreur de l'API).
  useEffect(() => {
    if (accountKey !== null) void load()
  }, [load, accountKey, i18n.language])

  // Installation terminée : le téléchargement est compté pour le compte, qui peut maintenant noter.
  const seen = useRef(installs)
  useEffect(() => {
    if (installs === seen.current) return
    seen.current = installs
    void load().then((r) => {
      if (r?.downloaded && r.canRate && r.mine === null) setInvite(true)
    })
  }, [installs, load])

  return (
    <>
      <div className="section-head" id="avis">
        <h2>{t('reviews.ratingsTitle')}</h2>
      </div>
      {error && !ratings ? (
        <div className="form-panel">
          <p className="muted">{error}</p>
          <div>
            <button onClick={() => void load()}>{t('common.retry')}</button>
          </div>
        </div>
      ) : !ratings ? (
        <p className="muted">{t('common.loading')}</p>
      ) : (
        <Ratings
          pack={pack}
          ratings={ratings}
          local={local}
          invite={invite}
          onRated={(r) => {
            setRatings(r)
            setInvite(false)
            onChanged()
          }}
          reload={() => void load()}
          onSignIn={onSignIn}
        />
      )}
      <Comments packId={pack.id} kind={pack.kind} accountKey={accountKey} onChanged={onChanged} onSignIn={onSignIn} />
    </>
  )
}

function Ratings({
  pack,
  ratings,
  local,
  invite,
  onRated,
  reload,
  onSignIn
}: {
  pack: MarketPack
  ratings: PackRatings
  local: boolean
  invite: boolean
  onRated: (r: PackRatings) => void
  reload: () => void
  onSignIn: () => void
}) {
  const { account, downloads, run, setMessage } = useStore()
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const max = Math.max(1, ...Object.values(ratings.distribution))

  const reason = account?.muted ? 'muted' : ratings.reason

  const rate = async (stars: number | null): Promise<void> => {
    // Sans compte : page de connexion (la fiche revient une fois connecté). Autre refus : son explication.
    if (stars !== null && !account) return onSignIn()
    if (stars !== null && (!ratings.canRate || account?.muted)) {
      setMessage({ kind: 'error', text: reasonText(reason ?? 'download-required', pack.kind) })
      return
    }
    setBusy(true)
    try {
      onRated(await window.api.packRate(pack.id, stars, pack.kind))
      setMessage({ kind: 'info', text: stars === null ? t('reviews.ratingRemoved') : t('reviews.thanks') })
    } catch (e) {
      const err = apiError(e)
      setMessage({ kind: 'error', text: err.message })
      // Refus (pack pas téléchargé, compte réduit au silence...) : l'explication à jour s'affiche.
      if (err.status === 401 || err.status === 403) reload()
    } finally {
      setBusy(false)
    }
  }
  // Pack de la bibliothèque téléchargé sans être connecté : un nouveau téléchargement au nom du compte permet de le noter.
  const claim = reason === 'download-required' && local && !!account
  return (
    <div className="ratings">
      <div className="ratings-summary">
        {ratings.count > 0 && ratings.average !== null ? (
          <>
            <div className="ratings-average">
              <Score value={ratings.average} size={32} />
            </div>
            <div className="muted small">{t('reviews.count', { count: ratings.count, n: num(ratings.count) })}</div>
          </>
        ) : (
          <>
            <div className="ratings-average muted">–</div>
          </>
        )}
      </div>

      <div className="ratings-bars" aria-label={t('reviews.distribution')}>
        {([5, 4, 3, 2, 1] as const).map((n) => (
          <div key={n} className="rbar" title={t('reviews.count', { count: ratings.distribution[n], n: num(ratings.distribution[n]) })}>
            <span className="rbar-label">
              {n} <span aria-hidden>★</span>
            </span>
            <div className="rbar-track">
              <div className="rbar-fill" style={{ width: `${(ratings.distribution[n] / max) * 100}%` }} />
            </div>
            <span className="rbar-count">{num(ratings.distribution[n])}</span>
          </div>
        ))}
      </div>

      <div className={`ratings-mine ${invite ? 'is-invite' : ''}`}>
        <div className="field-label">{invite ? t(pack.kind === 'mod' ? 'reviews.inviteMod' : 'reviews.invitePack') : t('reviews.yourRating')}</div>
        {/* Toujours affiché, même sans compte : un clic demande alors de se connecter. */}
        <StarPicker value={ratings.mine} disabled={busy} onPick={(n) => void rate(n)} />
        {ratings.canRate && !account?.muted ? (
          ratings.mine !== null && (
            <button className="link small" onClick={() => void rate(null)} disabled={busy}>
              {t('reviews.removeMine')}
            </button>
          )
        ) : (
          <>
            {reason && reason !== 'login-required' && (
              <p className="muted small">
                {claim ? t(pack.kind === 'mod' ? 'reviews.claim.anonymousMod' : 'reviews.claim.anonymousPack') : reasonText(reason, pack.kind)}
              </p>
            )}
            {claim && (
              <>
                <p className="muted small">
                  {pack.protected ? t('reviews.claim.protectedHint') : t('reviews.claim.redownloadHint', { size: bytes(pack.archiveSize) })}
                </p>
                <div>
                  <button onClick={() => void run(() => window.api.marketClaim(pack.id, pack.kind))} disabled={downloads.some((d) => d.id === pack.id)}>
                    {pack.protected ? t('reviews.claim.validate') : t('reviews.claim.redownload')}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ commentaires

/** Action sur un commentaire, puis commentaires relus ; une erreur s'affiche dans la barre de message. */
function useCommentAction(reload: () => void) {
  const { setMessage } = useStore()
  return useCallback(
    async (fn: () => Promise<unknown>, success?: string): Promise<boolean> => {
      try {
        await fn()
        if (success) setMessage({ kind: 'info', text: success })
        reload()
        return true
      } catch (e) {
        const err = apiError(e)
        setMessage({ kind: 'error', text: err.message })
        // Commentaire supprimé ou masqué entre-temps, commentaires fermés, compte réduit au silence...
        if (err.status === 401 || err.status === 403 || err.status === 404 || err.status === 409 || err.status === 422) reload()
        return false
      }
    },
    [setMessage, reload]
  )
}

function Comments({
  packId,
  kind,
  accountKey,
  onChanged,
  onSignIn
}: {
  packId: string
  kind: MarketKind
  accountKey: string | null
  onChanged: () => void
  onSignIn: () => void
}) {
  const { account } = useStore()
  const { t, i18n } = useTranslation()
  const [query, setQuery] = useState<Required<CommentQuery>>({ sort: 'recent', page: 0 })
  const [data, setData] = useState<CommentPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Change après chaque action : les réponses dépliées sont relues aussi.
  const [version, setVersion] = useState(0)
  const top = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      setData(await window.api.packComments(packId, query, kind))
      setError(null)
    } catch (e) {
      setError(cleanError(e))
    }
  }, [packId, query, kind])

  // Langue changée : commentaires relus (messages d'erreur de l'API).
  useEffect(() => {
    if (accountKey !== null) void load()
  }, [load, accountKey, version, i18n.language])

  /** Après une action : commentaires relus, et la fiche (nombre de commentaires). */
  const changed = useCallback(() => {
    setVersion((v) => v + 1)
    onChanged()
  }, [onChanged])
  const act = useCommentAction(changed)

  const post = async (body: string): Promise<boolean> => {
    const ok = await act(() => window.api.packCommentPost(packId, body, undefined, kind), t('reviews.posted'))
    // Le nouveau commentaire est en tête des plus récents.
    if (ok && (query.sort !== 'recent' || query.page !== 0)) setQuery({ sort: 'recent', page: 0 })
    return ok
  }

  const goTo = (page: number): void => {
    setQuery({ ...query, page })
    top.current?.scrollIntoView({ block: 'start' })
  }

  let gate: ReactNode = null
  if (data && !data.canComment) {
    if (!account)
      gate = (
        <div className="comment-gate">
          <span className="muted">{t(kind === 'mod' ? 'reviews.signInMod' : 'reviews.signInPack')}</span>
          <button onClick={onSignIn}>{t('reviews.signIn')}</button>
        </div>
      )
    else if (data.locked) gate = <div className="comment-gate muted">{t('reviews.locked')}</div>
    else if (account.muted) gate = <div className="comment-gate muted">{t('reviews.reason.muted')}</div>
  }

  return (
    <>
      <div className="section-head" ref={top}>
        <h2>
          {t('reviews.commentsTitle')}
          {data && data.commentCount > 0 && <span className="section-count">{num(data.commentCount)}</span>}
        </h2>
        {data && data.total > 1 && (
          <select value={query.sort} onChange={(e) => setQuery({ sort: e.target.value as 'recent' | 'oldest', page: 0 })} aria-label={t('reviews.sort.label')}>
            <option value="recent">{t('reviews.sort.recent')}</option>
            <option value="oldest">{t('reviews.sort.oldest')}</option>
          </select>
        )}
      </div>

      {error && !data ? (
        <div className="form-panel">
          <p className="muted">{error}</p>
          <div>
            <button onClick={() => void load()}>{t('common.retry')}</button>
          </div>
        </div>
      ) : !data ? (
        <p className="muted">{t('common.loading')}</p>
      ) : (
        <>
          {data.canComment && !account?.muted ? (
            <CommentForm placeholder={t(kind === 'mod' ? 'reviews.placeholderMod' : 'reviews.placeholderPack')} submitLabel={t('reviews.publish')} onSubmit={post} />
          ) : (
            gate
          )}
          {data.locked && data.canComment && <p className="hint">{t('reviews.lockedOthers')}</p>}

          {data.items.length === 0 ? (
            <p className="muted comments-empty">{t('reviews.empty')}</p>
          ) : (
            <div className="comments">
              {data.items.map((c) => (
                <Thread key={c.id} packId={packId} kind={kind} comment={c} version={version} act={act} onSignIn={onSignIn} />
              ))}
            </div>
          )}

          {data.totalPages > 1 && (
            <div className="pager">
              <button disabled={query.page === 0} onClick={() => goTo(query.page - 1)}>
                {t('common.previous')}
              </button>
              <span className="muted">{t('marketplace.page', { page: num(query.page + 1), total: num(data.totalPages) })}</span>
              <button disabled={query.page + 1 >= data.totalPages} onClick={() => goTo(query.page + 1)}>
                {t('common.next')}
              </button>
            </div>
          )}
        </>
      )}
    </>
  )
}

type Act = (fn: () => Promise<unknown>, success?: string) => Promise<boolean>

/** Commentaire et ses réponses (les 3 premières, puis toutes à la demande), avec le formulaire de réponse. */
function Thread({
  packId,
  kind,
  comment,
  version,
  act,
  onSignIn
}: {
  packId: string
  kind: MarketKind
  comment: PackComment
  version: number
  act: Act
  onSignIn: () => void
}) {
  const { account, setMessage } = useStore()
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<ReplyPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [replyTo, setReplyTo] = useState<PackComment | null>(null)
  const loaded = expanded?.items.length ?? 0

  const fetchReplies = useCallback(
    async (count: number): Promise<void> => {
      setLoading(true)
      try {
        setExpanded(await window.api.packCommentReplies(packId, comment.id, 0, Math.min(100, Math.max(20, count)), kind))
      } catch (e) {
        setMessage({ kind: 'error', text: cleanError(e) })
      } finally {
        setLoading(false)
      }
    },
    [packId, kind, comment.id, setMessage]
  )

  // Commentaires relus : les réponses dépliées aussi.
  const lastVersion = useRef(version)
  useEffect(() => {
    if (version === lastVersion.current) return
    lastVersion.current = version
    if (loaded) void fetchReplies(loaded)
  }, [version, loaded, fetchReplies])

  const more = async (): Promise<void> => {
    if (!expanded) return fetchReplies(20)
    setLoading(true)
    try {
      // Pages de 20 : celle qui suit les réponses déjà affichées (sans doublon si elles ne finissent pas une page).
      const next = await window.api.packCommentReplies(packId, comment.id, Math.floor(expanded.items.length / 20), 20, kind)
      const seen = new Set(expanded.items.map((r) => r.id))
      setExpanded({ ...next, items: [...expanded.items, ...next.items.filter((r) => !seen.has(r.id))] })
    } catch (e) {
      setMessage({ kind: 'error', text: cleanError(e) })
    } finally {
      setLoading(false)
    }
  }

  const reply = (target: PackComment): void => {
    if (!account) return onSignIn()
    setReplyTo(target)
  }

  const send = async (body: string): Promise<boolean> => {
    if (!replyTo) return false
    const ok = await act(() => window.api.packCommentPost(packId, body, replyTo.id, kind), t('reviews.replyPosted'))
    if (ok) {
      setReplyTo(null)
      // Réponses dans l'ordre : la nouvelle est la dernière, toutes sont affichées.
      await fetchReplies(comment.replyCount + 1)
    }
    return ok
  }

  const replies = expanded?.items ?? comment.replies
  const total = Math.max(comment.replyCount, expanded?.total ?? 0)
  const hidden = total - replies.length
  return (
    <div className={`thread ${comment.pinned ? 'is-pinned' : ''}`}>
      <CommentItem packId={packId} kind={kind} comment={comment} act={act} onReply={reply} onSignIn={onSignIn} />
      {(replies.length > 0 || hidden > 0 || replyTo) && (
        <div className="replies">
          {replies.map((r) => (
            <CommentItem key={r.id} packId={packId} kind={kind} comment={r} act={act} onReply={reply} onSignIn={onSignIn} />
          ))}
          {hidden > 0 && (
            <button className="link replies-more" onClick={() => void more()} disabled={loading}>
              {loading
                ? t('common.loading')
                : expanded
                  ? t('reviews.moreReplies', { n: num(hidden) })
                  : t('reviews.allReplies', { count: total, n: num(total) })}
            </button>
          )}
          {replyTo && (
            <CommentForm
              key={replyTo.id}
              placeholder={replyTo.author ? t('reviews.replyTo', { name: replyTo.author.displayName }) : t('reviews.replyToComment')}
              submitLabel={t('reviews.reply')}
              autoFocus
              compact
              onSubmit={send}
              onCancel={() => setReplyTo(null)}
            />
          )}
        </div>
      )}
    </div>
  )
}

/** Raisons d'un signalement (« Autre » demande une précision). */
const REPORT_REASONS = ['spam', 'abuse', 'offTopic', 'inappropriate', 'other'] as const
type ReportReason = (typeof REPORT_REASONS)[number]

function CommentItem({
  packId,
  kind,
  comment: c,
  act,
  onReply,
  onSignIn
}: {
  packId: string
  kind: MarketKind
  comment: PackComment
  act: Act
  onReply: (c: PackComment) => void
  onSignIn: () => void
}) {
  const { account } = useStore()
  const { t } = useTranslation()
  const [mode, setMode] = useState<'edit' | 'report' | 'hide' | null>(null)
  const admin = !!account?.admin
  const isReply = c.parentId !== null
  const name = c.author?.displayName ?? t('reviews.deletedAccount')

  const menu = async (): Promise<void> => {
    const items: MenuItem[] = []
    if (c.canEdit && c.status !== 'deleted' && c.body !== null) items.push({ id: 'edit', label: t('common.edit') })
    if (c.canDelete && c.status !== 'deleted') items.push({ id: 'delete', label: t('common.delete') })
    if (admin) {
      if (c.status === 'hidden') items.push({ id: 'unhide', label: t('reviews.menu.unhide'), separator: true })
      else if (c.status === 'visible') items.push({ id: 'hide', label: t('reviews.menu.hide'), separator: true })
      if (!isReply && c.status === 'visible') items.push({ id: c.pinned ? 'unpin' : 'pin', label: c.pinned ? t('reviews.menu.unpin') : t('reviews.menu.pin'), separator: c.status !== 'visible' })
      items.push({ id: 'purge', label: t('reviews.menu.purge'), separator: true })
    }
    switch (await window.api.popupMenu(items)) {
      case 'edit':
        return setMode('edit')
      case 'hide':
        return setMode('hide')
      case 'delete':
        if (
          await window.api.confirm(
            t('reviews.confirmDelete.message'),
            isReply ? t('reviews.confirmDelete.reply') : t('reviews.confirmDelete.comment'),
            t('common.delete')
          )
        )
          await act(() => window.api.packCommentDelete(packId, c.id, kind), t('reviews.deleted'))
        return
      case 'unhide':
        await act(() => window.api.adminCommentHide(c.id, false), t('reviews.unhidden'))
        return
      case 'pin':
      case 'unpin':
        await act(() => window.api.adminCommentPin(c.id, !c.pinned), c.pinned ? t('reviews.unpinned') : t('reviews.pinned'))
        return
      case 'purge':
        if (await window.api.confirm(t('reviews.confirmPurge.message'), t('reviews.confirmPurge.detail'), t('reviews.menu.purge')))
          await act(() => window.api.adminCommentDelete(c.id), t('reviews.purged'))
        return
    }
  }

  const hasMenu = (c.canEdit && c.body !== null) || c.canDelete || admin
  const gone = c.status !== 'visible' && c.body === null
  // Signaler : drapeau dans le coin du commentaire (sans compte, la page de connexion s'ouvre).
  const reportable = !c.mine && c.status === 'visible'
  return (
    <div className={`comment ${isReply ? 'is-reply' : ''} ${c.status !== 'visible' ? 'is-moderated' : ''} ${reportable ? 'has-flag' : ''}`}>
      {reportable && (
        <button
          className={`comment-flag ${mode === 'report' ? 'is-selected' : ''}`}
          aria-label={t('reviews.report.title')}
          title={t('reviews.report.flag')}
          onClick={() => (!account ? onSignIn() : setMode(mode === 'report' ? null : 'report'))}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M3 1.5h1.5V15H3zM5.5 2h7.6l-1.8 3.25L13.1 8.5H5.5z" />
          </svg>
        </button>
      )}
      {c.author && !gone ? <Avatar url={c.author.avatarUrl} name={name} size={isReply ? 28 : 36} /> : <span className="avatar" style={{ width: isReply ? 28 : 36, height: isReply ? 28 : 36 }} aria-hidden />}
      <div className="comment-main">
        {!gone && (
          <div className="comment-head">
            <span className="comment-author">{name}</span>
            {c.byPackAuthor && <span className="badge badge-accent">{kind === 'mod' ? t('reviews.badge.modAuthor') : t('reviews.badge.packAuthor')}</span>}
            {c.byAdmin && <span className="badge">{t('reviews.badge.admin')}</span>}
            {c.authorRating !== null && <Score value={c.authorRating} size={13} />}
            <span className="muted small" title={fullDate(c.createdAt)}>
              {ago(c.createdAt)}
            </span>
            {c.editedByModerator ? (
              <span className="muted small" title={c.editedAt ? fullDate(c.editedAt) : undefined}>
                {t('reviews.modifiedByModerator')}
              </span>
            ) : (
              c.editedAt && (
                <span className="muted small" title={fullDate(c.editedAt)}>
                  {t('reviews.modified')}
                </span>
              )
            )}
            {c.pinned && <span className="badge pinned-badge">{t('reviews.badge.pinned')}</span>}
          </div>
        )}

        {mode === 'edit' && c.body !== null ? (
          <CommentForm
            initial={c.body}
            submitLabel={t('common.save')}
            autoFocus
            compact
            onSubmit={async (body) => {
              const ok = await act(() => window.api.packCommentEdit(packId, c.id, body, kind), t('reviews.edited'))
              if (ok) setMode(null)
              return ok
            }}
            onCancel={() => setMode(null)}
          />
        ) : gone ? (
          <p className="comment-body is-gone">{c.status === 'hidden' ? t('reviews.hiddenComment') : t('reviews.deletedComment')}</p>
        ) : (
          <p className="comment-body">
            {c.replyTo && <span className="mention">@{c.replyTo.author?.displayName ?? t('reviews.deletedAccount')} </span>}
            {c.body}
          </p>
        )}

        {/* Admin : commentaire masqué affiché avec son texte, la raison et les signalements. */}
        {admin && (c.status === 'hidden' || (c.reportCount ?? 0) > 0) && (
          <div className="moderation-note">
            {c.status === 'hidden' && (c.moderationReason ? t('reviews.moderationHiddenReason', { reason: c.moderationReason }) : t('reviews.moderationHidden'))}
            {c.status === 'hidden' && (c.reportCount ?? 0) > 0 && ' · '}
            {(c.reportCount ?? 0) > 0 && t('reviews.reports', { count: c.reportCount!, n: num(c.reportCount!) })}
          </div>
        )}

        {mode === 'report' && (
          <ReportForm
            onCancel={() => setMode(null)}
            onSubmit={async (reason) => {
              const ok = await act(() => window.api.packCommentReport(packId, c.id, reason, kind), t('reviews.report.done'))
              if (ok) setMode(null)
            }}
          />
        )}
        {mode === 'hide' && (
          <HideForm
            onCancel={() => setMode(null)}
            onSubmit={async (reason) => {
              const ok = await act(() => window.api.adminCommentHide(c.id, true, reason), t('reviews.hide.done'))
              if (ok) setMode(null)
            }}
          />
        )}

        {!mode && (c.canReply || hasMenu) && (
          <div className="comment-actions">
            {c.canReply && c.status === 'visible' && (
              <button className="link small" onClick={() => onReply(c)}>
                {t('reviews.reply')}
              </button>
            )}
            {hasMenu && (
              <button className="more small-more" aria-label={t('reviews.moreOptions')} title={t('reviews.moreOptions')} onClick={() => void menu()}>
                ⋯
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** Zone de saisie d'un commentaire (1 à 2 000 caractères, Ctrl+Entrée pour envoyer). Vidée quand l'envoi réussit. */
function CommentForm({
  initial = '',
  placeholder,
  submitLabel,
  autoFocus = false,
  compact = false,
  onSubmit,
  onCancel
}: {
  initial?: string
  placeholder?: string
  submitLabel: string
  autoFocus?: boolean
  compact?: boolean
  onSubmit: (body: string) => Promise<boolean>
  onCancel?: () => void
}) {
  const { t } = useTranslation()
  const [text, setText] = useState(initial)
  const [busy, setBusy] = useState(false)
  const empty = !text.trim()
  const unchanged = text.trim() === initial.trim()

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    if (empty || busy || (initial && unchanged)) return
    setBusy(true)
    const ok = await onSubmit(text)
    setBusy(false)
    if (ok && !initial) setText('')
  }

  return (
    <form className={`comment-form ${compact ? 'is-compact' : ''}`} onSubmit={(e) => void submit(e)}>
      <textarea
        className="input"
        rows={compact ? 3 : 4}
        value={text}
        placeholder={placeholder}
        maxLength={COMMENT_MAX}
        autoFocus={autoFocus}
        aria-label={placeholder ?? submitLabel}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit()
          if (e.key === 'Escape' && onCancel) onCancel()
        }}
      />
      <div className="form-actions">
        <span className={`hint ${text.length > COMMENT_MAX - 100 ? 'warn-text' : ''}`}>
          {t('reviews.charCount', { n: num(text.length), max: num(COMMENT_MAX) })}
        </span>
        <div className="spacer" />
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </button>
        )}
        <button type="submit" className="primary" disabled={empty || busy || (!!initial && unchanged)}>
          {submitLabel}
        </button>
      </div>
    </form>
  )
}

function ReportForm({ onSubmit, onCancel }: { onSubmit: (reason: string) => Promise<void>; onCancel: () => void }) {
  const { t } = useTranslation()
  const [reason, setReason] = useState<ReportReason>(REPORT_REASONS[0])
  const [details, setDetails] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    const text = details.trim()
    // Raison envoyée en clair aux modérateurs, toujours en français (langue de la modération) ; le détail saisi reste
    // dans la langue de l'utilisateur.
    const fr = i18next.getFixedT('fr')
    const label = fr(`reviews.report.reasons.${reason}`)
    await onSubmit(text ? (reason === 'other' ? text : fr('reviews.report.withDetails', { reason: label, details: text })) : label)
    setBusy(false)
  }
  return (
    <form className="inline-panel" onSubmit={(e) => void submit(e)}>
      <div className="field-label">{t('reviews.report.title')}</div>
      <div className="chips">
        {REPORT_REASONS.map((r) => (
          <button key={r} type="button" className={`chip ${reason === r ? 'is-selected' : ''}`} aria-pressed={reason === r} onClick={() => setReason(r)}>
            {t(`reviews.report.reasons.${r}`)}
          </button>
        ))}
      </div>
      <input
        className="input"
        placeholder={reason === 'other' ? t('reviews.report.specify') : t('reviews.report.detailsPlaceholder')}
        aria-label={t('reviews.report.details')}
        value={details}
        maxLength={300}
        onChange={(e) => setDetails(e.target.value)}
      />
      <div className="form-actions">
        <div className="spacer" />
        <button type="button" onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="primary" disabled={busy || (reason === 'other' && !details.trim())}>
          {t('reviews.report.submit')}
        </button>
      </div>
    </form>
  )
}

function HideForm({ onSubmit, onCancel }: { onSubmit: (reason: string) => Promise<void>; onCancel: () => void }) {
  const { t } = useTranslation()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    await onSubmit(reason)
    setBusy(false)
  }
  return (
    <form className="inline-panel" onSubmit={(e) => void submit(e)}>
      <div className="field-label">{t('reviews.hide.title')}</div>
      <input className="input" placeholder={t('reviews.hide.placeholder')} aria-label={t('reviews.hide.label')} value={reason} maxLength={300} autoFocus onChange={(e) => setReason(e.target.value)} />
      <div className="form-actions">
        <div className="spacer" />
        <button type="button" onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="primary" disabled={busy}>
          {t('reviews.hide.submit')}
        </button>
      </div>
    </form>
  )
}

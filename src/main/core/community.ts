// Notes et commentaires des packs et des mods, et ceux téléchargés par le compte connecté.
//
// Les requêtes passent par le compte (Account.call) : au nom du compte connecté, avec renouvellement du jeton d'accès,
// ou anonymes sans connexion (lecture seulement). Les réponses de l'API sont mises au format de l'interface : photos
// des auteurs servies par pm-media, champs absents remplacés par des valeurs neutres.
//
// Aucune dépendance à Electron ici (testé avec vitest).

import { t } from 'i18next'
import type { CommentPage, MarketKind, MarketPack, MyDownloadsPage, PackComment, PackRatings, RatingReason, ReplyPage } from '@shared/types'
import type { CommentQuery } from '@shared/api'
import { formatNumber } from '@shared/intl'
import { toAuthorRef, type Account } from './account'
import type { RemoteSummary } from './marketplace'

export const COMMENT_MAX = 2000
const COMMENTS_PAGE = 20
const DOWNLOADS_PAGE = 24

interface RemoteAuthorRef {
  id: number
  slug: string
  displayName: string
  avatarUrl: string | null
}

interface RemoteRatings {
  average?: number | null
  count?: number
  distribution?: Partial<Record<'1' | '2' | '3' | '4' | '5', number>> | null
  mine?: number | null
  downloaded?: boolean
  canRate?: boolean
  reason?: string | null
}

export interface RemoteComment {
  id: string
  packId: string
  parentId?: string | null
  replyTo?: { id: string; author: RemoteAuthorRef | null } | null
  status?: string
  body?: string | null
  author?: RemoteAuthorRef | null
  byPackAuthor?: boolean
  byAdmin?: boolean
  authorRating?: number | null
  pinned?: boolean
  createdAt: string
  editedAt?: string | null
  editedByModerator?: boolean
  replyCount?: number
  replies?: RemoteComment[]
  mine?: boolean
  canEdit?: boolean
  canDelete?: boolean
  canReply?: boolean
  moderationReason?: string | null
  reportCount?: number | null
}

interface RemotePage<T> {
  items?: T[]
  page?: number
  total?: number
  totalPages?: number
}

interface RemoteCommentPage extends RemotePage<RemoteComment> {
  commentCount?: number
  locked?: boolean
  canComment?: boolean
}

interface RemoteDownload {
  pack: RemoteSummary
  firstDownloadedAt?: string | null
  lastDownloadedAt?: string | null
  downloadCount?: number
  myRating?: number | null
}

const REASONS: RatingReason[] = ['login-required', 'download-required', 'own-pack', 'muted']

/** Nombre d'étoiles de 1 à 5, sinon null. */
const stars = (n: unknown): number | null => (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 5 ? n : null)

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0)

export function toRatings(r: RemoteRatings): PackRatings {
  const d = r.distribution ?? {}
  return {
    average: typeof r.average === 'number' && Number.isFinite(r.average) ? r.average : null,
    count: count(r.count),
    distribution: { 1: count(d['1']), 2: count(d['2']), 3: count(d['3']), 4: count(d['4']), 5: count(d['5']) },
    mine: stars(r.mine),
    downloaded: r.downloaded === true,
    canRate: r.canRate === true,
    reason: REASONS.find((x) => x === r.reason) ?? null
  }
}

export function toComment(r: RemoteComment): PackComment {
  const status = r.status === 'hidden' || r.status === 'deleted' ? r.status : 'visible'
  const replies = (r.replies ?? []).map(toComment)
  return {
    id: r.id,
    packId: r.packId,
    parentId: r.parentId ?? null,
    replyTo: r.replyTo ? { id: r.replyTo.id, author: r.replyTo.author ? toAuthorRef(r.replyTo.author) : null } : null,
    status,
    body: typeof r.body === 'string' ? r.body : null,
    author: r.author ? toAuthorRef(r.author) : null,
    byPackAuthor: r.byPackAuthor === true,
    byAdmin: r.byAdmin === true,
    authorRating: stars(r.authorRating),
    pinned: r.pinned === true,
    createdAt: r.createdAt,
    editedAt: r.editedAt ?? null,
    editedByModerator: r.editedByModerator === true,
    replyCount: Math.max(count(r.replyCount), replies.length),
    replies,
    mine: r.mine === true,
    canEdit: r.canEdit === true,
    canDelete: r.canDelete === true,
    canReply: r.canReply === true,
    moderationReason: r.moderationReason ?? null,
    reportCount: typeof r.reportCount === 'number' ? r.reportCount : null
  }
}

function toPage<T, U>(r: RemotePage<T>, map: (item: T) => U): { items: U[]; page: number; total: number; totalPages: number } {
  return { items: (r.items ?? []).map(map), page: r.page ?? 0, total: count(r.total), totalPages: count(r.totalPages) }
}

export function toCommentPage(r: RemoteCommentPage): CommentPage {
  return { ...toPage(r, toComment), commentCount: count(r.commentCount), locked: r.locked === true, canComment: r.canComment === true }
}

/** Texte d'un commentaire : 1 à 2 000 caractères, sans les espaces autour. */
export function commentBody(body: string): string {
  const text = body.trim()
  if (!text) throw new Error(t('community.errors.emptyComment'))
  if (text.length > COMMENT_MAX) throw new Error(t('community.errors.commentTooLong', { max: formatNumber(COMMENT_MAX) }))
  return text
}

const seg = encodeURIComponent

/** Fiche d'un pack ou d'un mod : /packs/<id> ou /mods/<id> (l'API refuse un mod demandé à /packs, et l'inverse). */
const item = (kind: MarketKind, id: string): string => `/${kind === 'mod' ? 'mods' : 'packs'}/${seg(id)}`

export class Community {
  constructor(
    private account: Account,
    /** Packs de l'API au format de l'interface, avec leur état dans la bibliothèque. */
    private toPacks: (items: RemoteSummary[]) => Promise<MarketPack[]>
  ) {}

  async ratings(packId: string, kind: MarketKind = 'pack'): Promise<PackRatings> {
    return toRatings(await this.account.call<RemoteRatings>('GET', `${item(kind, packId)}/ratings`))
  }

  /** Note de 1 à 5 étoiles ; null retire la note. */
  async rate(packId: string, value: number | null, kind: MarketKind = 'pack'): Promise<PackRatings> {
    const pathname = `${item(kind, packId)}/rating`
    if (value === null) {
      const r = await this.account.call<RemoteRatings | undefined>('DELETE', pathname, { auth: 'required' })
      // Réponse vide (204) : notes relues.
      return r ? toRatings(r) : this.ratings(packId, kind)
    }
    if (stars(value) === null) throw new Error(t('community.errors.invalidRating'))
    return toRatings(await this.account.call<RemoteRatings>('PUT', pathname, { json: { stars: value }, auth: 'required' }))
  }

  async comments(packId: string, query: CommentQuery, kind: MarketKind = 'pack'): Promise<CommentPage> {
    const params = new URLSearchParams({ sort: query.sort ?? 'recent', page: String(query.page ?? 0), size: String(COMMENTS_PAGE) })
    return toCommentPage(await this.account.call<RemoteCommentPage>('GET', `${item(kind, packId)}/comments?${params}`))
  }

  async replies(packId: string, commentId: string, page: number, size = COMMENTS_PAGE, kind: MarketKind = 'pack'): Promise<ReplyPage> {
    const params = new URLSearchParams({ page: String(page), size: String(Math.min(Math.max(size, 1), 100)) })
    const r = await this.account.call<RemotePage<RemoteComment>>('GET', `${item(kind, packId)}/comments/${seg(commentId)}/replies?${params}`)
    return toPage(r, toComment)
  }

  async post(packId: string, body: string, parentId?: string, kind: MarketKind = 'pack'): Promise<PackComment> {
    const json = parentId ? { body: commentBody(body), parentId } : { body: commentBody(body) }
    return toComment(await this.account.call<RemoteComment>('POST', `${item(kind, packId)}/comments`, { json, auth: 'required' }))
  }

  async edit(packId: string, commentId: string, body: string, kind: MarketKind = 'pack'): Promise<PackComment> {
    const json = { body: commentBody(body) }
    return toComment(await this.account.call<RemoteComment>('PUT', `${item(kind, packId)}/comments/${seg(commentId)}`, { json, auth: 'required' }))
  }

  async remove(packId: string, commentId: string, kind: MarketKind = 'pack'): Promise<void> {
    await this.account.call('DELETE', `${item(kind, packId)}/comments/${seg(commentId)}`, { auth: 'required' })
  }

  async report(packId: string, commentId: string, reason?: string, kind: MarketKind = 'pack'): Promise<void> {
    const text = reason?.trim().slice(0, 500)
    await this.account.call('POST', `${item(kind, packId)}/comments/${seg(commentId)}/report`, { json: text ? { reason: text } : {}, auth: 'required' })
  }

  async hide(commentId: string, hidden: boolean, reason?: string): Promise<void> {
    const text = reason?.trim()
    const json = hidden && text ? { hidden, reason: text } : { hidden }
    await this.account.call('PUT', `/admin/comments/${seg(commentId)}/hidden`, { json, auth: 'required' })
  }

  async pin(commentId: string, pinned: boolean): Promise<void> {
    await this.account.call('PUT', `/admin/comments/${seg(commentId)}/pinned`, { json: { pinned }, auth: 'required' })
  }

  async purge(commentId: string): Promise<void> {
    await this.account.call('DELETE', `/admin/comments/${seg(commentId)}`, { auth: 'required' })
  }

  /** Packs et mods téléchargés par le compte ; `kind` : seulement les packs, ou seulement les mods. */
  async myDownloads(page: number, kind?: MarketKind): Promise<MyDownloadsPage> {
    const params = new URLSearchParams({ page: String(page), size: String(DOWNLOADS_PAGE) })
    if (kind) params.set('kind', kind)
    const r = await this.account.call<RemotePage<RemoteDownload>>('GET', `/me/downloads?${params}`, { auth: 'required' })
    const items = (r.items ?? []).filter((d) => d?.pack?.id)
    const packs = await this.toPacks(items.map((d) => d.pack))
    return {
      ...toPage({ ...r, items }, () => null),
      items: items.map((d, i) => ({
        pack: packs[i],
        firstDownloadedAt: d.firstDownloadedAt ?? null,
        lastDownloadedAt: d.lastDownloadedAt ?? null,
        downloadCount: count(d.downloadCount),
        myRating: stars(d.myRating)
      }))
    }
  }
}

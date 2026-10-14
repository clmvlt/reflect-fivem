// Marketplace : packs graphiques et mods publiés sur reflect-fivem.com, téléchargés directement dans la bibliothèque
// (celle des packs, ou celle des mods).
//
// Les deux catalogues ont le même format et sont séparés : /packs/... pour les packs, /mods/... pour les mods (un pack
// n'est jamais demandé à /mods, ni un mod à /packs : l'API répondrait 404).
// Le téléchargement se fait dans <bibliothèque>/.downloads/<id>/ (conservé entre deux lancements pour reprendre
// là où il s'était arrêté), l'archive est vérifiée (SHA-256) puis importée comme un pack ajouté à la main.
// Pack chiffré : le serveur n'envoie jamais son archive mais un paquet chiffré, gardé tel quel dans la bibliothèque
// (pack protégé, voir library.ts), et sa clé.
// Le pack garde un lien vers sa fiche (marketplace.id / sha256) : une autre empreinte en ligne signale une
// nouvelle version. Les images sont servies à l'interface par pm-media://market/... avec un cache sur le disque, les
// photos des auteurs par pm-media://avatar/... (même cache).
// Compte connecté : l'archive, le paquet chiffré et sa clé sont demandés avec son jeton d'accès, pour que le
// téléchargement lui soit compté (nécessaire pour noter le pack). Sans connexion, le téléchargement reste anonyme.

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { net } from 'electron'
import { t } from 'i18next'
import type {
  AuthorPage,
  AuthorProfile,
  MarketCategory,
  MarketKind,
  MarketPack,
  MarketPackDetail,
  MarketPage,
  MarketRating,
  MarketTag,
  ProfileLink
} from '@shared/types'
import { MOD_GONE, PACK_GONE, type AuthorQuery, type MarketQuery } from '@shared/api'
import { formatBytes as displayBytes } from '@shared/intl'
import { parsePackPerformance, parsePerformanceDetail, type PerformanceDetail } from '@shared/performance'
import { ApiError, toAuthorRef } from './account'
import { languageFetch } from './http'
import type { Report } from './installer'
import type { ImportProgress, Library, StoredManifest } from './library'
import { KEY_SIZE, packageId } from './sealed'
import { exists, formatBytes, freeSpace, walkFiles } from '../util/fsx'
import { log } from '../util/log'

interface RemoteImage {
  id: string
  width: number
  height: number
}

export interface RemoteSummary {
  id: string
  /** « pack » ou « mod » (absent avec une API plus ancienne : pack). */
  kind?: string
  /** Catégorie d'un mod (clé). */
  category?: string | null
  slug: string
  name: string
  summary: string
  author: string
  version: string
  tags: string[]
  archiveName: string | null
  archiveSize: number | null
  sha256: string | null
  downloadCount: number
  publishedAt: string | null
  updatedAt: string
  archiveUpdatedAt: string | null
  cover: RemoteImage | null
  /** Compte de l'auteur (null si le pack n'est rattaché à aucun compte). */
  authorProfile?: RemoteAuthorRef | null
  /** Pack du moment (absent avec une API plus ancienne). */
  featured?: boolean
  /** Pack chiffré : installable seulement avec l'application, qui télécharge {@link encryptedPackage}. */
  encrypted?: boolean
  encryptedPackage?: { size?: number | null; sha256?: string | null } | null
  /** Absents avec une API plus ancienne. */
  rating?: { average?: number | null; count?: number } | null
  commentCount?: number
  commentsLocked?: boolean
  /** Poids sur les performances (null : pas encore analysé ; absent avec une API plus ancienne). */
  performance?: unknown
}

interface RemoteAuthorRef {
  id: number
  slug: string
  displayName: string
  avatarUrl: string | null
}

interface RemoteAuthor extends RemoteAuthorRef {
  bio: string | null
  links: ProfileLink[] | null
  createdAt: string | null
  packCount: number
  modCount?: number
  downloads: number
}

interface RemoteAuthorPage {
  items: (RemoteAuthorRef & { packCount: number; modCount?: number; downloads: number })[]
  page: number
  total: number
  totalPages: number
}

interface RemoteDetail extends RemoteSummary {
  description: string
  images: RemoteImage[]
  youtubeId?: string | null
}

interface RemotePage {
  items: RemoteSummary[]
  page: number
  size: number
  total: number
  totalPages: number
}

/** Jeton d'accès du compte connecté (voir Account), pour les téléchargements. */
export interface DownloadAuth {
  /** Jeton valide (renouvelé s'il expire bientôt), null sans connexion. */
  accessToken(): Promise<string | null>
  /** Jeton refusé par l'API : renouvelé, puis renvoyé (null si la connexion a expiré). */
  renewRejected(token: string): Promise<string | null>
}

export interface InstallHooks {
  /** Pack actuellement installé dans le jeu. */
  activeId: () => string | null
  /** Installe un pack dans le jeu (remplace le pack installé). */
  apply: (packId: string, report: Report) => Promise<unknown>
  /**
   * Mod tout juste ajouté : activé s'il n'entre en conflit avec rien. Renvoie null s'il a été activé, sinon la raison
   * pour laquelle il ne l'a pas été.
   */
  enableMod?: (modId: string, report: Report) => Promise<string | null>
  /** Nouvelle version d'un mod : remplace l'ancienne dans le jeu si elle était activée (true dans ce cas). */
  replaceMod?: (oldId: string, next: StoredManifest, report: Report) => Promise<boolean>
}

export interface InstallResult {
  packId: string
  name: string
  kind: MarketKind
  status: 'added' | 'updated' | 'linked' | 'up-to-date'
  /** Mod activé dans le jeu à la fin du téléchargement. */
  enabled?: boolean
  /** Message à afficher (mise à jour faite mais pas encore installée dans le jeu, par exemple). */
  note?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const USER_ID = /^\d{1,18}$/
const AVATAR_VERSION = /^[A-Za-z0-9_-]{1,64}$/
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/
const IMAGE_CACHE_MAX = 300 * 1024 * 1024
const KINDS: MarketKind[] = ['pack', 'mod']

/** Segment d'adresse du catalogue : /packs ou /mods. */
const catalogPath = (kind: MarketKind): string => (kind === 'mod' ? '/mods' : '/packs')
/** Pack ou mod inconnu (ou retiré) de l'API : code PACK_GONE ou MOD_GONE, message dans la langue affichée. */
const goneError = (kind: MarketKind): ApiError =>
  kind === 'mod' ? new ApiError(t('market.modGone'), 404, MOD_GONE) : new ApiError(t('market.packGone'), 404, PACK_GONE)
const isGone = (err: unknown): boolean => err instanceof ApiError && (err.code === PACK_GONE || err.code === MOD_GONE)
/** Requêtes vers l'API, avec la langue affichée (Accept-Language). */
const apiFetch = languageFetch((url, init) => net.fetch(url, init))
const kindOf = (r: { kind?: string }): MarketKind => (r.kind === 'mod' ? 'mod' : 'pack')

/** Vidéo YouTube de la fiche (null si aucune, ou si l'identifiant reçu n'en est pas un). */
function youtubeId(r: RemoteDetail): string | null {
  return r.youtubeId && YOUTUBE_ID.test(r.youtubeId) ? r.youtubeId : null
}

/** Nom de l'auteur gardé en texte (fiche et bibliothèque) : celui de la fiche, sinon celui de son compte. */
function authorName(r: RemoteSummary): string {
  return r.author || r.authorProfile?.displayName || ''
}

function ratingOf(r: RemoteSummary): MarketRating {
  const average = r.rating?.average
  return { average: typeof average === 'number' && Number.isFinite(average) ? average : null, count: r.rating?.count ?? 0 }
}

/** Corps d'une erreur de l'API (application/problem+json), lu sur une copie de la réponse. */
async function problemOf(response: Response): Promise<{ detail: string | null; code: string | null }> {
  const p = (await response.clone().json().catch(() => null)) as { detail?: unknown; code?: unknown } | null
  return { detail: typeof p?.detail === 'string' && p.detail.trim() ? p.detail : null, code: typeof p?.code === 'string' ? p.code : null }
}

/** Pack de l'API tel que l'interface le reçoit ; `local` : sa version la plus récente dans la bibliothèque. */
export function toMarketPack(r: RemoteSummary, local: StoredManifest | undefined): MarketPack {
  const kind = kindOf(r)
  return {
    id: r.id,
    kind,
    category: kind === 'mod' ? (r.category ?? null) : null,
    slug: r.slug,
    name: r.name,
    summary: r.summary,
    author: authorName(r),
    version: r.version,
    tags: r.tags,
    archiveSize: (r.encrypted ? r.encryptedPackage?.size : r.archiveSize) ?? 0,
    sha256: r.sha256 ?? '',
    protected: !!r.encrypted,
    downloadCount: r.downloadCount,
    publishedAt: r.publishedAt,
    updatedAt: r.updatedAt,
    archiveUpdatedAt: r.archiveUpdatedAt,
    cover: r.cover,
    authorProfile: r.authorProfile ? toAuthorRef(r.authorProfile) : null,
    featured: r.featured === true,
    rating: ratingOf(r),
    commentCount: r.commentCount ?? 0,
    commentsLocked: r.commentsLocked === true,
    // API plus ancienne, sans le champ : rien à afficher (et non « pas encore analysé »).
    ...('performance' in r ? { performance: parsePackPerformance(r.performance) } : {}),
    localId: local?.id ?? null,
    updateAvailable: !!local && local.marketplace!.sha256 !== r.sha256
  }
}

/** Fichier téléchargé pour un pack : son archive, ou son paquet chiffré. */
interface Download {
  url: string
  name: string
  size: number
  sha256: string
}

function downloadOf(r: RemoteDetail, apiUrl: string, kind: MarketKind): Download | null {
  const base = `${apiUrl}${catalogPath(kind)}/${r.id}`
  if (r.encrypted) {
    const p = r.encryptedPackage
    if (!p?.size || !p.sha256 || !r.archiveName) return null
    return { url: `${base}/package`, name: `${r.archiveName.replace(/\.(zip|rar|7z|rpf)$/i, '')}.fpk`, size: p.size, sha256: p.sha256 }
  }
  if (!r.sha256 || !r.archiveSize || !r.archiveName) return null
  return { url: `${base}/download`, name: r.archiveName, size: r.archiveSize, sha256: r.sha256 }
}

export class Marketplace {
  private catalog = new Map<string, RemoteSummary>()
  /** Catalogues lus en entier (un élément absent n'est plus publié). */
  private complete = new Set<MarketKind>()

  constructor(
    private apiUrl: string,
    private cacheDir: string,
    private library: () => Library,
    private auth: DownloadAuth | null = null,
    /** Bibliothèque des mods (absente : les mods ne sont pas suivis). */
    private modLibrary: (() => Library) | null = null
  ) {}

  private libraryOf(kind: MarketKind): Library {
    if (kind === 'pack') return this.library()
    if (!this.modLibrary) throw new Error(t('market.errors.noModLibrary'))
    return this.modLibrary()
  }

  // ------------------------------------------------------------------ lecture

  /** `asAccount` : requête envoyée au nom du compte connecté (clé d'un paquet chiffré). */
  private async get<T>(pathAndQuery: string, notFound: () => Error = () => goneError('pack'), asAccount = false): Promise<T> {
    const url = `${this.apiUrl}${pathAndQuery}`
    let response: Response
    try {
      const signal = AbortSignal.timeout(20_000)
      response = asAccount ? await this.fetchAsAccount(url, { signal }) : await apiFetch(url, { signal })
    } catch {
      throw new Error(t('market.errors.unreachable'))
    }
    if (response.status === 404) throw notFound()
    if (!response.ok) throw new Error((await problemOf(response)).detail ?? t('market.errors.badStatus', { status: response.status }))
    return (await response.json()) as T
  }

  /** Jeton d'accès du compte connecté ; null sans connexion, ou si elle n'a pas pu être renouvelée (requête anonyme). */
  private async token(): Promise<string | null> {
    try {
      return (await this.auth?.accessToken()) ?? null
    } catch (err) {
      log.info(`Téléchargement anonyme : connexion non renouvelée (${(err as Error).message})`)
      return null
    }
  }

  /**
   * Requête avec le jeton d'accès du compte connecté, demandé à chaque fois : l'API ne le vérifie qu'au début de la
   * requête, il est donc renouvelé avant de lancer ou de reprendre un téléchargement. Refusé (401 « token-invalid ») :
   * renouvelé une fois, puis la requête est rejouée.
   */
  private async fetchAsAccount(url: string, init: { headers?: Record<string, string>; signal: AbortSignal }): Promise<Response> {
    const send = (token: string | null): Promise<Response> =>
      apiFetch(url, { ...init, headers: { ...init.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) } })
    const token = await this.token()
    const response = await send(token)
    if (response.status !== 401 || !token || !this.auth || (await problemOf(response)).code !== 'token-invalid') return response
    let next: string | null = null
    try {
      next = await this.auth.renewRejected(token)
    } catch (err) {
      log.info(`Téléchargement anonyme : connexion non renouvelée (${(err as Error).message})`)
    }
    return send(next)
  }

  private async localIndex(kind: MarketKind = 'pack'): Promise<Map<string, StoredManifest>> {
    const index = new Map<string, StoredManifest>()
    if (kind === 'mod' && !this.modLibrary) return index
    for (const m of await this.libraryOf(kind).list()) {
      if (!m.marketplace || m.deleting) continue
      // Deux versions du même pack (mise à jour pas encore installée) : la plus récente fait foi.
      const other = index.get(m.marketplace.id)
      if (!other || other.marketplace!.downloadedAt < m.marketplace.downloadedAt) index.set(m.marketplace.id, m)
    }
    return index
  }

  /** Packs et mods reçus d'une autre partie de l'API (téléchargés par le compte), avec leur état dans la bibliothèque. */
  async toPacks(items: RemoteSummary[]): Promise<MarketPack[]> {
    const packs = await this.localIndex('pack')
    const mods = items.some((r) => kindOf(r) === 'mod') ? await this.localIndex('mod') : new Map<string, StoredManifest>()
    return items.map((r) => toMarketPack(r, (kindOf(r) === 'mod' ? mods : packs).get(r.id)))
  }

  async list(query: MarketQuery): Promise<MarketPage> {
    const kind = query.kind ?? 'pack'
    const params = new URLSearchParams({ page: String(query.page ?? 0), size: '24', sort: query.sort ?? 'recommended' })
    if (query.q?.trim()) params.set('q', query.q.trim())
    if (query.tag) params.set('tag', query.tag)
    if (query.author) params.set('author', query.author)
    if (kind === 'mod' && query.category) params.set('category', query.category)
    // « Compatibles avec mon PC » seulement : sinon, rien de la machine ne part vers l'API.
    if (Number.isInteger(query.vram) && query.vram! > 0) params.set('vram', String(query.vram))
    if (Number.isInteger(query.gpuClass) && query.gpuClass! >= 0) params.set('gpuClass', String(query.gpuClass))
    const [page, index] = await Promise.all([this.get<RemotePage>(`${catalogPath(kind)}?${params}`), this.localIndex(kind)])
    for (const r of page.items) this.catalog.set(r.id, r)
    return { items: page.items.map((r) => toMarketPack(r, index.get(r.id))), page: page.page, total: page.total, totalPages: page.totalPages }
  }

  tags(kind: MarketKind = 'pack'): Promise<MarketTag[]> {
    return this.get<MarketTag[]>(`${catalogPath(kind)}/tags`)
  }

  /** Catégories des mods (libellés de l'API), dans l'ordre de l'API. */
  async categories(): Promise<MarketCategory[]> {
    const items = await this.get<MarketCategory[]>('/mods/categories')
    return (Array.isArray(items) ? items : [])
      .filter((c) => typeof c?.key === 'string')
      .map((c) => ({ key: c.key, label: typeof c.label === 'string' && c.label ? c.label : c.key, count: typeof c.count === 'number' ? c.count : 0 }))
  }

  /** Packs (ou mods) du moment, dans l'ordre de l'API. Erreur ou API plus ancienne (404) : aucun. */
  async featured(kind: MarketKind = 'pack'): Promise<MarketPack[]> {
    try {
      const [items, index] = await Promise.all([this.get<RemoteSummary[]>(`${catalogPath(kind)}/featured`), this.localIndex(kind)])
      if (!Array.isArray(items)) return []
      for (const r of items) this.catalog.set(r.id, r)
      return items.map((r) => toMarketPack(r, index.get(r.id)))
    } catch (err) {
      log.info(`${kind === 'mod' ? 'Mods' : 'Packs'} du moment non chargés : ${(err as Error).message}`)
      return []
    }
  }

  async detail(idOrSlug: string, kind: MarketKind = 'pack'): Promise<MarketPackDetail> {
    const [r, index] = await Promise.all([this.remoteDetail(idOrSlug, kind), this.localIndex(kind)])
    return { ...toMarketPack(r, index.get(r.id)), description: r.description, archiveName: r.archiveName ?? '', images: r.images, youtubeId: youtubeId(r) }
  }

  /**
   * Analyse détaillée du poids d'un pack sur les performances. Null si l'API ne la fournit pas (version plus ancienne)
   * ou si sa réponse est inutilisable ; les autres erreurs remontent.
   */
  async performance(id: string, kind: MarketKind = 'pack'): Promise<PerformanceDetail | null> {
    if (!UUID.test(id)) return null
    try {
      return parsePerformanceDetail(await this.get<unknown>(`${catalogPath(kind)}/${id}/performance`, () => goneError(kind)))
    } catch (err) {
      if (isGone(err)) return null
      throw err
    }
  }

  private async remoteDetail(idOrSlug: string, kind: MarketKind): Promise<RemoteDetail> {
    const r = await this.get<RemoteDetail>(`${catalogPath(kind)}/${encodeURIComponent(idOrSlug)}`, () => goneError(kind))
    // Fiche d'une API plus ancienne, sans genre : celle du catalogue demandé.
    const detail = { ...r, kind: r.kind ?? kind }
    this.catalog.set(detail.id, detail)
    return detail
  }

  /** Auteurs ayant au moins un pack publié. */
  async authors(query: AuthorQuery): Promise<AuthorPage> {
    const params = new URLSearchParams({ page: String(query.page ?? 0), size: '24', sort: query.sort ?? 'popular' })
    if (query.q?.trim()) params.set('q', query.q.trim())
    const r = await this.get<RemoteAuthorPage>(`/authors?${params}`)
    return {
      items: r.items.map((a) => ({ ...toAuthorRef(a), packCount: a.packCount ?? 0, modCount: a.modCount ?? 0, downloads: a.downloads ?? 0 })),
      page: r.page,
      total: r.total,
      totalPages: r.totalPages
    }
  }

  /** Page publique d'un auteur. */
  async author(slugOrId: string): Promise<AuthorProfile> {
    const r = await this.get<RemoteAuthor>(`/authors/${encodeURIComponent(slugOrId)}`, () => new Error(t('market.authorGone')))
    return {
      ...toAuthorRef(r),
      bio: r.bio ?? '',
      // Liens ouverts dans le navigateur : http(s) seulement.
      links: (r.links ?? []).filter((l) => /^https?:\/\//i.test(l.url)).map((l) => ({ label: l.label, url: l.url })),
      createdAt: r.createdAt ?? null,
      packCount: r.packCount ?? 0,
      modCount: r.modCount ?? 0,
      downloads: r.downloads ?? 0
    }
  }

  /** Catalogues complets (packs, puis mods), pour signaler les mises à jour dans la bibliothèque. */
  async refreshCatalog(): Promise<void> {
    const all = new Map<string, RemoteSummary>()
    const complete = new Set<MarketKind>()
    for (const kind of KINDS) {
      if (kind === 'mod' && !this.modLibrary) continue
      try {
        for (let page = 0; page < 50; page++) {
          const result = await this.get<RemotePage>(`${catalogPath(kind)}?page=${page}&size=100`)
          for (const r of result.items) all.set(r.id, { ...r, kind: r.kind ?? kind })
          if (page + 1 >= result.totalPages) break
        }
        complete.add(kind)
      } catch (err) {
        // Packs : l'erreur remonte. Mods : API plus ancienne, ou erreur passagère (les mods ne sont pas marqués retirés).
        if (kind === 'pack') throw err
        log.info(`Catalogue des mods non chargé : ${(err as Error).message}`)
      }
    }
    this.catalog = all
    this.complete = complete
  }

  /** Packs et mods de la bibliothèque dont une autre version est en ligne, et ceux qui ne sont plus publiés. */
  async status(): Promise<{ updates: string[]; gone: string[] }> {
    const updates: string[] = []
    const gone: string[] = []
    for (const kind of KINDS) {
      for (const m of (await this.localIndex(kind)).values()) {
        const remote = this.catalog.get(m.marketplace!.id)
        if (remote) {
          if (remote.sha256 && remote.sha256 !== m.marketplace!.sha256) updates.push(m.id)
        } else if (this.complete.has(kind)) gone.push(m.id)
      }
    }
    return { updates, gone }
  }

  /**
   * Adresse d'une page du site : même domaine que l'API (en développement, le serveur Vite sur le port 5173). Les
   * adresses officielles des pages se terminent par « / » (ex. /packs/bh-1960/) ; les autres passent par une redirection.
   */
  siteUrl(sitePath: string): string {
    const site = this.apiUrl.replace(/\/api\/?$/, '').replace(/:8080$/, ':5173')
    return `${site}${sitePath}`
  }

  // ------------------------------------------------------------------ images

  /** pm-media://market/<pack>/<image>[?size=thumb][&kind=mod] : image mise en cache sur le disque (les images ne changent jamais). */
  async image(packId: string, imageId: string, thumb: boolean, kind: MarketKind = 'pack'): Promise<Response> {
    if (!UUID.test(packId) || !UUID.test(imageId)) return new Response('Interdit', { status: 403 })
    const file = path.join(this.cacheDir, `${imageId}${thumb ? '-thumb' : ''}.jpg`)
    if (await exists(file)) return net.fetch(pathToFileURL(file).toString())
    try {
      const data = await this.fetchImage(packId, imageId, thumb, kind)
      await fs.mkdir(this.cacheDir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await fs.writeFile(tmp, data)
      await fs.rename(tmp, file).catch(() => fs.rm(tmp, { force: true }))
      return new Response(new Uint8Array(data), { headers: { 'Content-Type': 'image/jpeg' } })
    } catch {
      return new Response('', { status: 404 })
    }
  }

  /** pm-media://avatar/<compte>/<version> : photo d'un compte, en cache (l'adresse change avec la photo). */
  async avatar(userId: string, version: string): Promise<Response> {
    if (!USER_ID.test(userId) || !AVATAR_VERSION.test(version)) return new Response('Interdit', { status: 403 })
    const file = path.join(this.cacheDir, `avatar-${userId}-${version}.jpg`)
    if (await exists(file)) return net.fetch(pathToFileURL(file).toString())
    try {
      const response = await apiFetch(`${this.apiUrl}/users/${userId}/avatar?v=${version}`, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = Buffer.from(await response.arrayBuffer())
      if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error('Image invalide')
      await fs.mkdir(this.cacheDir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await fs.writeFile(tmp, data)
      await fs.rename(tmp, file).catch(() => fs.rm(tmp, { force: true }))
      return new Response(new Uint8Array(data), { headers: { 'Content-Type': 'image/jpeg' } })
    } catch {
      return new Response('', { status: 404 })
    }
  }

  private async fetchImage(packId: string, imageId: string, thumb: boolean, kind: MarketKind): Promise<Buffer> {
    const response = await apiFetch(`${this.apiUrl}${catalogPath(kind)}/${packId}/images/${imageId}${thumb ? '?size=thumb' : ''}`, {
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = Buffer.from(await response.arrayBuffer())
    // Toujours du JPEG (ré-encodé par le serveur).
    if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error('Image invalide')
    return data
  }

  /** Garde le cache des images sous 300 Mo en supprimant les plus anciennes. */
  async pruneImageCache(): Promise<void> {
    const files = await walkFiles(this.cacheDir).catch(() => [])
    let total = files.reduce((s, f) => s + f.size, 0)
    if (total <= IMAGE_CACHE_MAX) return
    const stats = await Promise.all(
      files.map(async (f) => ({ f, mtime: (await fs.stat(path.join(this.cacheDir, f.rel)).catch(() => null))?.mtimeMs ?? 0 }))
    )
    stats.sort((a, b) => a.mtime - b.mtime)
    for (const { f } of stats) {
      if (total <= IMAGE_CACHE_MAX * 0.7) break
      await fs.rm(path.join(this.cacheDir, f.rel), { force: true }).catch(() => undefined)
      total -= f.size
    }
  }

  /** Téléchargements abandonnés depuis plus d'une semaine. */
  async pruneDownloads(): Promise<void> {
    const root = path.join(this.library().dir, '.downloads')
    const limit = Date.now() - 7 * 24 * 3600 * 1000
    for (const e of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      const dir = path.join(root, e.name)
      const st = await fs.stat(dir).catch(() => null)
      if (st && st.mtimeMs < limit) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  // ------------------------------------------------------------------ téléchargement et ajout à la bibliothèque

  async install(id: string, report: Report, signal: AbortSignal, hooks: InstallHooks, kind: MarketKind = 'pack'): Promise<InstallResult> {
    const remote = await this.remoteDetail(id, kind)
    const download = downloadOf(remote, this.apiUrl, kind)
    if (!download || !remote.sha256 || !remote.archiveName) throw new Error(t(kind === 'mod' ? 'market.errors.noArchiveMod' : 'market.errors.noArchivePack'))
    const lib = this.libraryOf(kind)
    const index = await this.localIndex(kind)
    const linked = index.get(remote.id) ?? null

    if (linked && linked.marketplace!.sha256 === remote.sha256) {
      await this.applyMetadata(lib, linked, remote, false, report)
      return { packId: linked.id, name: linked.name, kind, status: 'up-to-date' }
    }
    if (!linked) {
      // Même archive déjà ajoutée à la main : on la relie à sa fiche plutôt que de la télécharger à nouveau.
      const duplicate = await lib.findDuplicate(remote.archiveName, remote.archiveSize ?? 0)
      if (duplicate && !duplicate.marketplace) {
        await this.applyMetadata(lib, duplicate, remote, false, report)
        return { packId: duplicate.id, name: duplicate.name, kind, status: 'linked' }
      }
    }

    const file = await this.download(remote, download, report, signal)
    const onProgress = (p: ImportProgress): void => report(p.phase, p.current, p.total)
    let imported: StoredManifest
    try {
      if (remote.encrypted) {
        report(t(kind === 'mod' ? 'market.phase.unlockMod' : 'market.phase.unlockPack'), 0, 0)
        const { packageId: expected, key } = await this.packageKey(remote.id, kind)
        if ((await packageId(file)) !== expected) {
          await fs.rm(path.dirname(file), { recursive: true, force: true }).catch(() => undefined)
          throw new Error(t(kind === 'mod' ? 'market.errors.changedDuringDownloadMod' : 'market.errors.changedDuringDownloadPack'))
        }
        imported = await lib.importPackage(file, key, { name: remote.archiveName, size: remote.archiveSize ?? 0 }, onProgress, kind)
      } else imported = await lib.import(file, onProgress, signal, { skipDuplicateCheck: true, kind })
    } catch (err) {
      // Mod sans rien d'installable dans FiveM.app : l'archive ne servira pas.
      if (kind === 'mod') await fs.rm(path.dirname(file), { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
    await this.applyMetadata(lib, imported, remote, true, report)
    await fs.rm(path.dirname(file), { recursive: true, force: true }).catch(() => undefined)
    log.info(`Marketplace : ${remote.name} téléchargé (${formatBytes(download.size)}${remote.encrypted ? ', protégé' : ''})`)
    if (kind === 'mod') return this.afterModDownload(lib, imported, linked, report, hooks)
    if (!linked) return { packId: imported.id, name: imported.name, kind, status: 'added' }

    // Nouvelle version d'un pack déjà présent : même nom, même preset, mêmes réglages personnels.
    const next = await lib.get(imported.id)
    next.name = linked.name
    if (linked.reshadePreset && (next.reshadePresets ?? []).includes(linked.reshadePreset)) next.reshadePreset = linked.reshadePreset
    await lib.save(next)
    await lib.copyUserConfigs(linked.id, next.id)

    if (hooks.activeId() === linked.id) {
      try {
        await hooks.apply(next.id, report)
        // Réglages modifiés pendant la dernière partie, récupérés au remplacement : repris pour la suite.
        await lib.copyUserConfigs(linked.id, next.id)
      } catch (err) {
        log.warn(`Nouvelle version de ${linked.name} non installée : ${(err as Error).message}`)
        return {
          packId: next.id,
          name: next.name,
          kind,
          status: 'updated',
          note: t('market.notes.updateNotInstalled', { name: linked.name, error: (err as Error).message })
        }
      }
    }
    await lib.remove(linked.id)
    return { packId: next.id, name: next.name, kind, status: 'updated' }
  }

  /**
   * Mod tout juste téléchargé. Nouveau : activé s'il n'entre en conflit avec rien. Nouvelle version : remplace
   * l'ancienne (dans le jeu aussi si elle était activée) ; en cas d'échec, l'ancienne est gardée telle quelle.
   */
  private async afterModDownload(lib: Library, imported: StoredManifest, linked: StoredManifest | null, report: Report, hooks: InstallHooks): Promise<InstallResult> {
    if (!linked) {
      const reason = hooks.enableMod ? await hooks.enableMod(imported.id, report) : t('market.notes.enableFromLibrary')
      const note = reason ? t('market.notes.modNotEnabled', { name: imported.name, reason }) : undefined
      return { packId: imported.id, name: imported.name, kind: 'mod', status: 'added', enabled: !reason, note }
    }
    const next = await lib.get(imported.id)
    next.name = linked.name
    await lib.save(next)
    await lib.copyUserConfigs(linked.id, next.id)
    let enabled = false
    try {
      enabled = hooks.replaceMod ? await hooks.replaceMod(linked.id, next, report) : false
    } catch (err) {
      await lib.remove(next.id).catch(() => undefined)
      throw new Error(t('market.errors.modUpdateFailed', { name: linked.name, error: (err as Error).message }))
    }
    // Réglages modifiés pendant la dernière partie, récupérés au remplacement : repris pour la suite.
    await lib.copyUserConfigs(linked.id, next.id)
    await lib.remove(linked.id)
    return { packId: next.id, name: next.name, kind: 'mod', status: 'updated', enabled }
  }

  /**
   * Pack déjà dans la bibliothèque mais téléchargé sans être connecté : téléchargé de nouveau au nom du compte, sans rien
   * changer à la bibliothèque, pour que le compte puisse le noter. Pack chiffré : demander sa clé suffit.
   */
  async claim(id: string, report: Report, signal: AbortSignal, kind: MarketKind = 'pack'): Promise<{ name: string }> {
    const remote = await this.remoteDetail(id, kind)
    if (remote.encrypted) {
      report(t('market.phase.claim'), 0, 0)
      await this.packageKey(remote.id, kind)
    } else {
      const download = downloadOf(remote, this.apiUrl, kind)
      if (!download) throw new Error(t(kind === 'mod' ? 'market.errors.noArchiveMod' : 'market.errors.noArchivePack'))
      // Archive laissée par un téléchargement précédent : elle ne serait pas demandée à l'API.
      await fs.rm(path.join(this.library().dir, '.downloads', remote.id), { recursive: true, force: true }).catch(() => undefined)
      const file = await this.download(remote, download, report, signal)
      await fs.rm(path.dirname(file), { recursive: true, force: true }).catch(() => undefined)
    }
    log.info(`Marketplace : téléchargement de ${remote.name} compté pour le compte`)
    return { name: remote.name }
  }

  /** Clé du paquet chiffré actuel d'un pack (ou d'un mod), et l'identifiant de ce paquet. */
  async packageKey(id: string, kind: MarketKind = 'pack'): Promise<{ packageId: string; key: Buffer }> {
    // Demander la clé compte le téléchargement pour le compte connecté.
    const body = await this.get<{ packageId?: unknown; key?: unknown }>(`${catalogPath(kind)}/${encodeURIComponent(id)}/package/key`, () => goneError(kind), true)
    const key = typeof body.key === 'string' ? Buffer.from(body.key, 'base64') : null
    if (typeof body.packageId !== 'string' || !/^[0-9a-f]{32}$/.test(body.packageId) || key?.length !== KEY_SIZE)
      throw new Error(t(kind === 'mod' ? 'market.errors.badKeyMod' : 'market.errors.badKeyPack'))
    return { packageId: body.packageId, key }
  }

  /** Télécharge l'archive ou le paquet chiffré (avec reprise) puis vérifie son empreinte. */
  private async download(remote: RemoteDetail, d: Download, report: Report, signal: AbortSignal): Promise<string> {
    const dir = path.join(this.library().dir, '.downloads', remote.id)
    const final = path.join(dir, safeFileName(d.name))
    const part = `${final}.part`
    const metaFile = path.join(dir, 'download.json')
    const size = d.size
    const sha = d.sha256

    // Téléchargement d'une autre version du pack laissé en plan : on repart de zéro.
    const meta = await fs.readFile(metaFile, 'utf8').then((text) => JSON.parse(text) as { sha256?: string }).catch(() => null)
    if (meta?.sha256 !== sha) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(metaFile, JSON.stringify({ sha256: sha, name: remote.name }))

    if ((await fs.stat(final).catch(() => null))?.size === size && (await sha256File(final, signal)) === sha) return final

    const already = (await fs.stat(part).catch(() => null))?.size ?? 0
    const free = await freeSpace(this.library().dir)
    // L'archive, puis son contenu extrait (environ deux fois sa taille) pendant l'ajout à la bibliothèque ; un paquet
    // chiffré n'est jamais extrait.
    const needed = size - already + (remote.encrypted ? 0 : size * 2.2)
    if (free !== null && free < needed) throw new Error(t('market.errors.noSpace', { size: displayBytes(needed) }))

    const url = d.url
    for (let attempt = 1; ; attempt++) {
      try {
        await this.fetchInto(url, part, size, sha, report, signal, kindOf(remote))
        break
      } catch (err) {
        if (signal.aborted || attempt >= 5 || (err as Error & { fatal?: boolean }).fatal) throw err
        log.warn(`Téléchargement interrompu (${(err as Error).message}), reprise dans ${attempt * 2} s`)
        report(t('market.phase.resuming'), 0, 0)
        await new Promise((r) => setTimeout(r, attempt * 2000))
      }
    }

    report(t('market.phase.verifying'), 0, 0)
    if ((await sha256File(part, signal)) !== sha) {
      await fs.rm(part, { force: true })
      throw new Error(t('market.errors.corrupted'))
    }
    await fs.rename(part, final)
    return final
  }

  private async fetchInto(url: string, part: string, size: number, sha: string, report: Report, signal: AbortSignal, kind: MarketKind): Promise<void> {
    let start = (await fs.stat(part).catch(() => null))?.size ?? 0
    if (start > size) {
      await fs.rm(part, { force: true })
      start = 0
    }
    if (start === size) return
    const headers: Record<string, string> = start > 0 ? { Range: `bytes=${start}-`, 'If-Range': `"${sha}"` } : {}
    // Avec le jeton du compte à chaque requête, reprises comprises : le dernier octet envoyé compte le téléchargement.
    const response = await this.fetchAsAccount(url, { headers, signal })
    if (response.status === 200) start = 0
    else if (response.status !== 206) {
      const detail = (await problemOf(response)).detail
      const error = response.status === 404 ? goneError(kind) : new Error(detail ?? t('market.errors.downloadFailed', { status: response.status }))
      if (response.status < 500) Object.assign(error, { fatal: true })
      throw error
    }
    if (!response.body) throw new Error(t('market.errors.emptyResponse'))
    let received = start
    const phase = t('market.phase.downloading')
    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        report(phase, received, size)
        callback(null, chunk)
      }
    })
    await pipeline(
      Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream),
      progress,
      createWriteStream(part, { flags: start > 0 ? 'a' : 'w' }),
      { signal }
    )
    if (received !== size) throw new Error(t('market.errors.incomplete'))
  }

  /** Nom, description, auteur, catégorie, images et vidéo de la fiche, copiés dans le pack (ou le mod) de la bibliothèque. */
  private async applyMetadata(lib: Library, pack: StoredManifest, remote: RemoteDetail, fresh: boolean, report: Report): Promise<void> {
    const kind = kindOf(remote)
    const m = await lib.get(pack.id)
    const packDir = lib.packDir(m.id)
    const phase = t('market.phase.images')
    report(phase, 0, remote.images.length)
    const rels: string[] = []
    for (const [i, image] of remote.images.entries()) {
      const rel = `market-${image.id}.jpg`
      const target = path.join(packDir, rel)
      if (!(await exists(target))) {
        try {
          const cached = path.join(this.cacheDir, `${image.id}.jpg`)
          if (await exists(cached)) await fs.copyFile(cached, target)
          else await fs.writeFile(target, await this.fetchImage(remote.id, image.id, false, kind))
        } catch (err) {
          log.warn(`Image ${image.id} non récupérée : ${(err as Error).message}`)
          continue
        }
      }
      rels.push(rel)
      report(phase, i + 1, remote.images.length)
    }
    // Anciennes images de la fiche qui n'en font plus partie.
    for (const old of m.gallery.filter((g) => /^market-/.test(g) && !rels.includes(g)))
      await fs.rm(path.join(packDir, old), { force: true }).catch(() => undefined)

    const coverWasMarket = !m.cover || /^market-/.test(m.cover)
    m.gallery = [...rels, ...m.gallery.filter((g) => !/^market-/.test(g))]
    if (fresh || coverWasMarket) m.cover = rels[0] ?? (coverWasMarket ? null : m.cover)
    if (fresh) m.name = remote.name
    m.description = remote.description
    m.author = authorName(remote)
    m.youtubeId = youtubeId(remote)
    if (kind === 'mod') {
      m.kind = 'mod'
      m.category = remote.category ?? null
    }
    m.marketplace = { id: remote.id, slug: remote.slug, sha256: remote.sha256!, version: remote.version, downloadedAt: new Date().toISOString(), kind }
    await lib.save(m)
  }
}

async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    if (signal?.aborted) throw new Error(t('market.errors.cancelled'))
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

function safeFileName(name: string): string {
  const base = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim()
  return base && !/^\.+$/.test(base) ? base : 'pack.zip'
}

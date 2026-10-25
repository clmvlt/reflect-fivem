// Compte reflect-fivem.com (facultatif) : connexion par jetons, profil public de l'auteur.
//
// Deux jetons, gardés chiffrés par Windows (safeStorage, DPAPI) dans le dossier de données avec le dernier état connu du
// compte pour l'afficher sans réseau, et jamais journalisés :
//  - le jeton d'accès (JWT, 15 minutes), envoyé dans l'en-tête « Authorization: Bearer » des requêtes connectées ;
//  - le jeton de renouvellement (« rt_… », 30 jours), échangé sur /auth/app/refresh contre une nouvelle paire. L'ancien
//    n'est plus accepté que 2 minutes (réutilisé plus tard, l'API déconnecte l'appareil) : le nouveau est enregistré
//    avant toute utilisation du nouveau jeton d'accès, et un seul renouvellement a lieu à la fois.
// Le jeton d'accès est renouvelé quand il expire dans moins d'une minute, sur un 401 « token-invalid » (une fois, puis
// la requête est rejouée), au démarrage (première requête) et toutes les 12 heures quand l'appli reste ouverte : la
// personne reste connectée sans rien faire. Seul un 401 « refresh-invalid » déconnecte ; hors ligne ou serveur
// indisponible, la connexion est gardée et le renouvellement réessayé plus tard.
//
// Les notes et commentaires des packs passent aussi par ici (call) : au nom du compte s'il y en a un, anonymes sinon.
// Les téléchargements de la Marketplace demandent un jeton d'accès valide (accessToken) pour être comptés au compte.
// « Créer ton pack » (builder.ts) n'existe qu'avec un compte : requêtes connectées obligatoires (call, fetchAuthed pour
// lire l'ETag du catalogue), jeton d'accès pour télécharger les fichiers des composants.
// Maintenance (503 « maintenance », voir http.ts) : l'erreur remonte telle quelle, la connexion est gardée.
//
// Connexion des versions 1.7.0 à 1.8.2 ({token: "pm_…"}) : convertie par /auth/app/migrate à la première requête
// (l'ancien jeton est alors supprimé par l'API) ; hors ligne, l'ancien fichier est gardé jusqu'au prochain essai.
//
// Connexion Google : flux « application de bureau » avec PKCE. La page Google s'ouvre dans le navigateur et revient sur
// un petit serveur http://127.0.0.1:<port>/callback ouvert le temps de la connexion ; le code reçu est échangé par
// l'API, qui garde le secret du client.
//
// Connexion et liaison Discord : même PKCE et même serveur local, mais le navigateur part de l'API
// (/auth/app/discord), qui échange le code de Discord et renvoie sur le serveur local un ticket « dt_… » à usage
// unique (2 minutes), échangé à son tour contre une connexion ou une liaison au compte connecté. Une seule connexion
// par navigateur à la fois, Google ou Discord : un nouvel essai abandonne le précédent. Quand l'application Discord est
// ouverte sur le PC, la page d'autorisation s'y affiche au lieu du navigateur (lien discord://, voir openDiscord) ;
// « Ouvrir dans le navigateur » reste possible pendant l'attente.
//
// Aucune dépendance à Electron ici (testé avec vitest) : le service fournit fetch, l'ouverture du navigateur, l'accès
// à l'application Discord et le chiffrement du système.

import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { AccountMe, AccountProfile, AuthorRef, DiscordAccount, ProfileInput, ProfileLink } from '@shared/types'
import { SIGNED_OUT } from '@shared/api'
import { t } from 'i18next'
import { currentLocale } from '@shared/i18n'
import { ApiError, MaintenanceError, maintenanceError } from './http'
import type { SystemProtection } from './keys'
import { log } from '../util/log'

const TIMEOUT = 20_000
/** Attente du retour d'une page de connexion ouverte dans le navigateur (Google, Discord). */
const BROWSER_TIMEOUT = 5 * 60_000
/** Jeton d'accès renouvelé quand il expire dans moins de 60 s. */
const RENEW_MARGIN = 60_000
/** Renouvellement régulier quand l'appli reste ouverte longtemps. */
const KEEP_ALIVE = 12 * 3_600_000
/** Compte relu au retour sur la fenêtre au plus une fois par minute. */
const REFRESH_ON_FOCUS_MIN = 60_000
export const AVATAR_MAX = 8 * 1024 * 1024

const AVATAR_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}
export const AVATAR_EXTENSIONS = Object.keys(AVATAR_TYPES).map((e) => e.slice(1))

export { ApiError }

// ------------------------------------------------------------------ fonctions pures (testées)

/** code_challenge S256 d'un code_verifier PKCE (RFC 7636). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

/** code_verifier aléatoire (43 caractères, alphabet base64url) et son challenge S256. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: pkceChallenge(verifier) }
}

/** Connexion dans le navigateur : ses textes (page de retour, erreurs) sont ceux de account.google.* ou account.discord.*. */
export type LoginProvider = 'google' | 'discord'

/** Adresse de retour sur le serveur local, défi PKCE et state d'une connexion dans le navigateur. */
export interface BrowserParams {
  redirectUri: string
  challenge: string
  state: string
}

export interface GoogleConfig {
  clientId: string
  authorizationEndpoint: string
  scope: string
}

/** Adresse de la page de connexion Google. */
export function googleAuthUrl(config: GoogleConfig, p: BrowserParams): string {
  const url = new URL(config.authorizationEndpoint)
  if (url.protocol !== 'https:') throw new Error(t('account.google.invalidUrl'))
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    scope: config.scope,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    state: p.state,
    prompt: 'select_account'
  }).toString()
  return url.toString()
}

/**
 * Adresse de départ de la connexion Discord, ouverte dans le navigateur : l'API envoie chez Discord puis renvoie sur
 * `redirectUri` (ticket ou erreur). `link` : liaison au compte connecté (Discord redemande l'accord, ce qui montre quel
 * compte sera lié). L'API de dev est en http : pas d'exigence https ici.
 */
export function discordStartUrl(apiUrl: string, p: BrowserParams & { link: boolean }): string {
  const url = new URL(`${apiUrl}/auth/app/discord`)
  url.search = new URLSearchParams({ redirectUri: p.redirectUri, codeChallenge: p.challenge, state: p.state, link: String(p.link) }).toString()
  return url.toString()
}

/**
 * Lien qui ouvre la page d'autorisation Discord dans l'application Discord : https://discord.com/oauth2/authorize?… →
 * discord://-/oauth2/authorize?… (lien que Discord ne documente pas, mais que son application reconnaît, sans numéro
 * de version de l'API dans le chemin). Null pour une autre adresse.
 */
export function discordAppUrl(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || u.host !== 'discord.com' || !/^(?:\/api)?\/oauth2\/authorize\/?$/.test(u.pathname)) return null
    return `discord://-/oauth2/authorize${u.search}`
  } catch {
    return null
  }
}

export type LoopbackResult =
  | { type: 'code'; code: string }
  | { type: 'error'; error: string }
  /** Retour sur /callback mal formé ou d'une autre connexion (state différent) : ignoré. */
  | { type: 'invalid' }
  /** Autre adresse (favicon.ico...). */
  | { type: 'ignore' }

/** Lit la redirection reçue par le serveur local (« /callback?code=…&state=… » ou « ?error=… »). */
export function parseLoopbackCallback(requestUrl: string | undefined, state: string): LoopbackResult {
  let url: URL
  try {
    url = new URL(requestUrl ?? '/', 'http://127.0.0.1')
  } catch {
    return { type: 'invalid' }
  }
  if (url.pathname !== '/callback') return { type: 'ignore' }
  const p = url.searchParams
  if (!state || p.get('state') !== state) return { type: 'invalid' }
  const error = p.get('error')
  if (error) return { type: 'error', error }
  const code = p.get('code')
  return code ? { type: 'code', code } : { type: 'invalid' }
}

/** Photo d'un compte : « /users/12/avatar?v=… » (adresse relative à l'API) → pm-media://avatar/12/…, mise en cache. */
export function avatarMediaUrl(apiPath: string | null | undefined): string | null {
  const m = /^\/users\/(\d{1,18})\/avatar\?v=([A-Za-z0-9_-]{1,64})$/.exec(apiPath ?? '')
  return m ? `pm-media://avatar/${m[1]}/${m[2]}` : null
}

export function deviceName(): string {
  return `Reflect FiveM - ${os.hostname()}`.slice(0, 80)
}

// ------------------------------------------------------------------ réponses de l'API

interface RemoteMe {
  authenticated?: boolean
  id: number
  username: string | null
  email: string | null
  displayName: string | null
  slug: string | null
  avatarUrl: string | null
  role: string | null
  admin: boolean
  canPublish: boolean
  canPublishMods?: boolean
  /** Absent d'une API plus ancienne : pas de droit. */
  canBuildPacks?: boolean
  mustChangePassword?: boolean
  hasPassword: boolean
  googleLinked: boolean
  /** Absents d'une API plus ancienne : pas de liaison. */
  discordLinked?: boolean
  discord?: RemoteDiscord | null
  muted?: boolean
  locale?: string | null
}

interface RemoteDiscord {
  id: string
  username: string | null
  displayName: string | null
  avatarUrl: string | null
  linkedAt: string | null
}

interface RemoteProfile extends RemoteMe {
  bio: string | null
  links: ProfileLink[] | null
  createdAt: string | null
}

interface SessionResponse {
  accessToken: string
  accessTokenExpiresAt: string
  refreshToken: string
  refreshTokenExpiresAt: string | null
  me: RemoteMe
}

function toMe(r: RemoteMe): AccountMe {
  return {
    id: r.id,
    username: r.username ?? null,
    email: r.email ?? null,
    displayName: r.displayName ?? '',
    slug: r.slug ?? '',
    avatarUrl: avatarMediaUrl(r.avatarUrl),
    role: r.role === 'admin' ? 'admin' : 'user',
    admin: !!r.admin,
    canPublish: !!r.canPublish,
    canPublishMods: !!r.canPublishMods,
    canBuildPacks: !!r.canBuildPacks,
    mustChangePassword: !!r.mustChangePassword,
    hasPassword: !!r.hasPassword,
    googleLinked: !!r.googleLinked,
    discordLinked: !!r.discordLinked,
    discord: toDiscord(r.discord),
    muted: !!r.muted,
    locale: typeof r.locale === 'string' && r.locale ? r.locale : null
  }
}

function toDiscord(r: RemoteDiscord | null | undefined): DiscordAccount | null {
  if (!r || typeof r.id !== 'string' || !r.id) return null
  return { id: r.id, username: r.username ?? '', displayName: r.displayName || null, avatarUrl: discordAvatarUrl(r.avatarUrl), linkedAt: r.linkedAt ?? null }
}

/** Photo d'un compte Discord : https://cdn.discordapp.com/… seulement (seule adresse permise par la CSP), null sinon. */
export function discordAvatarUrl(url: string | null | undefined): string | null {
  try {
    const u = new URL(url ?? '')
    return u.protocol === 'https:' && u.host === 'cdn.discordapp.com' ? u.toString() : null
  } catch {
    return null
  }
}

function toProfile(r: RemoteProfile): AccountProfile {
  const { mustChangePassword: _ignored, ...me } = toMe(r)
  return { ...me, bio: r.bio ?? '', links: (r.links ?? []).map((l) => ({ label: l.label, url: l.url })), createdAt: r.createdAt ?? null }
}

/** Auteur d'un pack ou d'une liste d'auteurs, avec sa photo servie par pm-media. */
export function toAuthorRef(r: { id: number; slug: string; displayName: string; avatarUrl: string | null }): AuthorRef {
  return { id: r.id, slug: r.slug, displayName: r.displayName, avatarUrl: avatarMediaUrl(r.avatarUrl) }
}

function toSession(r: SessionResponse): Session {
  const ok = (s: unknown): s is string => typeof s === 'string' && s.length > 0
  if (!ok(r?.accessToken) || !ok(r.refreshToken) || !ok(r.accessTokenExpiresAt) || !r.me) throw new Error(t('account.errors.badResponse'))
  return {
    accessToken: r.accessToken,
    accessTokenExpiresAt: r.accessTokenExpiresAt,
    refreshToken: r.refreshToken,
    refreshTokenExpiresAt: r.refreshTokenExpiresAt ?? null,
    me: toMe(r.me)
  }
}

/** Expire dans moins de `margin` ms (date illisible : considéré comme expiré). */
function expiresWithin(at: string, margin: number): boolean {
  const time = Date.parse(at)
  return !Number.isFinite(time) || time - Date.now() < margin
}

// ------------------------------------------------------------------ jetons chiffrés

export interface Session {
  accessToken: string
  accessTokenExpiresAt: string
  refreshToken: string
  refreshTokenExpiresAt: string | null
  me: AccountMe
}

/** Connexion enregistrée par les versions 1.7.0 à 1.8.2 (jeton « pm_… »), convertie au premier appel. */
export interface LegacySession {
  token: string
  expiresAt: string | null
  me: AccountMe
}

export type StoredSession = Session | LegacySession

export const isLegacySession = (s: StoredSession): s is LegacySession => 'token' in s

/** Jetons et dernier état connu du compte, chiffrés par le système. Sans chiffrement disponible : gardés en mémoire. */
export class TokenFile {
  private memory: StoredSession | null = null
  /** Écritures l'une après l'autre : la dernière demandée est celle qui reste sur le disque. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private file: string,
    private system: SystemProtection
  ) {}

  async load(): Promise<StoredSession | null> {
    if (!this.system.available()) return this.memory
    const saved = await fs.readFile(this.file).catch(() => null)
    if (!saved) return null
    try {
      const s = JSON.parse(this.system.unprotect(saved).toString('utf8')) as Partial<Session & LegacySession>
      const ok = (v: unknown): v is string => typeof v === 'string' && v.length > 0
      if (s.me && typeof s.me.id === 'number') {
        if (ok(s.accessToken) && ok(s.refreshToken))
          return {
            accessToken: s.accessToken,
            accessTokenExpiresAt: typeof s.accessTokenExpiresAt === 'string' ? s.accessTokenExpiresAt : '',
            refreshToken: s.refreshToken,
            refreshTokenExpiresAt: s.refreshTokenExpiresAt ?? null,
            me: s.me
          }
        if (ok(s.token)) return { token: s.token, expiresAt: s.expiresAt ?? null, me: s.me }
      }
    } catch {
      /* autre compte Windows, fichier abîmé */
    }
    log.warn('Connexion enregistrée illisible : reconnectez-vous')
    await this.clear()
    return null
  }

  save(session: StoredSession): Promise<void> {
    return this.serial(async () => {
      if (!this.system.available()) {
        log.warn('Chiffrement du système indisponible : connexion gardée pour cette session seulement')
        this.memory = session
        return
      }
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      await fs.writeFile(tmp, this.system.protect(Buffer.from(JSON.stringify(session), 'utf8')))
      await fs.rename(tmp, this.file)
    })
  }

  clear(): Promise<void> {
    return this.serial(async () => {
      this.memory = null
      await fs.rm(this.file, { force: true })
    })
  }

  private serial(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }
}

// ------------------------------------------------------------------ compte

export interface AccountDeps {
  apiUrl: string
  store: TokenFile
  fetch: (url: string, init: RequestInit) => Promise<Response>
  /** Ouvre une adresse dans le navigateur (ou un lien discord:// dans l'application Discord). */
  openExternal: (url: string) => Promise<void>
  /** Connexion, déconnexion, profil modifié, connexion expirée. */
  onChange: (me: AccountMe | null) => void
  /**
   * Application Discord du PC (facultatif : sans elle, la page Discord s'ouvre toujours dans le navigateur). `running` :
   * ouverte, avec les liens discord:// enregistrés ; `redirectOf` : adresse vers laquelle renvoie une page (3xx), sans
   * suivre le renvoi, null pour une autre réponse.
   */
  discordApp?: { running: () => Promise<boolean>; redirectOf: (url: string) => Promise<string | null> }
}

/** Connexion en cours dans le navigateur. `start` : adresse de départ de Discord, pour « Ouvrir dans le navigateur ». */
interface BrowserFlow {
  provider: LoginProvider
  abort: AbortController
  start?: string
}

interface RequestOptions {
  json?: unknown
  raw?: { data: Buffer; type: string }
  /** Jeton de l'en-tête Authorization (jeton d'accès, ou ancien jeton « pm_… » pour la conversion). */
  bearer?: string
  timeout?: number
  /** En-têtes en plus (If-None-Match...). */
  headers?: Record<string, string>
  /** Requête conditionnelle : une réponse 304 est rendue telle quelle au lieu d'être une erreur. */
  notModified?: boolean
}

const signedOut = (): ApiError => new ApiError(t('account.errors.signedOut'), 401, SIGNED_OUT)

export class Account {
  private session: Session | null = null
  /** Connexion d'une version précédente, pas encore convertie. */
  private legacy: LegacySession | null = null
  /** Renouvellement (ou conversion) en cours, partagé par toutes les requêtes. */
  private renewing: Promise<void> | null = null
  private keepAlive: NodeJS.Timeout | null = null
  /** Connexion en cours dans le navigateur (Google ou Discord, une seule à la fois). */
  private browser: BrowserFlow | null = null
  /** Lecture du compte en cours (partagée), et heure de la dernière (voir refreshIfStale). */
  private refreshing: Promise<AccountMe | null> | null = null
  private lastRefresh = 0

  constructor(private deps: AccountDeps) {}

  async init(): Promise<void> {
    const saved = await this.deps.store.load().catch(() => null)
    if (saved && isLegacySession(saved)) this.legacy = saved
    else this.session = saved
    // Connexion gardée vivante quand l'appli reste ouverte (le renouvellement au démarrage passe par refresh()).
    this.keepAlive ??= setInterval(() => {
      if (this.session || this.legacy) this.renew().catch((err: unknown) => log.info(`Connexion non renouvelée : ${(err as Error).message}`))
    }, KEEP_ALIVE)
    this.keepAlive.unref?.()
  }

  dispose(): void {
    if (this.keepAlive) clearInterval(this.keepAlive)
    this.keepAlive = null
  }

  /** Compte connecté (dernier état connu, sans réseau). */
  current(): AccountMe | null {
    return this.session?.me ?? this.legacy?.me ?? null
  }

  /** Compte admin connecté : jamais bloqué par une maintenance (ses requêtes doivent porter son jeton). */
  isAdmin(): boolean {
    return !!this.current()?.admin
  }

  /**
   * Relit le compte (GET /auth/me), en renouvelant la connexion si besoin : nom, photo, droits donnés ou retirés par
   * l'admin. Hors ligne : l'état enregistré est gardé. Une lecture déjà en cours sert à tous les appels.
   */
  refresh(): Promise<AccountMe | null> {
    if (!this.session && !this.legacy) return Promise.resolve(null)
    this.lastRefresh = Date.now()
    this.refreshing ??= this.readMe().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  /**
   * Relit le compte s'il ne l'a pas été depuis `minAge` ms (fenêtre qui reprend le focus : un droit donné sur le site
   * apparaît sans redémarrer, au plus une lecture par minute). Une lecture en cours sert aussi.
   */
  refreshIfStale(minAge = REFRESH_ON_FOCUS_MIN): Promise<AccountMe | null> {
    if (this.refreshing) return this.refreshing
    if (Date.now() - this.lastRefresh < minAge) return Promise.resolve(this.current())
    return this.refresh()
  }

  private async readMe(): Promise<AccountMe | null> {
    const me = await this.authed<RemoteMe>('GET', '/auth/me')
    if (!me.authenticated) {
      await this.forget()
      return null
    }
    await this.updateMe(toMe(me))
    return this.current()
  }

  async login(login: string, password: string): Promise<AccountMe> {
    if (!login.trim() || !password) throw new Error(t('account.errors.missingCredentials'))
    return this.signIn(await this.request<SessionResponse>('POST', '/auth/app/login', { json: { login: login.trim(), password, deviceName: deviceName() } }))
  }

  async register(email: string, password: string, displayName: string): Promise<AccountMe> {
    const body = { email: email.trim(), password, displayName: displayName.trim(), deviceName: deviceName(), locale: currentLocale() }
    return this.signIn(await this.request<SessionResponse>('POST', '/auth/app/register', { json: body }))
  }

  /** Connexion Google dans le navigateur. */
  async loginWithGoogle(): Promise<AccountMe> {
    const r = await this.browserCode('google', async () => {
      const config = await this.request<GoogleConfig>('GET', '/auth/app/google/config')
      return (p) => googleAuthUrl(config, p)
    })
    const body = { code: r.code, codeVerifier: r.verifier, redirectUri: r.redirectUri, deviceName: deviceName() }
    return this.signIn(await this.request<SessionResponse>('POST', '/auth/app/google', { json: body }))
  }

  cancelGoogle(): void {
    this.cancelBrowser('google')
  }

  /**
   * Connexion Discord, dans l'application Discord si elle est ouverte, sinon dans le navigateur. Un compte Discord dont
   * l'adresse est celle d'un compte existant y est lié ; sans compte, un compte sans mot de passe est créé.
   */
  async loginWithDiscord(): Promise<AccountMe> {
    const r = await this.discordTicket(false)
    const body = { code: r.code, codeVerifier: r.verifier, deviceName: deviceName() }
    return this.signIn(await this.request<SessionResponse>('POST', '/auth/app/discord', { json: body }))
  }

  /** Lie un compte Discord au compte connecté (il remplace celui déjà lié). */
  async linkDiscord(): Promise<AccountMe> {
    if (!this.session && !this.legacy) throw signedOut()
    const r = await this.discordTicket(true)
    await this.updateMe(toMe(await this.authed<RemoteMe>('POST', '/auth/app/discord/link', { json: { code: r.code, codeVerifier: r.verifier } })))
    return this.current()!
  }

  cancelDiscord(): void {
    this.cancelBrowser('discord')
  }

  /** Application Discord ouverte sur ce PC : la page d'autorisation de Discord s'y affichera. */
  discordAppOpen(): Promise<boolean> {
    return this.deps.discordApp?.running().catch(() => false) ?? Promise.resolve(false)
  }

  /** « Ouvrir dans le navigateur » : la page Discord en attente est ouverte dans le navigateur, même attente. */
  async discordInBrowser(): Promise<void> {
    const flow = this.browser
    if (flow?.provider === 'discord' && flow.start && !flow.abort.signal.aborted) await this.deps.openExternal(flow.start)
  }

  /** Retire la liaison Discord ; refusé (409) si le compte n'a ni mot de passe ni Google. */
  async unlinkDiscord(): Promise<AccountMe> {
    await this.updateMe(toMe(await this.authed<RemoteMe>('DELETE', '/me/discord')))
    return this.current()!
  }

  /** Déconnexion : l'appareil est déconnecté sur le serveur (si possible) et la connexion effacée de ce PC dans tous les cas. */
  async logout(): Promise<void> {
    // Un renouvellement en cours remplace le jeton de renouvellement : c'est le nouveau qu'il faut envoyer.
    await this.renewing?.catch(() => undefined)
    if (!this.session && !this.legacy) return
    const refreshToken = this.session?.refreshToken
    if (refreshToken) {
      try {
        await this.request('POST', '/auth/app/logout', { json: { refreshToken } })
      } catch (err) {
        log.info(`Déconnexion : appareil non déconnecté sur le serveur (${(err as Error).message})`)
      }
    }
    await this.forget()
    log.info('Compte : déconnecté')
  }

  async profile(): Promise<AccountProfile> {
    return this.withProfile(await this.authed<RemoteProfile>('GET', '/me'))
  }

  async saveProfile(input: ProfileInput): Promise<AccountProfile> {
    const body: ProfileInput = {
      displayName: input.displayName.trim(),
      bio: input.bio.trim(),
      links: input.links.map((l) => ({ label: l.label.trim(), url: l.url.trim() })).filter((l) => l.label || l.url)
    }
    return this.withProfile(await this.authed<RemoteProfile>('PUT', '/me', { json: body }))
  }

  /** Envoie la photo d'un fichier image (PNG, JPEG, GIF, BMP ; 8 Mo au plus). */
  async setAvatarFile(file: string): Promise<AccountProfile> {
    const type = AVATAR_TYPES[path.extname(file).toLowerCase()]
    if (!type) throw new Error(t('account.errors.avatarFormat'))
    const st = await fs.stat(file)
    if (st.size > AVATAR_MAX) throw new Error(t('account.errors.avatarTooLarge'))
    const data = await fs.readFile(file)
    return this.withProfile(await this.authed<RemoteProfile>('PUT', '/me/avatar', { raw: { data, type }, timeout: 60_000 }))
  }

  async removeAvatar(): Promise<AccountProfile> {
    return this.withProfile(await this.authed<RemoteProfile>('DELETE', '/me/avatar'))
  }

  /** Langue enregistrée dans le compte (PUT /me/locale). */
  async setLocale(locale: string): Promise<AccountProfile> {
    return this.withProfile(await this.authed<RemoteProfile>('PUT', '/me/locale', { json: { locale } }))
  }

  /** Les autres appareils sont déconnectés ; celui-ci reste connecté. */
  async changePassword(currentPassword: string | null, newPassword: string): Promise<AccountMe> {
    const body = currentPassword === null ? { newPassword } : { currentPassword, newPassword }
    await this.updateMe(toMe(await this.authed<RemoteMe>('POST', '/auth/password', { json: body })))
    return this.current()!
  }

  // ----------------------------------------------------------------

  /**
   * Ouvre une page de connexion dans le navigateur et attend son retour sur le serveur local : code à usage unique (code
   * Google, ticket Discord), vérificateur PKCE et adresse de retour. Une seule connexion par navigateur à la fois : un
   * nouvel essai, Google ou Discord, abandonne le précédent. `start` lit ce qu'il faut pour construire l'adresse de la
   * page (configuration Google), déjà annulable ; `open` ouvre cette adresse (le navigateur par défaut).
   */
  private async browserCode(
    provider: LoginProvider,
    start: () => Promise<(p: BrowserParams) => string>,
    open: (url: string, flow: BrowserFlow) => Promise<void> = (url) => this.deps.openExternal(url)
  ): Promise<{ code: string; verifier: string; redirectUri: string }> {
    this.browser?.abort.abort()
    const current: BrowserFlow = { provider, abort: new AbortController() }
    this.browser = current
    try {
      const authUrl = await start()
      const { verifier, challenge } = createPkce()
      const state = randomBytes(24).toString('base64url')
      const { code, redirectUri } = await waitForLoopback(provider, state, current.abort.signal, (redirectUri) =>
        open(authUrl({ redirectUri, challenge, state }), current)
      )
      return { code, verifier, redirectUri }
    } finally {
      if (this.browser === current) this.browser = null
    }
  }

  /** Ticket Discord (« dt_… », 2 minutes, usage unique) rendu par l'API au retour de la page Discord. */
  private discordTicket(link: boolean): Promise<{ code: string; verifier: string }> {
    return this.browserCode(
      'discord',
      async () => (p) => discordStartUrl(this.deps.apiUrl, { ...p, link }),
      (start, flow) => this.openDiscord(start, flow)
    )
  }

  /**
   * Page d'autorisation Discord : dans l'application Discord quand elle est ouverte, sinon dans le navigateur. Son
   * adresse est le renvoi de l'API (/auth/app/discord), lu sans le suivre ; un autre renvoi (Discord indisponible...)
   * ou une erreur : navigateur, qui montre la même chose. Après « Autoriser », l'application Discord ouvre l'adresse de
   * retour de l'API dans le navigateur, qui revient sur le serveur local comme depuis la page web.
   */
  private async openDiscord(start: string, flow: BrowserFlow): Promise<void> {
    flow.start = start
    const app = this.deps.discordApp
    if (app && (await this.discordAppOpen())) {
      const location = await app.redirectOf(start).catch((err: unknown) => {
        log.info(`Discord : page d'autorisation non lue sur l'API (${(err as Error).message})`)
        return null
      })
      const deepLink = location ? discordAppUrl(location) : null
      if (flow.abort.signal.aborted) return
      if (deepLink) {
        try {
          await this.deps.openExternal(deepLink)
          log.info("Discord : page d'autorisation ouverte dans l'application Discord")
          return
        } catch (err) {
          log.info(`Discord : application Discord injoignable, navigateur (${(err as Error).message})`)
        }
      }
    }
    if (!flow.abort.signal.aborted) await this.deps.openExternal(start)
  }

  /** Abandonne la connexion en cours dans le navigateur, si c'est celle de ce fournisseur. */
  private cancelBrowser(provider: LoginProvider): void {
    if (this.browser?.provider === provider) this.browser.abort.abort()
  }

  private async signIn(r: SessionResponse): Promise<AccountMe> {
    const session = toSession(r)
    await this.adopt(session)
    log.info(`Compte : connecté (compte ${session.me.id})`)
    this.deps.onChange(session.me)
    return session.me
  }

  /**
   * Nouvelle session : gardée en mémoire tout de suite (une mise à jour du profil pendant l'écriture garde ainsi les
   * nouveaux jetons), enregistrée avant que le nouveau jeton d'accès serve (les requêtes attendent `renewing`).
   */
  private async adopt(session: Session): Promise<void> {
    this.session = session
    this.legacy = null
    await this.deps.store.save(session).catch((err: unknown) => log.warn(`Connexion non enregistrée : ${(err as Error).message}`))
  }

  private async forget(): Promise<void> {
    this.session = null
    this.legacy = null
    await this.deps.store.clear().catch((err: unknown) => log.warn(`Connexion enregistrée non effacée : ${(err as Error).message}`))
    this.deps.onChange(null)
  }

  private async updateMe(me: AccountMe): Promise<void> {
    if (!this.session) return
    const changed = JSON.stringify(me) !== JSON.stringify(this.session.me)
    this.session = { ...this.session, me }
    if (!changed) return
    await this.deps.store.save(this.session).catch((err: unknown) => log.warn(`Compte non enregistré : ${(err as Error).message}`))
    this.deps.onChange(me)
  }

  /** Un profil reçu met aussi à jour le compte affiché (nom, photo...). */
  private async withProfile(r: RemoteProfile): Promise<AccountProfile> {
    const profile = toProfile(r)
    if (this.session) {
      const { bio: _b, links: _l, createdAt: _c, ...me } = profile
      await this.updateMe({ ...this.session.me, ...me })
    }
    return profile
  }

  // ---------------------------------------------------------------- requêtes pour les autres modules

  /**
   * Requête de l'API au nom du compte connecté, anonyme sans connexion (ou si la connexion vient d'expirer) ;
   * `auth: 'required'` refuse la requête sans connexion (401 « signed-out »).
   */
  async call<T>(method: string, pathname: string, opts: { json?: unknown; auth?: 'optional' | 'required' } = {}): Promise<T> {
    const anonymous = (): boolean => opts.auth !== 'required' && !this.session && !this.legacy
    if (anonymous()) return this.request<T>(method, pathname, { json: opts.json })
    try {
      return await this.authed<T>(method, pathname, { json: opts.json })
    } catch (err) {
      if (anonymous()) return this.request<T>(method, pathname, { json: opts.json })
      throw err
    }
  }

  /**
   * Requête connectée dont la réponse est rendue telle quelle quand elle réussit (en-têtes lus par l'appelant : ETag...),
   * ou vaut 304 (requête conditionnelle, If-None-Match). Sans connexion : 401 « signed-out ».
   */
  async fetchAuthed(method: string, pathname: string, opts: { json?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
    return this.withToken((bearer) => this.send(method, pathname, { ...opts, bearer, notModified: true }))
  }

  /** Jeton d'accès valide pour une requête faite ailleurs (téléchargements), renouvelé s'il expire bientôt ; null sans connexion. */
  async accessToken(): Promise<string | null> {
    if (!this.session && !this.legacy) return null
    return (await this.ready()).accessToken
  }

  /** Jeton d'accès refusé (401 « token-invalid ») : renouvelé, sauf si une autre requête l'a déjà fait, puis renvoyé. */
  async renewRejected(token: string): Promise<string | null> {
    if (this.session?.accessToken === token) await this.renew()
    return this.accessToken()
  }

  // ---------------------------------------------------------------- jetons

  /** Un seul renouvellement (ou conversion) à la fois : les appels simultanés attendent le même. */
  private renew(): Promise<void> {
    this.renewing ??= (this.legacy ? this.migrate(this.legacy) : this.renewSession()).finally(() => {
      this.renewing = null
    })
    return this.renewing
  }

  private async renewSession(): Promise<void> {
    const current = this.session
    if (!current) return
    // Comparaison par jeton : une mise à jour du profil pendant la requête remplace l'objet session, pas les jetons.
    const unchanged = (): boolean => this.session?.refreshToken === current.refreshToken
    let r: SessionResponse
    try {
      r = await this.request<SessionResponse>('POST', '/auth/app/refresh', { json: { refreshToken: current.refreshToken } })
    } catch (err) {
      // Seul un refus explicite déconnecte : hors ligne ou serveur indisponible, la connexion est gardée.
      if (err instanceof ApiError && err.status === 401 && err.code === 'refresh-invalid' && unchanged()) {
        log.info('Compte : connexion expirée ou révoquée')
        await this.forget()
      }
      throw err
    }
    // Déconnexion pendant le renouvellement : la nouvelle session n'est pas gardée.
    if (!unchanged()) return
    const next = toSession(r)
    const changed = JSON.stringify(next.me) !== JSON.stringify(this.current())
    await this.adopt(next)
    if (changed) this.deps.onChange(next.me)
  }

  /** Ancien jeton « pm_… » échangé contre une session (l'API le supprime). */
  private async migrate(legacy: LegacySession): Promise<void> {
    let r: SessionResponse
    try {
      r = await this.request<SessionResponse>('POST', '/auth/app/migrate', { json: { deviceName: deviceName() }, bearer: legacy.token })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && this.legacy === legacy) {
        log.info('Compte : ancienne connexion refusée, reconnectez-vous')
        await this.forget()
      }
      throw err
    }
    if (this.legacy !== legacy) return
    const next = toSession(r)
    const changed = JSON.stringify(next.me) !== JSON.stringify(legacy.me)
    await this.adopt(next)
    log.info(`Compte : connexion convertie (compte ${next.me.id})`)
    if (changed) this.deps.onChange(next.me)
  }

  /** Session prête pour une requête connectée : conversion, renouvellement en cours ou jeton d'accès bientôt expiré. */
  private async ready(): Promise<Session> {
    const session = this.session
    if (this.renewing || this.legacy || (session && expiresWithin(session.accessTokenExpiresAt, RENEW_MARGIN))) {
      try {
        await this.renew()
      } catch (err) {
        // Renouvellement impossible (hors ligne...) : le jeton d'accès sert tant qu'il n'a pas expiré.
        if (!this.session || expiresWithin(this.session.accessTokenExpiresAt, 0)) throw err
      }
    }
    if (!this.session) throw signedOut()
    return this.session
  }

  /** Requête connectée. Jeton d'accès refusé (401 « token-invalid ») : renouvelé une fois, puis la requête est rejouée. */
  private authed<T>(method: string, pathname: string, opts: Omit<RequestOptions, 'bearer'> = {}): Promise<T> {
    return this.withToken((bearer) => this.request<T>(method, pathname, { ...opts, bearer }))
  }

  /** Envoie une requête avec le jeton d'accès ; refusé (401 « token-invalid ») : renouvelé une fois, puis renvoyée. */
  private async withToken<T>(send: (bearer: string) => Promise<T>): Promise<T> {
    const session = await this.ready()
    try {
      return await send(session.accessToken)
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401 && err.code === 'token-invalid')) throw err
    }
    // Déjà renouvelé par une autre requête entre-temps : la nouvelle session suffit.
    if (this.session?.accessToken === session.accessToken) await this.renew()
    const next = await this.ready()
    return send(next.accessToken)
  }

  private async request<T>(method: string, pathname: string, opts: RequestOptions = {}): Promise<T> {
    const response = await this.send(method, pathname, opts)
    return (response.status === 204 ? undefined : await response.json()) as T
  }

  /** Le corps est reconstruit à chaque appel : une requête peut être rejouée. Réponse en échec : ApiError. */
  private async send(method: string, pathname: string, opts: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers }
    let body: RequestInit['body']
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(opts.json)
    } else if (opts.raw) {
      headers['Content-Type'] = opts.raw.type
      body = new Uint8Array(opts.raw.data)
    }
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`

    let response: Response
    try {
      response = await this.deps.fetch(`${this.deps.apiUrl}${pathname}`, { method, headers, body, signal: AbortSignal.timeout(opts.timeout ?? TIMEOUT) })
    } catch (err) {
      // Maintenance (serverFetch) : ni perte de réseau, ni raison de déconnecter le compte.
      if (err instanceof MaintenanceError) throw err
      throw new Error(t('errors.network'))
    }
    if (response.ok || (opts.notModified && response.status === 304)) return response

    // fetch donné sans serverFetch (tests) : la maintenance est reconnue ici aussi.
    const maintenance = await maintenanceError(response)
    if (maintenance) throw maintenance
    const problem = (await response.json().catch(() => null)) as { detail?: unknown; code?: unknown; retryAfter?: unknown } | null
    const code = typeof problem?.code === 'string' ? problem.code : undefined
    if (response.status === 403 && code === 'password-change-required' && this.session && !this.session.me.mustChangePassword)
      await this.updateMe({ ...this.session.me, mustChangePassword: true })
    // Compte réduit au silence depuis la dernière lecture : l'interface désactive notes et commentaires.
    if (response.status === 403 && code === 'muted' && this.session && !this.session.me.muted) await this.updateMe({ ...this.session.me, muted: true })
    throw new ApiError(problemMessage(response.status, problem), response.status, code)
  }
}

function problemMessage(status: number, problem: { detail?: unknown; retryAfter?: unknown } | null): string {
  if (typeof problem?.detail === 'string' && problem.detail.trim()) return problem.detail
  if (status === 429) {
    const s = typeof problem?.retryAfter === 'number' ? problem.retryAfter : null
    if (!s) return t('account.errors.tooMany')
    return s < 60 ? t('account.errors.tooManySeconds', { count: s }) : t('account.errors.tooManyMinutes', { count: Math.ceil(s / 60) })
  }
  return t('account.errors.badStatus', { status })
}

// ------------------------------------------------------------------ retour d'une connexion dans le navigateur

/** Page affichée dans le navigateur au retour de Google ou de Discord, dans la langue de l'application. */
const PAGE = (title: string, text: string): string =>
  `<!doctype html><html lang="${currentLocale()}"><head><meta charset="utf-8"><title>${title}</title><style>` +
  'html{color-scheme:light dark}body{margin:0;display:grid;place-items:center;height:100vh;font:15px/1.5 "Segoe UI",system-ui,sans-serif;' +
  'background:Canvas;color:CanvasText}main{text-align:center;padding:24px}h1{font-size:20px;margin:0 0 8px}p{margin:0;opacity:.75}</style>' +
  `</head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`

/**
 * Page et erreur d'un retour « ?error=… ». Google : toute erreur vaut une annulation. Discord (raisons de l'API) :
 * `access_denied` (refus sur la page Discord), `unavailable` (Discord pas configuré sur le serveur), sinon échec.
 */
function loopbackError(provider: LoginProvider, error: string): { page: string; error: Error } {
  if (provider === 'discord' && error === 'unavailable')
    return { page: PAGE(t('account.discord.page.unavailableTitle'), t('account.discord.page.unavailableText')), error: new Error(t('account.discord.unavailable')) }
  if (provider === 'discord' && error !== 'access_denied')
    return { page: PAGE(t('account.discord.page.discordFailedTitle'), t('account.discord.page.discordFailedText')), error: new Error(t('account.discord.discordFailed')) }
  return { page: PAGE(t(`account.${provider}.page.cancelledTitle`), t(`account.${provider}.page.cancelledText`)), error: new Error(t(`account.${provider}.cancelled`)) }
}

/**
 * Ouvre http://127.0.0.1:<port libre>/callback, appelle `open` avec cette adresse, puis attend la redirection de Google
 * ou de l'API pour Discord (5 minutes au plus). Le serveur est fermé dans tous les cas. Textes de la page du navigateur
 * et erreurs : ceux du fournisseur.
 */
export function waitForLoopback(
  provider: LoginProvider,
  state: string,
  signal: AbortSignal,
  open: (redirectUri: string) => Promise<void>,
  timeoutMs = BROWSER_TIMEOUT
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let redirectUri = ''
    let settled = false
    const finish = (err: Error | null, code?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      server.close()
      // Connexions gardées ouvertes par le navigateur : fermées après l'envoi de la page.
      setTimeout(() => server.closeAllConnections(), 500)
      if (err) reject(err)
      else resolve({ code: code!, redirectUri })
    }
    const reply = (res: http.ServerResponse, status: number, html: string): void => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' })
      res.end(html)
    }

    const server = http.createServer((req, res) => {
      const result = parseLoopbackCallback(req.url, state)
      switch (result.type) {
        case 'code':
          reply(res, 200, PAGE(t(`account.${provider}.page.successTitle`), t(`account.${provider}.page.successText`)))
          finish(null, result.code)
          break
        case 'error': {
          const { page, error } = loopbackError(provider, result.error)
          reply(res, 200, page)
          finish(error)
          break
        }
        case 'invalid':
          reply(res, 400, PAGE(t(`account.${provider}.page.invalidTitle`), t(`account.${provider}.page.invalidText`)))
          break
        default:
          res.writeHead(404, { Connection: 'close' })
          res.end()
      }
    })
    const onAbort = (): void => finish(new Error(t(`account.${provider}.cancelled`)))
    const timer = setTimeout(() => finish(new Error(t(`account.${provider}.expired`))), timeoutMs)
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort)
    server.on('error', (err) => finish(new Error(t(`account.${provider}.failed`, { error: err.message }))))
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`
      // Adresse de la page impossible à construire (exception avant l'ouverture) : erreur rendue telle quelle.
      let opened: Promise<void>
      try {
        opened = open(redirectUri)
      } catch (err) {
        return finish(err as Error)
      }
      opened.catch((err: unknown) => finish(new Error(t(`account.${provider}.noBrowser`, { error: (err as Error).message }))))
    })
  })
}

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
// Connexion des versions 1.7.0 à 1.8.2 ({token: "pm_…"}) : convertie par /auth/app/migrate à la première requête
// (l'ancien jeton est alors supprimé par l'API) ; hors ligne, l'ancien fichier est gardé jusqu'au prochain essai.
//
// Connexion Google : flux « application de bureau » avec PKCE. La page Google s'ouvre dans le navigateur et revient sur
// un petit serveur http://127.0.0.1:<port>/callback ouvert le temps de la connexion ; le code reçu est échangé par
// l'API, qui garde le secret du client.
//
// Aucune dépendance à Electron ici (testé avec vitest) : le service fournit fetch, l'ouverture du navigateur et le
// chiffrement du système.

import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { AccountMe, AccountProfile, AuthorRef, ProfileInput, ProfileLink } from '@shared/types'
import type { SystemProtection } from './keys'
import { log } from '../util/log'

const TIMEOUT = 20_000
const GOOGLE_TIMEOUT = 5 * 60_000
/** Jeton d'accès renouvelé quand il expire dans moins de 60 s. */
const RENEW_MARGIN = 60_000
/** Renouvellement régulier quand l'appli reste ouverte longtemps. */
const KEEP_ALIVE = 12 * 3_600_000
export const AVATAR_MAX = 8 * 1024 * 1024

const AVATAR_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}
export const AVATAR_EXTENSIONS = Object.keys(AVATAR_TYPES).map((e) => e.slice(1))

/** Erreur renvoyée par l'API : `detail` (message à afficher) et `code` facultatif. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string
  ) {
    super(message)
  }
}

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

export interface GoogleConfig {
  clientId: string
  authorizationEndpoint: string
  scope: string
}

/** Adresse de la page de connexion Google. */
export function googleAuthUrl(config: GoogleConfig, p: { redirectUri: string; challenge: string; state: string }): string {
  const url = new URL(config.authorizationEndpoint)
  if (url.protocol !== 'https:') throw new Error('Connexion Google indisponible (adresse invalide).')
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
  return `Reflect FiveM — ${os.hostname()}`.slice(0, 80)
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
  mustChangePassword?: boolean
  hasPassword: boolean
  googleLinked: boolean
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
    mustChangePassword: !!r.mustChangePassword,
    hasPassword: !!r.hasPassword,
    googleLinked: !!r.googleLinked
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
  if (!ok(r?.accessToken) || !ok(r.refreshToken) || !ok(r.accessTokenExpiresAt) || !r.me) throw new Error('Le serveur ne répond pas correctement.')
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
  const t = Date.parse(at)
  return !Number.isFinite(t) || t - Date.now() < margin
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
  /** Ouvre une adresse dans le navigateur. */
  openExternal: (url: string) => Promise<void>
  /** Connexion, déconnexion, profil modifié, connexion expirée. */
  onChange: (me: AccountMe | null) => void
}

interface RequestOptions {
  json?: unknown
  raw?: { data: Buffer; type: string }
  /** Jeton de l'en-tête Authorization (jeton d'accès, ou ancien jeton « pm_… » pour la conversion). */
  bearer?: string
  timeout?: number
}

const signedOut = (): ApiError => new ApiError('Vous n’êtes pas connecté.', 401, 'signed-out')

export class Account {
  private session: Session | null = null
  /** Connexion d'une version précédente, pas encore convertie. */
  private legacy: LegacySession | null = null
  /** Renouvellement (ou conversion) en cours, partagé par toutes les requêtes. */
  private renewing: Promise<void> | null = null
  private keepAlive: NodeJS.Timeout | null = null
  private google: AbortController | null = null

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

  /** Relit le compte (GET /auth/me), en renouvelant la connexion si besoin. Hors ligne : l'état enregistré est gardé. */
  async refresh(): Promise<AccountMe | null> {
    if (!this.session && !this.legacy) return null
    const me = await this.authed<RemoteMe>('GET', '/auth/me')
    if (!me.authenticated) {
      await this.forget()
      return null
    }
    await this.updateMe(toMe(me))
    return this.current()
  }

  async login(login: string, password: string): Promise<AccountMe> {
    if (!login.trim() || !password) throw new Error('Saisissez votre adresse e-mail et votre mot de passe.')
    return this.signIn(await this.request<SessionResponse>('POST', '/auth/app/login', { json: { login: login.trim(), password, deviceName: deviceName() } }))
  }

  async register(email: string, password: string, displayName: string): Promise<AccountMe> {
    const body = { email: email.trim(), password, displayName: displayName.trim(), deviceName: deviceName() }
    return this.signIn(await this.request<SessionResponse>('POST', '/auth/app/register', { json: body }))
  }

  /** Connexion Google dans le navigateur (une seule à la fois : un nouvel essai abandonne le précédent). */
  async loginWithGoogle(): Promise<AccountMe> {
    this.google?.abort()
    const abort = new AbortController()
    this.google = abort
    try {
      const config = await this.request<GoogleConfig>('GET', '/auth/app/google/config')
      const { verifier, challenge } = createPkce()
      const state = randomBytes(24).toString('base64url')
      const { code, redirectUri } = await waitForLoopback(state, abort.signal, (redirectUri) =>
        this.deps.openExternal(googleAuthUrl(config, { redirectUri, challenge, state }))
      )
      const body = { code, codeVerifier: verifier, redirectUri, deviceName: deviceName() }
      return this.signIn(await this.request<SessionResponse>('POST', '/auth/app/google', { json: body }))
    } finally {
      if (this.google === abort) this.google = null
    }
  }

  cancelGoogle(): void {
    this.google?.abort()
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
    if (!type) throw new Error('Format non pris en charge : choisissez une image PNG, JPEG, GIF ou BMP.')
    const st = await fs.stat(file)
    if (st.size > AVATAR_MAX) throw new Error('Photo trop lourde (8 Mo au plus).')
    const data = await fs.readFile(file)
    return this.withProfile(await this.authed<RemoteProfile>('PUT', '/me/avatar', { raw: { data, type }, timeout: 60_000 }))
  }

  async removeAvatar(): Promise<AccountProfile> {
    return this.withProfile(await this.authed<RemoteProfile>('DELETE', '/me/avatar'))
  }

  /** Les autres appareils sont déconnectés ; celui-ci reste connecté. */
  async changePassword(currentPassword: string | null, newPassword: string): Promise<AccountMe> {
    const body = currentPassword === null ? { newPassword } : { currentPassword, newPassword }
    await this.updateMe(toMe(await this.authed<RemoteMe>('POST', '/auth/password', { json: body })))
    return this.current()!
  }

  // ----------------------------------------------------------------

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
  private async authed<T>(method: string, pathname: string, opts: Omit<RequestOptions, 'bearer'> = {}): Promise<T> {
    const session = await this.ready()
    try {
      return await this.request<T>(method, pathname, { ...opts, bearer: session.accessToken })
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401 && err.code === 'token-invalid')) throw err
    }
    // Déjà renouvelé par une autre requête entre-temps : la nouvelle session suffit.
    if (this.session?.accessToken === session.accessToken) await this.renew()
    const next = await this.ready()
    return this.request<T>(method, pathname, { ...opts, bearer: next.accessToken })
  }

  /** Le corps est reconstruit à chaque appel : une requête peut être rejouée. */
  private async request<T>(method: string, pathname: string, opts: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
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
    } catch {
      throw new Error('Serveur injoignable. Vérifiez votre connexion à Internet.')
    }
    if (response.ok) return (response.status === 204 ? undefined : await response.json()) as T

    const problem = (await response.json().catch(() => null)) as { detail?: unknown; code?: unknown; retryAfter?: unknown } | null
    const code = typeof problem?.code === 'string' ? problem.code : undefined
    if (response.status === 403 && code === 'password-change-required' && this.session && !this.session.me.mustChangePassword)
      await this.updateMe({ ...this.session.me, mustChangePassword: true })
    throw new ApiError(problemMessage(response.status, problem), response.status, code)
  }
}

function problemMessage(status: number, problem: { detail?: unknown; retryAfter?: unknown } | null): string {
  if (typeof problem?.detail === 'string' && problem.detail.trim()) return problem.detail
  if (status === 429) {
    const s = typeof problem?.retryAfter === 'number' ? problem.retryAfter : null
    return s ? `Trop d’essais. Réessayez dans ${s < 60 ? `${s} s` : `${Math.ceil(s / 60)} min`}.` : 'Trop d’essais. Réessayez plus tard.'
  }
  return `Le serveur ne répond pas correctement (erreur ${status}).`
}

// ------------------------------------------------------------------ retour de la connexion Google

const PAGE = (title: string, text: string): string =>
  `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title><style>` +
  'html{color-scheme:light dark}body{margin:0;display:grid;place-items:center;height:100vh;font:15px/1.5 "Segoe UI",system-ui,sans-serif;' +
  'background:Canvas;color:CanvasText}main{text-align:center;padding:24px}h1{font-size:20px;margin:0 0 8px}p{margin:0;opacity:.75}</style>' +
  `</head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`

/**
 * Ouvre http://127.0.0.1:<port libre>/callback, appelle `open` avec cette adresse, puis attend la redirection de Google
 * (5 minutes au plus). Le serveur est fermé dans tous les cas.
 */
export function waitForLoopback(
  state: string,
  signal: AbortSignal,
  open: (redirectUri: string) => Promise<void>,
  timeoutMs = GOOGLE_TIMEOUT
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
          reply(res, 200, PAGE('Connexion réussie', 'Vous pouvez fermer cet onglet et revenir à Reflect FiveM.'))
          finish(null, result.code)
          break
        case 'error':
          reply(res, 200, PAGE('Connexion annulée', 'Vous pouvez fermer cet onglet.'))
          finish(new Error('Connexion annulée.'))
          break
        case 'invalid':
          reply(res, 400, PAGE('Requête invalide', 'Relancez la connexion depuis Reflect FiveM.'))
          break
        default:
          res.writeHead(404, { Connection: 'close' })
          res.end()
      }
    })
    const onAbort = (): void => finish(new Error('Connexion annulée.'))
    const timer = setTimeout(() => finish(new Error('Connexion Google expirée : réessayez.')), timeoutMs)
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort)
    server.on('error', (err) => finish(new Error(`Connexion Google impossible : ${err.message}`)))
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`
      open(redirectUri).catch((err: unknown) => finish(new Error(`Navigateur introuvable : ${(err as Error).message}`)))
    })
  })
}

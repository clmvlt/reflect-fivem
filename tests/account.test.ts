// Compte : PKCE de la connexion Google, retour sur le serveur local, jetons chiffrés, renouvellement et conversion des
// connexions des versions précédentes.
import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  Account,
  avatarMediaUrl,
  createPkce,
  googleAuthUrl,
  parseLoopbackCallback,
  pkceChallenge,
  TokenFile,
  waitForLoopback,
  type LegacySession,
  type Session,
  type StoredSession
} from '../src/main/core/account'
import type { SystemProtection } from '../src/main/core/keys'
import { log } from '../src/main/util/log'
import type { AccountMe } from '../src/shared/types'

/** Faux chiffrement du système (inversion des octets) : le fichier ne doit jamais contenir le jeton en clair. */
const fakeSystem = (available = true): SystemProtection => ({
  available: () => available,
  protect: (data) => Buffer.from(data.map((b) => b ^ 0xa5)),
  unprotect: (data) => Buffer.from(data.map((b) => b ^ 0xa5))
})

const remoteMe = {
  authenticated: true,
  id: 12,
  username: null,
  email: 'joueur@example.com',
  displayName: 'Joueur',
  slug: 'joueur',
  avatarUrl: '/users/12/avatar?v=3f2a9c1e-77aa-4b1b-8a7e-0c2d8a9b1f00',
  role: 'user',
  admin: false,
  canPublish: true,
  mustChangePassword: false,
  hasPassword: true,
  googleLinked: false
}

const json = (status: number, body: unknown, type = 'application/json'): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': type } })

let dir: string
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-account-'))
})
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('PKCE', () => {
  it('calcule le challenge S256 de l’exemple de la RFC 7636', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('génère un verifier de 43 à 128 caractères base64url et son challenge', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const { verifier, challenge } = createPkce()
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
      expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
      seen.add(verifier)
    }
    expect(seen.size).toBe(20)
  })

  it('construit l’adresse de connexion Google', () => {
    const url = new URL(
      googleAuthUrl(
        { clientId: 'client.apps.googleusercontent.com', authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth', scope: 'openid email profile' },
        { redirectUri: 'http://127.0.0.1:51234/callback', challenge: 'abc', state: 'xyz' }
      )
    )
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client.apps.googleusercontent.com',
      redirect_uri: 'http://127.0.0.1:51234/callback',
      response_type: 'code',
      scope: 'openid email profile',
      code_challenge: 'abc',
      code_challenge_method: 'S256',
      state: 'xyz',
      prompt: 'select_account'
    })
  })

  it('refuse une page de connexion qui n’est pas en https', () => {
    expect(() =>
      googleAuthUrl({ clientId: 'c', authorizationEndpoint: 'http://exemple.test/auth', scope: 's' }, { redirectUri: 'r', challenge: 'c', state: 's' })
    ).toThrow()
  })
})

describe('retour de la connexion Google', () => {
  it('lit le code quand le state correspond', () => {
    expect(parseLoopbackCallback('/callback?state=s1&code=4%2F0Ab_xyz&scope=email', 's1')).toEqual({ type: 'code', code: '4/0Ab_xyz' })
  })

  it('signale un refus (error=)', () => {
    expect(parseLoopbackCallback('/callback?error=access_denied&state=s1', 's1')).toEqual({ type: 'error', error: 'access_denied' })
  })

  it('ignore un retour d’une autre connexion ou sans code', () => {
    expect(parseLoopbackCallback('/callback?state=autre&code=abc', 's1')).toEqual({ type: 'invalid' })
    expect(parseLoopbackCallback('/callback?code=abc', 's1')).toEqual({ type: 'invalid' })
    expect(parseLoopbackCallback('/callback?error=access_denied&state=autre', 's1')).toEqual({ type: 'invalid' })
    expect(parseLoopbackCallback('/callback?state=s1', 's1')).toEqual({ type: 'invalid' })
    expect(parseLoopbackCallback('/callback?state=&code=abc', '')).toEqual({ type: 'invalid' })
  })

  it('ignore les autres adresses', () => {
    expect(parseLoopbackCallback('/favicon.ico', 's1')).toEqual({ type: 'ignore' })
    expect(parseLoopbackCallback('/', 's1')).toEqual({ type: 'ignore' })
  })

  it('attend la redirection sur 127.0.0.1 puis ferme le serveur', async () => {
    let redirect = ''
    const done = waitForLoopback('etat', new AbortController().signal, async (uri) => {
      redirect = uri
    })
    await expect.poll(() => redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    // Mauvais state : refusé, l'attente continue.
    expect((await fetch(`${redirect}?state=autre&code=pirate`)).status).toBe(400)
    const page = await fetch(`${redirect}?state=etat&code=le-code`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Connexion réussie')
    await expect(done).resolves.toEqual({ code: 'le-code', redirectUri: redirect })
    await expect(fetch(`${redirect}?state=etat&code=encore`)).rejects.toThrow()
  })

  it('« Connexion annulée » quand l’utilisateur refuse', async () => {
    let redirect = ''
    const done = waitForLoopback('etat', new AbortController().signal, async (uri) => {
      redirect = uri
    })
    const outcome = expect(done).rejects.toThrow('Connexion annulée.')
    await expect.poll(() => redirect).not.toBe('')
    const page = await fetch(`${redirect}?state=etat&error=access_denied`)
    expect(await page.text()).toContain('Connexion annulée')
    await outcome
  })

  it('abandon et délai dépassé', async () => {
    const abort = new AbortController()
    const cancelled = waitForLoopback('etat', abort.signal, async () => abort.abort())
    await expect(cancelled).rejects.toThrow('Connexion annulée.')
    await expect(waitForLoopback('etat', new AbortController().signal, async () => undefined, 50)).rejects.toThrow('expirée')
  })
})

describe('photo des comptes', () => {
  it('sert la photo par pm-media', () => {
    expect(avatarMediaUrl('/users/12/avatar?v=3f2a-9c')).toBe('pm-media://avatar/12/3f2a-9c')
    expect(avatarMediaUrl(null)).toBeNull()
    expect(avatarMediaUrl('https://exemple.test/a.jpg')).toBeNull()
    expect(avatarMediaUrl('/users/12/avatar?v=../../x')).toBeNull()
  })
})


describe('jetons chiffrés', () => {
  const me = { id: 12, displayName: 'Joueur' } as AccountMe
  const session: Session = {
    accessToken: 'eyJ.secret-acces',
    accessTokenExpiresAt: '2027-04-01T00:15:00Z',
    refreshToken: 'rt_secret-renouvellement',
    refreshTokenExpiresAt: '2027-05-01T00:00:00Z',
    me
  }

  it('enregistre la session chiffrée, la relit, puis l’efface', async () => {
    const file = path.join(dir, 'a', 'account.dat')
    const store = new TokenFile(file, fakeSystem())
    expect(await store.load()).toBeNull()
    await store.save(session)
    expect((await fs.readFile(file)).toString('latin1')).not.toContain('secret')
    expect(await new TokenFile(file, fakeSystem()).load()).toEqual(session)
    await store.clear()
    expect(existsSync(file)).toBe(false)
    expect(await store.load()).toBeNull()
  })

  it('relit la connexion d’une version précédente (jeton pm_)', async () => {
    const file = path.join(dir, 'legacy-read.dat')
    const legacy: LegacySession = { token: 'pm_ancien', expiresAt: null, me }
    await new TokenFile(file, fakeSystem()).save(legacy)
    expect(await new TokenFile(file, fakeSystem()).load()).toEqual(legacy)
  })

  it('écritures simultanées : la dernière demandée reste sur le disque', async () => {
    const file = path.join(dir, 'serial.dat')
    const store = new TokenFile(file, fakeSystem())
    await Promise.all([1, 2, 3, 4, 5].map((n) => store.save({ ...session, refreshToken: `rt_${n}` })))
    expect(await store.load()).toMatchObject({ refreshToken: 'rt_5' })
  })

  it('oublie un fichier illisible (autre compte Windows)', async () => {
    const file = path.join(dir, 'b.dat')
    await fs.writeFile(file, 'abîmé')
    expect(await new TokenFile(file, fakeSystem()).load()).toBeNull()
    expect(existsSync(file)).toBe(false)
  })

  it('sans chiffrement du système : rien sur le disque, gardé pour la session', async () => {
    const file = path.join(dir, 'c.dat')
    const store = new TokenFile(file, fakeSystem(false))
    await store.save(session)
    expect(existsSync(file)).toBe(false)
    expect(await store.load()).toEqual(session)
    await store.clear()
    expect(await store.load()).toBeNull()
  })
})

describe('compte', () => {
  /** Réponse de connexion n° n : jeton d'accès at_n valable `ttl` ms, jeton de renouvellement rt_n. */
  const tokens = (n: number, ttl = 15 * 60_000): Record<string, unknown> => ({
    accessToken: `at_${n}`,
    accessTokenExpiresAt: new Date(Date.now() + ttl).toISOString(),
    refreshToken: `rt_${n}`,
    refreshTokenExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    me: remoteMe
  })
  const profileBody = { ...remoteMe, bio: null, links: [], createdAt: null }
  const bearer = (init: RequestInit): string | undefined => (init.headers as Record<string, string>).Authorization
  const body = (init: RequestInit): Record<string, unknown> => JSON.parse(init.body as string)
  const offline = (): never => {
    throw new TypeError('fetch failed')
  }
  const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  interface Call {
    route: string
    init: RequestInit
  }
  const accounts: Account[] = []
  afterAll(() => accounts.forEach((a) => a.dispose()))

  /** Compte branché sur une fausse API (`handler` reçoit le chemin sans /api), avec éventuellement une connexion enregistrée. */
  const setup = async (
    name: string,
    handler: (route: string, init: RequestInit) => Response | Promise<Response>,
    saved?: StoredSession
  ): Promise<{ account: Account; file: string; changes: (AccountMe | null)[]; calls: Call[]; stored: () => Promise<StoredSession | null> }> => {
    const file = path.join(dir, `${name}.dat`)
    if (saved) await new TokenFile(file, fakeSystem()).save(saved)
    const changes: (AccountMe | null)[] = []
    const calls: Call[] = []
    const account = new Account({
      apiUrl: 'https://api.test/api',
      store: new TokenFile(file, fakeSystem()),
      fetch: async (url, init) => {
        const route = new URL(url).pathname.replace(/^\/api/, '')
        calls.push({ route, init })
        return handler(route, init)
      },
      openExternal: async () => undefined,
      onChange: (me) => changes.push(me)
    })
    await account.init()
    accounts.push(account)
    return { account, file, changes, calls, stored: () => new TokenFile(file, fakeSystem()).load() }
  }

  it('connexion : session enregistrée, jeton d’accès envoyé dans l’en-tête Authorization', async () => {
    const { account, file, changes, calls, stored } = await setup('login', (r) =>
      r === '/auth/app/login' ? json(200, tokens(1)) : json(200, profileBody)
    )
    const me = await account.login(' joueur@example.com ', 'motdepasse')
    expect(me.avatarUrl).toBe('pm-media://avatar/12/3f2a9c1e-77aa-4b1b-8a7e-0c2d8a9b1f00')
    expect(changes).toEqual([me])
    expect(body(calls[0].init)).toMatchObject({ login: 'joueur@example.com', password: 'motdepasse', deviceName: expect.stringMatching(/^Reflect FiveM — /) })
    expect(await stored()).toMatchObject({ accessToken: 'at_1', refreshToken: 'rt_1', me: { id: 12 } })

    await account.profile()
    expect(calls.map((c) => c.route)).toEqual(['/auth/app/login', '/me'])
    expect(bearer(calls[1].init)).toBe('Bearer at_1')

    // Relu au lancement suivant.
    const next = new Account({ apiUrl: '', store: new TokenFile(file, fakeSystem()), fetch, openExternal: async () => undefined, onChange: () => undefined })
    await next.init()
    next.dispose()
    expect(next.current()?.id).toBe(12)
  })

  it('inscription : /auth/app/register', async () => {
    const { account, calls } = await setup('register', () => json(201, tokens(1)))
    await account.register(' joueur@example.com ', 'motdepasse', ' Joueur ')
    expect(calls[0].route).toBe('/auth/app/register')
    expect(body(calls[0].init)).toMatchObject({ email: 'joueur@example.com', displayName: 'Joueur', deviceName: expect.any(String) })
    expect(account.current()?.id).toBe(12)
  })

  it('renouvelle le jeton d’accès avant son expiration, après avoir enregistré le nouveau jeton de renouvellement', async () => {
    let storedAtUse: StoredSession | null = null
    const { account, calls, stored } = await setup('renew', async (r, init) => {
      if (r === '/auth/app/login') return json(200, tokens(1, 30_000))
      if (r === '/auth/app/refresh') return body(init).refreshToken === 'rt_1' ? json(200, tokens(2)) : json(401, { code: 'refresh-invalid' })
      storedAtUse = await stored()
      return json(200, profileBody)
    })
    await account.login('joueur@example.com', 'motdepasse')
    await account.profile()
    expect(calls.map((c) => c.route)).toEqual(['/auth/app/login', '/auth/app/refresh', '/me'])
    expect(bearer(calls[1].init)).toBeUndefined()
    expect(bearer(calls[2].init)).toBe('Bearer at_2')
    expect(storedAtUse).toMatchObject({ accessToken: 'at_2', refreshToken: 'rt_2' })

    // Jeton valable 15 minutes : pas de nouveau renouvellement.
    await account.profile()
    expect(calls.map((c) => c.route).slice(3)).toEqual(['/me'])
  })

  it('401 « token-invalid » : renouvelle une fois puis rejoue la requête avec le même corps (JSON, photo)', async () => {
    const rejected = new Set(['Bearer at_1'])
    let n = 1
    const { account, calls, stored } = await setup('retry', (r, init) => {
      if (r === '/auth/app/login') return json(200, tokens(1))
      if (r === '/auth/app/refresh') return json(200, tokens(++n))
      if (rejected.has(bearer(init) ?? '')) return json(401, { detail: 'Connexion expirée.', code: 'token-invalid' }, 'application/problem+json')
      return json(200, profileBody)
    })
    await account.login('joueur@example.com', 'motdepasse')
    const trace = (): string[] => calls.map((c) => `${c.init.method} ${c.route} ${bearer(c.init) ?? ''}`.trim())

    calls.length = 0
    const input = { displayName: 'Joueur', bio: 'Bonjour', links: [{ label: 'Site', url: 'https://exemple.test' }] }
    await account.saveProfile(input)
    expect(trace()).toEqual(['PUT /me Bearer at_1', 'POST /auth/app/refresh', 'PUT /me Bearer at_2'])
    expect(body(calls[2].init)).toEqual(input)
    expect(calls[2].init.body).toBe(calls[0].init.body)
    expect(await stored()).toMatchObject({ refreshToken: 'rt_2' })

    // Photo : le fichier est renvoyé tel quel.
    rejected.add('Bearer at_2')
    const photo = path.join(dir, 'photo.png')
    await fs.writeFile(photo, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    calls.length = 0
    await account.setAvatarFile(photo)
    expect(trace()).toEqual(['PUT /me/avatar Bearer at_2', 'POST /auth/app/refresh', 'PUT /me/avatar Bearer at_3'])
    expect(Buffer.from(calls[0].init.body as Uint8Array)).toEqual(await fs.readFile(photo))
    expect(Buffer.from(calls[2].init.body as Uint8Array)).toEqual(await fs.readFile(photo))

    // Encore refusé après le renouvellement : erreur après un seul nouvel essai, connexion gardée.
    rejected.add('Bearer at_3').add('Bearer at_4')
    calls.length = 0
    await expect(account.profile()).rejects.toMatchObject({ status: 401, code: 'token-invalid' })
    expect(trace()).toEqual(['GET /me Bearer at_3', 'POST /auth/app/refresh', 'GET /me Bearer at_4'])
    expect(account.current()).not.toBeNull()
  })

  it('appels simultanés : un seul renouvellement', async () => {
    const rejected = new Set<string>()
    let n = 1
    const { account, calls } = await setup('concurrent', async (r, init) => {
      if (r === '/auth/app/login') return json(200, tokens(1, 10_000))
      if (r === '/auth/app/refresh') {
        await tick(30)
        return json(200, tokens(++n))
      }
      await tick(5)
      if (rejected.has(bearer(init) ?? '')) return json(401, { code: 'token-invalid' })
      return json(200, r === '/auth/me' ? remoteMe : profileBody)
    })
    await account.login('joueur@example.com', 'motdepasse')
    const refreshes = (): number => calls.filter((c) => c.route === '/auth/app/refresh').length

    // Jeton bientôt expiré.
    calls.length = 0
    await Promise.all([account.profile(), account.profile(), account.refresh(), account.removeAvatar()])
    expect(refreshes()).toBe(1)
    expect(calls.filter((c) => c.route !== '/auth/app/refresh').map((c) => bearer(c.init))).toEqual(Array(4).fill('Bearer at_2'))

    // Jeton refusé pour plusieurs requêtes à la fois.
    rejected.add('Bearer at_2')
    await Promise.all([account.profile(), account.profile(), account.profile()])
    expect(refreshes()).toBe(2)
    expect(calls.slice(-3).map((c) => bearer(c.init))).toEqual(Array(3).fill('Bearer at_3'))
  })

  it('profil reçu pendant un renouvellement : les nouveaux jetons sont gardés', async () => {
    const { account, calls, stored } = await setup('renew-during-profile', async (r, init) => {
      if (r === '/auth/app/login') return json(200, tokens(1))
      if (r === '/auth/app/refresh') {
        await tick(60)
        return json(200, tokens(2))
      }
      if (r === '/auth/me') {
        // Requête partie avec at_1 avant le renouvellement, revenue pendant : nom modifié sur le site.
        await tick(20)
        return json(200, { ...remoteMe, displayName: 'Nouveau nom' })
      }
      return bearer(init) === 'Bearer at_1' ? json(401, { code: 'token-invalid' }) : json(200, profileBody)
    })
    await account.login('joueur@example.com', 'motdepasse')
    await Promise.all([account.refresh(), account.profile()])
    expect(calls.filter((c) => c.route === '/auth/app/refresh')).toHaveLength(1)
    expect(bearer(calls.at(-1)!.init)).toBe('Bearer at_2')
    expect(await stored()).toMatchObject({ accessToken: 'at_2', refreshToken: 'rt_2' })
  })

  it('401 « refresh-invalid » : connexion effacée, retour à l’état déconnecté', async () => {
    const { account, file, changes } = await setup('refresh-invalid', (r) => {
      if (r === '/auth/app/login') return json(200, tokens(1, -1000))
      if (r === '/auth/app/refresh') return json(401, { detail: 'Connexion expirée : reconnectez-vous.', code: 'refresh-invalid' }, 'application/problem+json')
      return json(200, remoteMe)
    })
    await account.login('joueur@example.com', 'motdepasse')
    await expect(account.refresh()).rejects.toThrow('Connexion expirée : reconnectez-vous.')
    expect(account.current()).toBeNull()
    expect(existsSync(file)).toBe(false)
    expect(changes.at(-1)).toBeNull()
    await expect(account.profile()).rejects.toMatchObject({ code: 'signed-out' })
  })

  it('hors ligne ou serveur indisponible : connexion gardée, renouvelée plus tard', async () => {
    let network: 'off' | 'error' | 'on' = 'off'
    const { account, changes, calls, stored } = await setup('offline', (r, init) => {
      if (r === '/auth/app/login') return json(200, tokens(1, -1000))
      if (network === 'off') offline()
      if (network === 'error') return json(503, null)
      if (r === '/auth/app/refresh') return body(init).refreshToken === 'rt_1' ? json(200, tokens(2)) : json(401, { code: 'refresh-invalid' })
      return json(200, remoteMe)
    })
    const me = await account.login('joueur@example.com', 'motdepasse')
    await expect(account.refresh()).rejects.toThrow('Serveur injoignable')
    network = 'error'
    await expect(account.refresh()).rejects.toMatchObject({ status: 503 })
    expect(account.current()).toEqual(me)
    expect(await stored()).toMatchObject({ refreshToken: 'rt_1' })
    expect(changes).toEqual([me])

    network = 'on'
    expect(await account.refresh()).toEqual(me)
    expect(calls.slice(-2).map((c) => c.route)).toEqual(['/auth/app/refresh', '/auth/me'])
    expect(bearer(calls.at(-1)!.init)).toBe('Bearer at_2')
    expect(await stored()).toMatchObject({ refreshToken: 'rt_2' })
  })

  it('renouvellement impossible mais jeton d’accès encore valable : la requête part quand même', async () => {
    const { account, calls } = await setup('offline-valid', (r) => {
      if (r === '/auth/app/login') return json(200, tokens(1, 30_000))
      if (r === '/auth/app/refresh') offline()
      return json(200, profileBody)
    })
    await account.login('joueur@example.com', 'motdepasse')
    await account.profile()
    expect(calls.map((c) => c.route)).toEqual(['/auth/app/login', '/auth/app/refresh', '/me'])
    expect(bearer(calls[2].init)).toBe('Bearer at_1')
  })

  it('convertit la connexion pm_ d’une version précédente', async () => {
    const legacyMe = { id: 12, displayName: 'Ancien nom' } as AccountMe
    let up = false
    const { account, calls, changes, stored } = await setup(
      'migrate',
      (r) => {
        if (!up) offline()
        return json(200, r === '/auth/app/migrate' ? tokens(1) : remoteMe)
      },
      { token: 'pm_ancien', expiresAt: null, me: legacyMe }
    )
    expect(account.current()).toEqual(legacyMe)

    // Hors ligne : l'ancien fichier est gardé, nouvel essai au prochain appel.
    await expect(account.refresh()).rejects.toThrow('Serveur injoignable')
    expect(account.current()).toEqual(legacyMe)
    expect(await stored()).toEqual({ token: 'pm_ancien', expiresAt: null, me: legacyMe })

    up = true
    calls.length = 0
    const me = await account.refresh()
    expect(me?.displayName).toBe('Joueur')
    expect(calls.map((c) => `${c.init.method} ${c.route} ${bearer(c.init)}`)).toEqual(['POST /auth/app/migrate Bearer pm_ancien', 'GET /auth/me Bearer at_1'])
    expect(body(calls[0].init)).toEqual({ deviceName: expect.stringMatching(/^Reflect FiveM — /) })
    const saved = await stored()
    expect(saved).toMatchObject({ accessToken: 'at_1', refreshToken: 'rt_1' })
    expect(saved).not.toHaveProperty('token')
    expect(changes).toEqual([me])
  })

  it('connexion pm_ refusée (401) : effacée', async () => {
    const { account, file, changes } = await setup('migrate-401', () => json(401, { code: 'token-invalid' }), {
      token: 'pm_revoque',
      expiresAt: null,
      me: { id: 12 } as AccountMe
    })
    await expect(account.refresh()).rejects.toMatchObject({ status: 401 })
    expect(account.current()).toBeNull()
    expect(existsSync(file)).toBe(false)
    expect(changes).toEqual([null])
  })

  it('les erreurs affichent le `detail` de l’API', async () => {
    const { account, changes } = await setup('errors', () =>
      json(429, { detail: 'Trop d’essais. Réessayez dans 30 s.', retryAfter: 30 }, 'application/problem+json')
    )
    await expect(account.login('joueur@example.com', 'faux')).rejects.toThrow('Trop d’essais. Réessayez dans 30 s.')
    expect(account.current()).toBeNull()
    expect(changes).toEqual([])
  })

  it('déconnexion : jeton de renouvellement envoyé sans en-tête Authorization, connexion effacée', async () => {
    const { account, file, calls, changes } = await setup('logout', (r) => (r === '/auth/app/login' ? json(200, tokens(1)) : json(204, undefined)))
    await account.login('joueur@example.com', 'motdepasse')
    await account.logout()
    expect(calls.map((c) => `${c.init.method} ${c.route}`)).toEqual(['POST /auth/app/login', 'POST /auth/app/logout'])
    expect(body(calls[1].init)).toEqual({ refreshToken: 'rt_1' })
    expect(bearer(calls[1].init)).toBeUndefined()
    expect(account.current()).toBeNull()
    expect(existsSync(file)).toBe(false)
    expect(changes.at(-1)).toBeNull()
  })

  it('déconnexion : connexion effacée même si le serveur est injoignable', async () => {
    let down = false
    const { account, file } = await setup('logout-offline', () => (down ? offline() : json(200, tokens(1))))
    await account.login('joueur@example.com', 'motdepasse')
    down = true
    await account.logout()
    expect(account.current()).toBeNull()
    expect(existsSync(file)).toBe(false)
  })

  it('appli ouverte longtemps : renouvellement toutes les 12 heures', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] })
    try {
      let n = 1
      const { account, calls } = await setup('keep-alive', (r) => json(200, r === '/auth/app/refresh' ? tokens(++n) : tokens(1)))
      await account.login('joueur@example.com', 'motdepasse')
      vi.advanceTimersByTime(11 * 3_600_000)
      expect(calls).toHaveLength(1)
      vi.advanceTimersByTime(3_600_000)
      await expect.poll(() => calls.map((c) => c.route)).toEqual(['/auth/app/login', '/auth/app/refresh'])
      await expect.poll(() => account['renewing']).toBeNull()
      vi.advanceTimersByTime(12 * 3_600_000)
      await expect.poll(() => calls.length).toBe(3)
      expect(body(calls[2].init)).toEqual({ refreshToken: 'rt_2' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('aucun jeton dans le journal', () => {
    const lines = log.recent().map((l) => l.message)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).not.toMatch(/\b(at|rt|pm)_\w|secret|Bearer/)
  })
})

// Notes et commentaires des packs : réponses de l'API mises au format de l'interface, requêtes au nom du compte
// connecté (ou anonymes), erreurs transmises à l'interface avec leur code.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Account, ApiError, TokenFile, type Session } from '../src/main/core/account'
import { commentBody, Community, toComment, toCommentPage, toRatings, type RemoteComment } from '../src/main/core/community'
import type { SystemProtection } from '../src/main/core/keys'
import { readApiError, tagApiError } from '../src/shared/api'
import type { AccountMe, MarketPack } from '../src/shared/types'

const fakeSystem: SystemProtection = {
  available: () => true,
  protect: (data) => Buffer.from(data.map((b) => b ^ 0x5a)),
  unprotect: (data) => Buffer.from(data.map((b) => b ^ 0x5a))
}

const json = (status: number, body: unknown): Response =>
  status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const PACK = 'aa665074-b72c-498a-b3b5-f90f78957a65'

const author = { id: 7, slug: 'auteur', displayName: 'Auteur', avatarUrl: '/users/7/avatar?v=abc' }

const comment = (extra: Partial<RemoteComment> = {}): RemoteComment => ({
  id: 'c1',
  packId: PACK,
  parentId: null,
  status: 'visible',
  body: 'Superbe pack\nmerci',
  author,
  byPackAuthor: false,
  byAdmin: false,
  authorRating: 4,
  pinned: false,
  createdAt: '2026-10-01T10:00:00Z',
  editedAt: null,
  editedByModerator: false,
  mine: false,
  canEdit: false,
  canDelete: false,
  canReply: true,
  ...extra
})

describe('notes', () => {
  it('reprend la moyenne, la répartition et la raison', () => {
    expect(
      toRatings({
        average: 4.3,
        count: 12,
        distribution: { '1': 0, '2': 1, '3': 1, '4': 4, '5': 6 },
        mine: 5,
        downloaded: true,
        canRate: true,
        reason: null
      })
    ).toEqual({ average: 4.3, count: 12, distribution: { 1: 0, 2: 1, 3: 1, 4: 4, 5: 6 }, mine: 5, downloaded: true, canRate: true, reason: null })
  })

  it('valeurs neutres pour une réponse incomplète ou inattendue', () => {
    expect(toRatings({ reason: 'login-required' })).toEqual({
      average: null,
      count: 0,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      mine: null,
      downloaded: false,
      canRate: false,
      reason: 'login-required'
    })
    expect(toRatings({ mine: 9, reason: 'autre-chose' })).toMatchObject({ mine: null, reason: null })
  })
})

describe('commentaires', () => {
  it('photo des auteurs servie par pm-media, réponses et @nom', () => {
    const reply = comment({ id: 'r2', parentId: 'c1', replyTo: { id: 'r1', author: { ...author, id: 8, avatarUrl: null } }, authorRating: null })
    const c = toComment(comment({ replyCount: 5, replies: [reply] }))
    expect(c.author).toEqual({ id: 7, slug: 'auteur', displayName: 'Auteur', avatarUrl: 'pm-media://avatar/7/abc' })
    expect(c.replyCount).toBe(5)
    expect(c.replies[0]).toMatchObject({ id: 'r2', parentId: 'c1', replyTo: { id: 'r1', author: { id: 8, avatarUrl: null } }, authorRating: null })
    expect(c.body).toBe('Superbe pack\nmerci')
  })

  it('commentaire masqué ou supprimé sans texte, champs d’admin absents', () => {
    const c = toComment(comment({ status: 'hidden', body: null, author: null }))
    expect(c).toMatchObject({ status: 'hidden', body: null, author: null, moderationReason: null, reportCount: null, replies: [], replyCount: 0 })
    expect(toComment(comment({ status: 'inconnu' })).status).toBe('visible')
  })

  it('page de commentaires', () => {
    const page = toCommentPage({ items: [comment()], page: 0, total: 1, totalPages: 1, commentCount: 3, locked: false, canComment: true })
    expect(page).toMatchObject({ page: 0, total: 1, totalPages: 1, commentCount: 3, locked: false, canComment: true })
    expect(toCommentPage({})).toEqual({ items: [], page: 0, total: 0, totalPages: 0, commentCount: 0, locked: false, canComment: false })
  })

  it('texte de 1 à 2 000 caractères', () => {
    expect(commentBody('  Bonjour  ')).toBe('Bonjour')
    expect(() => commentBody('   ')).toThrow()
    expect(commentBody('a'.repeat(2000))).toHaveLength(2000)
    expect(() => commentBody('a'.repeat(2001))).toThrow()
  })
})

describe('erreurs de l’API transmises à l’interface', () => {
  it('statut et code ajoutés au message, puis retirés', () => {
    const tagged = tagApiError('Installez ce pack pour pouvoir le noter.', 403, 'download-required')
    expect(readApiError(tagged)).toEqual({ message: 'Installez ce pack pour pouvoir le noter.', status: 403, code: 'download-required' })
    expect(readApiError(tagApiError('Trop de commentaires.', 429))).toEqual({ message: 'Trop de commentaires.', status: 429, code: null })
    expect(readApiError('Erreur ordinaire')).toEqual({ message: 'Erreur ordinaire', status: null, code: null })
  })
})

describe('requêtes', () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-community-'))
  })
  const accounts: Account[] = []
  afterAll(async () => {
    accounts.forEach((a) => a.dispose())
    await fs.rm(dir, { recursive: true, force: true })
  })

  interface Call {
    method: string
    route: string
    auth: string | undefined
    body: unknown
  }

  const me = { id: 12, displayName: 'Joueur', muted: false } as AccountMe
  const session = (n: number): Session => ({
    accessToken: `at_${n}`,
    accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    refreshToken: `rt_${n}`,
    refreshTokenExpiresAt: null,
    me
  })

  const setup = async (name: string, handler: (c: Call) => Response, saved?: Session): Promise<{ community: Community; account: Account; calls: Call[] }> => {
    const file = path.join(dir, `${name}.dat`)
    if (saved) await new TokenFile(file, fakeSystem).save(saved)
    const calls: Call[] = []
    const account = new Account({
      apiUrl: 'https://api.test/api',
      store: new TokenFile(file, fakeSystem),
      fetch: async (url, init) => {
        const u = new URL(url)
        const call: Call = {
          method: init.method ?? 'GET',
          route: u.pathname.replace(/^\/api/, '') + u.search,
          auth: (init.headers as Record<string, string>).Authorization,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined
        }
        calls.push(call)
        return handler(call)
      },
      openExternal: async () => undefined,
      onChange: () => undefined
    })
    await account.init()
    accounts.push(account)
    const toPacks = async (items: unknown[]): Promise<MarketPack[]> => items.map((p) => ({ ...(p as object), localId: null }) as MarketPack)
    return { community: new Community(account, toPacks), account, calls }
  }

  it('sans connexion : lecture anonyme, écriture refusée sans requête', async () => {
    const { community, calls } = await setup('anonyme', () => json(200, { average: null, count: 0, canRate: false, reason: 'login-required' }))
    expect((await community.ratings(PACK)).reason).toBe('login-required')
    expect(calls).toEqual([{ method: 'GET', route: `/packs/${PACK}/ratings`, auth: undefined, body: undefined }])
    const refused = await community.rate(PACK, 4).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(ApiError)
    expect(refused).toMatchObject({ status: 401, code: 'signed-out' })
    expect(calls).toHaveLength(1)
  })

  it('connecté : jeton d’accès envoyé, note et commentaire', async () => {
    const { community, calls } = await setup(
      'connecte',
      (c) => {
        if (c.route.endsWith('/rating') && c.method === 'PUT') return json(200, { average: 4, count: 1, mine: 4, downloaded: true, canRate: true })
        if (c.route.endsWith('/rating') && c.method === 'DELETE') return json(204, undefined)
        if (c.route.endsWith('/ratings')) return json(200, { average: null, count: 0, mine: null, downloaded: true, canRate: true })
        if (c.method === 'POST') return json(201, comment({ id: 'c9', parentId: 'c1', mine: true, canEdit: true }))
        return json(200, { items: [comment()], page: 0, total: 1, totalPages: 1, commentCount: 1, canComment: true })
      },
      session(1)
    )
    expect((await community.rate(PACK, 4)).mine).toBe(4)
    expect(calls[0]).toEqual({ method: 'PUT', route: `/packs/${PACK}/rating`, auth: 'Bearer at_1', body: { stars: 4 } })

    // Note retirée : réponse vide, notes relues.
    expect((await community.rate(PACK, null)).mine).toBeNull()
    expect(calls.slice(1).map((c) => `${c.method} ${c.route}`)).toEqual([`DELETE /packs/${PACK}/rating`, `GET /packs/${PACK}/ratings`])
    await expect(community.rate(PACK, 6)).rejects.toThrow()

    const page = await community.comments(PACK, { sort: 'oldest', page: 2 })
    expect(page.canComment).toBe(true)
    expect(calls.at(-1)).toMatchObject({ route: `/packs/${PACK}/comments?sort=oldest&page=2&size=20`, auth: 'Bearer at_1' })

    const posted = await community.post(PACK, '  Merci !  ', 'c1')
    expect(posted).toMatchObject({ id: 'c9', mine: true, canEdit: true })
    expect(calls.at(-1)).toMatchObject({ method: 'POST', route: `/packs/${PACK}/comments`, body: { body: 'Merci !', parentId: 'c1' } })
  })

  it('mods : mêmes requêtes, sous /mods ; téléchargements filtrés par genre', async () => {
    const { community, calls } = await setup(
      'mods',
      (c) => {
        if (c.route.startsWith('/me/downloads')) return json(200, { items: [], page: 0, total: 0, totalPages: 0 })
        if (c.route.includes('/comments')) return json(200, { items: [], page: 0, total: 0, totalPages: 0, commentCount: 0, canComment: true })
        return json(200, { average: null, count: 0, mine: null, downloaded: false, canRate: false, reason: 'download-required' })
      },
      session(1)
    )
    expect((await community.ratings(PACK, 'mod')).reason).toBe('download-required')
    await community.comments(PACK, {}, 'mod')
    await community.replies(PACK, 'c1', 0, 20, 'mod')
    await community.myDownloads(0, 'mod')
    await community.myDownloads(0)
    expect(calls.map((c) => c.route)).toEqual([
      `/mods/${PACK}/ratings`,
      `/mods/${PACK}/comments?sort=recent&page=0&size=20`,
      `/mods/${PACK}/comments/c1/replies?page=0&size=20`,
      '/me/downloads?page=0&size=24&kind=mod',
      '/me/downloads?page=0&size=24'
    ])
  })

  it('refus de l’API : message et code ; « muted » met le compte à jour', async () => {
    const { community, account } = await setup(
      'muet',
      () => new Response(JSON.stringify({ detail: 'Votre compte est réduit au silence.', code: 'muted' }), { status: 403, headers: { 'Content-Type': 'application/problem+json' } }),
      session(1)
    )
    const err = await community.post(PACK, 'Bonjour').catch((e: unknown) => e)
    expect(err).toMatchObject({ message: 'Votre compte est réduit au silence.', status: 403, code: 'muted' })
    expect(account.current()?.muted).toBe(true)
  })

  it('jeton d’accès pour les téléchargements, renouvelé quand il est refusé', async () => {
    let n = 1
    const { account, calls } = await setup(
      'telechargement',
      (c) => {
        if (c.route === '/auth/app/refresh') {
          n++
          return json(200, { ...session(n), me: { id: 12, displayName: 'Joueur', slug: 'joueur', avatarUrl: null, admin: false, canPublish: false, hasPassword: true, googleLinked: false } })
        }
        return json(500, {})
      },
      session(1)
    )
    expect(await account.accessToken()).toBe('at_1')
    expect(await account.renewRejected('at_1')).toBe('at_2')
    // Déjà renouvelé par une autre requête : pas de nouveau renouvellement.
    expect(await account.renewRejected('at_1')).toBe('at_2')
    expect(calls.filter((c) => c.route === '/auth/app/refresh')).toHaveLength(1)
  })
})

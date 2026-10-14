// Maintenances prévues par l'admin : réponse 503 « maintenance » de l'API (http.ts), compte gardé connecté, dates et
// compte à rebours corrigés par l'heure du serveur, suivi de GET /maintenance, téléchargements en pause.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Account, TokenFile, type Session } from '../src/main/core/account'
import { ApiError, MaintenanceError, maintenanceError, onMaintenanceError, retryAfterSeconds, serverFetch } from '../src/main/core/http'
import { MaintenanceWatch, PausedDownloads } from '../src/main/core/maintenance'
import type { SystemProtection } from '../src/main/core/keys'
import { readApiError, tagApiError } from '../src/shared/api'
import {
  ANNOUNCE_BEFORE,
  CHECK_EVERY,
  CHECK_EVERY_SOON,
  clockText,
  countdown,
  emptyMaintenanceState,
  msUntil,
  nextBoundary,
  nextCheckDelay,
  nextMaintenance,
  ongoingMaintenance,
  parseMaintenance,
  parseMaintenanceStatus,
  serverNow,
  SOON_BEFORE,
  type Maintenance,
  type MaintenanceState
} from '../src/shared/maintenance'
import type { AccountMe } from '../src/shared/types'

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const H = 3_600_000
const T0 = Date.parse('2026-10-20T20:00:00Z')
const iso = (ms: number): string => new Date(ms).toISOString()

const maintenance = (startsAt: number, endsAt: number, extra: Partial<Maintenance> = {}): Maintenance => ({
  id: 'm-1',
  startsAt: iso(startsAt),
  endsAt: iso(endsAt),
  message: 'Migration de la base de données.',
  status: 'upcoming',
  createdAt: iso(T0 - 24 * H),
  updatedAt: iso(T0 - 24 * H),
  ...extra
})

/** Réponse 503 de l'API pendant une maintenance. */
const maintenanceResponse = (m: Maintenance, retryAfter = '1800'): Response =>
  new Response(JSON.stringify({ type: 'about:blank', status: 503, code: 'maintenance', detail: 'Reflect FiveM est en maintenance.', maintenance: m }), {
    status: 503,
    headers: { 'Content-Type': 'application/problem+json', 'Retry-After': retryAfter }
  })

const state = (extra: Partial<MaintenanceState> = {}): MaintenanceState => ({ ...emptyMaintenanceState(), ...extra })

// ------------------------------------------------------------------ http.ts

describe('réponse 503 « maintenance » (http.ts)', () => {
  const m = maintenance(T0, T0 + 2 * H, { status: 'active' })

  it('lève une MaintenanceError qui porte la maintenance et Retry-After, et la signale', async () => {
    const seen: MaintenanceError[] = []
    const off = onMaintenanceError((err) => seen.push(err))
    const fetch = vi.fn(async () => maintenanceResponse(m))
    try {
      const err = await serverFetch(fetch)('https://api.test/api/packs').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(MaintenanceError)
      expect(err).toBeInstanceOf(ApiError)
      const e = err as MaintenanceError
      expect(e).toMatchObject({ status: 503, code: 'maintenance', retryAfter: 1800, message: 'Reflect FiveM est en maintenance.' })
      expect(e.maintenance).toEqual(m)
      expect(seen).toEqual([e])
      // Une seule requête : aucune nouvelle tentative.
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      off()
    }
  })

  it('envoie la langue affichée', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json(200, {}))
    await serverFetch(fetch)('https://api.test/api/packs')
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('Accept-Language')).toBe('fr')
  })

  it('rend telles quelles les autres réponses, 503 compris', async () => {
    const seen = vi.fn()
    const off = onMaintenanceError(seen)
    try {
      const other = await serverFetch(async () => json(503, { code: 'overloaded', detail: 'Serveur surchargé' }))('https://api.test/api/packs')
      expect(other.status).toBe(503)
      expect(await other.json()).toEqual({ code: 'overloaded', detail: 'Serveur surchargé' })
      const ok = await serverFetch(async () => json(200, { items: [] }))('https://api.test/api/packs')
      expect(await ok.json()).toEqual({ items: [] })
      expect(seen).not.toHaveBeenCalled()
    } finally {
      off()
    }
  })

  it('lit le corps sur une copie et accepte une réponse sans la maintenance', async () => {
    const response = new Response(JSON.stringify({ code: 'maintenance' }), { status: 503 })
    const err = await maintenanceError(response)
    expect(err).toMatchObject({ maintenance: null, retryAfter: null, message: 'Reflect FiveM est en maintenance.' })
    expect(await response.json()).toEqual({ code: 'maintenance' })
  })

  it('Retry-After en secondes ou en date HTTP', () => {
    expect(retryAfterSeconds('120')).toBe(120)
    expect(retryAfterSeconds(new Date(T0 + 90_000).toUTCString(), T0)).toBe(90)
    expect(retryAfterSeconds(null)).toBeNull()
    expect(retryAfterSeconds('bientôt')).toBeNull()
  })

  it('passe dans l’IPC avec son code, reconnu par l’interface', () => {
    const err = new MaintenanceError('Reflect FiveM est en maintenance.', m, 60)
    expect(readApiError(tagApiError(err.message, err.status, err.code))).toEqual({ message: 'Reflect FiveM est en maintenance.', status: 503, code: 'maintenance' })
  })
})

// ------------------------------------------------------------------ compte

describe('compte pendant une maintenance', () => {
  let dir: string
  const accounts: Account[] = []
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-maintenance-account-'))
  })
  afterAll(async () => {
    accounts.forEach((a) => a.dispose())
    await fs.rm(dir, { recursive: true, force: true })
  })
  const fakeSystem: SystemProtection = {
    available: () => true,
    protect: (data) => Buffer.from(data.map((b) => b ^ 0x5a)),
    unprotect: (data) => Buffer.from(data.map((b) => b ^ 0x5a))
  }
  const me = { id: 12, displayName: 'Joueur', admin: false } as AccountMe
  const session: Session = { accessToken: 'at_1', accessTokenExpiresAt: iso(Date.now() + 15 * 60_000), refreshToken: 'rt_1', refreshTokenExpiresAt: null, me }

  it('garde la connexion : l’erreur remonte telle quelle, sans « réseau » ni déconnexion', async () => {
    const file = path.join(dir, 'account.dat')
    await new TokenFile(file, fakeSystem).save(session)
    const onChange = vi.fn()
    const fetch = vi.fn(async () => maintenanceResponse(maintenance(T0, T0 + H, { status: 'active' })))
    // Avec serverFetch (application) et sans (fetch brut) : même erreur.
    for (const f of [serverFetch(fetch), fetch]) {
      const account = new Account({ apiUrl: 'https://api.test/api', store: new TokenFile(file, fakeSystem), fetch: f, openExternal: async () => undefined, onChange })
      accounts.push(account)
      await account.init()
      await expect(account.profile()).rejects.toBeInstanceOf(MaintenanceError)
      expect(account.current()?.id).toBe(12)
    }
    expect(onChange).not.toHaveBeenCalled()
    expect(await new TokenFile(file, fakeSystem).load()).toMatchObject({ refreshToken: 'rt_1' })
  })
})

// ------------------------------------------------------------------ dates, horloge et compte à rebours

describe('dates et compte à rebours', () => {
  it('lit GET /maintenance : maintenances triées, décalage d’horloge mesuré au milieu de l’aller-retour', () => {
    const later = maintenance(T0 + 48 * H, T0 + 49 * H, { id: 'm-2' })
    const first = maintenance(T0 + 2 * H, T0 + 3 * H)
    // Poste en retard d'une minute : envoi à 19:58:59, réception à 19:59:01, serveur à 20:00:00.
    const s = parseMaintenanceStatus({ serverTime: iso(T0), active: null, upcoming: [later, { id: 'cassée' }, first] }, T0 - 61_000, T0 - 59_000)
    expect(s).toEqual({ clockOffset: 60_000, active: null, upcoming: [first, later], checkedAt: iso(T0) })
    expect(parseMaintenanceStatus({ active: null }, 0, 0)).toBeNull()
    expect(parseMaintenance({ id: 'x', startsAt: 'demain', endsAt: iso(T0) })).toBeNull()
  })

  it('compte à rebours arrondi à la seconde supérieure, jours à part', () => {
    expect(countdown(3_723_400)).toEqual({ days: 0, hours: 1, minutes: 2, seconds: 4 })
    expect(clockText(countdown(3_723_400))).toBe('01:02:04')
    expect(countdown(2 * 86_400_000 + 5000)).toEqual({ days: 2, hours: 0, minutes: 0, seconds: 5 })
    expect(countdown(-5000)).toEqual({ days: 0, hours: 0, minutes: 0, seconds: 0 })
  })

  it('corrige l’horloge du poste : décompte, début et fin à l’heure du serveur', () => {
    const m = maintenance(T0 + H, T0 + 2 * H)
    // Poste en avance de 10 minutes : il affiche 20:10 quand le serveur est à 20:00.
    const s = state({ clockOffset: -10 * 60_000, upcoming: [m] })
    const local = T0 + 10 * 60_000
    expect(serverNow(s, local)).toBe(T0)
    expect(msUntil(m.startsAt, s, local)).toBe(H)
    // À 21:05 sur le poste, le serveur est à 20:55 : pas encore commencée.
    expect(ongoingMaintenance(s, T0 + H + 5 * 60_000)).toBeNull()
    expect(ongoingMaintenance(s, T0 + H + 10 * 60_000)).toEqual({ maintenance: m, overdue: false })
    // Prochain changement d'affichage (début dans l'heure) : 20:00 serveur = 20:10 poste.
    expect(nextBoundary(s, T0 + 10 * 60_000 - 5 * 60_000)).toBe(T0 + 10 * 60_000)
    expect(nextBoundary(s, local)).toBe(T0 + H + 10 * 60_000)
  })

  it('annonce dans les 7 jours seulement', () => {
    const m = maintenance(T0 + ANNOUNCE_BEFORE + 60_000, T0 + ANNOUNCE_BEFORE + H)
    const s = state({ upcoming: [m] })
    expect(nextMaintenance(s, T0)).toBeNull()
    expect(nextMaintenance(s, T0 + 2 * 60_000)).toEqual(m)
    expect(nextMaintenance(s, Date.parse(m.startsAt))).toBeNull()
  })

  it('maintenance confirmée par l’API, plage connue hors ligne, fin dépassée', () => {
    const m = maintenance(T0, T0 + H, { status: 'active' })
    // Confirmée par GET /maintenance ou une réponse 503.
    expect(ongoingMaintenance(state({ active: m, confirmedAt: iso(T0 + 60_000) }), T0 + 30 * 60_000)).toEqual({ maintenance: m, overdue: false })
    // Serveur injoignable : la plage connue suffit.
    expect(ongoingMaintenance(state({ upcoming: [m], offline: true }), T0 + 30 * 60_000)).toEqual({ maintenance: m, overdue: false })
    expect(ongoingMaintenance(state({ upcoming: [m], offline: true }), T0 + H)).toBeNull()
    // Fin dépassée : en cours seulement si l'API refuse encore les requêtes après la fin prévue.
    expect(ongoingMaintenance(state({ active: m, confirmedAt: iso(T0 + 50 * 60_000) }), T0 + H + 1000)).toBeNull()
    expect(ongoingMaintenance(state({ active: m, confirmedAt: iso(T0 + H + 500) }), T0 + H + 1000)).toEqual({ maintenance: m, overdue: true })
  })

  it('vérifications : 5 min, 30 s dans la dernière heure et pendant la maintenance, juste après début et fin', () => {
    const m = maintenance(T0 + 3 * H, T0 + 4 * H)
    const s = state({ upcoming: [m] })
    expect(nextCheckDelay(state(), T0)).toBe(CHECK_EVERY)
    expect(nextCheckDelay(s, T0)).toBe(CHECK_EVERY)
    expect(nextCheckDelay(s, T0 + 3 * H - SOON_BEFORE)).toBe(CHECK_EVERY_SOON)
    expect(nextCheckDelay(s, T0 + 3 * H - 10_000)).toBe(11_000)
    expect(nextCheckDelay(s, T0 + 3 * H + 60_000)).toBe(CHECK_EVERY_SOON)
    // Juste avant la dernière heure : vérifié dès qu'elle commence.
    expect(nextCheckDelay(s, T0 + 2 * H - 60_000)).toBe(61_000)
  })
})

// ------------------------------------------------------------------ suivi de GET /maintenance

describe('suivi des maintenances (processus principal)', () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-maintenance-'))
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const setup = (name: string, respond: (now: number) => Response | Promise<Response>, now: { t: number }) => {
    const onChange = vi.fn<(s: MaintenanceState) => void>()
    const notify = vi.fn<(m: Maintenance) => void>()
    const file = path.join(dir, `${name}.json`)
    const watch = new MaintenanceWatch({ apiUrl: 'https://api.test/api', fetch: async () => respond(now.t), file, onChange, notify, now: () => now.t })
    return { watch, onChange, notify, file }
  }

  it('corrige l’horloge, prévient 15 min avant, signale la fin et garde l’état sur le disque', async () => {
    const m = maintenance(T0 + H, T0 + 2 * H)
    const now = { t: T0 - 5 * 60_000 }
    let active: Maintenance | null = null
    let upcoming = [m]
    let reachable = true
    // Le serveur a 5 minutes d'avance sur le poste.
    const { watch, onChange, notify, file } = setup(
      'cycle',
      (t) => {
        if (!reachable) throw new TypeError('fetch failed')
        return json(200, { serverTime: iso(t + 5 * 60_000), active, upcoming })
      },
      now
    )
    await watch.check()
    expect(watch.current.clockOffset).toBe(5 * 60_000)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(notify).not.toHaveBeenCalled()

    // 20:46 au serveur : début dans 14 minutes.
    now.t = T0 + 41 * 60_000
    await watch.check()
    expect(notify).toHaveBeenCalledWith(m)
    await watch.check()
    expect(notify).toHaveBeenCalledTimes(1)

    // Requête refusée : maintenance confirmée tout de suite.
    now.t = T0 + 56 * 60_000
    active = { ...m, status: 'active' }
    upcoming = []
    watch.report(new MaintenanceError('maintenance', active, 3600))
    expect(watch.ongoing()?.maintenance).toEqual(active)
    expect(watch.current.confirmedAt).toBe(iso(T0 + H + 60_000))
    // Puis GET /maintenance, tout de suite.
    await watch.check()
    expect(watch.current).toMatchObject({ active, upcoming: [], confirmedAt: iso(T0 + H + 60_000) })

    // Serveur injoignable pendant la plage : l'état connu est gardé.
    reachable = false
    await watch.check()
    expect(watch.current.offline).toBe(true)
    expect(watch.ongoing()).not.toBeNull()

    // Nouveau démarrage hors ligne : écran de maintenance d'après le disque.
    const restarted = new MaintenanceWatch({ apiUrl: 'https://api.test/api', fetch: async () => Promise.reject(new TypeError('fetch failed')), file, onChange: () => undefined, now: () => now.t })
    await restarted.load()
    expect(restarted.ongoing()?.maintenance.id).toBe('m-1')

    // Fin : GET /maintenance ne la donne plus en cours.
    const over = vi.fn()
    watch.onOver(over)
    reachable = true
    active = null
    now.t = T0 + 2 * H - 4 * 60_000
    await watch.check()
    expect(watch.ongoing()).toBeNull()
    expect(over).toHaveBeenCalledTimes(1)
    watch.dispose()
    restarted.dispose()
  })

  it('API plus ancienne, sans GET /maintenance : aucune maintenance', async () => {
    const { watch } = setup('old', () => json(404, { code: 'not-found' }), { t: T0 })
    await watch.check()
    expect(watch.current).toMatchObject({ active: null, upcoming: [], offline: false })
  })
})

// ------------------------------------------------------------------ téléchargements en pause

describe('téléchargements en pause', () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-paused-'))
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('repris un par un à la fin de la maintenance, gardés sur le disque', async () => {
    const file = path.join(dir, 'paused.json')
    const started: string[] = []
    const now = { t: T0 }
    const paused = new PausedDownloads(file, async (d) => void started.push(d.id), () => now.t)
    await paused.pause({ id: 'p1', kind: 'pack', name: 'BH 1960' })
    await paused.pause({ id: 'm1', kind: 'mod', name: 'Voitures', claim: true })
    await paused.pause({ id: 'p1', kind: 'pack', name: 'BH 1960' })
    expect(paused.list().map((d) => d.id)).toEqual(['m1', 'p1'])

    const reloaded = new PausedDownloads(file, async () => undefined)
    await reloaded.load()
    expect(reloaded.list()).toEqual(paused.list())

    expect(await paused.resumeNext()).toBe(true)
    expect(started).toEqual(['m1'])
    expect(paused.list().map((d) => d.id)).toEqual(['p1'])
  })

  it('encore en maintenance : gardé pour la prochaine fin ; autre erreur : nouvel essai plus tard ; retiré : oublié', async () => {
    const now = { t: T0 }
    let fail: Error | null = new MaintenanceError('maintenance', null, 60)
    const start = vi.fn(async () => {
      if (fail) throw fail
    })
    const paused = new PausedDownloads(path.join(dir, 'errors.json'), start, () => now.t)
    await paused.pause({ id: 'p1', kind: 'pack', name: 'BH 1960' })

    expect(await paused.resumeNext()).toBe(false)
    expect(paused.list().map((d) => d.id)).toEqual(['p1'])
    expect(paused.retryDelay()).toBe(0)

    fail = new Error('Serveur injoignable')
    expect(await paused.resumeNext()).toBe(false)
    expect(paused.retryDelay()).toBe(60_000)
    expect(await paused.resumeNext()).toBe(false)
    expect(start).toHaveBeenCalledTimes(2)

    now.t += 60_000
    fail = new ApiError('Ce pack n’est plus sur la Marketplace.', 404, 'pack-gone')
    expect(await paused.resumeNext()).toBe(false)
    expect(paused.list()).toEqual([])
  })
})

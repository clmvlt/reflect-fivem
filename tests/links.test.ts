// Liens publics modifiables depuis le site (GET /links) : https seulement, cache sur le disque, au plus une requête par
// minute, liens gardés quand l'API ne répond pas.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { LINKS_REFRESH_MIN, LinksWatch } from '../src/main/core/links'
import { emptyLinks, httpsUrl, parseLinks, type AppLinks } from '../src/shared/links'

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const INVITE = 'https://discord.gg/abcDEF123'

describe('parseLinks', () => {
  it('garde les adresses https et les liens inconnus', () => {
    expect(parseLinks({ discord: INVITE, youtube: 'https://youtube.com/@reflect' })).toEqual({ discord: INVITE, youtube: 'https://youtube.com/@reflect' })
  })

  it('discord null ou absent : pas de lien', () => {
    expect(parseLinks({ discord: null })).toEqual(emptyLinks())
    expect(parseLinks({})).toEqual(emptyLinks())
  })

  it('refuse tout autre protocole que https', () => {
    for (const bad of ['http://discord.gg/x', 'discord://-/invite/x', 'javascript:alert(1)', 'file:///C:/Windows', 'discord.gg/x', '', 42])
      expect(httpsUrl(bad)).toBeNull()
    expect(parseLinks({ discord: 'http://discord.gg/x' })?.discord).toBeNull()
  })

  it('réponse inutilisable', () => {
    expect(parseLinks(null)).toBeNull()
    expect(parseLinks('https://discord.gg/x')).toBeNull()
    expect(parseLinks([INVITE])).toBeNull()
  })
})

describe('LinksWatch', () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-links-'))
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const watch = (fetch: (url: string) => Promise<Response>, file: string, clock = { t: 0 }) => {
    const changes: AppLinks[] = []
    const w = new LinksWatch({ apiUrl: 'https://api.test/api', fetch: vi.fn(fetch), file, onChange: (l) => changes.push(l), now: () => clock.t })
    return { w, changes, clock }
  }

  it('charge GET /links, le garde sur le disque et le relit au démarrage suivant', async () => {
    const file = path.join(dir, 'a.json')
    const { w, changes } = watch(async (url) => {
      expect(url).toBe('https://api.test/api/links')
      return json(200, { discord: INVITE })
    }, file)
    await w.load()
    expect(w.current.discord).toBeNull()
    expect((await w.refresh()).discord).toBe(INVITE)
    expect(changes).toEqual([{ discord: INVITE }])

    // Hors ligne au démarrage suivant : le dernier lien reçu reste affiché.
    const offline = watch(async () => {
      throw new Error('réseau')
    }, file)
    await offline.w.load()
    expect(offline.w.current.discord).toBe(INVITE)
    expect((await offline.w.refresh()).discord).toBe(INVITE)
    expect(offline.changes).toEqual([])
  })

  it('API en erreur ou réponse invalide : lien connu gardé', async () => {
    const file = path.join(dir, 'b.json')
    const responses = [json(200, { discord: INVITE }), json(500, {}), json(200, 'oops')]
    const { w, clock } = watch(async () => responses.shift()!, file)
    await w.refresh()
    for (let i = 0; i < 2; i++) {
      clock.t += LINKS_REFRESH_MIN
      expect((await w.refresh()).discord).toBe(INVITE)
    }
  })

  it('lien retiré par les admins (null) : bouton masqué, aussi au démarrage suivant', async () => {
    const file = path.join(dir, 'c.json')
    const responses = [json(200, { discord: INVITE }), json(200, { discord: null })]
    const { w, clock, changes } = watch(async () => responses.shift()!, file)
    await w.refresh()
    clock.t += LINKS_REFRESH_MIN
    expect((await w.refresh()).discord).toBeNull()
    expect(changes.at(-1)?.discord).toBeNull()
    const next = watch(async () => json(200, {}), file)
    await next.w.load()
    expect(next.w.current.discord).toBeNull()
  })

  it('au plus une requête par minute, une seule à la fois', async () => {
    const file = path.join(dir, 'd.json')
    const { w, clock } = watch(async () => json(200, { discord: INVITE }), file)
    const fetch = (w as unknown as { deps: { fetch: ReturnType<typeof vi.fn> } }).deps.fetch
    await Promise.all([w.refresh(), w.refresh()])
    expect(fetch).toHaveBeenCalledTimes(1)
    clock.t += LINKS_REFRESH_MIN - 1
    await w.refresh()
    expect(fetch).toHaveBeenCalledTimes(1)
    clock.t += 1
    await w.refresh()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

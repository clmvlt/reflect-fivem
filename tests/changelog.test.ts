// Fenêtre « Nouveautés » : lecture des notes de l'API, ordre des versions, et ce qui est demandé, montré ou enregistré au
// démarrage (premier lancement, mise à jour, même version, API injoignable).
import { describe, expect, it, vi } from 'vitest'
import { WhatsNewWatch } from '../src/main/core/changelog'
import { compareVersions, emptyChangelog, parseChangelog, parseReleaseNotes, type WhatsNew } from '../src/shared/changelog'

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const API = 'https://api.test/api'

const entry = (version: string, changelog: unknown = { summary: '', features: [`Nouveauté ${version}`] }) => ({
  version,
  prerelease: false,
  publishedAt: '2026-10-01T10:00:00Z',
  notes: '',
  changelog
})

describe('parseChangelog', () => {
  it('garde les rubriques connues, nettoyées', () => {
    expect(parseChangelog({ summary: '  Intro  ', features: [' A ', '', 'B\n suite'], fixes: ['C', 42], extra: ['?'] })).toEqual({
      ...emptyChangelog(),
      summary: 'Intro',
      features: ['A', 'B suite'],
      fixes: ['C']
    })
  })

  it('sans rubriques ni introduction : notes en introduction', () => {
    expect(parseChangelog(null, '- ancien texte').summary).toBe('- ancien texte')
    expect(parseChangelog({ summary: '', other: [] }, 'texte').summary).toBe('texte')
    expect(parseChangelog({ other: ['x'] }, 'texte').summary).toBe('')
  })

  it('version inutilisable', () => {
    expect(parseReleaseNotes({ version: 'dev' })).toBeNull()
    expect(parseReleaseNotes(null)).toBeNull()
    expect(parseReleaseNotes({ version: '1.9.0', publishedAt: 'hier' })?.publishedAt).toBeNull()
  })
})

describe('compareVersions', () => {
  it('majeur, mineur, correctif, pré-versions avant la version finale', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.8.6', '1.8.6')).toBe(0)
    expect(compareVersions('1.8.5', '1.8.6')).toBeLessThan(0)
    expect(compareVersions('1.9.0-beta.1', '1.9.0')).toBeLessThan(0)
    expect(compareVersions('1.9.0-beta.2', '1.9.0-beta.10')).toBeLessThan(0)
    expect(compareVersions('1.9.0-alpha', '1.9.0-beta')).toBeLessThan(0)
    expect(compareVersions('1.9.0-beta', '1.8.6')).toBeGreaterThan(0)
  })
})

describe('WhatsNewWatch', () => {
  const watch = (version: string, lastSeen: string | undefined, fetch: (url: string) => Promise<Response>) => {
    const saved: string[] = []
    const shown: (WhatsNew | null)[] = []
    const f = vi.fn(fetch)
    const w = new WhatsNewWatch({
      apiUrl: API,
      fetch: f,
      version,
      lastSeen: () => saved[saved.length - 1] ?? lastSeen,
      save: async (v) => {
        saved.push(v)
      },
      onChange: (n) => shown.push(n)
    })
    return { w, f, saved, shown }
  }

  it('premier lancement : notes de la version lancée', async () => {
    const { w, f, saved, shown } = watch('1.8.6', undefined, async () => json(200, { ...entry('1.8.6'), files: [] }))
    await w.check()
    expect(f).toHaveBeenCalledWith(`${API}/app/releases/1.8.6`, expect.anything())
    expect(shown).toHaveLength(1)
    expect(w.current?.releases.map((r) => r.version)).toEqual(['1.8.6'])
    expect(saved).toEqual([])
    // OK : version vue, la fenêtre disparaît et ne revient plus.
    await w.dismiss()
    expect(saved).toEqual(['1.8.6'])
    expect(w.current).toBeNull()
    expect(shown[shown.length - 1]).toBeNull()
    await w.check()
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('après une mise à jour : versions publiées depuis la dernière vue', async () => {
    const { w, f } = watch('1.9.0', '1.8.4', async () => json(200, [entry('1.9.0'), entry('1.8.6'), entry('1.8.5', { summary: '' })]))
    await w.check()
    const url = new URL(f.mock.calls[0][0])
    expect(url.pathname).toBe('/api/app/releases/changelog')
    expect(Object.fromEntries(url.searchParams)).toEqual({ since: '1.8.4', until: '1.9.0' })
    // Version sans notes : écartée.
    expect(w.current).toEqual({ version: '1.9.0', releases: [parseReleaseNotes(entry('1.9.0')), parseReleaseNotes(entry('1.8.6'))] })
  })

  it('même version : aucune requête', async () => {
    const { w, f, shown } = watch('1.8.6', '1.8.6', async () => json(200, []))
    await w.check()
    expect(f).not.toHaveBeenCalled()
    expect(shown).toEqual([])
  })

  it('aucune note : version enregistrée sans rien montrer', async () => {
    const { w, saved, shown } = watch('1.9.0', '1.8.6', async () => json(200, []))
    await w.check()
    expect(saved).toEqual(['1.9.0'])
    expect(shown).toEqual([])
    expect(w.current).toBeNull()
  })

  it('API injoignable ou version non publiée : rien de montré ni d’enregistré', async () => {
    for (const fetch of [async () => json(404, { detail: 'introuvable' }), async () => json(500, {}), async (): Promise<Response> => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED'))]) {
      const first = watch('1.8.6', undefined, fetch)
      await first.w.check()
      const update = watch('1.9.0', '1.8.6', fetch)
      await update.w.check()
      for (const { w, saved, shown } of [first, update]) {
        expect(w.current).toBeNull()
        expect(saved).toEqual([])
        expect(shown).toEqual([])
      }
    }
  })

  it('réponse inattendue : nouvel essai au prochain lancement', async () => {
    const { w, saved } = watch('1.9.0', '1.8.6', async () => json(200, { version: '1.9.0' }))
    await w.check()
    expect(w.current).toBeNull()
    expect(saved).toEqual([])
  })

  it('retour à une version plus ancienne : enregistrée sans requête', async () => {
    const { w, f, saved } = watch('1.8.5', '1.8.6', async () => json(200, []))
    await w.check()
    expect(f).not.toHaveBeenCalled()
    expect(saved).toEqual(['1.8.5'])
  })

  it('dernière version vue illisible : comme un premier lancement', async () => {
    const { w, f } = watch('1.8.6', 'n/a', async () => json(200, entry('1.8.6')))
    await w.check()
    expect(f).toHaveBeenCalledWith(`${API}/app/releases/1.8.6`, expect.anything())
    expect(w.current?.version).toBe('1.8.6')
  })
})

describe('WhatsNewWatch.latest (bouton des réglages)', () => {
  const latest = (version: string, fetch: (url: string) => Promise<Response>) => {
    const save = vi.fn(async () => undefined)
    const w = new WhatsNewWatch({ apiUrl: API, fetch: vi.fn(fetch), version, lastSeen: () => '1.8.6', save, onChange: () => undefined })
    return { w, save }
  }

  it('notes de la version lancée, sans rien enregistrer', async () => {
    const { w, save } = latest('1.8.6', async (url) => (url.endsWith('/app/releases/1.8.6') ? json(200, entry('1.8.6')) : json(500, {})))
    expect((await w.latest()).releases.map((r) => r.version)).toEqual(['1.8.6'])
    expect(save).not.toHaveBeenCalled()
  })

  it('version de dev non publiée : dernière version publiée', async () => {
    const { w } = latest('1.9.0', async (url) => (url.endsWith('/app/releases/latest') ? json(200, entry('1.8.6')) : json(404, {})))
    expect(await w.latest()).toMatchObject({ version: '1.8.6', releases: [{ version: '1.8.6' }] })
  })

  it('API injoignable ou notes vides : message à afficher', async () => {
    await expect(latest('1.8.6', async () => json(500, {})).w.latest()).rejects.toThrow('Nouveautés indisponibles')
    await expect(latest('1.8.6', async () => json(200, entry('1.8.6', { summary: '' }))).w.latest()).rejects.toThrow('Aucune nouveauté')
  })
})

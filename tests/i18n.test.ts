import { afterEach, describe, expect, it, vi } from 'vitest'
import i18next from 'i18next'
import { currentLocale, msg, pickLocale, supportedLocale, tm, withPluralForms } from '@shared/i18n'
import { formatBytes, formatRelative, quote } from '@shared/intl'
import { LOCALES } from '@shared/locales'
import { withLanguage } from '../src/main/core/http'
import { accountLanguageAction, fetchLanguages, startupLocale } from '../src/main/core/language'

type Tree = { [k: string]: string | Tree }

const flatten = (o: Tree, p = ''): Map<string, string> =>
  new Map(Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [[`${p}${k}`, v] as const] : [...flatten(v, `${p}${k}.`)])))

const placeholders = (s: string): string[] => [...s.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1]).sort()

describe('fichiers de traduction', () => {
  const fr = flatten(LOCALES.find((l) => l.code === 'fr')!.resources as unknown as Tree)

  for (const locale of LOCALES.filter((l) => l.code !== 'fr')) {
    const other = flatten(locale.resources as unknown as Tree)

    it(`${locale.code} a exactement les clés du français`, () => {
      expect([...other.keys()].filter((k) => !fr.has(k))).toEqual([])
      expect([...fr.keys()].filter((k) => !other.has(k))).toEqual([])
    })

    it(`${locale.code} garde les paramètres de chaque texte`, () => {
      const different = [...fr].filter(([k, v]) => other.has(k) && placeholders(v).join() !== placeholders(other.get(k)!).join()).map(([k]) => k)
      expect(different).toEqual([])
    })

    it(`${locale.code} n'a pas de texte vide`, () => {
      expect([...other].filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([])
    })
  }

  it("le français n'a pas de texte vide", () => {
    expect([...fr].filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([])
  })
})

describe('choix de la langue', () => {
  it('reconnaît les langues proposées', () => {
    expect(supportedLocale('en-US')).toBe('en')
    expect(supportedLocale('FR_ca')).toBe('fr')
    expect(supportedLocale('de-DE')).toBeNull()
    expect(supportedLocale(null)).toBeNull()
  })

  it('prend la première langue proposée, sinon le français', () => {
    expect(pickLocale(['de', 'en-GB', 'fr'])).toBe('en')
    expect(pickLocale(['de', 'it'])).toBe('fr')
    expect(pickLocale([])).toBe('fr')
  })

  it('au démarrage : réglages, puis compte, puis système, puis français', () => {
    expect(startupLocale({ chosen: 'en', account: 'fr', system: ['fr-FR'] })).toBe('en')
    expect(startupLocale({ chosen: null, account: 'en', system: ['fr-FR'] })).toBe('en')
    expect(startupLocale({ account: null, system: ['de-DE', 'en-US', 'fr-FR'] })).toBe('en')
    expect(startupLocale({ system: ['de-DE'] })).toBe('fr')
  })

  it('à la connexion : langue du compte si aucune choisie sur le poste, sinon la langue locale va au compte', () => {
    expect(accountLanguageAction({ signedIn: true, accountLocale: 'en', chosen: undefined, current: 'fr' })).toEqual({ apply: 'en' })
    expect(accountLanguageAction({ signedIn: true, accountLocale: 'en', chosen: undefined, current: 'en' })).toBeNull()
    expect(accountLanguageAction({ signedIn: true, accountLocale: 'en', chosen: 'fr', current: 'fr' })).toEqual({ push: 'fr' })
    expect(accountLanguageAction({ signedIn: true, accountLocale: null, chosen: undefined, current: 'fr' })).toEqual({ push: 'fr' })
    expect(accountLanguageAction({ signedIn: true, accountLocale: 'fr', chosen: 'fr', current: 'fr' })).toBeNull()
  })

  it('compte relu : langue changée sur le site appliquée, choix du poste gardé, compte sans langue complété', () => {
    expect(accountLanguageAction({ signedIn: false, accountLocale: 'en', chosen: undefined, current: 'fr' })).toEqual({ apply: 'en' })
    expect(accountLanguageAction({ signedIn: false, accountLocale: 'en', chosen: 'fr', current: 'fr' })).toBeNull()
    expect(accountLanguageAction({ signedIn: false, accountLocale: null, chosen: undefined, current: 'en' })).toEqual({ push: 'en' })
  })
})

describe('langues de l’API', () => {
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  it('garde les langues que l’application sait afficher', async () => {
    const fetch = vi.fn(async () => json(200, { defaultLocale: 'fr', current: 'fr', locales: [{ code: 'en', name: 'English' }, { code: 'de', name: 'Deutsch' }, { code: 'fr', name: 'Français' }] }))
    expect(await fetchLanguages('https://api.test/api', fetch)).toEqual([
      { code: 'en', name: 'English' },
      { code: 'fr', name: 'Français' }
    ])
    expect(fetch).toHaveBeenCalledWith('https://api.test/api/locales', expect.anything())
  })

  it('liste embarquée hors ligne ou en cas d’erreur', async () => {
    const local = LOCALES.map((l) => ({ code: l.code, name: l.name }))
    expect(await fetchLanguages('https://api.test/api', async () => Promise.reject(new Error('hors ligne')))).toEqual(local)
    expect(await fetchLanguages('https://api.test/api', async () => json(500, {}))).toEqual(local)
  })

  it('envoie Accept-Language sans écraser celui donné', () => {
    expect(new Headers(withLanguage({ headers: { Authorization: 'Bearer x' } }, 'en').headers).get('Accept-Language')).toBe('en')
    expect(new Headers(withLanguage({ headers: { 'Accept-Language': 'fr' } }, 'en').headers).get('Accept-Language')).toBe('fr')
    expect(new Headers(withLanguage({ headers: { Authorization: 'Bearer x' } }, 'en').headers).get('Authorization')).toBe('Bearer x')
  })
})

describe('textes et formats', () => {
  afterEach(async () => {
    await i18next.changeLanguage('fr')
  })

  it('formes du pluriel manquantes complétées par « other »', () => {
    const filled = withPluralForms('fr', { a: { n_one: 'un', n_other: 'plusieurs' } }) as { a: Record<string, string> }
    expect(filled.a.n_many).toBe('plusieurs')
    expect(withPluralForms('en', { n_one: 'one', n_other: 'many' })).toEqual({ n_one: 'one', n_other: 'many' })
  })

  it('tailles, citations et dates dans la langue affichée', async () => {
    expect(currentLocale()).toBe('fr')
    expect(formatBytes(1536 * 1024 * 1024)).toBe('1,5 Go')
    expect(quote('Pack')).toBe('« Pack »')
    expect(formatRelative(Date.now() - 10_000)).toBe('à l’instant')
    await i18next.changeLanguage('en')
    expect(currentLocale()).toBe('en')
    expect(formatBytes(1536 * 1024 * 1024)).toBe('1.5 GB')
    expect(formatBytes(512)).toBe('512 B')
    expect(quote('Pack')).toBe('“Pack”')
    expect(formatRelative(Date.now() - 3 * 3600_000)).toBe('3 hr. ago')
  })

  it('traduit un texte gardé sous forme de clé, et rend une ancienne chaîne telle quelle', async () => {
    expect(tm(msg('market.packGone'))).toBe('Ce pack n’est plus disponible sur la Marketplace.')
    expect(tm('Texte d’une ancienne version')).toBe('Texte d’une ancienne version')
    await i18next.changeLanguage('en')
    expect(tm(msg('market.packGone'))).toBe('This pack is no longer available on the Marketplace.')
  })
})

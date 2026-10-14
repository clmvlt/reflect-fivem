// Traductions communes au processus principal et à l'interface : chacun a son instance i18next (celle par défaut du
// module), initialisée avec la langue choisie par le processus principal (source de vérité).

import i18next, { type Module } from 'i18next'
import { DEFAULT_LOCALE, LOCALES, type LocaleInfo } from './locales'

/**
 * Texte à traduire au moment de l'afficher : gardé tel quel sur le disque (historique, analyse d'un pack...), il suit
 * la langue courante au lieu de rester dans celle du moment où il a été produit.
 */
export interface Msg {
  key: string
  params?: Record<string, string | number>
}

export const msg = (key: string, params?: Msg['params']): Msg => (params ? { key, params } : { key })

export const SUPPORTED_LOCALES = LOCALES.map((l) => l.code)

/** Langue de l'application correspondant à une étiquette (« en-US » → « en »), null si elle n'est pas proposée. */
export function supportedLocale(tag: string | null | undefined): string | null {
  if (!tag) return null
  const code = tag.trim().toLowerCase().split(/[-_]/)[0]
  return SUPPORTED_LOCALES.includes(code) ? code : null
}

/** Première langue proposée parmi les candidates (dans l'ordre de préférence), sinon le français. */
export function pickLocale(candidates: readonly (string | null | undefined)[]): string {
  for (const c of candidates) {
    const code = supportedLocale(c)
    if (code) return code
  }
  return DEFAULT_LOCALE
}

/**
 * Formes du pluriel manquantes complétées par la forme « other » : le français a une forme « many » (1 000 000) que
 * les fichiers ne donnent pas, et une clé absente s'afficherait telle quelle.
 */
export function withPluralForms(code: string, tree: unknown): unknown {
  const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories
  const fill = (node: unknown): unknown => {
    if (!node || typeof node !== 'object') return node
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) out[k] = fill(v)
    for (const k of Object.keys(out)) {
      const m = /^(.*)_other$/.exec(k)
      if (!m) continue
      for (const c of categories) if (!(`${m[1]}_${c}` in out)) out[`${m[1]}_${c}`] = out[k]
    }
    return out
  }
  return fill(tree)
}

/** Initialise l'instance i18next du processus (synchrone : les textes sont embarqués). */
export function initI18n(lng: string, plugin?: Module): void {
  if (plugin) i18next.use(plugin)
  const resources = Object.fromEntries(LOCALES.map((l: LocaleInfo) => [l.code, { translation: withPluralForms(l.code, l.resources) as LocaleInfo['resources'] }]))
  void i18next.init({
    lng: supportedLocale(lng) ?? DEFAULT_LOCALE,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: SUPPORTED_LOCALES,
    resources,
    initAsync: false,
    interpolation: { escapeValue: false },
    returnNull: false
  })
}

/** Langue affichée. */
export function currentLocale(): string {
  return supportedLocale(i18next.resolvedLanguage ?? i18next.language) ?? DEFAULT_LOCALE
}

/** Traduit un texte gardé sous forme de clé ; une chaîne (texte d'une version précédente) est rendue telle quelle. */
export function tm(m: Msg | string | null | undefined): string {
  if (!m) return ''
  if (typeof m === 'string') return m
  return (i18next.t as unknown as (key: string, options?: object) => string)(m.key, m.params)
}

// Langues de l'application. Les textes sont dans <code>.json (mêmes clés que fr.json, vérifié par tests/i18n.test.ts),
// lus par l'interface et par le processus principal (menus, boîtes de dialogue, notifications, erreurs).
//
// Ajouter une langue : copier en.json en <code>.json, le traduire, l'ajouter ci-dessous, puis ajouter la langue de
// l'installateur dans electron-builder.yml (nsis.installerLanguages).

import fr from './fr.json'
import en from './en.json'

/** Langue par défaut, et de secours pour une clé absente d'une autre langue. */
export const DEFAULT_LOCALE = 'fr'

/** Textes d'une langue : mêmes clés que le français. */
export type Translations = typeof fr

export interface LocaleInfo {
  /** Code ISO 639-1 (celui de l'API, GET /locales). */
  code: string
  /** Nom de la langue dans cette langue (liste de secours hors ligne). */
  name: string
  resources: Translations
}

export const LOCALES: readonly LocaleInfo[] = [
  { code: 'fr', name: 'Français', resources: fr },
  { code: 'en', name: 'English', resources: en }
]

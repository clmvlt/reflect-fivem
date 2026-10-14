// Langue de l'application. Le processus principal la choisit et la transmet aux fenêtres :
//  1. celle choisie dans les réglages de l'application sur ce poste (settings.json) ;
//  2. sinon celle du compte connecté (me.locale) ;
//  3. sinon celle du système (langues préférées de Windows, puis app.getLocale()) si elle est proposée ;
//  4. sinon le français.
// Aucune dépendance à Electron ici (testé avec vitest).

import type { LanguageOption } from '@shared/api'
import { pickLocale, supportedLocale } from '@shared/i18n'
import { LOCALES } from '@shared/locales'
import type { Fetch } from './http'

export interface LocaleSources {
  /** Langue choisie dans les réglages (settings.locale). */
  chosen?: string | null
  /** Langue du compte connecté. */
  account?: string | null
  /** Langues du système, de la préférée à la moins préférée. */
  system: readonly string[]
}

export function startupLocale(s: LocaleSources): string {
  return pickLocale([s.chosen, s.account, ...s.system])
}

/** Liste embarquée (hors ligne, ou API qui ne répond pas). */
export function localLanguages(): LanguageOption[] {
  return LOCALES.map((l) => ({ code: l.code, name: l.name }))
}

/**
 * Langues de GET /locales que l'application sait afficher (avec le nom donné par l'API), complétées par celles de
 * l'application que l'API ne connaît pas encore ; liste embarquée si l'API ne répond pas.
 */
export async function fetchLanguages(apiUrl: string, fetch: Fetch): Promise<LanguageOption[]> {
  const local = localLanguages()
  try {
    const response = await fetch(`${apiUrl}/locales`, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) return local
    const body = (await response.json()) as { locales?: { code?: unknown; name?: unknown }[] }
    const remote: LanguageOption[] = []
    for (const l of body.locales ?? []) {
      const code = typeof l.code === 'string' ? supportedLocale(l.code) : null
      if (!code || remote.some((r) => r.code === code)) continue
      const name = typeof l.name === 'string' && l.name.trim() ? l.name.trim() : (local.find((x) => x.code === code)?.name ?? code)
      remote.push({ code, name })
    }
    if (!remote.length) return local
    return [...remote, ...local.filter((l) => !remote.some((r) => r.code === l.code))]
  } catch {
    return local
  }
}

/**
 * Langue à appliquer, ou à envoyer au compte, quand le compte connecté change.
 *  - connexion : la langue du compte s'applique si l'utilisateur n'a jamais choisi de langue sur ce poste ; sinon la
 *    langue affichée est enregistrée dans le compte ;
 *  - compte relu (renouvellement, profil) : la langue du compte, changée sur le site, s'applique de la même façon ; un
 *    compte sans langue reçoit la langue affichée.
 */
export function accountLanguageAction(p: {
  signedIn: boolean
  accountLocale: string | null | undefined
  chosen: string | null | undefined
  current: string
}): { apply: string } | { push: string } | null {
  const account = supportedLocale(p.accountLocale)
  if (account && !p.chosen) return account === p.current ? null : { apply: account }
  if (p.signedIn) return p.accountLocale === p.current ? null : { push: p.current }
  return p.accountLocale ? null : { push: p.current }
}

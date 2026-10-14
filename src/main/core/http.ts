// Client HTTP commun des requêtes vers l'API : toutes partent du processus principal avec la langue affichée
// (Accept-Language), dans laquelle l'API répond (« detail » des erreurs, catégories, modèle de performance, analyses).

import { currentLocale } from '@shared/i18n'

/** En-têtes de la requête, complétés par Accept-Language (sauf s'il est déjà donné). */
export function withLanguage(init: RequestInit = {}, locale = currentLocale()): RequestInit {
  const headers = new Headers(init.headers)
  if (!headers.has('Accept-Language')) headers.set('Accept-Language', locale)
  return { ...init, headers }
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** fetch donné (net.fetch d'Electron, ou celui d'un test) qui envoie la langue affichée. */
export function languageFetch(fetch: Fetch): Fetch {
  return (url, init) => fetch(url, withLanguage(init))
}

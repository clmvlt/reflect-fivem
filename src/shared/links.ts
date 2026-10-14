// Liens publics modifiables par les admins depuis le site (GET /links de l'API, sans compte, jamais refusé pendant une
// maintenance) : types et lecture communs au processus principal et à l'interface. Aucune dépendance (testé avec vitest).
//
// D'autres liens pourront s'ajouter au même objet : ceux que l'application ne connaît pas encore sont gardés tels quels.

/** Liens de l'application, null quand il n'y en a pas (bouton masqué). Seulement des adresses https://. */
export interface AppLinks {
  /** Invitation du serveur Discord. */
  discord: string | null
  [name: string]: string | null
}

export const emptyLinks = (): AppLinks => ({ discord: null })

/** Adresse https:// valide (normalisée), sinon null : un lien ne s'ouvre jamais avec un autre protocole. */
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' && url.hostname ? url.toString() : null
  } catch {
    return null
  }
}

/** Réponse de GET /links (ou liens gardés sur le disque) ; null si elle est inutilisable. */
export function parseLinks(raw: unknown): AppLinks | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const links = emptyLinks()
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) links[name] = httpsUrl(value)
  return links
}

// Liens « fivem-pack-manager://pack/<id> » et « fivem-pack-manager://mod/<id> » du site : ouvrent l'application sur
// la fiche d'un pack ou d'un mod de la Marketplace. Windows les transmet sur la ligne de commande (premier lancement,
// ou instance déjà ouverte via second-instance). Seuls le catalogue et l'identifiant (UUID) en sont tirés : rien
// d'autre n'est ouvert ni exécuté.

export const PROTOCOL = 'fivem-pack-manager'

const PREFIX = `${PROTOCOL}://`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KINDS = ['pack', 'mod'] as const

/** Fiche demandée par un lien : catalogue (packs ou mods) et identifiant. */
export interface MarketLink {
  kind: (typeof KINDS)[number]
  id: string
}

/** Lien de l'application dans une ligne de commande, null s'il n'y en a pas. */
export function findDeepLink(argv: readonly string[]): string | null {
  return argv.find((a) => a.slice(0, PREFIX.length).toLowerCase() === PREFIX) ?? null
}

/** Fiche d'un lien « fivem-pack-manager://pack/<uuid> » ou « …://mod/<uuid> », null pour toute autre adresse. */
export function parseMarketLink(link: string): MarketLink | null {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return null
  }
  const kind = KINDS.find((k) => k === url.host.toLowerCase())
  if (url.protocol !== `${PROTOCOL}:` || !kind || url.username || url.password) return null
  // Un seul segment, « / » final toléré (ajouté par certains navigateurs).
  const m = /^\/([^/]+)\/?$/.exec(url.pathname)
  return m && UUID.test(m[1]) ? { kind, id: m[1].toLowerCase() } : null
}

/** Lien tel qu'il peut être écrit dans le journal : court, sur une ligne. */
export function describeLink(link: string): string {
  return JSON.stringify(link.length > 200 ? `${link.slice(0, 200)}…` : link)
}

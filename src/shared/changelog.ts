// Notes des versions de l'application (fenêtre « Nouveautés ») : types et lecture des réponses de l'API, communs au
// processus principal et à l'interface. Aucune dépendance (testé avec vitest).
//
// Une version a une introduction facultative (Markdown) et des rubriques aux clés fixes, chacune une liste de points
// d'une ligne. Les titres des rubriques sont ceux de l'application (traduits), les textes ceux de l'admin.

/** Rubriques, dans l'ordre d'affichage. */
export const CHANGELOG_SECTIONS = ['features', 'improvements', 'fixes', 'other'] as const
export type ChangelogSection = (typeof CHANGELOG_SECTIONS)[number]

export interface Changelog {
  /** Introduction en Markdown (vide s'il n'y en a pas). */
  summary: string
  features: string[]
  improvements: string[]
  fixes: string[]
  other: string[]
}

/** Notes d'une version publiée. */
export interface ReleaseNotes {
  version: string
  prerelease: boolean
  /** Date de publication (ISO), null si elle est inconnue. */
  publishedAt: string | null
  changelog: Changelog
}

/** Nouveautés à montrer : versions publiées depuis la dernière vue, la plus récente d'abord. */
export interface WhatsNew {
  /** Version lancée (ou version de la mise à jour dont on montre les nouveautés). */
  version: string
  releases: ReleaseNotes[]
}

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/** Numéro de version accepté par l'API (« 1.8.6 », « 1.9.0-beta.1 »). */
export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && SEMVER.test(value)
}

/**
 * Ordre des versions : majeur, mineur, correctif, puis une pré-version avant la version finale (« 1.9.0-beta.1 » <
 * « 1.9.0 »). Négatif si a < b, positif si a > b, 0 si elles sont égales.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { core: number[]; pre: string[] } => {
    const [core, ...pre] = v.replace(/^v/, '').split('-')
    return { core: core.split('.').map((n) => Number(n) || 0), pre: pre.length ? pre.join('-').split('.') : [] }
  }
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) - (y.core[i] ?? 0)
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]]
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1
    if (p === q) continue
    const [np, nq] = [/^\d+$/.test(p), /^\d+$/.test(q)]
    if (np && nq) return Number(p) - Number(q)
    if (np !== nq) return np ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

export const emptyChangelog = (): Changelog => ({ summary: '', features: [], improvements: [], fixes: [], other: [] })

/** Aucune introduction ni aucun point : rien à montrer. */
export function isChangelogEmpty(c: Changelog): boolean {
  return !c.summary && CHANGELOG_SECTIONS.every((s) => !c[s].length)
}

/**
 * `changelog` d'une réponse de l'API, nettoyé (points vides retirés, un point par ligne). Sans rubriques ni
 * introduction, `notes` (les mêmes notes en un seul Markdown, ou celles d'une ancienne version) sert d'introduction.
 */
export function parseChangelog(raw: unknown, notes?: unknown): Changelog {
  const c = emptyChangelog()
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  if (typeof obj.summary === 'string') c.summary = obj.summary.trim()
  for (const section of CHANGELOG_SECTIONS) {
    const items = obj[section]
    if (Array.isArray(items))
      c[section] = items
        .filter((i): i is string => typeof i === 'string')
        .map((i) => i.trim().replace(/\s*\n\s*/g, ' '))
        .filter(Boolean)
  }
  if (isChangelogEmpty(c) && typeof notes === 'string') c.summary = notes.trim()
  return c
}

/** Une version de GET /app/releases/changelog ou GET /app/releases/{version} ; null si elle est inutilisable. */
export function parseReleaseNotes(raw: unknown): ReleaseNotes | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (!isVersion(r.version)) return null
  const publishedAt = typeof r.publishedAt === 'string' && !Number.isNaN(Date.parse(r.publishedAt)) ? r.publishedAt : null
  return { version: r.version, prerelease: r.prerelease === true, publishedAt, changelog: parseChangelog(r.changelog, r.notes) }
}

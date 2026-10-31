// Fichiers d'un mod réglé par le joueur : copies de ses .rpf aux couleurs choisies, écrites dans un nouveau dossier de
// generated/ (chiffrées pour un mod protégé). Le contenu d'origine n'est jamais touché : chaque réglage repart de lui.

import { randomBytes } from 'node:crypto'
import { t } from 'i18next'
import { colorToRgb, usableValues } from '@shared/modOptions'
import { resolveInstallMap } from './analyzer'
import type { Report } from './installer'
import type { Library, StoredManifest } from './library'
import { particleKey, recolorRpf, RecolorError, type Recolor } from './rpfRecolor'

/** Au-delà, un .rpf n'est pas lu en mémoire. */
const MAX_ARCHIVE = 1024 * 1024 * 1024

/**
 * Écrit les fichiers du mod {@link m} pour ces réglages et renvoie leur dossier (null : aucun réglage, le mod d'origine
 * s'installe). Échoue sans rien laisser si une particule attendue n'est pas dans le mod.
 */
export async function writeModOptionFiles(lib: Library, m: StoredManifest, values: Record<string, string>, report: Report): Promise<string | null> {
  const recolors: Recolor[] = (m.options ?? [])
    .filter((o) => values[o.id])
    .flatMap((o) => o.targets.map((target) => ({ file: target.file, particles: target.particles, rgb: colorToRgb(values[o.id]) })))
  if (!recolors.length) return null
  report(t('modOptions.phase'), 0, 0)

  const content = await lib.content(m)
  const sizes = new Map(m.files.map((f) => [f.rel, f.size]))
  const dir = `options-${randomBytes(4).toString('hex')}`
  const found = new Set<string>()
  try {
    for (const { rel, dest } of resolveInstallMap(m.components)) {
      if (!/\.rpf$/i.test(dest.path) || (sizes.get(rel) ?? 0) > MAX_ARCHIVE) continue
      const archive = await content.read(rel)
      if (!archive) continue
      // Archive illisible (chiffrée, endommagée) : si les particules attendues y étaient, elles sont signalées manquantes.
      const result = await recolorRpf(archive, recolors).catch((err: unknown) => {
        if (err instanceof RecolorError) return null
        throw err
      })
      if (!result) continue
      for (const key of result.found) found.add(key)
      if (result.data) await lib.writeGenerated(m, `${dir}/${dest.root}/${dest.path}`, result.data)
    }
    const missing = recolors.flatMap((r) => r.particles.filter((p) => !found.has(particleKey(r.file, p))))
    if (missing.length) throw new Error(t('modOptions.errors.notFound', { particles: missing.join(', ') }))
    return dir
  } catch (err) {
    await lib.removeOptionFiles(m.id, dir)
    throw err
  }
}

/** Choix du joueur repris par une nouvelle version d'un mod (manifeste à enregistrer) ; échoue s'ils ne s'y appliquent plus. */
export async function carryModOptions(lib: Library, from: StoredManifest, to: StoredManifest, report: Report): Promise<void> {
  const values = usableValues(to.options ?? [], from.optionValues)
  if (!Object.keys(values).length) return
  const dir = await writeModOptionFiles(lib, to, values, report)
  to.optionValues = values
  to.optionsDir = dir ?? undefined
}

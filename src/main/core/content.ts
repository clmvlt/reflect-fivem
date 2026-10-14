// Contenu d'un pack de la bibliothèque, lu de la même façon qu'il soit extrait (content/) ou protégé (paquet chiffré,
// jamais extrait : chaque fichier est déchiffré à la demande, en mémoire ou directement à sa place dans le jeu).

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { t } from 'i18next'
import { sanitizeEntryPath } from '../archive/sanitize'
import { unsealToBuffer, type PackageIndex, type SealedRef } from './sealed'

/** Fichier à installer ou à lire : fichier du disque, ou flux chiffré ({@link sealed}) dans ce fichier. */
export interface ContentSource {
  src: string
  sealed?: SealedRef
}

export interface PackContent {
  /** Contenu entier d'un fichier du pack ; null s'il est absent ou illisible. */
  read(rel: string): Promise<Buffer | null>
  /** Premiers octets d'un fichier (tous s'il est plus court) ; null s'il est absent ou illisible. */
  head(rel: string, bytes: number): Promise<Buffer | null>
  /** Emplacement d'un fichier du pack, pour l'installer. */
  source(rel: string): ContentSource
}

export function readSource(s: ContentSource): Promise<Buffer> {
  return s.sealed ? unsealToBuffer(s.src, s.sealed) : fs.readFile(s.src)
}

/** Pack extrait dans un dossier. */
export function folderContent(dir: string): PackContent {
  const abs = (rel: string): string => path.join(dir, ...rel.split('/'))
  return {
    read: (rel) => fs.readFile(abs(rel)).catch(() => null),
    head: async (rel, bytes) => {
      try {
        const h = await fs.open(abs(rel), 'r')
        try {
          const buf = Buffer.alloc(bytes)
          const { bytesRead } = await h.read(buf, 0, bytes, 0)
          return buf.subarray(0, bytesRead)
        } finally {
          await h.close()
        }
      } catch {
        return null
      }
    },
    source: (rel) => ({ src: abs(rel) })
  }
}

/**
 * Pack protégé : fichiers du paquet chiffré {@link file}, chemins nettoyés comme à l'extraction d'une archive, sous le
 * dossier enveloppe {@link prefix} retiré à l'import. {@link overrides} : fichiers corrigés à l'import (clé : chemin en
 * minuscules), qui remplacent ceux du paquet. Comme sous Windows, la casse des chemins ne compte pas ; un doublon
 * remplace le précédent.
 */
export function packageContent(file: string, index: PackageIndex, prefix: string, overrides: Map<string, ContentSource> = new Map()): PackContent {
  const byRel = new Map<string, SealedRef>()
  const lowerPrefix = prefix.toLowerCase()
  for (const e of index.entries) {
    const rel = sanitizeEntryPath(e.path)?.toLowerCase()
    if (rel?.startsWith(lowerPrefix)) byRel.set(rel.slice(lowerPrefix.length), e.ref)
  }
  const find = (rel: string): ContentSource | null => {
    const key = rel.toLowerCase()
    const override = overrides.get(key)
    if (override) return override
    const ref = byRel.get(key)
    return ref ? { src: file, sealed: ref } : null
  }
  return {
    read: async (rel) => {
      const s = find(rel)
      return s ? readSource(s).catch(() => null) : null
    },
    head: async (rel, bytes) => {
      const s = find(rel)
      if (!s?.sealed) return s ? readSource(s).then((b) => b.subarray(0, bytes)).catch(() => null) : null
      return unsealToBuffer(s.src, s.sealed, bytes).catch(() => null)
    },
    source: (rel) => {
      const s = find(rel)
      if (!s) throw new Error(t('protection.missingFile', { path: rel }))
      return s
    }
  }
}

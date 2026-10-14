// Repérage des mods graphiques installés à la main (non gérés par l'application).

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { t } from 'i18next'
import type { ActiveInstall, ForeignItem, GamesInfo, RootId } from '@shared/types'
import { classifyGtaRootEntry, classifyPluginsEntry } from './knowledge'
import { walkFiles } from '../util/fsx'

export function managedKey(root: RootId, rel: string): string {
  return `${root}:${rel.toLowerCase()}`
}

export function managedSet(active: ActiveInstall | null): Set<string> {
  return new Set((active?.files ?? []).map((f) => managedKey(f.root, f.path)))
}

async function listDir(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Fichiers (relatifs à la racine) contenus dans un élément, hors fichiers gérés par l'application. */
export async function expandItem(rootPath: string, item: { root: RootId; path: string; isDir: boolean }, managed: Set<string>): Promise<{ rel: string; size: number }[]> {
  if (!item.isDir) {
    if (managed.has(managedKey(item.root, item.path))) return []
    try {
      const st = await fs.stat(path.join(rootPath, ...item.path.split('/')))
      return [{ rel: item.path, size: st.size }]
    } catch {
      return []
    }
  }
  const files = await walkFiles(path.join(rootPath, ...item.path.split('/')))
  return files
    .map((f) => ({ rel: `${item.path}/${f.rel}`, size: f.size }))
    .filter((f) => !managed.has(managedKey(item.root, f.rel)))
}

/** Liste des fichiers livrés par FiveM (content_index.xml), en minuscules ; null si illisible. */
async function fivemContentIndex(fivem: string): Promise<Set<string> | null> {
  try {
    const xml = await fs.readFile(path.join(fivem, 'content_index.xml'), 'utf8')
    const set = new Set<string>()
    for (const m of xml.matchAll(/<ContentFile\s+Name="([^"]+)"/g)) set.add(m[1].replace(/\\/g, '/').toLowerCase())
    return set.size ? set : null
  } catch {
    return null
  }
}

export async function scanForeign(games: GamesInfo, active: ActiveInstall | null): Promise<ForeignItem[]> {
  const managed = managedSet(active)
  const out: ForeignItem[] = []

  const addEntry = async (
    root: RootId,
    rootPath: string,
    rel: string,
    isDir: boolean,
    rule: { category: ForeignItem['category']; label: string; recommended: boolean }
  ): Promise<void> => {
    const files = await expandItem(rootPath, { root, path: rel, isDir }, managed)
    if (!files.length) return
    out.push({
      root,
      path: rel,
      isDir,
      size: files.reduce((s, f) => s + f.size, 0),
      fileCount: files.length,
      category: rule.category,
      label: rule.label,
      recommended: rule.recommended
    })
  }

  const fivem = games.fivem.valid ? games.fivem.path : null
  if (fivem) {
    for (const e of await listDir(path.join(fivem, 'plugins'))) {
      await addEntry('fivem', fivem, `plugins/${e.name}`, e.isDirectory(), classifyPluginsEntry(e.name, e.isDirectory()))
    }
    for (const e of await listDir(path.join(fivem, 'mods'))) {
      const isRpf = !e.isDirectory() && e.name.toLowerCase().endsWith('.rpf')
      await addEntry('fivem', fivem, `mods/${e.name}`, e.isDirectory(), {
        category: isRpf ? 'rpf' : 'other',
        label: isRpf ? t('foreign.rpfMod') : e.isDirectory() ? t('foreign.modsFolder') : t('foreign.modsFile'),
        recommended: true
      })
    }
  }

  if (fivem) {
    for (const e of await listDir(path.join(fivem, 'addons'))) {
      await addEntry('fivem', fivem, `addons/${e.name}`, e.isDirectory(), { category: 'rpf', label: t('foreign.addonsArchive'), recommended: true })
    }
    // Fichiers ajoutés dans citizen/common et citizen/platform* : absents du manifeste de FiveM (content_index.xml).
    const known = await fivemContentIndex(fivem)
    if (known) {
      for (const top of await listDir(path.join(fivem, 'citizen'))) {
        if (!top.isDirectory() || !/^(common|platform(-\d+)?)$/i.test(top.name)) continue
        for (const f of await walkFiles(path.join(fivem, 'citizen', top.name))) {
          const rel = `citizen/${top.name}/${f.rel}`
          if (known.has(rel.toLowerCase())) continue
          await addEntry('fivem', fivem, rel, false, { category: 'other', label: t('foreign.citizenFile'), recommended: true })
        }
      }
    }
  }

  const gta = games.gta.valid ? games.gta.path : null
  if (gta) {
    for (const e of await listDir(gta)) {
      const rule = classifyGtaRootEntry(e.name, e.isDirectory())
      if (rule) await addEntry('gta', gta, e.name, e.isDirectory(), rule)
    }
  }

  const order: ForeignItem['category'][] = ['proxy-dll', 'asi', 'enb', 'reshade', 'plugin-config', 'plugin-data', 'rpf', 'other', 'log', 'sp-loader', 'screenshot']
  out.sort((a, b) => a.root.localeCompare(b.root) || order.indexOf(a.category) - order.indexOf(b.category) || a.path.localeCompare(b.path))
  return out
}

export interface ForeignMove {
  root: RootId
  rel: string
  isDir: boolean
}

export interface ForeignCollection {
  /** Éléments à déplacer : un dossier entier quand il ne contient aucun fichier géré, sinon fichier par fichier. */
  moves: ForeignMove[]
  files: { root: RootId; rel: string; size: number }[]
}

/** Mods installés à la main à ranger dans un pack (les captures d'écran, journaux et chargeurs du mode solo restent en place). */
export async function collectForeign(
  games: GamesInfo,
  active: ActiveInstall | null,
  selection?: { root: RootId; path: string; isDir: boolean }[]
): Promise<ForeignCollection> {
  const managed = managedSet(active)
  const out: ForeignCollection = { moves: [], files: [] }
  const items = selection ?? (await scanForeign(games, active)).filter((i) => i.recommended)
  for (const item of items) {
    const rootPath = item.root === 'fivem' ? games.fivem.path : games.gta.path
    if (!rootPath) continue
    const files = await expandItem(rootPath, item, managed)
    if (!files.length) continue
    const whole = !item.isDir || (await walkFiles(path.join(rootPath, ...item.path.split('/')))).length === files.length
    if (whole) out.moves.push({ root: item.root, rel: item.path, isDir: item.isDir })
    else for (const f of files) out.moves.push({ root: item.root, rel: f.rel, isDir: false })
    for (const f of files) out.files.push({ root: item.root, rel: f.rel, size: f.size })
  }
  return out
}

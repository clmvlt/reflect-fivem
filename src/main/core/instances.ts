// Instances : plusieurs dossiers FiveM gérés par l'application, chacun avec son pack installé et ses mods (par exemple
// deux lanceurs FiveM sur le bureau, le second lancé avec -cl2 pour jouer en même temps).
//
// Une instance = un dossier FiveM.app (et le dossier de GTA V qu'il utilise) et son état : state.json pour l'instance
// principale, Instances/<id>/state.json pour les autres. Les bibliothèques des packs et des mods sont communes. Les
// pages de l'application montrent l'instance active ; un pack peut être installé dans n'importe quelle instance.
//
// Chaque instance a son propre dossier FiveM.app, mais elles partagent en général le même GTA V : les fichiers qu'un
// pack pose à la racine de GTA V servent à toutes les instances qui l'utilisent (voir l'en-tête d'installer.ts).
//
// Une nouvelle instance peut être une copie d'une instance existante : FiveM.exe et FiveM.app, sans le cache de FiveM,
// sans les fichiers posés par l'application (pack, mods ; les fichiers d'origine qu'ils remplaçaient sont copiés à leur
// place) et sans ses dossiers de travail.

import { constants as fsc, promises as fs } from 'node:fs'
import path from 'node:path'
import type { FiveMInstance, InstalledFile, Settings } from '@shared/types'
import { walkFiles } from '../util/fsx'
import { ORIGINALS_DIR } from './installer'

export const MAIN_INSTANCE = 'main'
/** Argument de FiveM.exe qui permet de le lancer alors qu'un autre FiveM tourne déjà. */
export const SECOND_CLIENT_ARG = '-cl2'

export function instanceStateFile(dataDir: string, id: string): string {
  return id === MAIN_INSTANCE ? path.join(dataDir, 'state.json') : path.join(dataDir, 'Instances', id, 'state.json')
}

/** Instance active : celle des réglages si elle existe encore, sinon la première. */
export function currentInstanceId(s: Settings): string {
  if (!s.instances?.length) return MAIN_INSTANCE
  return s.instances.some((i) => i.id === s.instance) ? s.instance! : s.instances[0].id
}

/**
 * Instances enregistrées ; sans liste, l'instance principale seule ({@link mainName} : son nom dans la langue affichée).
 * Les dossiers de l'instance active sont ceux des réglages.
 */
export function listInstances(s: Settings, mainName: string): FiveMInstance[] {
  const current = currentInstanceId(s)
  const list = s.instances?.length ? s.instances : [{ id: MAIN_INSTANCE, name: mainName, fivemPath: null, gtaPath: null }]
  return list.map((i) => (i.id === current ? { ...i, fivemPath: s.fivemPath, gtaPath: s.gtaPath } : i))
}

/** Nom proposé pour une instance : le dossier qui contient FiveM.app (« D:\FiveM RP\FiveM.app » → « FiveM RP »). */
export function suggestedName(fivemApp: string): string {
  const clean = fivemApp.replace(/[\\/]+$/, '')
  const dir = /^fivem\.app$/i.test(path.basename(clean)) ? path.dirname(clean) : clean
  return path.basename(dir) || 'FiveM'
}

/** Nom utilisable pour un fichier ou un dossier de Windows (caractères interdits retirés). */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/[. ]+$/, '').trim() || 'FiveM'
}

/** Dossiers de FiveM.app jamais copiés : cache (recréé par FiveM), journaux, rapports de plantage. */
const SKIPPED_DIRS = ['data/cache', 'data/server-cache', 'data/server-cache-priv', 'logs', 'crashes']

export interface CopyPlan {
  files: { from: string; to: string; size: number }[]
  bytes: number
}

/**
 * Fichiers à copier pour une nouvelle instance basée sur le dossier FiveM.app {@link fivemApp} (FiveM.exe est à côté),
 * dans {@link dest} (qui recevra FiveM.exe et FiveM.app). {@link managed} : fichiers posés par l'application dans cette
 * instance (pack installé, mods activés), remplacés par l'original du jeu quand il a été gardé.
 */
export async function copyPlan(fivemApp: string, dest: string, managed: InstalledFile[]): Promise<CopyPlan> {
  const exe = path.join(path.dirname(fivemApp), 'FiveM.exe')
  const st = await fs.stat(exe)
  const files: CopyPlan['files'] = [{ from: exe, to: path.join(dest, 'FiveM.exe'), size: st.size }]
  const skip = new Set(managed.filter((f) => f.root === 'fivem').map((f) => f.path.toLowerCase()))
  const skipped = (rel: string): boolean => {
    const lower = rel.toLowerCase()
    return lower.split('/').some((part) => part.startsWith('.fpm-')) || SKIPPED_DIRS.some((d) => lower === d || lower.startsWith(`${d}/`))
  }
  const destApp = path.join(dest, 'FiveM.app')
  for (const f of await walkFiles(fivemApp)) {
    if (skipped(f.rel)) continue
    const to = path.join(destApp, ...f.rel.split('/'))
    if (!skip.has(f.rel.toLowerCase())) {
      files.push({ from: path.join(fivemApp, ...f.rel.split('/')), to, size: f.size })
      continue
    }
    // Fichier du jeu remplacé par le pack : l'original gardé par l'application.
    const original = path.join(fivemApp, ORIGINALS_DIR, ...f.rel.split('/'))
    const ost = await fs.stat(original).catch(() => null)
    if (ost?.isFile()) files.push({ from: original, to, size: ost.size })
  }
  return { files, bytes: files.reduce((s, f) => s + f.size, 0) }
}

/** Copie les fichiers du plan (aucun fichier existant n'est écrasé) ; {@link onProgress} : octets copiés et total. */
export async function runCopy(plan: CopyPlan, onProgress: (bytes: number, total: number) => void, signal?: AbortSignal): Promise<void> {
  let bytes = 0
  const dirs = new Set<string>()
  for (const f of plan.files) {
    if (signal?.aborted) throw new Error('aborted')
    const dir = path.dirname(f.to)
    if (!dirs.has(dir)) {
      await fs.mkdir(dir, { recursive: true })
      dirs.add(dir)
    }
    await fs.copyFile(f.from, f.to, fsc.COPYFILE_EXCL)
    bytes += f.size
    onProgress(bytes, plan.bytes)
  }
}

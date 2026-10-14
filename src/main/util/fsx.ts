import { promises as fs, constants as fsc } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { t } from 'i18next'
import { formatBytes as formatSize } from '@shared/intl'

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

export async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile()
  } catch {
    return false
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Écriture atomique : fichier temporaire puis renommage, pour ne jamais laisser un JSON à moitié écrit. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

export interface WalkEntry {
  rel: string // chemin relatif, séparateur « / »
  size: number
  mtimeMs: number
}

/** Liste récursive des fichiers d'un dossier (chemins relatifs POSIX). */
export async function walkFiles(root: string, relBase = ''): Promise<WalkEntry[]> {
  const out: WalkEntry[] = []
  const stack: string[] = [relBase]
  while (stack.length) {
    const rel = stack.pop() as string
    const abs = rel ? path.join(root, ...rel.split('/')) : root
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) stack.push(childRel)
      else if (e.isFile()) {
        const st = await fs.stat(path.join(abs, e.name))
        out.push({ rel: childRel, size: st.size, mtimeMs: st.mtimeMs })
      }
    }
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel))
  return out
}

export async function dirSize(root: string): Promise<{ size: number; count: number }> {
  const files = await walkFiles(root)
  return { size: files.reduce((s, f) => s + f.size, 0), count: files.length }
}

/** Vérifie qu'on peut écrire dans un dossier en y créant (puis supprimant) un fichier témoin. */
export async function canWrite(dir: string): Promise<boolean> {
  const probe = path.join(dir, `.pm-write-test-${randomBytes(4).toString('hex')}`)
  try {
    const h = await fs.open(probe, 'wx')
    await h.close()
    await fs.unlink(probe)
    return true
  } catch {
    return false
  }
}

/** Déplace un fichier ; bascule sur copie + suppression si les volumes diffèrent. */
export async function moveFile(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true })
  try {
    await fs.rename(from, to)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EXDEV' && code !== 'EPERM') throw err
    await fs.copyFile(from, to, fsc.COPYFILE_EXCL)
    await fs.unlink(from)
  }
}

/** Déplace un dossier entier (rename, ou copie récursive si changement de volume). */
export async function moveDir(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true })
  try {
    await fs.rename(from, to)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EXDEV' && code !== 'EPERM') throw err
    await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false })
    await fs.rm(from, { recursive: true, force: true })
  }
}

export async function removeEmptyDirsUpward(dir: string, stopAt: string): Promise<void> {
  let cur = path.resolve(dir)
  const stop = path.resolve(stopAt)
  while (cur.length > stop.length && isInside(stop, cur)) {
    try {
      await fs.rmdir(cur)
    } catch {
      return
    }
    cur = path.dirname(cur)
  }
}

/** Vrai si `child` est strictement à l'intérieur de `parent` (comparaison insensible à la casse, Windows). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Résout un chemin relatif POSIX sous une racine en refusant toute sortie de la racine. */
export function safeJoin(root: string, rel: string): string {
  const parts = rel.split('/').filter((p) => p && p !== '.')
  if (parts.some((p) => p === '..')) throw new Error(t('files.invalidPath', { path: rel }))
  const abs = path.resolve(root, ...parts)
  if (abs !== path.resolve(root) && !isInside(root, abs)) throw new Error(t('files.outsideRoot', { path: rel }))
  return abs
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

/** Taille lisible dans la langue affichée (« 1,5 Go » / « 1.5 GB »). */
export function formatBytes(n: number): string {
  return formatSize(n)
}

export function newId(prefix = ''): string {
  const time = Date.now().toString(36)
  return `${prefix}${time}-${randomBytes(3).toString('hex')}`
}

export function slugify(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'pack'
  )
}

export async function freeSpace(dir: string): Promise<number | null> {
  try {
    let probe = path.resolve(dir)
    while (!(await exists(probe))) {
      const parent = path.dirname(probe)
      if (parent === probe) break
      probe = parent
    }
    const st = await fs.statfs(probe)
    return st.bavail * st.bsize
  } catch {
    return null
  }
}

export function sameVolume(a: string, b: string): boolean {
  return path.parse(path.resolve(a)).root.toLowerCase() === path.parse(path.resolve(b)).root.toLowerCase()
}

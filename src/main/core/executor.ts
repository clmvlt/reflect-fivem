// Exécution d'un « plan » d'opérations fichiers.
// Le même code tourne dans l'application ou dans un processus élevé (UAC) quand un dossier est protégé.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { t } from 'i18next'
import { copyFileTracked, moveDir, moveFile } from '../util/fsx'
import { unsealToFile } from './sealed'

export type Op =
  /** Crée un dossier s'il n'existe pas (le résultat indique s'il a été créé). */
  | { t: 'mkdir'; path: string }
  /** Copie (ou lien physique) d'un fichier de la bibliothèque vers le jeu. Échoue si la destination existe. */
  | { t: 'place'; from: string; to: string; link: boolean; size: number }
  /**
   * Fichier d'un pack protégé déchiffré directement à sa place dans le jeu (flux « offset/length » de « from », voir
   * sealed.ts ; la clé ne déchiffre que ce fichier). Échoue si la destination existe.
   */
  | { t: 'unseal'; from: string; offset: number; length: number; key: string; to: string; size: number }
  /** Supprime un fichier installé par l'application (absent = succès). */
  | { t: 'remove'; path: string }
  /** Déplace un fichier ou dossier vers la zone de sauvegarde (absent = ignoré). */
  | { t: 'stash'; path: string; to: string; size: number }
  /** Remet un élément sauvegardé à sa place (échoue si la destination est occupée). */
  | { t: 'unstash'; from: string; to: string; size: number }
  /** Copie un fichier du jeu vers la bibliothèque (réglages modifiés en jeu, capture). */
  | { t: 'copyOut'; from: string; to: string; size: number }
  /** Supprime un dossier s'il est vide. */
  | { t: 'rmdirIfEmpty'; path: string }
  /** Supprime un dossier et son contenu ; « quiet » : un échec est ignoré (nettoyage final). */
  | { t: 'rmTree'; path: string; quiet?: boolean }

export interface Plan {
  id: string
  title: string
  /** atomic : au premier échec, tout ce qui a été fait est annulé. best-effort : on continue et on rapporte. */
  mode: 'atomic' | 'best-effort'
  ops: Op[]
}

export interface OpResult {
  i: number
  ok: boolean
  skipped?: boolean
  created?: boolean
  linked?: boolean
  size?: number
  mtimeMs?: number
  error?: string
}

export interface PlanResult {
  ok: boolean
  results: OpResult[]
  error?: string
  rolledBack: boolean
}

export interface ExecProgress {
  done: number
  total: number
  bytes: number
  totalBytes: number
  current: string
}

const opBytes = (op: Op): number => ('size' in op ? op.size : 0)

/** Chemins lus ou écrits par une opération. */
export function opPaths(op: Op): string[] {
  const { path: p, from, to } = op as { path?: string; from?: string; to?: string }
  return [p, from, to].filter((x): x is string => !!x)
}
const opLabel = (op: Op): string => {
  switch (op.t) {
    case 'place':
    case 'unseal':
    case 'remove':
    case 'rmdirIfEmpty':
    case 'rmTree':
    case 'mkdir':
      return path.basename('to' in op ? op.to : op.path)
    case 'stash':
      return path.basename(op.path)
    case 'unstash':
    case 'copyOut':
      return path.basename(op.to)
  }
}

function errMsg(err: unknown): string {
  const e = err as NodeJS.ErrnoException
  switch (e?.code) {
    case 'EBUSY':
      return t('executor.errors.busy')
    case 'EPERM':
    case 'EACCES':
      return t('executor.errors.accessDenied', { path: e.path ?? '' })
    case 'ENOSPC':
      return t('executor.errors.noSpace')
    case 'EEXIST':
      return t('executor.errors.exists', { path: e.path ?? '' })
    case 'ENOENT':
      return t('executor.errors.notFound', { path: e.path ?? '' })
    default:
      return e?.message ?? String(err)
  }
}

async function statOf(p: string): Promise<{ size: number; mtimeMs: number }> {
  const st = await fs.stat(p)
  return { size: st.size, mtimeMs: st.mtimeMs }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p)
    return true
  } catch {
    return false
  }
}

async function runOp(op: Op, onBytes: (n: number) => void): Promise<Omit<OpResult, 'i'>> {
  switch (op.t) {
    case 'mkdir': {
      if (await pathExists(op.path)) return { ok: true, created: false }
      await fs.mkdir(op.path, { recursive: true })
      return { ok: true, created: true }
    }
    case 'place': {
      await fs.mkdir(path.dirname(op.to), { recursive: true })
      if (op.link) {
        try {
          await fs.link(op.from, op.to)
          return { ok: true, linked: true, ...(await statOf(op.to)) }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code === 'EEXIST') throw err
          // Volume différent, FAT32, droits... : copie classique.
        }
      }
      await copyFileTracked(op.from, op.to, onBytes)
      return { ok: true, linked: false, ...(await statOf(op.to)) }
    }
    case 'unseal': {
      await fs.mkdir(path.dirname(op.to), { recursive: true })
      await unsealToFile(op.from, { offset: op.offset, length: op.length, key: op.key }, op.to, onBytes)
      return { ok: true, linked: false, ...(await statOf(op.to)) }
    }
    case 'remove': {
      try {
        await fs.unlink(op.path)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, skipped: true }
        if ((err as NodeJS.ErrnoException).code === 'EPERM') {
          // Fichier en lecture seule : on retire l'attribut puis on réessaie.
          await fs.chmod(op.path, 0o666).catch(() => undefined)
          await fs.unlink(op.path)
          return { ok: true }
        }
        throw err
      }
      return { ok: true }
    }
    case 'stash': {
      let st
      try {
        st = await fs.lstat(op.path)
      } catch {
        return { ok: true, skipped: true }
      }
      if (st.isDirectory()) await moveDir(op.path, op.to)
      else await moveFile(op.path, op.to)
      return { ok: true }
    }
    case 'unstash': {
      if (await pathExists(op.to)) {
        const e = new Error(t('executor.errors.occupied', { path: op.to })) as NodeJS.ErrnoException
        e.code = 'EEXIST'
        e.path = op.to
        throw e
      }
      const st = await fs.lstat(op.from)
      if (st.isDirectory()) await moveDir(op.from, op.to)
      else await moveFile(op.from, op.to)
      return { ok: true }
    }
    case 'copyOut': {
      await fs.mkdir(path.dirname(op.to), { recursive: true })
      await fs.copyFile(op.from, op.to)
      return { ok: true }
    }
    case 'rmdirIfEmpty': {
      try {
        await fs.rmdir(op.path)
        return { ok: true }
      } catch {
        return { ok: true, skipped: true }
      }
    }
    case 'rmTree': {
      try {
        await fs.rm(op.path, { recursive: true, force: true, maxRetries: 2 })
      } catch (err) {
        if (!op.quiet) throw err
        return { ok: true, skipped: true }
      }
      return { ok: true }
    }
  }
}

async function undoOp(op: Op, res: OpResult): Promise<void> {
  if (!res.ok || res.skipped) return
  switch (op.t) {
    case 'mkdir':
      if (res.created) await fs.rmdir(op.path).catch(() => undefined)
      return
    case 'place':
    case 'unseal':
      await fs.unlink(op.to).catch(() => undefined)
      return
    case 'stash': {
      const st = await fs.lstat(op.to).catch(() => null)
      if (!st) return
      if (st.isDirectory()) await moveDir(op.to, op.path).catch(() => undefined)
      else await moveFile(op.to, op.path).catch(() => undefined)
      return
    }
    case 'unstash': {
      const st = await fs.lstat(op.to).catch(() => null)
      if (!st) return
      if (st.isDirectory()) await moveDir(op.to, op.from).catch(() => undefined)
      else await moveFile(op.to, op.from).catch(() => undefined)
      return
    }
    default:
      return // remove / copyOut / rmdir / rmTree : non annulables (jamais utilisés en mode atomique)
  }
}

/** Supprime une arborescence de dossiers vides ; s'arrête (sans rien perdre) si un fichier s'y trouve encore. */
async function removeEmptyTree(dir: string): Promise<boolean> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return true
  }
  let empty = true
  for (const e of entries) {
    if (!e.isDirectory() || !(await removeEmptyTree(path.join(dir, e.name)))) empty = false
  }
  if (empty) await fs.rmdir(dir).catch(() => undefined)
  return empty
}

export async function executePlan(plan: Plan, onProgress: (p: ExecProgress) => void): Promise<PlanResult> {
  const results: OpResult[] = []
  const total = plan.ops.length
  const totalBytes = plan.ops.reduce((s, op) => s + opBytes(op), 0)
  let bytes = 0
  // Octets déjà écrits du fichier en cours : la barre avance pendant la copie d'un gros fichier.
  let partial = 0
  let last = 0
  const emit = (done: number, current: string, force = false): void => {
    const now = Date.now()
    if (!force && now - last < 100) return
    last = now
    onProgress({ done, total, bytes: bytes + partial, totalBytes, current })
  }

  for (let i = 0; i < plan.ops.length; i++) {
    const op = plan.ops[i]
    const label = opLabel(op)
    emit(i, label)
    try {
      const r = await runOp(op, (n) => {
        partial += n
        emit(i, label)
      })
      results.push({ i, ...r })
    } catch (err) {
      const error = errMsg(err)
      results.push({ i, ok: false, error })
      if (plan.mode === 'atomic') {
        emit(i, t('executor.rollingBack'), true)
        // Ordre inverse : les fichiers sont retirés avant les dossiers qui les contiennent.
        for (let j = results.length - 2; j >= 0; j--) await undoOp(plan.ops[results[j].i], results[j])
        // Dossiers temporaires du plan : supprimés seulement s'ils ne contiennent plus aucun fichier.
        for (const o of plan.ops) if (o.t === 'rmTree' && o.quiet) await removeEmptyTree(o.path)
        return { ok: false, results, error, rolledBack: true }
      }
    }
    partial = 0
    bytes += opBytes(op)
  }
  emit(total, '', true)
  const failed = results.filter((r) => !r.ok)
  return {
    ok: failed.length === 0,
    results,
    error: failed.length ? t('executor.errors.failed', { count: failed.length, error: failed[0].error ?? '' }) : undefined,
    rolledBack: false
  }
}

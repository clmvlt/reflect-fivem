// Application, bascule et retrait des packs.
//
// Changer de pack est une seule opération atomique :
//   1. les fichiers de l'ancien pack sont déplacés dans un dossier temporaire (sur le même disque, donc instantané) ;
//   2. les mods installés à la main sont déplacés dans un nouveau pack de la bibliothèque (« Ancienne installation ») ;
//   3. les fichiers du nouveau pack sont installés ;
//   4. le dossier temporaire est supprimé.
// Au moindre échec, tout est remis en place. Une seule demande d'autorisation administrateur au plus.
//
// Fichiers du jeu (archives .rpf de GTA V, dossiers update/ et x64/, fichiers de FiveM hors mods, plugins, addons et
// citizen) : l'original remplacé par un pack est déplacé dans le dossier .fpm-originaux de sa racine (même disque, donc
// instantané) et remis en place quand le pack est retiré, ou à la bascule vers un pack qui ne le remplace pas.
//
// Pack protégé : chaque fichier est déchiffré directement à sa place dans le jeu (opération « unseal ») ; les réglages
// modifiés en jeu et les fichiers générés sont chiffrés dans la bibliothèque. Retiré du jeu, il ne reste de lui aucun
// fichier en clair sur le disque.
//
// Mods : plusieurs à la fois, en plus du pack actif et indépendants de lui (état : AppState.mods). Activer, désactiver
// ou mettre à jour des mods est aussi une seule opération atomique (voir changeMods). Un mod ne remplace jamais le
// fichier d'un autre mod ; il peut remplacer un fichier du pack actif, réinstallé depuis le pack quand le mod est retiré.
// Changer de pack ne touche pas aux mods : leurs fichiers sont connus (ni rangés dans « Ajouts manuels », ni remplacés).
//
// Instances (voir instances.ts) : les fichiers posés par les autres instances dans les mêmes dossiers (GTA V, en général
// commun) sont connus eux aussi. Un pack ne les remplace jamais ; le même pack installé dans deux instances partage ses
// fichiers de GTA V, retirés seulement quand plus aucune instance ne les utilise.

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { t } from 'i18next'
import type {
  ActiveInstall,
  AppState,
  Destination,
  ForeignItem,
  GamesInfo,
  InstalledFile,
  InstalledMod,
  ModPreflight,
  RootId,
  ShadowedFile
} from '@shared/types'
import { msg, tm, type Msg } from '@shared/i18n'
import { formatBytes, formatNumber, quote } from '@shared/intl'
import { resolveInstallMap } from './analyzer'
import { parseVersion, reshadeAckLine, versionAtLeast } from './binary'
import { executePlan, type ExecProgress, type Op, type Plan, type PlanResult } from './executor'
import { executePlanElevated } from './elevation'
import { collectForeign, managedKey, managedSet, scanForeign, type ForeignCollection } from './foreign'
import {
  defaultReshadeIni,
  iniGet,
  iniSet,
  mergeQuantvPreset,
  presetDestFromIni,
  presetIniValue,
  QUANTV_ADDON_DEST,
  QUANTV_PRESET_DEST,
  RESHADE_INI_DEST
} from './reshade'
import { isEnbLocal, withEnbFpsLimit, withPackFpsLimit } from './enb'
import { CONFIG_EXT, ext, isAllowedFiveMPath, isProtectedGtaPath } from './knowledge'
import { readSource, type PackContent } from './content'
import { samePath } from './games'
import type { Library, StoredManifest } from './library'
import type { SealedRef } from './sealed'
import { JsonStore, pushHistory } from './stores'
import { canWrite, dirSize, exists, freeSpace, newId, sameVolume } from '../util/fsx'
import { runningGameProcesses } from '../util/win'
import { log } from '../util/log'

/** Progression d'une tâche. `bytes` : current et total sont des octets téléchargés (débit affiché). */
export type Report = (phase: string, current: number, total: number, detail?: string, bytes?: boolean) => void

export interface InstallerCtx {
  jobsDir: string
  library: () => Library
  /** Bibliothèque des mods (absente : mods indisponibles). */
  modLibrary?: () => Library
  state: JsonStore<AppState>
  detectGames: () => Promise<GamesInfo>
  /** Enregistre une image (réduite) dans le dossier d'un pack ; renvoie son nom de fichier (cover-*.jpg). */
  saveCover?: (src: string, packDir: string) => Promise<string | null>
  /** Limite d'images par seconde choisie dans l'application : null = celle du pack, 0 = aucune limite. */
  fpsLimit?: () => number | null
  /** Fichiers posés par les autres instances (pack installé, mods activés). */
  others?: () => Promise<OtherInstall[]>
}

/** Fichiers posés par une autre instance : son pack installé (packId) ou l'un de ses mods activés (packId null). */
export interface OtherInstall {
  instance: string
  packId: string | null
  packName: string | null
  roots: Record<RootId, string>
  files: InstalledFile[]
}

/** Fichier d'une autre instance posé dans les dossiers de celle-ci, et son instance. */
interface SharedFile {
  owner: OtherInstall
  file: InstalledFile
}

interface InstallItem {
  src: string
  /** Pack protégé : flux chiffré dans {@link src}, déchiffré à l'installation. */
  sealed?: SealedRef
  source: string
  dest: Destination
  size: number
  fromUser: boolean
}

const abs = (rootPath: string, rel: string): string => path.join(rootPath, ...rel.split('/'))
const destKey = (d: Destination): string => `${d.root}:${d.path.toLowerCase()}`
const TRASH_PREFIX = '.fpm-trash-'
/** Dossier (à la racine de FiveM.app ou de GTA V) des fichiers d'origine du jeu remplacés par le pack installé. */
export const ORIGINALS_DIR = '.fpm-originaux'
const originalFile = (rootPath: string, rel: string): string => abs(path.join(rootPath, ORIGINALS_DIR), rel)

/** Fichier du jeu : son original est gardé tant qu'un pack le remplace (voir l'en-tête). */
const isGameFile = (d: Destination): boolean => (d.root === 'gta' ? isProtectedGtaPath(d.path) : !isAllowedFiveMPath(d.path))

/** Nom français du pack des mods rangés : sert à son identifiant (dossier) ; le nom donné au pack suit la langue. */
export const PREVIOUS_INSTALL_NAME = 'Ancienne installation'

export interface SwitchResult {
  installed: number
  /** Nom du pack « Ancienne installation » créé, s'il y avait des mods installés à la main. */
  captured: string | null
  /** Pack retiré au passage. */
  removed: string | null
  /** Nettoyage du jeu : nombre de mods désactivés. */
  mods?: number
}

const isModified = (st: { size: number; mtimeMs: number }, f: InstalledFile): boolean => st.size !== f.size || Math.abs(st.mtimeMs - f.mtimeMs) > 1

/** Dossiers parents de chaque fichier (du moins profond au plus profond). */
function parentDirs(dests: Destination[]): Map<string, Destination> {
  const out = new Map<string, Destination>()
  for (const dest of dests) {
    const parts = dest.path.split('/').slice(0, -1)
    for (let i = 1; i <= parts.length; i++) {
      const d: Destination = { root: dest.root, path: parts.slice(0, i).join('/') }
      out.set(destKey(d), d)
    }
  }
  return out
}

const byDepth = (a: Destination, b: Destination): number => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path)

/** Dossiers de .fpm-originaux vidés par la remise en place (ou l'abandon) de ces originaux, du plus profond au moins profond. */
function originalsCleanup(list: Destination[], roots: Record<RootId, string>): Op[] {
  const dirs = [...parentDirs(list).values()].sort((a, b) => byDepth(b, a)).map((d) => originalFile(roots[d.root], d.path))
  const tops = [...new Set(list.map((d) => path.join(roots[d.root], ORIGINALS_DIR)))]
  return [...dirs, ...tops].map((p): Op => ({ t: 'rmdirIfEmpty', path: p }))
}

function foreignMessage(paths: string[]): string {
  const shown = paths.slice(0, 3).join(', ') + (paths.length > 3 ? '…' : '')
  return t('installer.errors.modForeign', { count: paths.length, files: shown })
}

/** Erreur d'un plan qui a échoué ; {@link fallback} : message quand le plan n'en donne pas. */
function planError(res: PlanResult, fallback: string): string {
  return res.rolledBack ? t('installer.errors.nothingChanged', { error: res.error ?? t('installer.failed') }) : (res.error ?? fallback)
}

/** Résumé d'un échec pour l'historique : l'erreur du plan telle quelle, sinon « Échec » (traduit à l'affichage). */
function failureSummary(error: string | undefined): { summary: string } | { msg: Msg } {
  return error ? { summary: error } : { msg: msg('history.failed') }
}

/** Résumé de l'historique avec un nombre (count pour le pluriel, n formaté). */
const countMsg = (key: string, count: number): Msg => msg(key, { count, n: formatNumber(count) })

export class Installer {
  constructor(private ctx: InstallerCtx) {}

  private get state(): AppState {
    return this.ctx.state.get()
  }

  private async setState(s: AppState): Promise<void> {
    await this.ctx.state.set(s)
  }

  /** Exécute un plan, avec les droits administrateur si l'une des racines n'est pas modifiable (aussi pour le changement d'instance). */
  async runPlan(plan: Plan, roots: string[], report: Report): Promise<PlanResult> {
    let elevate = false
    for (const r of new Set(roots.filter(Boolean))) if (!(await canWrite(r))) elevate = true
    // Test : force le passage par le processus séparé (avec PM_NO_UAC, sans fenêtre UAC).
    if (process.env.PM_FORCE_ELEVATION === '1') elevate = true
    const onP = (p: ExecProgress): void => report(plan.title, p.totalBytes ? p.bytes : p.done, p.totalBytes || p.total, p.current)
    if (elevate) log.info(`Plan « ${plan.title} » exécuté avec les droits administrateur`)
    const res = elevate ? await executePlanElevated(plan, this.ctx.jobsDir, onP) : await executePlan(plan, onP)
    log[res.ok ? 'info' : 'warn'](`Plan « ${plan.title} » : ${res.ok ? 'OK' : res.error} (${plan.ops.length} opérations)`)
    return res
  }

  private async assertGameClosed(): Promise<void> {
    if ((await runningGameProcesses()).length) throw new Error(t('installer.errors.gameRunning'))
  }

  private get mods(): InstalledMod[] {
    return this.state.mods ?? []
  }

  /** Fichiers des autres instances posés dans ces dossiers (GTA V commun), par destination. */
  private async sharedFiles(roots: Record<RootId, string | null>): Promise<Map<string, SharedFile>> {
    const out = new Map<string, SharedFile>()
    for (const owner of (await this.ctx.others?.()) ?? [])
      for (const file of owner.files) if (samePath(owner.roots[file.root], roots[file.root])) out.set(destKey(file), { owner, file })
    return out
  }

  /** Mods activés, plus les fichiers des autres instances : connus, jamais pris pour des mods installés à la main. */
  private async knownMods(games: GamesInfo): Promise<InstalledMod[]> {
    const roots = { fivem: games.fivem.path ?? '', gta: games.gta.path ?? '' }
    const shared = await this.sharedFiles(roots)
    if (!shared.size) return this.mods
    const files = [...shared.values()].map((s) => s.file)
    return [...this.mods, { id: '', name: '', enabled: true, appliedAt: null, roots, files, createdDirs: [], shadowed: [] }]
  }

  /** Fichiers à installer ; un réglage modifié en jeu (dossier user/) remplace l'original. */
  private async installItems(m: StoredManifest, content: PackContent, lib = this.ctx.library()): Promise<InstallItem[]> {
    const sizes = new Map(m.files.map((f) => [f.rel, f.size]))
    const out: InstallItem[] = []
    for (const { rel, dest } of resolveInstallMap(m.components)) {
      const user = await lib.userSource(m, dest)
      if (user) out.push({ src: user.src, sealed: user.sealed, source: path.relative(lib.packDir(m.id), user.src), dest, size: user.size, fromUser: true })
      else out.push({ ...content.source(rel), source: `content/${rel}`, dest, size: sizes.get(rel) ?? 0, fromUser: false })
    }
    return out
  }

  private canLink(it: InstallItem, rootPath: string): boolean {
    // Fichier du jeu : copié, une mise à jour du jeu écrivant dedans modifierait sinon le fichier de la bibliothèque.
    return !it.fromUser && !it.sealed && !isGameFile(it.dest) && !CONFIG_EXT.has(ext(it.dest.path)) && sameVolume(it.src, rootPath)
  }

  /** Copie, lien physique, ou déchiffrement (pack protégé) du fichier à sa place dans le jeu. */
  private placeOp(it: InstallItem, rootPath: string): Op {
    const to = abs(rootPath, it.dest.path)
    if (it.sealed) return { t: 'unseal', from: it.src, ...it.sealed, to, size: it.size }
    return { t: 'place', from: it.src, to, link: this.canLink(it, rootPath), size: it.size }
  }

  /**
   * Garde un réglage modifié en jeu. Pack protégé : chiffré tout de suite dans la bibliothèque (jamais en clair) ; sinon
   * copié par le plan.
   */
  private async keepUserFile(pack: StoredManifest, dest: Destination, from: string, size: number, ops: Op[], lib = this.ctx.library()): Promise<void> {
    if (pack.protection) await lib.sealUserFile(pack, dest, from)
    else ops.push({ t: 'copyOut', from, to: lib.userFile(pack.id, dest), size })
  }

  /** Raisons d'empêcher l'installation, en une phrase courte chacune. */
  private async blockers(items: InstallItem[], games: GamesInfo): Promise<string[]> {
    const out: string[] = []
    const needs = new Set(items.map((i) => i.dest.root))
    if (!items.length) out.push(t('installer.errors.packEmpty'))
    if (games.runningProcesses.length) out.push(t('installer.errors.gameRunning'))
    if (needs.has('fivem') && !games.fivem.valid) out.push(t('installer.errors.fivemMissing'))
    if (needs.has('gta') && !games.gta.valid) out.push(t('installer.errors.gtaMissing'))
    if (needs.has('gta') && games.gta.edition === 'enhanced') out.push(t('installer.errors.enhancedPack'))
    if (out.length) return out
    const need = new Map<string, number>()
    for (const it of items) {
      const rp = (it.dest.root === 'fivem' ? games.fivem.path : games.gta.path) as string
      if (!this.canLink(it, rp)) need.set(rp, (need.get(rp) ?? 0) + it.size)
    }
    for (const [rp, bytes] of need) {
      const free = await freeSpace(rp)
      if (free !== null && free < bytes + 200 * 1024 * 1024) out.push(t('installer.errors.noSpace', { size: formatBytes(bytes) }))
    }
    return out
  }

  // -------------------------------------------------------------------------

  /** Mods installés à la main, hors pack actif (pour la ligne « Installation actuelle »). `games` : détection déjà faite. */
  async foreignSummary(games?: GamesInfo): Promise<{ files: number; size: number } | null> {
    const g = games ?? (await this.ctx.detectGames())
    const c = await collectForeign(g, this.state.active, undefined, await this.knownMods(g))
    return c.files.length ? { files: c.files.length, size: c.files.reduce((s, f) => s + f.size, 0) } : null
  }

  /** Opérations qui rangent des fichiers existants du jeu dans un nouveau pack de la bibliothèque. */
  private captureOps(capId: string, roots: Record<RootId, string>, collection: ForeignCollection, extra: { root: RootId; rel: string; size: number }[]) {
    const lib = this.ctx.library()
    const ops: Op[] = []
    const seen = new Set<string>()
    const covered = (root: RootId, rel: string): boolean => {
      const k = managedKey(root, rel)
      return [...seen].some((s) => k === s || k.startsWith(`${s}/`))
    }
    for (const m of collection.moves) {
      ops.push({ t: 'stash', path: abs(roots[m.root], m.rel), to: lib.capturedFile(capId, m.root, m.rel), size: 0 })
      seen.add(managedKey(m.root, m.rel))
    }
    const files = [...collection.files]
    for (const f of extra) {
      if (covered(f.root, f.rel)) continue
      ops.push({ t: 'stash', path: abs(roots[f.root], f.rel), to: lib.capturedFile(capId, f.root, f.rel), size: 0 })
      seen.add(managedKey(f.root, f.rel))
      files.push(f)
    }
    return { ops, files }
  }

  // -------------------------------------------------------------------------
  // Application / bascule

  async apply(packId: string, report: Report): Promise<SwitchResult> {
    return this.switchTo(packId, report)
  }

  /**
   * Remet le jeu d'origine en une seule opération : le pack installé est retiré et les mods installés
   * à la main sont rangés dans un pack « Ancienne installation » (réinstallable). Les captures d'écran restent.
   * `withMods` : les mods de la bibliothèque des mods sont d'abord désactivés (sinon ils restent en place).
   */
  async cleanGame(report: Report, withMods = false): Promise<SwitchResult> {
    const enabled = this.mods.filter((m) => m.enabled)
    if (!withMods || !enabled.length) return this.switchTo(null, report)
    await this.changeMods({ remove: enabled, add: [] }, report, msg('removeMods'))
    const games = await this.ctx.detectGames()
    if (!this.state.active && !(await collectForeign(games, null, undefined, await this.knownMods(games))).files.length)
      return { installed: 0, captured: null, removed: null, mods: enabled.length }
    return { ...(await this.switchTo(null, report)), mods: enabled.length }
  }

  /** Bascule vers un pack, ou vers le jeu d'origine (packId null), en une seule opération atomique. */
  private async switchTo(packId: string | null, report: Report): Promise<SwitchResult> {
    report(t('installer.phase.preparing'), 0, 1)
    const lib = this.ctx.library()
    const games = await this.ctx.detectGames()
    const manifest = packId ? await lib.get(packId) : null
    const active = this.state.active
    const content = manifest ? await lib.content(manifest) : null
    let items = manifest && content ? await this.installItems(manifest, content) : []
    const blockers = manifest ? await this.blockers(items, games) : games.runningProcesses.length ? [t('installer.errors.gameRunning')] : []
    if (blockers.length) throw new Error(blockers[0])

    const roots: Record<RootId, string> = { fivem: games.fivem.path ?? '', gta: games.gta.path ?? '' }
    const id = newId('inst-')
    const ops: Op[] = []
    const trashDirs = new Set<string>()

    // 1) Ancien pack : réglages modifiés conservés, puis fichiers déplacés dans un dossier temporaire. Ceux qu'une autre
    // instance utilise aussi (même pack, GTA V commun) restent en place.
    const oldPack = active ? await lib.get(active.packId).catch(() => null) : null
    const stillUsed = active ? await this.sharedFiles(active.roots) : new Map<string, SharedFile>()
    const saved = new Set<string>()
    // Fichiers du jeu remplacés depuis l'installation (mise à jour du jeu) : ce sont les nouveaux originaux, laissés en place.
    const updated = new Set<string>()
    if (active) {
      for (const f of active.files) {
        if (stillUsed.has(destKey(f))) continue
        const rp = active.roots[f.root]
        const target = abs(rp, f.path)
        const st = await fs.stat(target).catch(() => null)
        if (!st) continue
        const modified = st.size !== f.size || Math.abs(st.mtimeMs - f.mtimeMs) > 1
        if (modified && isGameFile(f)) {
          updated.add(destKey(f))
          continue
        }
        if (modified && oldPack) {
          await this.keepUserFile(oldPack, { root: f.root, path: f.path }, target, st.size, ops)
          saved.add(destKey({ root: f.root, path: f.path }))
        }
        const trash = path.join(rp, `${TRASH_PREFIX}${id}`)
        trashDirs.add(trash)
        ops.push({ t: 'stash', path: target, to: abs(trash, f.path), size: 0 })
      }
      // Réappliquer le même pack : les réglages qu'on vient de sauvegarder sont réinstallés.
      if (manifest && oldPack?.id === manifest.id && saved.size) {
        const next: InstallItem[] = []
        for (const it of items) {
          if (!saved.has(destKey(it.dest))) next.push(it)
          else if (manifest.protection) {
            // Déjà chiffré dans la bibliothèque (voir keepUserFile).
            const user = await lib.userSource(manifest, it.dest)
            next.push(user ? { ...it, src: user.src, sealed: user.sealed, size: user.size, fromUser: true, source: path.relative(lib.packDir(manifest.id), user.src) } : it)
          } else {
            const file = lib.userFile(manifest.id, it.dest)
            next.push({ ...it, src: file, fromUser: true, source: path.relative(lib.packDir(manifest.id), file) })
          }
        }
        items = next
      }
    }

    // Preset ReShade du pack : ReShade.ini pointe dessus, sans passer par le menu de ReShade en jeu ; avec QuantV,
    // il est aussi recopié dans QuantV.preset.ini, le preset que QuantV impose à ReShade.
    if (manifest) items = await this.withPreset(manifest, items, roots)
    if (manifest && content) items = await this.withQuantvPreset(manifest, items, content)
    // Limite d'images par seconde choisie dans l'application : écrite dans l'enblocal.ini (ENB) du pack.
    if (manifest && content) items = await this.withFpsLimit(manifest, items, content)

    // Fichiers déjà posés par un mod activé : le mod reste prioritaire. Le fichier du pack n'est pas installé ; il le sera
    // quand le mod sera retiré.
    const shadowed = new Map<string, ShadowedFile[]>()
    if (manifest) {
      const holders = this.modHolders()
      const placed: InstallItem[] = []
      for (const it of items) {
        const mod = holders.get(destKey(it.dest))
        if (!mod) {
          placed.push(it)
          continue
        }
        const file: InstalledFile = { root: it.dest.root, path: it.dest.path, size: it.size, mtimeMs: 0, linked: false, source: it.source }
        shadowed.set(mod.id, [...(shadowed.get(mod.id) ?? []), { packId: manifest.id, file }])
      }
      items = placed
    }
    // Fichiers d'une autre instance au même endroit (GTA V commun) : partagés si c'est le même fichier du même pack,
    // sinon l'installation est refusée (les deux instances verraient le fichier de l'autre).
    const sharing: InstalledFile[] = []
    if (manifest) {
      const shared = await this.sharedFiles(roots)
      const placed: InstallItem[] = []
      for (const it of items) {
        const s = shared.get(destKey(it.dest))
        if (!s) placed.push(it)
        else if (s.owner.packId === manifest.id && s.file.source === it.source && !isGameFile(it.dest)) sharing.push(s.file)
        else
          throw new Error(
            t('installer.errors.otherInstance', {
              instance: quote(s.owner.instance),
              owner: quote(s.owner.packName ?? s.owner.instance),
              path: `${it.dest.root === 'gta' ? 'GTA V' : 'FiveM.app'}/${it.dest.path}`
            })
          )
      }
      items = placed
    }

    // Les notes de l'ancien pack sont oubliées : ses fichiers ne reviendront pas.
    const modsAfter = (): InstalledMod[] => this.mods.map((m) => ({ ...m, shadowed: shadowed.get(m.id) ?? [] }))

    // Originaux gardés pour l'ancien pack : conservés tels quels si le nouveau pack remplace le même fichier, jetés si le
    // jeu l'a remplacé entre-temps, remis en place sinon.
    const itemKeys = new Set(items.map((it) => destKey(it.dest)))
    const kept: Destination[] = []
    const released: Destination[] = []
    for (const o of active?.originals ?? []) {
      const k = destKey(o)
      const rp = active!.roots[o.root]
      const from = originalFile(rp, o.path)
      if (!(await exists(from))) {
        log.warn(`Fichier d'origine introuvable dans ${ORIGINALS_DIR}, non remis en place : ${o.path}`)
        continue
      }
      if (itemKeys.has(k) && !updated.has(k) && rp === roots[o.root]) {
        kept.push(o)
        continue
      }
      released.push(o)
      if (updated.has(k)) {
        const trash = path.join(rp, `${TRASH_PREFIX}${id}`)
        trashDirs.add(trash)
        ops.push({ t: 'stash', path: from, to: abs(path.join(trash, ORIGINALS_DIR), o.path), size: 0 })
      } else ops.push({ t: 'unstash', from, to: abs(rp, o.path), size: 0 })
    }

    // 2) Mods installés à la main et fichiers qui seraient écrasés : rangés dans « Ancienne installation ». Fichiers du
    // jeu : gardés dans .fpm-originaux, remis en place au retrait du pack.
    const known = await this.knownMods(games)
    const managed = managedSet(active, known)
    const collection = await collectForeign(games, active, undefined, known)
    const overwritten: { root: RootId; rel: string; size: number }[] = []
    const replaced: Destination[] = []
    for (const it of items) {
      if (managed.has(managedKey(it.dest.root, it.dest.path)) && !updated.has(destKey(it.dest))) continue
      const st = await fs.lstat(abs(roots[it.dest.root], it.dest.path)).catch(() => null)
      if (!st || st.isDirectory()) continue
      if (isGameFile(it.dest)) replaced.push(it.dest)
      else overwritten.push({ root: it.dest.root, rel: it.dest.path, size: st.size })
    }
    if (!manifest && !active && !collection.files.length) throw new Error(t('installer.errors.alreadyClean'))
    const capId = lib.newCapturedId(PREVIOUS_INSTALL_NAME)
    const capture = this.captureOps(capId, roots, collection, overwritten)
    ops.push(...capture.ops)
    for (const d of replaced) ops.push({ t: 'stash', path: abs(roots[d.root], d.path), to: originalFile(roots[d.root], d.path), size: 0 })
    if (replaced.length) log.info(`${replaced.length} fichier(s) du jeu remplacé(s), originaux gardés dans ${ORIGINALS_DIR}`)

    // 3) Nouveau pack : dossiers (du moins profond au plus profond), puis fichiers.
    const dirKeys = new Map<string, Destination>()
    for (const it of items) {
      const parts = it.dest.path.split('/').slice(0, -1)
      for (let i = 1; i <= parts.length; i++) {
        const d: Destination = { root: it.dest.root, path: parts.slice(0, i).join('/') }
        dirKeys.set(destKey(d), d)
      }
    }
    const dirs = [...dirKeys.values()].sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))
    const mkdirIdx: { idx: number; dest: Destination }[] = []
    for (const d of dirs) {
      ops.push({ t: 'mkdir', path: abs(roots[d.root], d.path) })
      mkdirIdx.push({ idx: ops.length - 1, dest: d })
    }
    const placeIdx: { idx: number; item: InstallItem }[] = []
    for (const it of items) {
      ops.push(this.placeOp(it, roots[it.dest.root]))
      placeIdx.push({ idx: ops.length - 1, item: it })
    }

    // 4) Nettoyage : dossiers vidés de l'ancien pack, dossier temporaire (et ceux d'une opération interrompue).
    for (const d of [...(active?.createdDirs ?? [])].sort((a, b) => b.path.split('/').length - a.path.split('/').length))
      ops.push({ t: 'rmdirIfEmpty', path: abs(active!.roots[d.root], d.path) })
    if (active) ops.push(...originalsCleanup(released, active.roots))
    for (const rp of new Set([...Object.values(roots), ...Object.values(active?.roots ?? {})].filter(Boolean)))
      for (const e of await fs.readdir(rp).catch(() => [] as string[])) if (e.startsWith(TRASH_PREFIX)) trashDirs.add(path.join(rp, e))
    for (const t of trashDirs) ops.push({ t: 'rmTree', path: t, quiet: true })

    const plan: Plan = { id, title: manifest ? t('installer.plan.install', { name: manifest.name }) : t('installer.plan.clean'), mode: 'atomic', ops }
    const res = await this.runPlan(plan, [...Object.values(roots), ...Object.values(active?.roots ?? {})], report)
    if (!res.ok) {
      await fs.rm(lib.packDir(capId), { recursive: true, force: true }).catch(() => undefined)
      await this.setState(pushHistory(this.state, { action: manifest ? 'apply' : 'clean', packName: manifest?.name, ok: false, ...failureSummary(res.error) }))
      throw new Error(planError(res, t('installer.errors.installFailed')))
    }

    // Pack « Ancienne installation » : seulement s'il a reçu des fichiers.
    let captured: string | null = null
    if (capture.files.length) {
      const name = await lib.uniqueName(active ? t('installer.names.manualAdditions') : t('installer.names.previousInstall'))
      captured = (await lib.finalizeCaptured(capId, name, capture.files)).name
    } else await fs.rm(lib.packDir(capId), { recursive: true, force: true }).catch(() => undefined)

    if (oldPack) {
      oldPack.userConfigCount = await lib.countUserConfigs(oldPack.id)
      await this.syncPresetFromGame(oldPack)
      await lib.save(oldPack)
      if (active) await this.autoCover(oldPack.id, active.appliedAt, games)
    }
    if (captured) await this.autoCover(capId, null, games)

    const files: InstalledFile[] = placeIdx.map(({ idx, item }) => ({
      root: item.dest.root,
      path: item.dest.path,
      size: res.results[idx]?.size ?? item.size,
      mtimeMs: res.results[idx]?.mtimeMs ?? 0,
      linked: !!res.results[idx]?.linked,
      source: item.source
    }))
    files.push(...sharing)
    // Dossiers à supprimer au retrait : créés maintenant, ou créés par l'ancien pack et réutilisés.
    const inherited = (active?.createdDirs ?? []).filter((d) => dirKeys.has(destKey(d)))
    const createdDirs = [...mkdirIdx.filter((m) => res.results[m.idx]?.created).map((m) => m.dest), ...inherited]
    if (!manifest) {
      const summary =
        active && captured
          ? msg('installer.history.cleanedBoth', { pack: active.packName, captured })
          : active
            ? msg('installer.history.cleanedRemoved', { pack: active.packName })
            : captured
              ? msg('installer.history.cleanedCaptured', { captured })
              : msg('history.gameRestored')
      await this.setState(pushHistory({ ...this.state, active: null, mods: modsAfter() }, { action: 'clean', ok: true, msg: summary }))
      return { installed: 0, captured, removed: active?.packName ?? null }
    }
    const next: ActiveInstall = {
      id,
      packId: manifest.id,
      packName: manifest.name,
      appliedAt: new Date().toISOString(),
      roots,
      files,
      createdDirs,
      originals: [...kept, ...replaced],
      partial: false
    }
    await this.setState(pushHistory({ ...this.state, active: next, mods: modsAfter() }, { action: 'apply', packName: manifest.name, ok: true, msg: countMsg('history.files', files.length) }))

    if (manifest.reshadeVersion && versionAtLeast(parseVersion(manifest.reshadeVersion), [5]) && games.fivem.path) {
      await ensureReshadeAck(games.fivem.path).catch((e) => log.warn(`CitizenFX.ini non modifié : ${(e as Error).message}`))
    }
    return { installed: files.length, captured, removed: active?.packName ?? null }
  }

  // -------------------------------------------------------------------------
  // Retrait

  async removeActive(report: Report): Promise<{ removed: number }> {
    const active = this.state.active
    if (!active) return { removed: 0 }
    await this.assertGameClosed()
    const lib = this.ctx.library()
    const pack = await lib.get(active.packId).catch(() => null)
    const ops: Op[] = []
    const fileOps: { file: InstalledFile; idx: number }[] = []

    const updated = new Set<string>()
    // Fichiers qu'une autre instance utilise aussi (même pack, GTA V commun) : laissés en place.
    const stillUsed = await this.sharedFiles(active.roots)
    for (const f of [...active.files].sort((a, b) => b.path.localeCompare(a.path))) {
      if (stillUsed.has(destKey(f))) continue
      const target = abs(active.roots[f.root], f.path)
      const st = await fs.stat(target).catch(() => null)
      if (!st) continue
      const modified = st.size !== f.size || Math.abs(st.mtimeMs - f.mtimeMs) > 1
      // Fichier du jeu remplacé depuis l'installation (mise à jour du jeu) : c'est le nouvel original, laissé en place.
      if (modified && isGameFile(f)) {
        updated.add(destKey(f))
        continue
      }
      // Fichier modifié en jeu (preset ReShade...) : gardé dans le pack pour la prochaine fois.
      if (modified && pack) await this.keepUserFile(pack, { root: f.root, path: f.path }, target, st.size, ops)
      ops.push({ t: 'remove', path: target })
      fileOps.push({ file: f, idx: ops.length - 1 })
    }
    // Fichiers d'origine du jeu remis en place (celui qu'une mise à jour du jeu a rendu obsolète est jeté).
    const restoreOps: { original: Destination; idx: number }[] = []
    for (const o of active.originals ?? []) {
      const from = originalFile(active.roots[o.root], o.path)
      if (!(await exists(from))) {
        log.warn(`Fichier d'origine introuvable dans ${ORIGINALS_DIR}, non remis en place : ${o.path}`)
        continue
      }
      ops.push(updated.has(destKey(o)) ? { t: 'remove', path: from } : { t: 'unstash', from, to: abs(active.roots[o.root], o.path), size: 0 })
      restoreOps.push({ original: o, idx: ops.length - 1 })
    }
    for (const d of [...active.createdDirs].sort((a, b) => b.path.split('/').length - a.path.split('/').length || b.path.localeCompare(a.path)))
      ops.push({ t: 'rmdirIfEmpty', path: abs(active.roots[d.root], d.path) })
    ops.push(...originalsCleanup(restoreOps.map((r) => r.original), active.roots))

    const plan: Plan = { id: newId('rm-'), title: t('installer.plan.remove', { name: active.packName }), mode: 'best-effort', ops }
    const res = ops.length ? await this.runPlan(plan, Object.values(active.roots), report) : { ok: true, results: [], rolledBack: false }
    const failed = fileOps.filter((fo) => !res.results[fo.idx]?.ok).map((fo) => fo.file)
    const notRestored = restoreOps.filter((r) => !res.results[r.idx]?.ok).map((r) => r.original)
    if (pack) {
      pack.userConfigCount = await lib.countUserConfigs(pack.id)
      await this.syncPresetFromGame(pack)
      await lib.save(pack)
      await this.autoCover(pack.id, active.appliedAt, await this.ctx.detectGames())
    }
    const nextActive: ActiveInstall | null = failed.length || notRestored.length ? { ...active, files: failed, originals: notRestored, partial: true } : null
    // Pack retiré : les fichiers qu'il avait laissés aux mods ne reviendront pas.
    const mods = nextActive ? this.mods : this.mods.map((m) => ({ ...m, shadowed: m.shadowed.filter((s) => s.packId !== active.packId) }))
    await this.setState(
      pushHistory({ ...this.state, active: nextActive, mods }, { action: 'remove', packName: active.packName, ok: !nextActive, ...(nextActive ? { summary: res.error ?? '' } : { msg: msg('history.removed') }) })
    )
    if (failed.length) throw new Error(t('installer.errors.removeFailed', { count: failed.length }))
    if (notRestored.length) throw new Error(t('installer.errors.originalsFailed', { count: notRestored.length }))
    return { removed: fileOps.length }
  }

  /** Liste des éléments installés à la main (hors pack actif), captures d'écran et journaux compris. */
  async scanForeign(): Promise<ForeignItem[]> {
    const games = await this.ctx.detectGames()
    return scanForeign(games, this.state.active, await this.knownMods(games))
  }

  /**
   * Range des mods installés à la main dans un pack « Ancienne installation » : ils quittent le jeu
   * mais restent réinstallables en un clic. Sans sélection : tous les mods reconnus.
   */
  async stashForeign(report: Report, selection?: { root: RootId; path: string; isDir: boolean }[]): Promise<{ captured: string | null }> {
    await this.assertGameClosed()
    const lib = this.ctx.library()
    const games = await this.ctx.detectGames()
    const roots: Record<RootId, string> = { fivem: games.fivem.path ?? '', gta: games.gta.path ?? '' }
    const collection = await collectForeign(games, this.state.active, selection, await this.knownMods(games))
    if (!collection.files.length) return { captured: null }
    const capId = lib.newCapturedId(PREVIOUS_INSTALL_NAME)
    const { ops, files } = this.captureOps(capId, roots, collection, [])
    const res = await this.runPlan({ id: capId, title: t('installer.plan.removeMods'), mode: 'atomic', ops }, Object.values(roots), report)
    if (!res.ok) {
      await fs.rm(lib.packDir(capId), { recursive: true, force: true }).catch(() => undefined)
      throw new Error(res.error ?? t('installer.failed'))
    }
    const name = await lib.uniqueName(this.state.active ? t('installer.names.manualAdditions') : t('installer.names.previousInstall'))
    await lib.finalizeCaptured(capId, name, files)
    await this.autoCover(capId, null, games)
    await this.setState(pushHistory(this.state, { action: 'capture', packName: name, ok: true, msg: countMsg('history.captured', files.length) }))
    return { captured: name }
  }

  /**
   * Fait pointer ReShade.ini sur le preset choisi pour ce pack. Le fichier installé est une copie générée
   * (dossier generated/ du pack) : le contenu d'origine du pack n'est jamais modifié. Si le pack fournit ReShade
   * sans ReShade.ini, un fichier minimal est créé.
   */
  private async withPreset(manifest: StoredManifest, items: InstallItem[], roots: Record<RootId, string>): Promise<InstallItem[]> {
    if (!manifest.reshadePreset) return items
    const lib = this.ctx.library()
    const presetDest = resolveInstallMap(manifest.components).find((m) => m.rel === manifest.reshadePreset)?.dest
    if (!presetDest || presetDest.root !== 'fivem' || !/^plugins\//i.test(presetDest.path)) return items
    const value = presetIniValue(presetDest.path)
    const idx = items.findIndex((i) => i.dest.root === 'fivem' && i.dest.path.toLowerCase() === RESHADE_INI_DEST)
    let content: string
    if (idx >= 0) {
      // Réinstallation du même pack : le réglage personnel n'est copié qu'au cours de l'opération, on lit donc le fichier en place.
      content = (await this.readItem(items[idx])) ?? (await fs.readFile(abs(roots.fivem, items[idx].dest.path), 'utf8').catch(() => null)) ?? ''
    } else if (manifest.reshadeVersion) {
      const saved = await lib.readUserFile(manifest, { root: 'fivem', path: 'plugins/ReShade.ini' })
      content = saved?.toString('utf8') ?? defaultReshadeIni(value)
    } else return items
    let next = iniSet(content, 'GENERAL', 'PresetPath', value)
    next = iniSet(next, 'GENERAL', 'StartupPresetPath', value)
    if (idx >= 0 && next === content) return items
    const generated = await lib.writeGenerated(manifest, 'ReShade.ini', Buffer.from(next, 'utf8'))
    const item: InstallItem = {
      ...generated,
      dest: { root: 'fivem', path: idx >= 0 ? items[idx].dest.path : 'plugins/ReShade.ini' },
      fromUser: true
    }
    return idx >= 0 ? items.map((it, i) => (i === idx ? item : it)) : [...items, item]
  }

  /** Contenu d'un fichier à installer ({@link encoding} : utf8 par défaut) ; null s'il est illisible. */
  private async readItem(it: InstallItem, encoding: BufferEncoding = 'utf8'): Promise<string | null> {
    return readSource(it)
      .then((b) => b.toString(encoding))
      .catch(() => null)
  }

  /**
   * QuantV (QuantV.addon) fait charger à ReShade QuantV.preset.ini au lieu du preset désigné par ReShade.ini : ce
   * fichier reçoit donc le preset choisi pour le pack, avec les effets et réglages QuantV qui lui manqueraient. Les
   * retouches faites en jeu sur cette copie sont gardées tant que le preset choisi reste le même.
   */
  private async withQuantvPreset(manifest: StoredManifest, items: InstallItem[], pack: PackContent): Promise<InstallItem[]> {
    const isFivem = (it: InstallItem, dest: string): boolean => it.dest.root === 'fivem' && it.dest.path.toLowerCase() === dest
    if (!manifest.reshadePreset || !items.some((it) => isFivem(it, QUANTV_ADDON_DEST))) return items
    const map = resolveInstallMap(manifest.components)
    const presetDest = map.find((m) => m.rel === manifest.reshadePreset)?.dest
    if (!presetDest || presetDest.root !== 'fivem' || presetDest.path.toLowerCase() === QUANTV_PRESET_DEST) return items
    const idx = items.findIndex((it) => isFivem(it, QUANTV_PRESET_DEST))
    if (idx >= 0 && items[idx].fromUser && manifest.quantvPresetFrom === manifest.reshadePreset) return items
    const presetItem = items.find((it) => isFivem(it, presetDest.path.toLowerCase()))
    const preset = presetItem ? await this.readItem(presetItem) : null
    if (preset === null) return items
    // Réglages QuantV fournis par le pack lui-même (et non une copie générée ou retouchée auparavant).
    const lib = this.ctx.library()
    const packQuantv = map.find((m) => m.dest.root === 'fivem' && m.dest.path.toLowerCase() === QUANTV_PRESET_DEST)
    const quantvBase = packQuantv ? ((await pack.read(packQuantv.rel))?.toString('utf8') ?? null) : null
    const content = mergeQuantvPreset(preset, quantvBase)
    const generated = await lib.writeGenerated(manifest, 'QuantV.preset.ini', Buffer.from(content, 'utf8'))
    if (manifest.quantvPresetFrom !== manifest.reshadePreset) {
      manifest.quantvPresetFrom = manifest.reshadePreset
      await lib.save(manifest)
    }
    log.info(`Preset QuantV de ${manifest.name} : ${path.posix.basename(manifest.reshadePreset)}`)
    const item: InstallItem = {
      ...generated,
      dest: { root: 'fivem', path: idx >= 0 ? items[idx].dest.path : 'plugins/QuantV.preset.ini' },
      fromUser: true
    }
    return idx >= 0 ? items.map((it, i) => (i === idx ? item : it)) : [...items, item]
  }

  /**
   * enblocal.ini du pack avec la limite d'images par seconde choisie dans l'application. Sans limite choisie (« celle
   * du pack »), le fichier d'origine reste tel quel, et une copie retouchée en jeu reprend la limite d'origine du pack.
   */
  private async withFpsLimit(manifest: StoredManifest, items: InstallItem[], pack: PackContent): Promise<InstallItem[]> {
    const limit = this.ctx.fpsLimit?.() ?? null
    const targets = items.filter((it) => isEnbLocal(it.dest.path) && (limit !== null || it.fromUser))
    if (!targets.length) return items
    const lib = this.ctx.library()
    const map = resolveInstallMap(manifest.components)
    const out: InstallItem[] = []
    for (const it of items) {
      // latin1 : les octets du fichier sont gardés tels quels, quel que soit son encodage.
      const content = targets.includes(it) ? await this.readItem(it, 'latin1') : null
      let next: string | null = null
      if (content !== null && limit !== null) next = withEnbFpsLimit(content, limit)
      else if (content !== null) {
        const rel = map.find((m) => destKey(m.dest) === destKey(it.dest))?.rel
        const original = rel ? ((await pack.read(rel))?.toString('latin1') ?? null) : null
        if (original !== null) next = withPackFpsLimit(content, original)
      }
      if (next === null || next === content) {
        out.push(it)
        continue
      }
      const generated = await lib.writeGenerated(manifest, `fps/${it.dest.root}/${it.dest.path}`, Buffer.from(next, 'latin1'))
      out.push({ ...it, ...generated, fromUser: true })
    }
    log.info(`Limite d'images par seconde de ${manifest.name} : ${limit === null ? 'celle du pack' : limit > 0 ? limit : 'aucune'}`)
    return out
  }

  /**
   * Limite d'images par seconde changée alors qu'un pack est installé : ses enblocal.ini sont remplacés tout de suite.
   * Les retouches faites en jeu sur ces fichiers sont d'abord gardées dans les réglages du pack. Renvoie le nombre de
   * fichiers mis à jour (0 : aucun pack installé, ou pack sans ENB).
   */
  async applyFpsLimit(report: Report): Promise<number> {
    const active = this.state.active
    const targets = active?.files.filter((f) => isEnbLocal(f.path)) ?? []
    if (!active || !targets.length) return 0
    const lib = this.ctx.library()
    const manifest = await lib.get(active.packId).catch(() => null)
    if (!manifest) return 0
    await this.assertGameClosed()

    let kept = 0
    for (const f of targets) {
      const target = abs(active.roots[f.root], f.path)
      const st = await fs.stat(target).catch(() => null)
      if (!st || (st.size === f.size && Math.abs(st.mtimeMs - f.mtimeMs) <= 1)) continue
      const dest = { root: f.root, path: f.path }
      if (manifest.protection) await lib.sealUserFile(manifest, dest, target)
      else {
        const user = lib.userFile(manifest.id, dest)
        await fs.mkdir(path.dirname(user), { recursive: true })
        await fs.copyFile(target, user)
      }
      kept++
    }
    if (kept) {
      manifest.userConfigCount = await lib.countUserConfigs(manifest.id)
      await lib.save(manifest)
    }

    const keys = new Set(targets.map((f) => destKey(f)))
    const content = await lib.content(manifest)
    const items = (await this.withFpsLimit(manifest, await this.installItems(manifest, content), content)).filter((it) => keys.has(destKey(it.dest)))
    const id = newId('fps-')
    const ops: Op[] = []
    const trashDirs = new Set<string>()
    const placeIdx: { idx: number; item: InstallItem }[] = []
    for (const it of items) {
      const rp = active.roots[it.dest.root]
      const trash = path.join(rp, `${TRASH_PREFIX}${id}`)
      trashDirs.add(trash)
      ops.push({ t: 'stash', path: abs(rp, it.dest.path), to: abs(trash, it.dest.path), size: 0 })
      ops.push(this.placeOp(it, rp))
      placeIdx.push({ idx: ops.length - 1, item: it })
    }
    for (const t of trashDirs) ops.push({ t: 'rmTree', path: t, quiet: true })
    const res = await this.runPlan({ id, title: t('installer.plan.fpsLimit'), mode: 'atomic', ops }, Object.values(active.roots), report)
    if (!res.ok) throw new Error(planError(res, t('installer.errors.fpsFailed')))

    // Fichiers installés mis à jour : ils ne passent pas pour des réglages modifiés en jeu.
    const placed = new Map(
      placeIdx.map(({ idx, item }) => [
        destKey(item.dest),
        { size: res.results[idx]?.size ?? item.size, mtimeMs: res.results[idx]?.mtimeMs ?? 0, linked: !!res.results[idx]?.linked, source: item.source }
      ])
    )
    const files = active.files.map((f) => ({ ...f, ...placed.get(destKey(f)) }))
    await this.setState({ ...this.state, active: { ...active, files } })
    return placed.size
  }

  /** Preset choisi dans le menu de ReShade en jeu : retenu pour les prochaines installations du pack. */
  private async syncPresetFromGame(pack: StoredManifest): Promise<void> {
    const lib = this.ctx.library()
    const saved = (await lib.readUserFile(pack, { root: 'fivem', path: 'plugins/ReShade.ini' }))?.toString('utf8')
    if (!saved) return
    const target = presetDestFromIni(iniGet(saved, 'PresetPath'))?.toLowerCase()
    const map = resolveInstallMap(pack.components)
    const match = (pack.reshadePresets ?? []).find((p) => map.find((m) => m.rel === p)?.dest.path.toLowerCase() === target)
    if (match && match !== pack.reshadePreset) {
      pack.reshadePreset = match
      log.info(`Preset ReShade de ${pack.name} : ${path.posix.basename(match)} (choisi en jeu)`)
    }
  }

  /**
   * Un pack sans image reçoit la capture d'écran ReShade la plus récente prise pendant qu'il était installé
   * (depuis « since »), ou la plus récente tout court pour une ancienne installation.
   */
  private async autoCover(packId: string, since: string | null, games: GamesInfo): Promise<void> {
    try {
      const save = this.ctx.saveCover
      const lib = this.ctx.library()
      const m = await lib.get(packId).catch(() => null)
      if (!save || !m || m.cover || m.gallery.length || !games.fivem.path) return
      const from = since ? Date.parse(since) : 0
      const shots: { file: string; t: number }[] = []
      for (const s of await scanForeign(games, this.state.active, this.mods)) {
        if (s.category !== 'screenshot' || s.isDir) continue
        const file = abs(games.fivem.path, s.path)
        const st = await fs.stat(file).catch(() => null)
        if (st && st.mtimeMs >= from) shots.push({ file, t: st.mtimeMs })
      }
      // La plus récente d'abord ; une image illisible est ignorée au profit de la suivante.
      for (const s of shots.sort((a, b) => b.t - a.t).slice(0, 5)) {
        const name = await save(s.file, lib.packDir(m.id))
        if (name) {
          await lib.setCover(m.id, name)
          return
        }
      }
    } catch (err) {
      log.warn(`Image automatique non définie : ${(err as Error).message}`)
    }
  }

  // -------------------------------------------------------------------------
  // Mods

  private modLib(): Library {
    const lib = this.ctx.modLibrary?.()
    if (!lib) throw new Error(t('installer.errors.modLibraryUnavailable'))
    return lib
  }

  /** Fichiers posés par les mods activés (hors {@link except}) : destination → mod. */
  private modHolders(except: Set<string> = new Set()): Map<string, InstalledMod> {
    const out = new Map<string, InstalledMod>()
    for (const m of this.mods) if (m.enabled && !except.has(m.id)) for (const f of m.files) out.set(destKey(f), m)
    return out
  }

  private async modItems(m: StoredManifest): Promise<InstallItem[]> {
    const lib = this.modLib()
    return this.installItems(m, await lib.content(m), lib)
  }

  /** Raisons d'empêcher l'activation d'un mod : celles d'un pack, et un mod ne s'installe que dans FiveM.app. */
  private async modBlockers(items: InstallItem[], games: GamesInfo): Promise<string[]> {
    const out: string[] = []
    if (!items.length) out.push(t('installer.errors.modEmpty'))
    if (games.runningProcesses.length) out.push(t('installer.errors.gameRunning'))
    if (!games.fivem.valid || !games.fivem.path) out.push(t('installer.errors.fivemMissing'))
    if (games.gta.edition === 'enhanced') out.push(t('installer.errors.enhancedMod'))
    if (items.some((i) => i.dest.root !== 'fivem' || !isAllowedFiveMPath(i.dest.path)))
      out.push(t('installer.errors.modOutsideFolders'))
    if (out.length) return out
    const rp = games.fivem.path as string
    const bytes = items.filter((it) => !this.canLink(it, rp)).reduce((s, it) => s + it.size, 0)
    const free = bytes ? await freeSpace(rp) : null
    if (free !== null && free < bytes + 200 * 1024 * 1024) out.push(t('installer.errors.noSpace', { size: formatBytes(bytes) }))
    return out
  }

  /** Fichiers déjà présents dans le jeu que l'application ne connaît pas (installés à la main). */
  private async foreignHits(items: InstallItem[], roots: Record<RootId, string>, known: Set<string>): Promise<string[]> {
    const out: string[] = []
    for (const it of items) {
      if (known.has(destKey(it.dest))) continue
      if (await fs.lstat(abs(roots[it.dest.root], it.dest.path)).catch(() => null)) out.push(it.dest.path)
    }
    return out
  }

  /** Ce que changerait l'activation d'un mod (rien n'est modifié). */
  async modPreflight(modId: string): Promise<ModPreflight> {
    const m = await this.modLib().get(modId)
    const games = await this.ctx.detectGames()
    const items = await this.modItems(m)
    const blockers = await this.modBlockers(items, games)
    const keys = new Set(items.map((it) => destKey(it.dest)))
    const conflicts = new Map<string, { id: string; name: string; files: string[] }>()
    const holders = this.modHolders(new Set([modId]))
    for (const it of items) {
      const other = holders.get(destKey(it.dest))
      if (!other) continue
      const c = conflicts.get(other.id) ?? { id: other.id, name: other.name, files: [] }
      c.files.push(it.dest.path)
      conflicts.set(other.id, c)
    }
    const active = this.state.active
    const packFiles = (active?.files ?? []).filter((f) => keys.has(destKey(f))).map((f) => f.path)
    if (!blockers.length) {
      const roots: Record<RootId, string> = { fivem: games.fivem.path ?? '', gta: games.gta.path ?? '' }
      const known = new Set([...holders.keys(), ...(active?.files ?? []).map(destKey), ...(this.mods.find((x) => x.id === modId)?.files ?? []).map(destKey)])
      const foreign = await this.foreignHits(items, roots, known)
      if (foreign.length) blockers.push(foreignMessage(foreign))
    }
    return { blockers, conflicts: [...conflicts.values()], pack: packFiles.length && active ? { name: active.packName, files: packFiles } : null }
  }

  /** Active (en désactivant au passage les mods de {@link disable}) ou désactive un mod. */
  async setModEnabled(modId: string, enabled: boolean, report: Report, disable: string[] = []): Promise<{ name: string; enabled: boolean }> {
    await this.assertGameClosed()
    const entry = this.mods.find((m) => m.id === modId)
    if (!enabled) {
      if (entry?.enabled) await this.changeMods({ remove: [entry], add: [] }, report, msg('modDisable', { name: entry.name }))
      return { name: entry?.name ?? modId, enabled: false }
    }
    const m = await this.modLib().get(modId)
    if (entry?.enabled) return { name: m.name, enabled: true }
    const remove = this.mods.filter((x) => x.enabled && disable.includes(x.id))
    await this.changeMods({ remove, add: [m] }, report, msg('modEnable', { name: m.name }))
    return { name: m.name, enabled: true }
  }

  /** Désactive tous les mods activés en une seule opération (serveurs en mode pur) : le pack actif reste en place. */
  async disableAllMods(report: Report): Promise<{ disabled: number }> {
    await this.assertGameClosed()
    const enabled = this.mods.filter((m) => m.enabled)
    if (enabled.length) await this.changeMods({ remove: enabled, add: [] }, report, msg('modDisableAll'))
    return { disabled: enabled.length }
  }

  /**
   * Nouvelle version d'un mod (déjà dans la bibliothèque des mods) : si l'ancienne était activée, ses fichiers sont
   * remplacés en une seule opération et la nouvelle reste activée. L'ancienne quitte l'état (sa suppression de la
   * bibliothèque revient à l'appelant).
   */
  async replaceMod(oldId: string, next: StoredManifest, report: Report): Promise<boolean> {
    const entry = this.mods.find((m) => m.id === oldId)
    const enabled = !!entry?.enabled
    if (entry?.enabled) await this.changeMods({ remove: [entry], add: [next] }, report, msg('modUpdate', { name: next.name }))
    await this.setState({ ...this.state, mods: this.mods.filter((m) => m.id !== oldId) })
    return enabled
  }

  /** Retire le mod du jeu s'il est activé, puis l'oublie (sa suppression de la bibliothèque revient à l'appelant). */
  async forgetMod(modId: string, report: Report): Promise<void> {
    const entry = this.mods.find((m) => m.id === modId)
    if (entry?.enabled) {
      await this.assertGameClosed()
      await this.changeMods({ remove: [entry], add: [] }, report, msg('remove', { name: entry.name }))
    }
    if (this.mods.some((m) => m.id === modId)) await this.setState({ ...this.state, mods: this.mods.filter((m) => m.id !== modId) })
  }

  /**
   * Retire des mods du jeu et en installe d'autres en une seule opération atomique. Au moindre échec, tout est remis
   * en place. Un mod n'écrase jamais le fichier d'un autre mod activé, ni un fichier installé à la main ; il peut
   * remplacer un fichier du pack actif, noté dans `shadowed` et réinstallé depuis le pack quand plus aucun mod ne le
   * remplace. {@link titleMsg} : titre de l'opération (clé sous installer.plan, avec ses paramètres).
   */
  private async changeMods(change: { remove: InstalledMod[]; add: StoredManifest[] }, report: Report, titleMsg: Msg): Promise<void> {
    const titleKey = msg(`installer.plan.${titleMsg.key}`, titleMsg.params)
    const title = tm(titleKey)
    report(t('installer.phase.preparing'), 0, 1)
    const lib = this.modLib()
    const packLib = this.ctx.library()
    const games = await this.ctx.detectGames()
    if (games.runningProcesses.length) throw new Error(t('installer.errors.gameRunning'))
    const roots: Record<RootId, string> = { fivem: games.fivem.path ?? '', gta: games.gta.path ?? '' }
    const active = this.state.active
    const pack = active ? await packLib.get(active.packId).catch(() => null) : null
    const removing = new Set(change.remove.map((m) => m.id))

    const adds: { m: StoredManifest; items: InstallItem[] }[] = []
    for (const m of change.add) adds.push({ m, items: await this.modItems(m) })
    const all = adds.flatMap((a) => a.items)
    if (adds.length) {
      const blockers = await this.modBlockers(all, games)
      if (blockers.length) throw new Error(blockers[0])
    }

    // Conflits : un autre mod activé, ou un fichier installé à la main, au même endroit.
    const holders = this.modHolders(removing)
    const owner = new Map<string, string>()
    for (const { m, items } of adds) {
      for (const it of items) {
        const k = destKey(it.dest)
        const other = holders.get(k)?.name ?? (owner.get(k) !== m.name ? owner.get(k) : undefined)
        if (other) throw new Error(t('installer.errors.modConflict', { name: quote(m.name), other: quote(other), path: it.dest.path }))
        owner.set(k, m.name)
      }
    }
    const activeFiles = new Map((active?.files ?? []).map((f) => [destKey(f), f]))
    const known = new Set([...change.remove.flatMap((r) => r.files.map(destKey)), ...activeFiles.keys()])
    const foreign = await this.foreignHits(all, roots, known)
    if (foreign.length) throw new Error(foreignMessage(foreign))

    const id = newId('mod-')
    const ops: Op[] = []
    const trashDirs = new Set<string>()
    const toTrash = (rp: string, rel: string): void => {
      const trash = path.join(rp, `${TRASH_PREFIX}${id}`)
      trashDirs.add(trash)
      ops.push({ t: 'stash', path: abs(rp, rel), to: abs(trash, rel), size: 0 })
    }

    // 1) Mods retirés : réglages modifiés en jeu gardés dans le mod, fichiers mis de côté.
    const keptMods: StoredManifest[] = []
    for (const r of change.remove) {
      const m = await lib.get(r.id).catch(() => null)
      for (const f of r.files) {
        const target = abs(r.roots[f.root], f.path)
        const st = await fs.stat(target).catch(() => null)
        if (!st) continue
        if (m && isModified(st, f)) {
          await this.keepUserFile(m, f, target, st.size, ops, lib)
          if (!keptMods.includes(m)) keptMods.push(m)
        }
        toTrash(r.roots[f.root], f.path)
      }
    }

    // 2) Fichiers du pack actif : ceux que les mods retirés libèrent, ceux que les nouveaux mods remplacent.
    const released = new Map<string, ShadowedFile>()
    for (const r of change.remove) for (const s of r.shadowed) if (active && s.packId === active.packId) released.set(destKey(s.file), s)
    const shadows = new Map<string, ShadowedFile[]>()
    const pulled = new Set<string>()
    let packKept = false
    for (const { m, items } of adds) {
      const list: ShadowedFile[] = []
      for (const it of items) {
        const k = destKey(it.dest)
        const freed = released.get(k)
        if (freed) {
          // Déjà hors du jeu (mise à jour d'un mod) : reste noté pour la nouvelle version.
          list.push(freed)
          released.delete(k)
          continue
        }
        const pf = activeFiles.get(k)
        if (!pf || !active) continue
        let file = pf
        const target = abs(active.roots[pf.root], pf.path)
        const st = await fs.stat(target).catch(() => null)
        if (st) {
          if (pack && isModified(st, pf)) {
            await this.keepUserFile(pack, pf, target, st.size, ops)
            packKept = true
            file = { ...pf, source: path.relative(packLib.packDir(pack.id), packLib.userFile(pack.id, pf)) }
          }
          toTrash(active.roots[pf.root], pf.path)
        }
        list.push({ packId: active.packId, file })
        pulled.add(k)
      }
      shadows.set(m.id, list)
    }

    // 3) Nouveaux mods : dossiers (du moins profond au plus profond), puis fichiers.
    const dirKeys = parentDirs(all.map((it) => it.dest))
    const mkdirIdx: { idx: number; dest: Destination }[] = []
    for (const d of [...dirKeys.values()].sort(byDepth)) {
      ops.push({ t: 'mkdir', path: abs(roots[d.root], d.path) })
      mkdirIdx.push({ idx: ops.length - 1, dest: d })
    }
    const placeIdx: { idx: number; item: InstallItem; modId: string }[] = []
    for (const { m, items } of adds) {
      for (const it of items) {
        ops.push(this.placeOp(it, roots[it.dest.root]))
        placeIdx.push({ idx: ops.length - 1, item: it, modId: m.id })
      }
    }

    // 4) Fichiers du pack que plus aucun mod ne remplace : réinstallés depuis le pack.
    const restoreIdx: { idx: number; file: InstalledFile }[] = []
    if (active) {
      for (const s of released.values()) {
        const src = pack ? await packLib.installSource(pack, s.file.source) : null
        if (!src) {
          log.warn(`Fichier de ${active.packName} non réinstallé (introuvable dans le pack) : ${s.file.path}`)
          continue
        }
        const item: InstallItem = {
          src: src.src,
          sealed: src.sealed,
          source: s.file.source,
          dest: { root: s.file.root, path: s.file.path },
          size: src.size,
          fromUser: !/^content[\\/]/.test(s.file.source)
        }
        ops.push(this.placeOp(item, active.roots[s.file.root]))
        restoreIdx.push({ idx: ops.length - 1, file: s.file })
      }
    }

    // 5) Nettoyage : dossiers vidés des mods retirés, dossier temporaire (et ceux d'une opération interrompue).
    const rmdirIdx: { idx: number; dest: Destination }[] = []
    for (const r of change.remove) {
      for (const d of [...r.createdDirs].sort((a, b) => byDepth(b, a))) {
        ops.push({ t: 'rmdirIfEmpty', path: abs(r.roots[d.root], d.path) })
        rmdirIdx.push({ idx: ops.length - 1, dest: d })
      }
    }
    const allRoots = [...Object.values(roots), ...change.remove.flatMap((r) => Object.values(r.roots)), ...Object.values(active?.roots ?? {})].filter(Boolean)
    for (const rp of new Set(allRoots))
      for (const e of await fs.readdir(rp).catch(() => [] as string[])) if (e.startsWith(TRASH_PREFIX)) trashDirs.add(path.join(rp, e))
    for (const t of trashDirs) ops.push({ t: 'rmTree', path: t, quiet: true })

    const res = await this.runPlan({ id, title, mode: 'atomic', ops }, allRoots, report)
    const names = [...change.remove.map((r) => r.name), ...change.add.map((m) => m.name)].join(', ')
    if (!res.ok) {
      await this.setState(pushHistory(this.state, { action: 'mod', packName: names, ok: false, ...failureSummary(res.error) }))
      throw new Error(planError(res, t('installer.errors.operationFailed')))
    }

    // État : mods retirés désactivés, nouveaux mods activés avec leurs fichiers, fichiers du pack actif mis à jour.
    const now = new Date().toISOString()
    let mods: InstalledMod[] = this.mods.map((m) => (removing.has(m.id) ? { ...m, enabled: false, appliedAt: null, files: [], createdDirs: [], shadowed: [] } : m))
    const leftDirs = rmdirIdx.filter((x) => res.results[x.idx]?.skipped).map((x) => x.dest)
    for (const { m, items } of adds) {
      const files: InstalledFile[] = placeIdx
        .filter((p) => p.modId === m.id)
        .map(({ idx, item }) => ({
          root: item.dest.root,
          path: item.dest.path,
          size: res.results[idx]?.size ?? item.size,
          mtimeMs: res.results[idx]?.mtimeMs ?? 0,
          linked: !!res.results[idx]?.linked,
          source: item.source
        }))
      const mine = parentDirs(items.map((it) => it.dest))
      const createdDirs = mkdirIdx.filter((x) => res.results[x.idx]?.created && mine.has(destKey(x.dest))).map((x) => x.dest)
      const entry: InstalledMod = { id: m.id, name: m.name, enabled: true, appliedAt: now, roots, files, createdDirs, shadowed: shadows.get(m.id) ?? [] }
      mods = [...mods.filter((x) => x.id !== m.id), entry]
    }
    // Dossier créé par un mod retiré mais encore utilisé par un autre mod : supprimé quand celui-ci sera retiré.
    for (const d of leftDirs) {
      const heir = mods.find((m) => m.enabled && m.files.some((f) => f.root === d.root && f.path.toLowerCase().startsWith(`${d.path.toLowerCase()}/`)))
      if (heir && !heir.createdDirs.some((x) => destKey(x) === destKey(d))) mods = mods.map((m) => (m === heir ? { ...m, createdDirs: [...m.createdDirs, d] } : m))
    }
    let nextActive = active
    if (active && (pulled.size || restoreIdx.length)) {
      const restored = restoreIdx.map(({ idx, file }) => ({
        ...file,
        size: res.results[idx]?.size ?? file.size,
        mtimeMs: res.results[idx]?.mtimeMs ?? 0,
        linked: !!res.results[idx]?.linked
      }))
      nextActive = { ...active, files: [...active.files.filter((f) => !pulled.has(destKey(f))), ...restored] }
    }
    // Titre (clé de installer.plan, imbriquée dans installer.history.mod* : retraduit à l'affichage) et fichiers du pack.
    const counts = { ...titleMsg.params, title: titleMsg.key, pulled: pulled.size, restored: restoreIdx.length }
    const summary =
      pulled.size && restoreIdx.length
        ? msg('installer.history.modBoth', counts)
        : pulled.size
          ? msg('installer.history.modPulled', counts)
          : restoreIdx.length
            ? msg('installer.history.modRestored', counts)
            : titleKey
    await this.setState(pushHistory({ ...this.state, active: nextActive, mods }, { action: 'mod', packName: names, ok: true, msg: summary }))

    for (const m of keptMods) {
      m.userConfigCount = await lib.countUserConfigs(m.id)
      await lib.save(m)
    }
    if (pack && packKept) {
      pack.userConfigCount = await packLib.countUserConfigs(pack.id)
      await packLib.save(pack)
    }
  }

  // -------------------------------------------------------------------------
  // Nettoyage

  private cacheDirs(fivem: string): string[] {
    // game-storage (fichiers du jeu téléchargés) et nui-storage (réglages des interfaces) ne sont jamais touchés.
    return ['cache', 'server-cache', 'server-cache-priv'].map((d) => path.join(fivem, 'data', d))
  }

  async cacheInfo(): Promise<{ size: number } | null> {
    const games = await this.ctx.detectGames()
    if (!games.fivem.valid || !games.fivem.path) return null
    let size = 0
    for (const d of this.cacheDirs(games.fivem.path)) if (await exists(d)) size += (await dirSize(d)).size
    return { size }
  }

  async clearCache(report: Report): Promise<{ freed: number }> {
    await this.assertGameClosed()
    const games = await this.ctx.detectGames()
    if (!games.fivem.valid || !games.fivem.path) throw new Error(t('installer.errors.fivemNotFound'))
    const before = (await this.cacheInfo())?.size ?? 0
    const ops: Op[] = this.cacheDirs(games.fivem.path).map((d) => ({ t: 'rmTree', path: d }))
    const res = await this.runPlan({ id: newId('cc-'), title: t('installer.plan.clearCache'), mode: 'best-effort', ops }, [games.fivem.path], report)
    const summary = res.ok ? { msg: msg('history.cacheFreed', { size: formatBytes(before) }) } : failureSummary(res.error)
    await this.setState(pushHistory(this.state, { action: 'cache', ok: res.ok, ...summary }))
    if (!res.ok) throw new Error(res.error ?? t('installer.failed'))
    return { freed: before }
  }

  /** Déplace les captures d'écran ReShade du dossier plugins vers un dossier d'images. */
  async moveScreenshots(targetDir: string, report: Report): Promise<{ moved: number }> {
    const games = await this.ctx.detectGames()
    if (!games.fivem.valid || !games.fivem.path) throw new Error(t('installer.errors.fivemNotFound'))
    const shots = (await scanForeign(games, this.state.active, this.mods)).filter((i) => i.category === 'screenshot' && !i.isDir)
    if (!shots.length) return { moved: 0 }
    const taken = new Set((await fs.readdir(targetDir).catch(() => [] as string[])).map((n) => n.toLowerCase()))
    const ops: Op[] = []
    for (const s of shots) {
      const file = path.posix.basename(s.path)
      const dot = file.lastIndexOf('.')
      const [stem, extension] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, '']
      let name = file
      for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${stem} (${i})${extension}`
      taken.add(name.toLowerCase())
      ops.push({ t: 'stash', path: abs(games.fivem.path, s.path), to: path.join(targetDir, name), size: 0 })
    }
    const res = await this.runPlan({ id: newId('ss-'), title: t('installer.plan.moveScreenshots'), mode: 'best-effort', ops }, [games.fivem.path], report)
    const moved = res.results.filter((r) => r.ok && !r.skipped).length
    await this.setState(pushHistory(this.state, { action: 'clean', ok: res.ok, msg: countMsg('history.screenshotsMoved', moved) }))
    if (!moved && !res.ok) throw new Error(res.error ?? t('installer.failed'))
    return { moved }
  }
}

/**
 * FiveM refuse ReShade 5+ tant que CitizenFX.ini ne contient pas la ligne d'acceptation propre à ce PC
 * ([Addons] ReShade5=ID:<hash du nom de l'ordinateur> acknowledged...). On l'ajoute (ou la corrige) si besoin.
 * Le fichier est lu et réécrit octet pour octet (latin1) pour ne pas altérer son encodage.
 */
export async function ensureReshadeAck(fivemApp: string): Promise<boolean> {
  const file = path.join(fivemApp, 'CitizenFX.ini')
  const line = reshadeAckLine(process.env.COMPUTERNAME || os.hostname())
  let raw = ''
  try {
    raw = await fs.readFile(file, 'latin1')
  } catch {
    raw = ''
  }
  const lines = raw ? raw.split(/\r?\n/) : []
  if (lines.some((l) => l.trim() === line)) return false
  const eol = raw.includes('\r\n') || !raw ? '\r\n' : '\n'
  const existing = lines.findIndex((l) => /^\s*ReShade5\s*=/i.test(l))
  if (existing >= 0) lines[existing] = line
  else {
    const section = lines.findIndex((l) => /^\s*\[Addons\]\s*$/i.test(l))
    if (section >= 0) lines.splice(section + 1, 0, line)
    else {
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
      lines.push('', '[Addons]', line)
    }
  }
  let out = lines.join(eol)
  if (!out.endsWith(eol)) out += eol
  await fs.writeFile(file, out, 'latin1')
  log.info("Ligne d'acceptation ReShade 5+ ajoutée à CitizenFX.ini")
  return true
}

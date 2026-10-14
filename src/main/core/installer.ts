// Application, bascule et retrait des packs.
//
// Changer de pack est une seule opération atomique :
//   1. les fichiers de l'ancien pack sont déplacés dans un dossier temporaire (sur le même disque, donc instantané) ;
//   2. les mods installés à la main sont déplacés dans un nouveau pack de la bibliothèque (« Ancienne installation ») ;
//   3. les fichiers du nouveau pack sont installés ;
//   4. le dossier temporaire est supprimé.
// Au moindre échec, tout est remis en place. Une seule demande d'autorisation administrateur au plus.
//
// Pack protégé : chaque fichier est déchiffré directement à sa place dans le jeu (opération « unseal ») ; les réglages
// modifiés en jeu et les fichiers générés sont chiffrés dans la bibliothèque. Retiré du jeu, il ne reste de lui aucun
// fichier en clair sur le disque.

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { t } from 'i18next'
import type { ActiveInstall, AppState, Destination, ForeignItem, GamesInfo, InstalledFile, RootId } from '@shared/types'
import { msg, type Msg } from '@shared/i18n'
import { formatBytes, formatNumber } from '@shared/intl'
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
import type { Library, StoredManifest } from './library'
import type { SealedRef } from './sealed'
import { JsonStore, pushHistory } from './stores'
import { canWrite, dirSize, exists, freeSpace, newId, sameVolume } from '../util/fsx'
import { runningGameProcesses } from '../util/win'
import { log } from '../util/log'

export type Report = (phase: string, current: number, total: number, detail?: string) => void

export interface InstallerCtx {
  jobsDir: string
  library: () => Library
  state: JsonStore<AppState>
  detectGames: () => Promise<GamesInfo>
  /** Enregistre une image (réduite) dans le dossier d'un pack ; renvoie son nom de fichier (cover-*.jpg). */
  saveCover?: (src: string, packDir: string) => Promise<string | null>
  /** Limite d'images par seconde choisie dans l'application : null = celle du pack, 0 = aucune limite. */
  fpsLimit?: () => number | null
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

/** Nom français du pack des mods rangés : sert à son identifiant (dossier) ; le nom donné au pack suit la langue. */
export const PREVIOUS_INSTALL_NAME = 'Ancienne installation'

export interface SwitchResult {
  installed: number
  /** Nom du pack « Ancienne installation » créé, s'il y avait des mods installés à la main. */
  captured: string | null
  /** Pack retiré au passage. */
  removed: string | null
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

  private async runPlan(plan: Plan, roots: string[], report: Report): Promise<PlanResult> {
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

  /** Fichiers à installer ; un réglage modifié en jeu (dossier user/) remplace l'original. */
  private async installItems(m: StoredManifest, content: PackContent): Promise<InstallItem[]> {
    const lib = this.ctx.library()
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
    return !it.fromUser && !it.sealed && !CONFIG_EXT.has(ext(it.dest.path)) && sameVolume(it.src, rootPath)
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
  private async keepUserFile(pack: StoredManifest, dest: Destination, from: string, size: number, ops: Op[]): Promise<void> {
    const lib = this.ctx.library()
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
    if (items.some((i) => (i.dest.root === 'gta' && isProtectedGtaPath(i.dest.path)) || (i.dest.root === 'fivem' && !isAllowedFiveMPath(i.dest.path))))
      out.push(t('installer.errors.gameFiles'))
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
    const c = await collectForeign(games ?? (await this.ctx.detectGames()), this.state.active)
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
   */
  async cleanGame(report: Report): Promise<SwitchResult> {
    return this.switchTo(null, report)
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

    // 1) Ancien pack : réglages modifiés conservés, puis fichiers déplacés dans un dossier temporaire.
    const oldPack = active ? await lib.get(active.packId).catch(() => null) : null
    const saved = new Set<string>()
    if (active) {
      for (const f of active.files) {
        const rp = active.roots[f.root]
        const target = abs(rp, f.path)
        const st = await fs.stat(target).catch(() => null)
        if (!st) continue
        const modified = st.size !== f.size || Math.abs(st.mtimeMs - f.mtimeMs) > 1
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

    // 2) Mods installés à la main et fichiers qui seraient écrasés : rangés dans « Ancienne installation ».
    const managed = managedSet(active)
    const collection = await collectForeign(games, active)
    const overwritten: { root: RootId; rel: string; size: number }[] = []
    for (const it of items) {
      if (managed.has(managedKey(it.dest.root, it.dest.path))) continue
      const st = await fs.lstat(abs(roots[it.dest.root], it.dest.path)).catch(() => null)
      if (st && !st.isDirectory()) overwritten.push({ root: it.dest.root, rel: it.dest.path, size: st.size })
    }
    if (!manifest && !active && !collection.files.length) throw new Error(t('installer.errors.alreadyClean'))
    const capId = lib.newCapturedId(PREVIOUS_INSTALL_NAME)
    const capture = this.captureOps(capId, roots, collection, overwritten)
    ops.push(...capture.ops)

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
      await this.setState(pushHistory({ ...this.state, active: null }, { action: 'clean', ok: true, msg: summary }))
      return { installed: 0, captured, removed: active?.packName ?? null }
    }
    const next: ActiveInstall = { id, packId: manifest.id, packName: manifest.name, appliedAt: new Date().toISOString(), roots, files, createdDirs, partial: false }
    await this.setState(pushHistory({ ...this.state, active: next }, { action: 'apply', packName: manifest.name, ok: true, msg: countMsg('history.files', files.length) }))

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

    for (const f of [...active.files].sort((a, b) => b.path.localeCompare(a.path))) {
      const target = abs(active.roots[f.root], f.path)
      const st = await fs.stat(target).catch(() => null)
      if (!st) continue
      // Fichier modifié en jeu (preset ReShade...) : gardé dans le pack pour la prochaine fois.
      if ((st.size !== f.size || Math.abs(st.mtimeMs - f.mtimeMs) > 1) && pack)
        await this.keepUserFile(pack, { root: f.root, path: f.path }, target, st.size, ops)
      ops.push({ t: 'remove', path: target })
      fileOps.push({ file: f, idx: ops.length - 1 })
    }
    for (const d of [...active.createdDirs].sort((a, b) => b.path.split('/').length - a.path.split('/').length || b.path.localeCompare(a.path)))
      ops.push({ t: 'rmdirIfEmpty', path: abs(active.roots[d.root], d.path) })

    const plan: Plan = { id: newId('rm-'), title: t('installer.plan.remove', { name: active.packName }), mode: 'best-effort', ops }
    const res = ops.length ? await this.runPlan(plan, Object.values(active.roots), report) : { ok: true, results: [], rolledBack: false }
    const failed = fileOps.filter((fo) => !res.results[fo.idx]?.ok).map((fo) => fo.file)
    if (pack) {
      pack.userConfigCount = await lib.countUserConfigs(pack.id)
      await this.syncPresetFromGame(pack)
      await lib.save(pack)
      await this.autoCover(pack.id, active.appliedAt, await this.ctx.detectGames())
    }
    const nextActive: ActiveInstall | null = failed.length ? { ...active, files: failed, partial: true } : null
    await this.setState(
      pushHistory({ ...this.state, active: nextActive }, { action: 'remove', packName: active.packName, ok: !failed.length, ...(failed.length ? { summary: res.error ?? '' } : { msg: msg('history.removed') }) })
    )
    if (failed.length) throw new Error(t('installer.errors.removeFailed', { count: failed.length }))
    return { removed: fileOps.length }
  }

  /** Liste des éléments installés à la main (hors pack actif), captures d'écran et journaux compris. */
  async scanForeign(): Promise<ForeignItem[]> {
    return scanForeign(await this.ctx.detectGames(), this.state.active)
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
    const collection = await collectForeign(games, this.state.active, selection)
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
      for (const s of await scanForeign(games, this.state.active)) {
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
    const shots = (await scanForeign(games, this.state.active)).filter((i) => i.category === 'screenshot' && !i.isDir)
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

// Optimisations pour les PC modestes (voir @shared/optimizations) : état lu sur le PC, application et annulation.
//
// Chaque optimisation est une liste de changements (valeur du registre, plan d'alimentation, réglage du jeu...). La
// valeur d'avant de chaque changement est notée dans optimizations.json : « Annuler » la remet, seulement si la valeur
// en place est encore celle écrite par l'application (un réglage modifié depuis par l'utilisateur est laissé tel quel).
// Les changements qui demandent les droits administrateur sont faits ensemble, avec une seule demande UAC.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { t } from 'i18next'
import {
  applyCfg,
  CFG_DEFAULTS,
  cfgMaxChanges,
  directXPref,
  distanceTarget,
  driverAgeDays,
  graphicsChanges,
  graphicsTarget,
  gpuVendor,
  mergeDirectXPrefs,
  OPTIMIZATIONS,
  optimizationDef,
  pagefileOk,
  parseCfg,
  POWER,
  SAMPLING_SCALE,
  scalingChanges,
  scalingValue,
  VEHICLE_TEXTURES,
  type CheckState,
  type GraphicsMachine,
  type OptimizationId,
  type OptimizationsOverview,
  type OptimizationsResult,
  type OptimizationState
} from '@shared/optimizations'
import { formatDate, formatList, formatMegabytes, quote } from '@shared/intl'
import { readJson, writeJsonAtomic } from '../util/fsx'
import { log } from '../util/log'
import type { Hive, OpResult, PageFile, RegData, RegRef, RegValue, SystemOp, SystemProbe } from './winTweaks'

/** Changement fait par une optimisation, avec la valeur d'avant (remise par « Annuler »). */
export type Change =
  | { t: 'reg'; hive: Hive; key: string; name: string; type: 'dword' | 'string'; before: RegData; after: RegData }
  | { t: 'power'; before: string; after: string }
  | { t: 'powermode'; before: string; after: string }
  | { t: 'xml'; key: string; before: string; after: string }
  | { t: 'cfg'; key: string; before: string | null; after: string }
  /** `added` : exclusion ajoutée par l'application (faux : elle existait déjà, « Annuler » la laisse). */
  | { t: 'defender'; path: string; added?: boolean }
  | { t: 'pagefile'; before: { auto: boolean; files: PageFile[] } }
  | { t: 'priority' }

interface Applied {
  at: string
  changes: Change[]
}

interface Saved {
  schema: 1
  applied: Partial<Record<OptimizationId, Applied>>
}

/** Ce que l'application sait du PC et du jeu, en plus de ce que lit PowerShell. */
export interface OptimizerContext {
  /** Dossier FiveM.app (null : FiveM introuvable). */
  fivemApp: () => Promise<string | null>
  /** Dossier de GTA V (null : introuvable). */
  gtaPath: () => Promise<string | null>
  /** Fichier gta5_settings.xml de FiveM (null : pas encore créé). */
  settingsFile: () => Promise<string | null>
  /** Écrit des réglages dans gta5_settings.xml (l'original est sauvegardé avant la première modification). */
  writeSettings: (file: string, changes: Record<string, string>) => Promise<void>
  /** Fichier fivem.cfg (%APPDATA%\CitizenFX\fivem.cfg). */
  cfgFile: string
  /** Carte graphique (classe, mémoire vidéo) et pack installé. */
  machine: () => Promise<{ gpuClass: number | null; vramMb: number | null; pack: { name: string; features: string[] } | null }>
  ramMb: () => number
  /** Numéro de version de Windows (22000 et plus : Windows 11). */
  windowsBuild: () => number
  /** PC portable sur batterie. */
  onBattery: () => boolean
  gameRunning: () => Promise<boolean>
  /** Processus du jeu en cours (noms d'exécutables), pour leur priorité. */
  gameProcesses: () => Promise<string[]>
  setPriority: (exes: string[], priority: 'AboveNormal' | 'Normal') => Promise<void>
  /** Cartes graphiques à ignorer (pilote de base, écrans virtuels). */
  virtualAdapter: (name: string) => boolean
}

/** Lecture et changements du système (PowerShell). */
export interface OptimizerSystem {
  probe: (reg: RegRef[], driveLetters: string[], powerMode: boolean) => Promise<SystemProbe>
  /** `admin` : avec une demande UAC ; null : autorisation refusée. */
  run: (ops: SystemOp[], admin: boolean) => Promise<OpResult[] | null>
}

/** Tout ce qui sert à décider de l'état des optimisations. */
interface Env {
  probe: SystemProbe
  reg: (ref: RegRef) => RegValue | null
  build: number
  ramMb: number
  machine: GraphicsMachine
  packName: string | null
  hybrid: boolean
  fivem: { dir: string; exes: string[] } | null
  settings: { file: string; values: Record<string, string> } | null
  cfg: { text: string; values: Record<string, string> } | null
  gtaPath: string | null
  fivemApp: string | null
}

type Plan = { na: string } | { changes: Change[]; note?: string | null }

const GPU_PREFS = 'Software\\Microsoft\\DirectX\\UserGpuPreferences'
const REG: Record<'gameMode' | 'gameModeAllow' | 'dvr' | 'historical' | 'dxGlobal', RegRef> = {
  gameMode: { hive: 'HKCU', key: 'Software\\Microsoft\\GameBar', name: 'AutoGameModeEnabled' },
  gameModeAllow: { hive: 'HKCU', key: 'Software\\Microsoft\\GameBar', name: 'AllowAutoGameMode' },
  dvr: { hive: 'HKCU', key: 'System\\GameConfigStore', name: 'GameDVR_Enabled' },
  historical: { hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR', name: 'HistoricalCaptureEnabled' },
  dxGlobal: { hive: 'HKCU', key: GPU_PREFS, name: 'DirectXUserGlobalSettings' }
}
const gpuRef = (exe: string): RegRef => ({ hive: 'HKCU', key: GPU_PREFS, name: exe })
const refId = (r: RegRef): string => `${r.hive}\\${r.key}\\${r.name}`.toLowerCase()

/** Plan d'alimentation « Économie d'énergie » (avec Utilisation normale : remplacés par Performances élevées). */
const POWER_SAVER = 'a1841308-3541-4fab-bc81-f71556f20b4a'
/** PC assez puissant pour le budget de textures étendu de FiveM. */
const BUDGET_VRAM_MB = 6144
const BUDGET_RAM_MB = 16 * 1024

/** Programmes de FiveM dont la carte graphique se choisit : FiveM.exe, le jeu (une copie par version) et les pages. */
const FIVEM_PROGRAM = /^FiveM_((b\d+_)?(GTA|Game)Process\.exe|ChromeBrowser(\.exe)?)$/i
/** Processus du jeu, dont la priorité est relevée. */
const GAME_PROCESS = /^FiveM_(b\d+_)?(GTA|Game)Process\.exe$/i

/** Deux valeurs égales (« 1.000000 » et « 1 » le sont). */
function same(a: RegData | string | undefined, b: RegData | string | undefined): boolean {
  if (a === undefined || a === null || b === undefined || b === null) return (a ?? null) === (b ?? null)
  if (a === b) return true
  const x = Number(a)
  const y = Number(b)
  return typeof a !== 'object' && a !== '' && b !== '' && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 1e-6
}

/** Identifiant de ce que touche un changement (deux changements du même réglage n'en font qu'un). */
function target(c: Change): string {
  switch (c.t) {
    case 'reg':
      return `reg:${refId(c)}`
    case 'xml':
    case 'cfg':
      return `${c.t}:${c.key}`
    case 'defender':
      return `defender:${c.path.toLowerCase()}`
    default:
      return c.t
  }
}

/** Changement du système à faire pour un changement (null : fichier du jeu, ou rien à faire sur le système). */
function opOf(c: Change): { op: SystemOp; admin: boolean } | null {
  switch (c.t) {
    case 'reg':
      return { op: { t: 'reg', hive: c.hive, key: c.key, name: c.name, type: c.type, data: c.after }, admin: c.hive === 'HKLM' }
    case 'power':
      return { op: { t: 'power', scheme: c.after }, admin: false }
    case 'powermode':
      return { op: { t: 'powermode', mode: c.after }, admin: false }
    case 'defender':
      return { op: { t: 'defender', add: [c.path], remove: [] }, admin: true }
    case 'pagefile':
      return { op: { t: 'pagefile', auto: true, files: [] }, admin: true }
    default:
      return null
  }
}

const regData = (v: RegValue | null): RegData => v?.data ?? null

export class Optimizer {
  private saved: Saved | null = null
  /** Une seule opération à la fois (lecture comprise : elle suit les changements). */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    /** Changements faits (optimizations.json). */
    private file: string,
    private system: OptimizerSystem,
    private ctx: OptimizerContext
  ) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async load(): Promise<Saved> {
    if (!this.saved) {
      const raw = await readJson<Saved | null>(this.file, null)
      this.saved = raw?.schema === 1 && raw.applied && typeof raw.applied === 'object' ? raw : { schema: 1, applied: {} }
    }
    return this.saved
  }

  private async save(): Promise<void> {
    if (this.saved) await writeJsonAtomic(this.file, this.saved)
  }

  /** Priorité du jeu à relever quand il se lance. */
  async priorityOn(): Promise<boolean> {
    return !!(await this.load()).applied.priority
  }

  overview(): Promise<OptimizationsOverview> {
    return this.serial(async () => {
      const env = await this.env()
      await this.load()
      return { ...this.overviewOf(env), gameRunning: await this.ctx.gameRunning() }
    })
  }

  apply(ids: OptimizationId[]): Promise<OptimizationsResult> {
    return this.serial(() => this.doApply(ids))
  }

  revert(ids: OptimizationId[]): Promise<OptimizationsResult> {
    return this.serial(() => this.doRevert(ids))
  }

  /**
   * Carte graphique dédiée déjà choisie : ajoutée aux programmes de FiveM apparus depuis (nouvelle version du jeu),
   * sans rien demander. Appelé au démarrage.
   */
  heal(): Promise<void> {
    return this.serial(async () => {
      const saved = await this.load()
      if (!saved.applied.gpu) return
      const env = await this.env()
      const plan = this.plan('gpu', env)
      if ('na' in plan || !plan.changes.length) return
      const result = await this.run([{ id: 'gpu', changes: plan.changes }], env, false)
      if (result.done.length) log.info(`Carte graphique dédiée ajoutée à ${plan.changes.length} programme(s) de FiveM`)
    })
  }

  // -------------------------------------------------------------------------
  // Lecture

  private async env(): Promise<Env> {
    const [fivemApp, gtaPath, settingsFile, machine] = await Promise.all([this.ctx.fivemApp(), this.ctx.gtaPath(), this.ctx.settingsFile(), this.ctx.machine()])
    const fivem = fivemApp ? await this.fivemPrograms(fivemApp) : null
    const refs = [...Object.values(REG), ...(fivem?.exes ?? []).map(gpuRef)]
    const letters = [...new Set([gtaPath, fivemApp].map((p) => /^([a-z]):/i.exec(p ?? '')?.[1]?.toUpperCase()).filter((l): l is string => !!l))]
    const build = this.ctx.windowsBuild()
    const [probe, settingsText, cfgText] = await Promise.all([
      this.system.probe(refs, letters, build >= 22000),
      settingsFile ? fs.readFile(settingsFile, 'utf8').catch(() => null) : Promise.resolve(null),
      fs.readFile(this.ctx.cfgFile, 'utf8').catch(() => null)
    ])
    const values = new Map(refs.map((r, i) => [refId(r), probe.reg[i] ?? null]))
    const adapters = probe.drivers.filter((d) => !this.ctx.virtualAdapter(d.name))
    return {
      probe,
      reg: (r) => values.get(refId(r)) ?? null,
      build,
      ramMb: this.ctx.ramMb(),
      machine: { gpuClass: machine.gpuClass, vramMb: machine.vramMb, features: machine.pack?.features ?? [] },
      packName: machine.pack?.name ?? null,
      hybrid: new Set(adapters.map((a) => a.name.toLowerCase())).size >= 2,
      fivem,
      settings: settingsFile && settingsText !== null ? { file: settingsFile, values: parseSettings(settingsText) } : null,
      cfg: cfgText !== null ? { text: cfgText, values: parseCfg(cfgText) } : null,
      gtaPath,
      fivemApp
    }
  }

  /** Dossier d'installation de FiveM et ses programmes (ceux du jeu n'existent qu'après un premier lancement). */
  private async fivemPrograms(fivemApp: string): Promise<{ dir: string; exes: string[] }> {
    const dir = path.dirname(fivemApp)
    const sub = path.join(fivemApp, 'data', 'cache', 'subprocess')
    const names = await fs.readdir(sub).catch(() => [] as string[])
    return { dir, exes: [path.join(dir, 'FiveM.exe'), ...names.filter((n) => FIVEM_PROGRAM.test(n)).sort().map((n) => path.join(sub, n))] }
  }

  private overviewOf(env: Env): OptimizationsOverview {
    const applied = this.saved?.applied ?? {}
    const items = OPTIMIZATIONS.map((d): OptimizationState => {
      const plan = this.plan(d.id, env)
      const undoable = !!applied[d.id]
      if ('na' in plan) return { id: d.id, status: 'na', undoable, note: plan.na }
      const status = plan.changes.length ? (undoable ? 'partial' : 'off') : undoable ? 'on' : 'native'
      return { id: d.id, status, undoable, note: plan.note ?? null }
    })
    return { items, checks: this.checks(env), gameRunning: false }
  }

  // -------------------------------------------------------------------------
  // Ce que fait chaque optimisation sur ce PC

  private plan(id: OptimizationId, env: Env): Plan {
    const recorded = !!this.saved?.applied[id]
    switch (id) {
      case 'graphics': {
        if (!env.settings) return { na: t('optimizations.na.noSettings') }
        const keep = env.packName && (env.machine.features.includes('NVE') || env.machine.features.includes('QuantV'))
        return {
          changes: this.xml(env, graphicsChanges(env.settings.values, graphicsTarget(env.machine))),
          note: keep ? t('optimizations.notes.keptForPack', { pack: quote(env.packName!) }) : null
        }
      }
      case 'distance':
        if (!env.settings) return { na: t('optimizations.na.noSettings') }
        return { changes: this.xml(env, graphicsChanges(env.settings.values, distanceTarget())) }
      case 'scaling': {
        if (!env.settings) return { na: t('optimizations.na.noSettings') }
        const wanted = scalingValue(env.machine)
        return {
          changes: this.xml(env, scalingChanges(env.settings.values, wanted)),
          note: t('optimizations.notes.scaling', { percent: Math.round(SAMPLING_SCALE[wanted] * 100) })
        }
      }
      case 'vehicle-textures':
        if (!env.cfg) return { na: t('optimizations.na.noCfg') }
        return { changes: this.cfg(env, cfgMaxChanges(env.cfg.values, VEHICLE_TEXTURES, CFG_DEFAULTS)) }
      case 'texture-budget': {
        if (!env.cfg) return { na: t('optimizations.na.noCfg') }
        const changes = this.cfg(env, cfgMaxChanges(env.cfg.values, { vid_budgetScale: 0 }, CFG_DEFAULTS))
        // Assez de mémoire : le budget étendu ne pose pas de problème (sauf s'il a déjà été remis ici).
        if (changes.length && !recorded && (env.machine.vramMb ?? 0) >= BUDGET_VRAM_MB && env.ramMb >= BUDGET_RAM_MB) return { na: t('optimizations.na.budgetFine') }
        return { changes }
      }
      case 'nui-gpu':
        if (!env.cfg) return { na: t('optimizations.na.noCfg') }
        return { changes: env.cfg.values.nui_useInProcessGpu === 'false' ? this.cfg(env, { nui_useInProcessGpu: 'true' }) : [] }
      case 'power':
        return this.powerPlan(env, recorded)
      case 'gpu': {
        if (!env.hybrid) return { na: t('optimizations.na.singleGpu') }
        if (!env.fivem) return { na: t('optimizations.na.noFiveM') }
        const changes: Change[] = []
        for (const exe of env.fivem.exes) {
          const current = env.reg(gpuRef(exe))
          const text = current?.type === 'string' ? (current.data as string) : null
          if (directXPref(text, 'GpuPreference') !== '2')
            changes.push({ t: 'reg', ...gpuRef(exe), type: 'string', before: regData(current), after: mergeDirectXPrefs(text, { GpuPreference: '2' }) })
        }
        return { changes }
      }
      case 'game-dvr': {
        const changes: Change[] = []
        const dvr = env.reg(REG.dvr)
        // Absente : enregistrement possible (valeur par défaut 1).
        if (dvr?.data !== 0) changes.push({ t: 'reg', ...REG.dvr, type: 'dword', before: regData(dvr), after: 0 })
        const historical = env.reg(REG.historical)
        if (historical?.data === 1) changes.push({ t: 'reg', ...REG.historical, type: 'dword', before: 1, after: 0 })
        return { changes }
      }
      case 'game-mode': {
        // Absentes : mode jeu activé (valeur par défaut de Windows).
        const changes: Change[] = []
        for (const ref of [REG.gameMode, REG.gameModeAllow]) {
          const v = env.reg(ref)
          if (v?.data === 0) changes.push({ t: 'reg', ...ref, type: 'dword', before: 0, after: 1 })
        }
        return { changes }
      }
      case 'windowed': {
        if (env.build < 22000) return { na: t('optimizations.na.windows11') }
        const current = env.reg(REG.dxGlobal)
        const text = current?.type === 'string' ? (current.data as string) : null
        if (directXPref(text, 'SwapEffectUpgradeEnable') === '1') return { changes: [] }
        return { changes: [{ t: 'reg', ...REG.dxGlobal, type: 'string', before: regData(current), after: mergeDirectXPrefs(text, { SwapEffectUpgradeEnable: '1' }) }] }
      }
      case 'pagefile': {
        const ok = pagefileOk(env.probe.pagefile, env.ramMb)
        if (ok === null) return { na: t('optimizations.na.unknown') }
        if (ok) return { changes: [] }
        const size = env.probe.pagefile.files.reduce((s, f) => s + f.maximum, 0)
        return {
          changes: [{ t: 'pagefile', before: { auto: false, files: env.probe.pagefile.files } }],
          note: size ? t('optimizations.notes.pagefileSmall', { size: formatMegabytes(size) }) : t('optimizations.notes.pagefileNone')
        }
      }
      case 'priority':
        return { changes: recorded ? [] : [{ t: 'priority' }] }
      case 'defender': {
        if (!env.fivem) return { na: t('optimizations.na.noFiveM') }
        const av = env.probe.antivirus
        const defender = av.some((a) => /defender/i.test(a.name) && a.enabled)
        if (!defender) {
          const others = av.filter((a) => a.enabled && !/defender/i.test(a.name)).map((a) => a.name)
          return { na: others.length ? t('optimizations.na.otherAntivirus', { name: formatList(others.map(quote)) }) : t('optimizations.na.noDefender') }
        }
        // Exclusions illisibles sans droits administrateur : celle notée ici fait foi.
        return { changes: recorded ? [] : [{ t: 'defender', path: env.fivem.dir }], note: env.fivem.dir }
      }
    }
  }

  private xml(env: Env, changes: Record<string, string>): Change[] {
    return Object.entries(changes).map(([key, after]) => ({ t: 'xml', key, before: env.settings!.values[key], after }))
  }

  private cfg(env: Env, changes: Record<string, string>): Change[] {
    return Object.entries(changes).map(([key, after]) => ({ t: 'cfg', key, before: env.cfg!.values[key] ?? null, after }))
  }

  /**
   * Plan « Performances élevées » s'il est proposé ; sinon (PC en veille moderne, qui n'ont que le plan Utilisation
   * normale) le mode « Meilleures performances » de Windows 11 sur secteur. Un autre plan choisi sur ce PC (fabricant,
   * Performances optimales) est gardé.
   */
  private powerPlan(env: Env, recorded: boolean): Plan {
    const { active, schemes } = env.probe.power
    if (!active) return { na: t('optimizations.na.unknown') }
    if (schemes.some((s) => s.guid === POWER.high)) {
      if (active === POWER.high) return { changes: [] }
      if (active !== POWER.balanced && active !== POWER_SAVER && !recorded) {
        const name = schemes.find((s) => s.guid === active)?.name
        return { changes: [], note: name ? t('optimizations.notes.customPlan', { name: quote(name) }) : null }
      }
      return { changes: [{ t: 'power', before: active, after: POWER.high }] }
    }
    const mode = env.probe.powerModeAc
    if (mode === null) return { na: t('optimizations.na.powerPlan') }
    return { changes: mode === POWER.bestPerformanceMode ? [] : [{ t: 'powermode', before: mode, after: POWER.bestPerformanceMode }], note: t('optimizations.notes.powerMode') }
  }

  // -------------------------------------------------------------------------
  // Vérifications

  private checks(env: Env): CheckState[] {
    const out: CheckState[] = []
    const p = env.probe
    if (p.battery)
      out.push(
        this.ctx.onBattery()
          ? { id: 'power-source', level: 'warn', detail: t('optimizations.checks.power-source.battery'), link: 'power-settings' }
          : { id: 'power-source', level: 'ok', detail: t('optimizations.checks.power-source.plugged'), link: null }
      )
    const gb = Math.round(env.ramMb / 1024)
    const lowRam = env.ramMb < 12 * 1024
    out.push({ id: 'ram', level: lowRam ? 'warn' : 'ok', detail: t(lowRam ? 'optimizations.checks.ram.low' : 'optimizations.checks.ram.ok', { gb }), link: null })
    if (env.machine.gpuClass === 0 && p.memorySticks === 1) out.push({ id: 'single-channel', level: 'warn', detail: null, link: null })
    // Carte qui fait tourner le jeu : celle qui a le plus de mémoire vidéo.
    const gpu = p.drivers.filter((d) => !this.ctx.virtualAdapter(d.name)).sort((a, b) => (b.memory ?? 0) - (a.memory ?? 0))[0]
    const age = driverAgeDays(gpu?.date ?? null)
    if (gpu && age !== null) {
      const vendor = gpuVendor(gpu.name)
      const old = age > 365
      out.push({
        id: 'driver',
        level: old ? 'warn' : 'ok',
        detail: t(old ? 'optimizations.checks.driver.old' : 'optimizations.checks.driver.recent', { name: gpu.name, date: formatDate(`${gpu.date}T12:00:00Z`) }),
        link: old ? (vendor ? `driver-${vendor}` : 'driver-update') : null
      })
    }
    const hdd = [
      { where: t('optimizations.checks.disk.gta'), dir: env.gtaPath },
      { where: t('optimizations.checks.disk.fivem'), dir: env.fivemApp }
    ].filter((x) => {
      const letter = /^([a-z]):/i.exec(x.dir ?? '')?.[1]?.toUpperCase()
      return letter && p.disks[letter] === 'HDD'
    })
    const known = Object.values(p.disks).some((d) => d === 'SSD' || d === 'HDD')
    if (hdd.length) out.push({ id: 'disk', level: 'warn', detail: t('optimizations.checks.disk.hdd', { what: formatList(hdd.map((h) => h.where)) }), link: null })
    else if (known) out.push({ id: 'disk', level: 'ok', detail: t('optimizations.checks.disk.ssd'), link: null })
    if (p.memoryIntegrity !== null)
      out.push(
        p.memoryIntegrity
          ? { id: 'memory-integrity', level: 'info', detail: t('optimizations.checks.memory-integrity.on'), link: 'core-isolation' }
          : { id: 'memory-integrity', level: 'ok', detail: t('optimizations.checks.memory-integrity.off'), link: null }
      )
    out.push({ id: 'overlays', level: 'info', detail: null, link: 'game-bar' })
    out.push({ id: 'startup', level: 'info', detail: null, link: 'startup-apps' })
    return out
  }

  // -------------------------------------------------------------------------
  // Application et annulation

  private async doApply(ids: OptimizationId[]): Promise<OptimizationsResult> {
    const env = await this.env()
    await this.load()
    const running = await this.ctx.gameRunning()
    const failed: OptimizationsResult['failed'] = []
    const todo: { id: OptimizationId; changes: Change[] }[] = []
    for (const id of new Set(ids)) {
      const plan = this.plan(id, env)
      if ('na' in plan) failed.push({ id, error: plan.na })
      else if (optimizationDef(id).gameClosed && running && plan.changes.length) failed.push({ id, error: t('optimizations.errors.closeGame') })
      else todo.push({ id, changes: plan.changes })
    }
    const result = await this.run(todo, env, running)
    return this.result(result, failed)
  }

  private async doRevert(ids: OptimizationId[]): Promise<OptimizationsResult> {
    const env = await this.env()
    const saved = await this.load()
    const running = await this.ctx.gameRunning()
    const failed: OptimizationsResult['failed'] = []
    const ops: { id: OptimizationId; op: SystemOp; admin: boolean }[] = []
    const xml: Record<string, string> = {}
    const cfg: Record<string, string | null> = {}
    const pending = new Map<OptimizationId, boolean>()
    let stopPriority = false
    for (const id of new Set(ids)) {
      const record = saved.applied[id]
      if (!record) continue
      const files = record.changes.some((c) => (c.t === 'xml' && env.settings && same(env.settings.values[c.key], c.after)) || (c.t === 'cfg' && env.cfg && same(env.cfg.values[c.key], c.after)))
      if (files && running) {
        failed.push({ id, error: t('optimizations.errors.closeGame') })
        continue
      }
      pending.set(id, true)
      for (const c of [...record.changes].reverse()) {
        switch (c.t) {
          case 'reg':
            if (same(regData(env.reg(c)), c.after)) ops.push({ id, op: { t: 'reg', hive: c.hive, key: c.key, name: c.name, type: c.type, data: c.before }, admin: c.hive === 'HKLM' })
            break
          case 'power':
            if (env.probe.power.active === c.after) ops.push({ id, op: { t: 'power', scheme: c.before }, admin: false })
            break
          case 'powermode':
            if (env.probe.powerModeAc === c.after) ops.push({ id, op: { t: 'powermode', mode: c.before }, admin: false })
            break
          case 'xml':
            if (env.settings && same(env.settings.values[c.key], c.after)) xml[c.key] = c.before
            break
          case 'cfg':
            if (env.cfg && same(env.cfg.values[c.key], c.after)) cfg[c.key] = c.before
            break
          case 'defender':
            if (c.added) ops.push({ id, op: { t: 'defender', add: [], remove: [c.path] }, admin: true })
            break
          case 'pagefile':
            if (env.probe.pagefile.auto) ops.push({ id, op: { t: 'pagefile', auto: c.before.auto, files: c.before.files }, admin: true })
            break
          case 'priority':
            stopPriority = true
            break
        }
      }
    }
    let denied = false
    for (const admin of [false, true]) {
      const batch = ops.filter((o) => o.admin === admin)
      if (!batch.length) continue
      const res = await this.system.run(
        batch.map((o) => o.op),
        admin
      )
      if (res === null) denied = true
      batch.forEach((o, i) => {
        if (!res?.[i]?.ok) {
          pending.set(o.id, false)
          if (res) log.warn(`Annulation de ${o.id} : ${res[i]?.error ?? 'échec'}`)
        }
      })
    }
    const fileIds = [...pending.keys()].filter((id) => saved.applied[id]!.changes.some((c) => c.t === 'xml' || c.t === 'cfg'))
    try {
      if (Object.keys(xml).length && env.settings) await this.ctx.writeSettings(env.settings.file, xml)
      if (Object.keys(cfg).length && env.cfg) await this.writeCfg(env.cfg.text, cfg)
    } catch (err) {
      for (const id of fileIds) {
        pending.set(id, false)
        failed.push({ id, error: (err as Error).message })
      }
    }
    if (stopPriority) await this.ctx.setPriority(await this.ctx.gameProcesses(), 'Normal').catch(() => undefined)
    const done: OptimizationId[] = []
    for (const [id, ok] of pending) {
      if (!ok) {
        if (!failed.some((f) => f.id === id)) failed.push({ id, error: denied ? t('executor.errors.elevationDenied') : t('optimizations.errors.failed') })
        continue
      }
      delete saved.applied[id]
      done.push(id)
    }
    await this.save()
    log.info(`Optimisations annulées : ${done.join(', ') || 'aucune'}`)
    return this.result({ done, denied, reboot: done.some((id) => optimizationDef(id).reboot) }, failed)
  }

  /** Fait les changements et les note ; renvoie les optimisations faites. */
  private async run(
    todo: { id: OptimizationId; changes: Change[] }[],
    env: Env,
    running: boolean
  ): Promise<{ done: OptimizationId[]; denied: boolean; reboot: boolean; errors?: { id: OptimizationId; error: string }[] }> {
    const saved = await this.load()
    const ok = new Map<OptimizationId, boolean>(todo.map((x) => [x.id, true]))
    const errors: { id: OptimizationId; error: string }[] = []
    const fail = (id: OptimizationId, error: string): void => {
      if (ok.get(id)) errors.push({ id, error })
      ok.set(id, false)
    }
    // Système : d'abord ce qui se fait sans droits, puis le reste avec une seule demande UAC.
    const ops = todo.flatMap((x) => x.changes.map((change) => ({ id: x.id, change, ...(opOf(change) ?? { op: null, admin: false }) }))).filter((o) => o.op)
    let denied = false
    for (const admin of [false, true]) {
      const batch = ops.filter((o) => o.admin === admin)
      if (!batch.length) continue
      const res = await this.system.run(
        batch.map((o) => o.op!),
        admin
      )
      if (res === null) {
        denied = true
        for (const o of batch) fail(o.id, t('executor.errors.elevationDenied'))
        continue
      }
      batch.forEach((o, i) => {
        const r = res[i]
        if (!r?.ok) return fail(o.id, r?.error || t('optimizations.errors.failed'))
        if (o.change.t === 'defender') o.change.added = !!r.added?.length
      })
    }
    // Fichiers du jeu : tous les réglages en une écriture par fichier.
    const xml = todo.filter((x) => x.changes.some((c) => c.t === 'xml'))
    if (xml.length && env.settings) {
      const values = Object.fromEntries(xml.flatMap((x) => x.changes.flatMap((c) => (c.t === 'xml' ? [[c.key, c.after]] : []))))
      try {
        await this.ctx.writeSettings(env.settings.file, values)
      } catch (err) {
        for (const x of xml) fail(x.id, (err as Error).message)
      }
    }
    const cfg = todo.filter((x) => x.changes.some((c) => c.t === 'cfg'))
    if (cfg.length && env.cfg) {
      const values = Object.fromEntries(cfg.flatMap((x) => x.changes.flatMap((c) => (c.t === 'cfg' ? [[c.key, c.after]] : []))))
      try {
        await this.writeCfg(env.cfg.text, values)
      } catch (err) {
        for (const x of cfg) fail(x.id, (err as Error).message)
      }
    }
    const done: OptimizationId[] = []
    const now = new Date().toISOString()
    for (const x of todo) {
      if (!ok.get(x.id)) continue
      done.push(x.id)
      if (!x.changes.length) continue
      // Déjà changée : la valeur d'avant reste celle notée la première fois.
      const previous = saved.applied[x.id]?.changes ?? []
      const merged = [...previous]
      for (const c of x.changes) {
        const i = merged.findIndex((p) => target(p) === target(c))
        if (i < 0) merged.push(c)
        else merged[i] = { ...c, ...('before' in merged[i] ? { before: (merged[i] as { before: unknown }).before } : {}) } as Change
      }
      saved.applied[x.id] = { at: saved.applied[x.id]?.at ?? now, changes: merged }
    }
    await this.save()
    if (done.includes('priority') && running) await this.ctx.setPriority(await this.ctx.gameProcesses(), 'AboveNormal').catch(() => undefined)
    if (done.length) log.info(`Optimisations appliquées : ${done.join(', ')}`)
    for (const e of errors) log.warn(`Optimisation ${e.id} non appliquée : ${e.error}`)
    return { done, denied, reboot: done.some((id) => optimizationDef(id).reboot && todo.find((x) => x.id === id)!.changes.length > 0), errors }
  }

  private async result(
    r: { done: OptimizationId[]; denied: boolean; reboot: boolean; errors?: { id: OptimizationId; error: string }[] },
    failed: OptimizationsResult['failed']
  ): Promise<OptimizationsResult> {
    const overview = { ...this.overviewOf(await this.env()), gameRunning: await this.ctx.gameRunning() }
    return { overview, done: r.done, failed: [...failed, ...(r.errors ?? [])], denied: r.denied, reboot: r.reboot }
  }

  /** Écrit fivem.cfg (relu juste avant : FiveM fermé, il ne change pas entre-temps). */
  private async writeCfg(text: string, changes: Record<string, string | null>): Promise<void> {
    const next = applyCfg(text, changes)
    if (next === text) return
    const tmp = `${this.ctx.cfgFile}.fpm-tmp`
    try {
      await fs.writeFile(tmp, next, 'utf8')
      await fs.rename(tmp, this.ctx.cfgFile)
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
    }
  }

  /** Processus du jeu parmi ceux en cours. */
  static gameProcesses(running: string[]): string[] {
    return running.filter((n) => GAME_PROCESS.test(n))
  }
}

/** Valeurs de gta5_settings.xml (tous les réglages « <Nom value="..." /> »). */
export function parseSettings(xml: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of xml.matchAll(/<([A-Za-z_]\w*)\s+value="([^"]*)"\s*\/>/g)) if (!(m[1] in out)) out[m[1]] = m[2]
  return out
}

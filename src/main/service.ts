// Service principal : état de l'application, tâches longues, et implémentation de l'API exposée à l'interface.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, Menu, nativeImage, net, safeStorage, shell, systemPreferences } from 'electron'
import type { AppState, GamesInfo, MarketKind, Overview, PackPatch, RootId, Settings, TaskProgress } from '@shared/types'
import type { AccountMe, ProfileInput } from '@shared/types'
import type { AuthorQuery, ComponentFile, ForeignSelection, MarketQuery, MenuItem, PackManagerApi } from '@shared/api'
import { IPC } from '@shared/api'
import i18next, { t } from 'i18next'
import { currentLocale, initI18n, msg, supportedLocale } from '@shared/i18n'
import { formatNumber, quote } from '@shared/intl'
import { detectGames, inspectFiveM, inspectGta, normalizeFiveMPath } from './core/games'
import { Installer, type Report } from './core/installer'
import { FPS_LIMIT_MAX, FPS_LIMIT_MIN } from './core/enb'
import { Account, AVATAR_EXTENSIONS, TokenFile } from './core/account'
import { KeyRing, type SystemProtection } from './core/keys'
import { Library, toPublic, type StoredManifest } from './core/library'
import { GraphicsManager } from './core/graphics'
import { languageFetch } from './core/http'
import { accountLanguageAction, fetchLanguages, startupLocale } from './core/language'
import { Marketplace } from './core/marketplace'
import { AppUpdater } from './core/updater'
import { runningGameProcesses } from './util/win'
import type { GraphicsTarget } from '@shared/graphics'
import { fileDestination } from './core/analyzer'
import { defaultSettings, emptyState, JsonStore, normalizeState, pushHistory } from './core/stores'
import { exists, isInside, moveDir, readJson, writeJsonAtomic } from './util/fsx'
import { log } from './util/log'

type ServerApi = Omit<PackManagerApi, 'onTask' | 'onChanged' | 'onUpdate' | 'onAccount' | 'onLanguage' | 'onOpenMarketPack' | 'getPathForFile'>

const MARKET_REFRESH = 6 * 60 * 60 * 1000
/** Bibliothèque des mods : sous-dossier de la bibliothèque des packs (ignoré par celle-ci, comme tout dossier « . »). */
const modsDir = (libraryDir: string): string => path.join(libraryDir, '.mods')
/** Requêtes vers l'API, avec la langue affichée (Accept-Language). */
const apiFetch = languageFetch((url, init) => net.fetch(url, init))

/** Dernière détection des jeux, enregistrée pour le démarrage suivant. */
interface SavedGames {
  /** Version de l'application qui l'a écrite : le format de GamesInfo peut changer d'une version à l'autre. */
  version: string
  fivemPath: string | null
  gtaPath: string | null
  games: GamesInfo
}

/** Chiffrement de Windows (DPAPI) pour le compte de l'utilisateur. */
const systemProtection: SystemProtection = {
  available: () => safeStorage.isEncryptionAvailable(),
  protect: (data) => safeStorage.encryptString(data.toString('base64')),
  unprotect: (data) => Buffer.from(safeStorage.decryptString(data), 'base64')
}

export class Service {
  settings: JsonStore<Settings>
  state: JsonStore<AppState>
  library!: Library
  /** Bibliothèque des mods (leur état dans le jeu : state.mods). */
  modLibrary!: Library
  installer!: Installer
  graphics: GraphicsManager
  marketplace!: Marketplace
  updater: AppUpdater
  private gamesCache: GamesInfo | null = null
  /** Détection des jeux lancée au démarrage (null en cas d'échec). */
  private firstDetection: Promise<GamesInfo | null> = Promise.resolve(null)
  private foreign: Promise<Overview['foreign']> | null = null
  private running: { id: string; abort: AbortController } | null = null
  /** Clés des packs protégés : clé locale gardée chiffrée par Windows (DPAPI), clés des paquets remises par l'API. */
  private keys: KeyRing
  /** Compte reflect-fivem.com (facultatif) : jeton gardé chiffré par Windows. */
  account: Account
  /** Compte connecté au dernier changement (une connexion se reconnaît à un compte différent). */
  private accountId: number | null = null

  constructor(
    public dataDir: string,
    private getWindow: () => BrowserWindow | null,
    public apiUrl: string
  ) {
    this.keys = new KeyRing(path.join(dataDir, 'protection.key'), systemProtection, (marketId, kind) => this.marketplace.packageKey(marketId, kind))
    this.account = new Account({
      apiUrl,
      store: new TokenFile(path.join(dataDir, 'account.dat'), systemProtection),
      fetch: apiFetch,
      openExternal: (url) => shell.openExternal(url),
      onChange: (me) => {
        this.emit(IPC.account, me)
        this.accountLanguage(me)
      }
    })
    this.settings = new JsonStore(path.join(dataDir, 'settings.json'), defaultSettings(dataDir))
    this.state = new JsonStore(path.join(dataDir, 'state.json'), emptyState())
    this.graphics = new GraphicsManager(path.join(dataDir, 'Graphismes'))
    this.updater = new AppUpdater(apiUrl, (s) => this.emit(IPC.update, s))
  }

  private async graphicsTarget(id?: GraphicsTarget['id']): Promise<{ target: GraphicsTarget; targets: GraphicsTarget[] } | null> {
    const targets = await this.graphics.targets(app.getPath('documents'))
    const target = targets.find((t) => t.id === id) ?? targets[0]
    return target ? { target, targets } : null
  }

  async init(): Promise<void> {
    await this.settings.load(defaultSettings(this.dataDir))
    // Langue : avant tout texte affiché (menus, erreurs, tâches). Celle du compte enregistré peut servir.
    await this.account.init()
    this.accountId = this.account.current()?.id ?? null
    const locale = startupLocale({
      chosen: this.settings.get().locale,
      account: this.account.current()?.locale,
      system: [...app.getPreferredSystemLanguages(), app.getLocale()]
    })
    initI18n(locale)
    log.info(`Langue : ${locale}`)
    await this.state.load(emptyState())
    // state.json d'avant les mods : liste des mods ajoutée (vide).
    const state = normalizeState(this.state.get())
    if (state !== this.state.get()) await this.state.set(state)
    // Détection des jeux (registre lu par PowerShell : une demi-seconde, plus sur un PC lent) lancée tout de suite,
    // pendant l'ouverture de la fenêtre. L'interface s'affiche sans l'attendre avec celle du lancement précédent,
    // puis se met à jour si elle a changé.
    const saved = await this.savedGames()
    this.gamesCache = saved
    this.firstDetection = this.refreshGames().then(
      (games) => {
        if (saved && JSON.stringify(saved) !== JSON.stringify(games)) this.changed()
        return games
      },
      (err: unknown) => {
        log.warn(`Détection des jeux : ${(err as Error).message}`)
        return null
      }
    )
    this.library = new Library(this.settings.get().libraryDir, this.keys)
    await this.library.cleanupStaging()
    this.modLibrary = new Library(modsDir(this.settings.get().libraryDir), this.keys)
    await this.modLibrary.cleanupStaging()
    this.installer = new Installer({
      jobsDir: path.join(this.dataDir, 'jobs'),
      library: () => this.library,
      modLibrary: () => this.modLibrary,
      state: this.state,
      detectGames: () => this.refreshGames(),
      saveCover: (src, packDir) => saveCover(src, packDir),
      fpsLimit: () => this.settings.get().fpsLimit ?? null
    })
    await fs.rm(path.join(this.dataDir, 'jobs'), { recursive: true, force: true }).catch(() => undefined)
    this.marketplace = new Marketplace(this.apiUrl, path.join(this.dataDir, 'Marketplace', 'images'), () => this.library, () => this.modLibrary)
  }

  /** Langue changée : processus principal (menus, textes produits ici) et toutes les fenêtres. */
  private async applyLanguage(code: string): Promise<void> {
    if (code === currentLocale()) return
    await i18next.changeLanguage(code)
    log.info(`Langue : ${code}`)
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.language, code)
    // Vérifications des dossiers du jeu : libellés produits par la détection.
    void this.refreshGames().then(
      () => this.changed(),
      () => undefined
    )
    this.changed()
  }

  /** Connexion ou compte relu : langue du compte appliquée, ou langue affichée enregistrée dans le compte. */
  private accountLanguage(me: AccountMe | null): void {
    const signedIn = !!me && me.id !== this.accountId
    this.accountId = me?.id ?? null
    if (!me || !i18next.isInitialized) return
    const action = accountLanguageAction({ signedIn, accountLocale: me.locale, chosen: this.settings.get().locale, current: currentLocale() })
    if (!action) return
    if ('apply' in action) void this.applyLanguage(action.apply)
    else this.account.setLocale(action.push).catch((err: unknown) => log.info(`Langue non enregistrée dans le compte : ${(err as Error).message}`))
  }

  /** Tâches de fond : catalogue de la Marketplace (mises à jour des packs), caches, mises à jour de l'app. */
  startBackground(): void {
    const refreshMarket = async (): Promise<void> => {
      try {
        await this.marketplace.refreshCatalog()
        this.changed()
      } catch (err) {
        log.info(`Catalogue de la Marketplace non chargé : ${(err as Error).message}`)
      }
    }
    setTimeout(() => {
      // Compte : connexion expirée ou révoquée, nom ou photo modifiés sur le site.
      this.account.refresh().catch((err: unknown) => log.info(`Compte non vérifié : ${(err as Error).message}`))
      void refreshMarket()
      void this.marketplace.pruneImageCache()
      void this.marketplace.pruneDownloads()
    }, 5000)
    setInterval(() => void refreshMarket(), MARKET_REFRESH)
    this.updater.start()
  }

  private emit(channel: string, payload?: unknown): void {
    const w = this.getWindow()
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
  }

  private changed(): void {
    this.foreign = null
    this.emit(IPC.changed)
  }

  private get gamesFile(): string {
    return path.join(this.dataDir, 'games.json')
  }

  async refreshGames(): Promise<GamesInfo> {
    const settings = this.settings.get()
    const games = await detectGames(settings)
    this.gamesCache = games
    const saved: SavedGames = { version: app.getVersion(), fivemPath: settings.fivemPath, gtaPath: settings.gtaPath, games }
    void writeJsonAtomic(this.gamesFile, saved).catch(() => undefined)
    return games
  }

  /** Détection du lancement précédent, si elle vient de cette version et que les dossiers choisis n'ont pas changé. */
  private async savedGames(): Promise<GamesInfo | null> {
    const s = await readJson<SavedGames | null>(this.gamesFile, null)
    const { fivemPath, gtaPath } = this.settings.get()
    if (!s?.games?.fivem || !s.games.gta || s.version !== app.getVersion() || s.fivemPath !== fivemPath || s.gtaPath !== gtaPath) return null
    // Jeu en cours d'exécution : la détection en cours le dira.
    return { ...s.games, runningProcesses: [] }
  }

  /**
   * Mod tout juste téléchargé : activé s'il n'entre en conflit avec aucun autre mod et que rien ne l'empêche (il peut
   * remplacer des fichiers du pack actif, remis en place quand il sera désactivé). Renvoie null s'il a été activé,
   * sinon la raison.
   */
  private async enableIfFree(modId: string, report: Report): Promise<string | null> {
    try {
      const pre = await this.installer.modPreflight(modId)
      if (pre.blockers.length) return pre.blockers[0]
      if (pre.conflicts.length)
        return t('service.modConflict', { names: pre.conflicts.map((c) => quote(c.name)).join(', ') })
      await this.installer.setModEnabled(modId, true, report)
      return null
    } catch (err) {
      return (err as Error).message
    }
  }

  private screenshotsDir(): string {
    return path.join(app.getPath('pictures'), 'FiveM')
  }

  private toError(message: string): Error {
    return new Error(message)
  }

  /** Lance une tâche longue (une seule à la fois) et relaie sa progression à l'interface. */
  private startTask(kind: TaskProgress['kind'], title: string, target: string | null, fn: (report: Report, signal: AbortSignal) => Promise<unknown>): string {
    if (this.running) throw this.toError(t('errors.busy'))
    const id = `${kind}-${Date.now().toString(36)}`
    const abort = new AbortController()
    this.running = { id, abort }
    const base: TaskProgress = { taskId: id, kind, title, phase: '', current: 0, total: 0, done: false, detail: target ?? undefined }
    let last = 0
    const report: Report = (phase, current, total) => {
      const now = Date.now()
      if (now - last < 80 && current < total) return
      last = now
      this.emit(IPC.task, { ...base, phase, current, total } satisfies TaskProgress)
    }
    this.emit(IPC.task, base)
    log.info(`Tâche démarrée : ${title}`)
    void (async () => {
      try {
        const result = await fn(report, abort.signal)
        this.emit(IPC.task, { ...base, current: 1, total: 1, done: true, ok: true, result } satisfies TaskProgress)
        log.info(`Tâche terminée : ${title}`)
      } catch (err) {
        const message = (err as Error)?.message ?? String(err)
        log.error(`Tâche en échec : ${title} : ${message}`)
        this.emit(IPC.task, { ...base, done: true, ok: false, error: message } satisfies TaskProgress)
      } finally {
        this.running = null
        this.changed()
      }
    })()
    return id
  }

  // -------------------------------------------------------------------------

  api: ServerApi = {
    getOverview: async (): Promise<Overview> => {
      const games = this.gamesCache ?? (await this.firstDetection) ?? (await this.refreshGames())
      // Mods installés à la main : parcours des dossiers du jeu, en même temps que la bibliothèque.
      const pendingForeign = (this.foreign ??= this.installer.foreignSummary(games).catch(() => null))
      const library = await this.library.list()
      const mods = await this.modLibrary.list()
      const market = await this.marketplace.status().catch(() => ({ updates: [], gone: [] }))
      const foreign = await pendingForeign
      return {
        settings: this.settings.get(),
        games,
        state: this.state.get(),
        library: library.map(toPublic),
        mods: mods.map(toPublic),
        foreign,
        accent: accentColor(),
        version: app.getVersion(),
        dataDir: this.dataDir,
        apiUrl: this.apiUrl,
        market,
        update: this.updater.state
      }
    },

    refreshGames: async () => {
      const g = await this.refreshGames()
      this.changed()
      return g
    },

    setGamePath: async (which: RootId, p: string | null) => {
      if (p) {
        // Vérifié avant d'être enregistré : on refuse un dossier qui n'est manifestement pas le bon.
        if (which === 'fivem') {
          const info = await inspectFiveM(await normalizeFiveMPath(p), t('games.source.manual'))
          if (!info.valid) throw this.toError(t('service.errors.notFiveMDir'))
          p = info.path
        } else {
          const info = await inspectGta(p, t('games.source.manual'))
          if (!info.valid) throw this.toError(t('service.errors.notGtaDir'))
        }
      }
      await this.settings.patch(which === 'fivem' ? { fivemPath: p } : { gtaPath: p })
      const g = await this.refreshGames()
      this.changed()
      return g
    },

    pickFolder: async (title: string, defaultPath?: string) => {
      const w = this.getWindow()
      const opts = { title, defaultPath, properties: ['openDirectory' as const] }
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
      return r.canceled ? null : (r.filePaths[0] ?? null)
    },

    pickArchives: async () => {
      const w = this.getWindow()
      const opts = {
        title: t('service.dialogs.addPacks'),
        properties: ['openFile' as const, 'multiSelections' as const],
        filters: [{ name: t('service.dialogs.archives'), extensions: ['zip', 'rar', '7z'] }]
      }
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
      return r.canceled ? [] : r.filePaths
    },

    importPacks: async (paths: string[]) => {
      if (!paths.length) throw this.toError(t('service.errors.noFiles'))
      // Nom de l'archive (seule) : affiché sur la carte du pack en cours d'ajout.
      const name = paths.length === 1 ? path.basename(paths[0]).replace(/\.(zip|rar|7z)$/i, '') : null
      const title = name ? t('service.tasks.importOne', { name }) : t('service.tasks.importPacks', { count: paths.length })
      return this.startTask('import', title, name, async (report, signal) => {
        const imported: string[] = []
        const errors: string[] = []
        for (let i = 0; i < paths.length; i++) {
          try {
            const m = await this.library.import(paths[i], (pr) => report(pr.phase, pr.current, pr.total), signal)
            imported.push(m.name)
            await this.state.set(pushHistory(this.state.get(), { action: 'import', packName: m.name, ok: true, msg: msg('history.files', { count: m.fileCount, n: formatNumber(m.fileCount) }) }))
            this.changed()
          } catch (err) {
            if (signal.aborted) throw err
            errors.push((err as Error).message)
          }
        }
        if (errors.length && !imported.length) throw this.toError(errors.join('\n'))
        return { imported, errors }
      })
    },

    renamePack: async (id: string, name: string) => {
      const m = await this.library.update(id, { name })
      if (this.state.get().active?.packId === id) {
        const s = this.state.get()
        await this.state.set({ ...s, active: s.active ? { ...s.active, packName: m.name } : null })
      }
      this.changed()
      return toPublic(m)
    },

    updatePack: async (id: string, patch: PackPatch) => {
      const m = await this.library.update(id, patch)
      this.changed()
      return toPublic(m)
    },

    resetUserConfigs: async (id: string) => {
      const m = await this.library.resetUserConfigs(id)
      this.changed()
      return toPublic(m)
    },

    getComponentFiles: async (packId: string, componentId: string): Promise<ComponentFile[]> => {
      const m = await this.library.get(packId)
      const c = m.components.find((x) => x.id === componentId)
      if (!c) return []
      const sizes = new Map(m.files.map((f) => [f.rel, f.size]))
      return c.files.map((rel) => {
        const d = fileDestination(c, rel)
        return { rel, size: sizes.get(rel) ?? 0, dest: d ? `${d.root === 'fivem' ? 'FiveM.app' : 'GTA V'}/${d.path}` : null }
      })
    },

    setCover: async (id: string, rel: string | null) => {
      const m = await this.library.setCover(id, rel)
      this.changed()
      return toPublic(m)
    },

    setReshadePreset: async (id: string, rel: string) => {
      const m = await this.library.setReshadePreset(id, rel)
      this.changed()
      return toPublic(m)
    },

    setCoverFromFile: async (id: string) => {
      const w = this.getWindow()
      const plugins = this.gamesCache?.fivem.path ? path.join(this.gamesCache.fivem.path, 'plugins') : undefined
      const opts = {
        title: t('service.dialogs.packImage'),
        defaultPath: plugins,
        properties: ['openFile' as const],
        filters: [{ name: t('service.dialogs.images'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
      }
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths[0]) return null
      const name = await saveCover(r.filePaths[0], this.library.packDir(id))
      if (!name) throw this.toError(t('service.errors.unreadableImage'))
      const m = await this.library.setCover(id, name)
      this.changed()
      return toPublic(m)
    },

    deletePack: async (id: string) => {
      if (this.state.get().active?.packId === id) throw this.toError(t('service.errors.removePackFirst'))
      if (this.running) throw this.toError(t('errors.busy'))
      const m = await this.library.get(id)
      return this.startTask('delete', t('service.tasks.delete', { name: m.name }), id, async (report) => {
        await this.library.remove(id, (done, total) => report(t('service.phases.deleting'), done, total))
        await this.state.set(pushHistory(this.state.get(), { action: 'delete', packName: m.name, ok: true, msg: msg('history.deleted') }))
      })
    },

    openPackFolder: async (id: string) => {
      if ((await this.library.get(id)).protection) throw this.toError(t('service.errors.protectedPackFolder'))
      if (await shell.openPath(this.library.contentDir(id))) throw this.toError(t('service.errors.cannotOpenFolder'))
    },

    applyPack: async (id: string) => {
      const m = await this.library.get(id)
      return this.startTask('apply', t('service.tasks.apply', { name: m.name }), id, (report) => this.installer.apply(id, report))
    },

    removeActive: async () => {
      const a = this.state.get().active
      if (!a) throw this.toError(t('service.errors.noActivePack'))
      return this.startTask('remove', t('service.tasks.remove', { name: a.packName }), a.packId, (report) => this.installer.removeActive(report))
    },

    stashForeign: async (selection?: ForeignSelection[]) =>
      this.startTask('stash', t('service.tasks.stash'), 'foreign', (report) => this.installer.stashForeign(report, selection)),

    scanForeign: () => this.installer.scanForeign(),

    cacheInfo: () => this.installer.cacheInfo(),

    clearCache: async () => this.startTask('cache', t('service.tasks.clearCache'), 'cache', (report) => this.installer.clearCache(report)),

    openScreenshots: async (where: 'plugins' | 'pictures') => {
      let dir: string
      if (where === 'pictures') {
        dir = this.screenshotsDir()
        await fs.mkdir(dir, { recursive: true })
      } else {
        const fivem = (this.gamesCache ?? (await this.refreshGames())).fivem.path
        if (!fivem) throw this.toError(t('service.errors.fivemFolderNotFound'))
        dir = path.join(fivem, 'plugins')
      }
      if (await shell.openPath(dir)) throw this.toError(t('service.errors.cannotOpenFolder'))
    },

    trashScreenshots: async () =>
      this.startTask('trash', t('service.tasks.trashScreenshots'), 'screenshots', async (report) => {
        const fivem = (this.gamesCache ?? (await this.refreshGames())).fivem.path
        if (!fivem) throw this.toError(t('service.errors.fivemFolderNotFound'))
        const shots = (await this.installer.scanForeign()).filter((i) => i.category === 'screenshot' && !i.isDir)
        let done = 0
        for (const s of shots) {
          // Corbeille de Windows : récupérable en cas d'erreur.
          await shell.trashItem(path.join(fivem, ...s.path.split('/')))
          report(t('service.phases.deleting'), ++done, shots.length)
        }
        await this.state.set(pushHistory(this.state.get(), { action: 'clean', ok: true, msg: msg('history.screenshotsTrashed', { count: done, n: formatNumber(done) }) }))
        return { trashed: done }
      }),

    cleanGame: async (withMods?: boolean) =>
      this.startTask('clean', t('service.tasks.clean'), 'game', (report) => this.installer.cleanGame(report, withMods === true)),

    pickModFiles: async () => {
      const w = this.getWindow()
      const opts = {
        title: t('service.dialogs.importMods'),
        properties: ['openFile' as const, 'multiSelections' as const],
        filters: [{ name: t('service.dialogs.modFiles'), extensions: ['zip', 'rar', '7z', 'rpf'] }]
      }
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
      return r.canceled ? [] : r.filePaths
    },

    importMods: async (paths: string[]) => {
      if (!paths.length) throw this.toError(t('service.errors.noFiles'))
      const title =
        paths.length > 1
          ? t('service.tasks.importMods', { count: paths.length })
          : t('service.tasks.importOne', { name: path.basename(paths[0]).replace(/\.(zip|rar|7z|rpf)$/i, '') })
      return this.startTask('mod', title, 'mod-import', async (report, signal) => {
        const imported: string[] = []
        const errors: string[] = []
        for (const p of paths) {
          try {
            const m = await this.modLibrary.import(p, (pr) => report(pr.phase, pr.current, pr.total), signal, { kind: 'mod' })
            imported.push(m.name)
            await this.state.set(pushHistory(this.state.get(), { action: 'import', packName: m.name, ok: true, msg: msg('history.modAdded', { count: m.fileCount, n: formatNumber(m.fileCount) }) }))
            this.changed()
          } catch (err) {
            if (signal.aborted) throw err
            errors.push(paths.length > 1 ? t('service.errors.fileError', { file: path.basename(p), message: (err as Error).message }) : (err as Error).message)
          }
        }
        if (errors.length && !imported.length) throw this.toError(errors.join('\n'))
        return { imported, errors }
      })
    },

    modPreflight: (id: string) => this.installer.modPreflight(id),

    setModEnabled: async (id: string, enabled: boolean, disable?: string[]) => {
      if ((await runningGameProcesses()).length) throw this.toError(t('service.errors.closeGameForMod'))
      const m = await this.modLibrary.get(id)
      const title = t(enabled ? 'service.tasks.enableMod' : 'service.tasks.disableMod', { name: m.name })
      return this.startTask('mod', title, id, (report) => this.installer.setModEnabled(id, enabled, report, disable ?? []))
    },

    disableAllMods: async () => {
      if ((await runningGameProcesses()).length) throw this.toError(t('service.errors.closeGameForMods'))
      return this.startTask('mod', t('service.tasks.disableAllMods'), 'mods-all', (report) => this.installer.disableAllMods(report))
    },

    deleteMod: async (id: string) => {
      const m = await this.modLibrary.get(id)
      const enabled = this.state.get().mods.some((x) => x.id === id && x.enabled)
      if (enabled && (await runningGameProcesses()).length) throw this.toError(t('service.errors.closeGameForModDelete'))
      return this.startTask('mod', t('service.tasks.delete', { name: m.name }), id, async (report) => {
        await this.installer.forgetMod(id, report)
        await this.modLibrary.remove(id, (done, total) => report(t('service.phases.deleting'), done, total))
        await this.state.set(pushHistory(this.state.get(), { action: 'delete', packName: m.name, ok: true, msg: msg('history.modDeleted') }))
        return { name: m.name, deleted: true }
      })
    },

    openModFolder: async (id: string) => {
      if ((await this.modLibrary.get(id)).protection) throw this.toError(t('service.errors.protectedModFolder'))
      if (await shell.openPath(this.modLibrary.contentDir(id))) throw this.toError(t('service.errors.cannotOpenFolder'))
    },

    moveScreenshots: async () => {
      const dir = this.screenshotsDir()
      await fs.mkdir(dir, { recursive: true })
      return this.startTask('screenshots', t('service.tasks.moveScreenshots'), 'screenshots', (report) => this.installer.moveScreenshots(dir, report))
    },

    getGraphics: async (id?: GraphicsTarget['id']) => {
      const gt = await this.graphicsTarget(id)
      return gt ? this.graphics.read(gt.target, gt.targets) : null
    },

    saveGraphics: async (id: GraphicsTarget['id'], changes: Record<string, string>) => {
      const gt = await this.graphicsTarget(id)
      if (!gt) throw this.toError(t('service.errors.graphicsFileMissingFirstRun'))
      // Le jeu réécrit ce fichier en quittant : une modification faite pendant qu'il tourne serait perdue.
      if ((await runningGameProcesses()).length) throw this.toError(t('service.errors.closeGameForGraphics'))
      await this.graphics.write(gt.target, changes)
      const n = Object.keys(changes).length
      await this.state.set(
        pushHistory(this.state.get(), { action: 'graphics', ok: true, msg: msg('history.graphicsChanged', { count: n, n: formatNumber(n), target: gt.target.label }) })
      )
      this.changed()
      return this.graphics.read(gt.target, gt.targets)
    },

    setFpsLimit: async (limit: number | null) => {
      if (limit !== null && !(Number.isInteger(limit) && (limit === 0 || (limit >= FPS_LIMIT_MIN && limit <= FPS_LIMIT_MAX))))
        throw this.toError(t('service.errors.invalidFpsLimit', { min: FPS_LIMIT_MIN, max: FPS_LIMIT_MAX }))
      if (this.running) throw this.toError(t('errors.busy'))
      const previous = this.settings.get().fpsLimit ?? null
      await this.settings.patch({ fpsLimit: limit })
      let updated: number
      try {
        updated = await this.installer.applyFpsLimit(() => undefined)
      } catch (e) {
        await this.settings.patch({ fpsLimit: previous })
        throw e
      }
      const summary = limit === null ? msg('history.fpsLimitPack') : limit === 0 ? msg('history.fpsLimitNone') : msg('history.fpsLimit', { limit })
      await this.state.set(pushHistory(this.state.get(), { action: 'graphics', ok: true, msg: summary }))
      this.changed()
      return updated
    },

    restoreGraphics: async (id: GraphicsTarget['id']) => {
      const gt = await this.graphicsTarget(id)
      if (!gt) throw this.toError(t('service.errors.graphicsFileMissing'))
      if ((await runningGameProcesses()).length) throw this.toError(t('service.errors.closeGameForGraphics'))
      await this.graphics.restore(gt.target)
      await this.state.set(pushHistory(this.state.get(), { action: 'graphics', ok: true, msg: msg('history.graphicsRestored', { target: gt.target.label }) }))
      this.changed()
      return this.graphics.read(gt.target, gt.targets)
    },

    moveLibrary: async (newDir: string) => {
      const oldDir = this.settings.get().libraryDir
      const target = path.resolve(newDir)
      if (path.resolve(oldDir).toLowerCase() === target.toLowerCase()) throw this.toError(t('service.errors.libraryAlreadyThere'))
      if (isInside(oldDir, target)) throw this.toError(t('service.errors.libraryInsideCurrent'))
      if (this.state.get().active) throw this.toError(t('service.errors.removeInstalledPackFirst'))
      if (this.state.get().mods.some((m) => m.enabled)) throw this.toError(t('service.errors.disableModsFirst'))
      return this.startTask('move-library', t('service.tasks.moveLibrary'), null, async (report) => {
        await fs.mkdir(target, { recursive: true })
        const packs = await this.library.list()
        for (let i = 0; i < packs.length; i++) {
          report('', i, packs.length)
          const dest = path.join(target, packs[i].id)
          if (await exists(dest)) throw this.toError(t('service.errors.folderExists', { path: dest }))
          await moveDir(this.library.packDir(packs[i].id), dest)
        }
        // Bibliothèque des mods : déplacée en entier.
        if (await exists(modsDir(oldDir))) {
          if (await exists(modsDir(target))) throw this.toError(t('service.errors.folderExists', { path: modsDir(target) }))
          await moveDir(modsDir(oldDir), modsDir(target))
        }
        await this.settings.patch({ libraryDir: target })
        this.library = new Library(target, this.keys)
        this.modLibrary = new Library(modsDir(target), this.keys)
        await fs.rm(path.join(oldDir, '.staging'), { recursive: true, force: true }).catch(() => undefined)
        return { moved: packs.length }
      })
    },

    openPath: async (p: string) => {
      if (await shell.openPath(p)) throw this.toError(t('service.errors.cannotOpenFolder'))
    },

    packMenu: async (id: string) => {
      const w = this.getWindow()
      const isActive = this.state.get().active?.packId === id
      const isProtected = !!(await this.library.get(id).catch(() => null))?.protection
      return new Promise<'rename' | 'image' | 'open' | 'delete' | null>((resolve) => {
        let choice: 'rename' | 'image' | 'open' | 'delete' | null = null
        const menu = Menu.buildFromTemplate([
          { label: t('service.packMenu.rename'), click: () => (choice = 'rename') },
          { label: t('service.packMenu.changeImage'), click: () => (choice = 'image') },
          { label: t('service.packMenu.openFolder'), enabled: !isProtected, click: () => (choice = 'open') },
          { type: 'separator' },
          { label: t('common.delete'), enabled: !isActive, click: () => (choice = 'delete') }
        ])
        menu.popup({ window: w ?? undefined, callback: () => setTimeout(() => resolve(choice), 0) })
      })
    },

    confirm: async (message: string, detail: string, okLabel: string) => {
      const w = this.getWindow()
      const opts = { type: 'question' as const, message, detail, buttons: [okLabel, t('common.cancel')], defaultId: 0, cancelId: 1, noLink: true }
      const r = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts)
      return r.response === 0
    },

    popupMenu: async (items: MenuItem[]) => {
      const w = this.getWindow()
      return new Promise<string | null>((resolve) => {
        let choice: string | null = null
        const template: Electron.MenuItemConstructorOptions[] = []
        for (const item of items) {
          if (item.separator && template.length) template.push({ type: 'separator' })
          template.push({ label: item.label, enabled: item.enabled !== false, click: () => (choice = item.id) })
        }
        Menu.buildFromTemplate(template).popup({ window: w ?? undefined, callback: () => setTimeout(() => resolve(choice), 0) })
      })
    },

    marketList: (query: MarketQuery) => this.marketplace.list(query),

    marketTags: (kind?: MarketKind) => this.marketplace.tags(kind),

    marketCategories: () => this.marketplace.categories(),

    marketFeatured: (kind?: MarketKind) => this.marketplace.featured(kind),

    marketDetail: (idOrSlug: string, kind?: MarketKind) => this.marketplace.detail(idOrSlug, kind),

    marketInstall: async (id: string, kind: MarketKind = 'pack') => {
      const remote = await this.marketplace.detail(id, kind)
      const title = t(remote.updateAvailable ? 'service.tasks.update' : 'service.tasks.download', { name: remote.name })
      return this.startTask('download', title, remote.id, async (report, signal) => {
        const hooks = {
          activeId: () => this.state.get().active?.packId ?? null,
          apply: (packId: string, r: Report) => this.installer.apply(packId, r),
          enableMod: (modId: string, r: Report) => this.enableIfFree(modId, r),
          replaceMod: (oldId: string, next: StoredManifest, r: Report) => this.installer.replaceMod(oldId, next, r)
        }
        const result = await this.marketplace.install(remote.id, report, signal, hooks, kind)
        if (result.status !== 'up-to-date') {
          const summary = msg({ added: 'history.downloaded', updated: 'history.updated', linked: 'history.linked' }[result.status])
          await this.state.set(pushHistory(this.state.get(), { action: 'download', packName: result.name, ok: true, msg: summary }))
        }
        return result
      })
    },

    marketAuthors: (query: AuthorQuery) => this.marketplace.authors(query),

    marketAuthor: (slugOrId: string) => this.marketplace.author(slugOrId),

    openSite: async (sitePath: string) => {
      if (!/^\/[a-z0-9/_-]*$/i.test(sitePath)) throw this.toError(t('service.errors.invalidAddress'))
      // « depuis=app » : le site retient que l'application est installée sur ce PC (« Installer via l'app »).
      await shell.openExternal(`${this.marketplace.siteUrl(sitePath)}?depuis=app`)
    },

    openLink: async (url: string) => {
      let parsed: URL | null = null
      try {
        parsed = new URL(url)
      } catch {
        /* adresse invalide */
      }
      if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) throw this.toError(t('service.errors.invalidLink'))
      await shell.openExternal(parsed.toString())
    },

    openDiscordInvite: async (code: string) => {
      if (!/^[a-z0-9-]+$/i.test(code)) throw this.toError(t('service.errors.invalidInvite'))
      // Application Discord installée : l'invitation s'ouvre directement dedans, sinon dans le navigateur.
      const url = app.getApplicationNameForProtocol('discord://') ? `discord://-/invite/${code}` : `https://discord.gg/${code}`
      await shell.openExternal(url)
    },

    accountGet: async () => this.account.current(),

    accountLogin: (login: string, password: string) => this.account.login(login, password),

    accountRegister: (email: string, password: string, displayName: string) => this.account.register(email, password, displayName),

    accountLoginGoogle: async (): Promise<AccountMe> => {
      const me = await this.account.loginWithGoogle()
      // Retour au premier plan après la page Google.
      const w = this.getWindow()
      if (w && !w.isDestroyed()) {
        if (w.isMinimized()) w.restore()
        w.focus()
      }
      return me
    },

    accountCancelGoogle: async () => this.account.cancelGoogle(),

    accountLogout: () => this.account.logout(),

    accountProfile: () => this.account.profile(),

    accountSaveProfile: (input: ProfileInput) => this.account.saveProfile(input),

    accountPickAvatar: async () => {
      const w = this.getWindow()
      const opts = {
        title: t('service.dialogs.avatar'),
        defaultPath: app.getPath('pictures'),
        properties: ['openFile' as const],
        filters: [{ name: t('service.dialogs.images'), extensions: AVATAR_EXTENSIONS }]
      }
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths[0]) return null
      return this.account.setAvatarFile(r.filePaths[0])
    },

    accountRemoveAvatar: () => this.account.removeAvatar(),

    accountChangePassword: (currentPassword: string | null, newPassword: string) => this.account.changePassword(currentPassword, newPassword),

    getLanguage: async () => currentLocale(),

    setLanguage: async (code: string) => {
      const locale = supportedLocale(code)
      if (!locale) throw this.toError(t('language.invalid', { code }))
      await this.settings.patch({ locale })
      await this.applyLanguage(locale)
      if (this.account.current() && this.account.current()?.locale !== locale)
        this.account.setLocale(locale).catch((err: unknown) => log.info(`Langue non enregistrée dans le compte : ${(err as Error).message}`))
    },

    listLanguages: () => fetchLanguages(this.apiUrl, apiFetch),

    checkForUpdates: () => this.updater.check(),

    installUpdate: async () => {
      if (this.running) throw this.toError(t('service.errors.waitForTask'))
      this.updater.install()
    }
  }
}

/** Enregistre une image réduite (1600 px de large au plus, JPEG) dans le dossier d'un pack. */
async function saveCover(src: string, packDir: string): Promise<string | null> {
  let img = nativeImage.createFromPath(src)
  if (img.isEmpty()) return null
  if (img.getSize().width > 1600) img = img.resize({ width: 1600, quality: 'best' })
  const name = `cover-${Date.now().toString(36)}.jpg`
  await fs.writeFile(path.join(packDir, name), img.toJPEG(88))
  return name
}

function accentColor(): string {
  try {
    const c = systemPreferences.getAccentColor()
    return /^[0-9a-f]{6}/i.test(c) ? `#${c.slice(0, 6)}` : '#0067c0'
  } catch {
    return '#0067c0'
  }
}

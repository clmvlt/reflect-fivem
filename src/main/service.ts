// Service principal : état de l'application, tâches longues, et implémentation de l'API exposée à l'interface.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, Menu, nativeImage, net, safeStorage, shell, systemPreferences } from 'electron'
import type { AppState, GamesInfo, Overview, PackPatch, RootId, Settings, TaskProgress } from '@shared/types'
import type { AccountMe, ProfileInput } from '@shared/types'
import type { AuthorQuery, ComponentFile, ForeignSelection, MarketQuery, PackManagerApi } from '@shared/api'
import { IPC } from '@shared/api'
import { detectGames, inspectFiveM, inspectGta, normalizeFiveMPath } from './core/games'
import { Installer, type Report } from './core/installer'
import { FPS_LIMIT_MAX, FPS_LIMIT_MIN } from './core/enb'
import { Account, AVATAR_EXTENSIONS, TokenFile } from './core/account'
import { KeyRing, type SystemProtection } from './core/keys'
import { Library, toPublic } from './core/library'
import { GraphicsManager } from './core/graphics'
import { Marketplace } from './core/marketplace'
import { AppUpdater } from './core/updater'
import { runningGameProcesses } from './util/win'
import type { GraphicsTarget } from '@shared/graphics'
import { fileDestination } from './core/analyzer'
import { defaultSettings, emptyState, JsonStore, pushHistory } from './core/stores'
import { exists, isInside, moveDir, readJson, writeJsonAtomic } from './util/fsx'
import { log } from './util/log'

type ServerApi = Omit<PackManagerApi, 'onTask' | 'onChanged' | 'onUpdate' | 'onAccount' | 'onOpenMarketPack' | 'getPathForFile'>

const MARKET_REFRESH = 6 * 60 * 60 * 1000

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

  constructor(
    public dataDir: string,
    private getWindow: () => BrowserWindow | null,
    public apiUrl: string
  ) {
    this.keys = new KeyRing(path.join(dataDir, 'protection.key'), systemProtection, (marketId) => this.marketplace.packageKey(marketId))
    this.account = new Account({
      apiUrl,
      store: new TokenFile(path.join(dataDir, 'account.dat'), systemProtection),
      fetch: (url, init) => net.fetch(url, init),
      openExternal: (url) => shell.openExternal(url),
      onChange: (me) => this.emit(IPC.account, me)
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
    await this.state.load(emptyState())
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
    this.installer = new Installer({
      jobsDir: path.join(this.dataDir, 'jobs'),
      library: () => this.library,
      state: this.state,
      detectGames: () => this.refreshGames(),
      saveCover: (src, packDir) => saveCover(src, packDir),
      fpsLimit: () => this.settings.get().fpsLimit ?? null
    })
    await fs.rm(path.join(this.dataDir, 'jobs'), { recursive: true, force: true }).catch(() => undefined)
    this.marketplace = new Marketplace(this.apiUrl, path.join(this.dataDir, 'Marketplace', 'images'), () => this.library)
    await this.account.init()
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

  private screenshotsDir(): string {
    return path.join(app.getPath('pictures'), 'FiveM')
  }

  private toError(message: string): Error {
    return new Error(message)
  }

  /** Lance une tâche longue (une seule à la fois) et relaie sa progression à l'interface. */
  private startTask(kind: TaskProgress['kind'], title: string, target: string | null, fn: (report: Report, signal: AbortSignal) => Promise<unknown>): string {
    if (this.running) throw this.toError('Une opération est déjà en cours.')
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
      const market = await this.marketplace.status().catch(() => ({ updates: [], gone: [] }))
      const foreign = await pendingForeign
      return {
        settings: this.settings.get(),
        games,
        state: this.state.get(),
        library: library.map(toPublic),
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
          const info = await inspectFiveM(await normalizeFiveMPath(p), 'manuel')
          if (!info.valid) throw this.toError("Ce dossier n'est pas un dossier FiveM.")
          p = info.path
        } else {
          const info = await inspectGta(p, 'manuel')
          if (!info.valid) throw this.toError("Ce dossier n'est pas un dossier GTA V (GTA5.exe introuvable).")
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
        title: 'Ajouter des packs',
        properties: ['openFile' as const, 'multiSelections' as const],
        filters: [{ name: 'Archives', extensions: ['zip', 'rar', '7z'] }]
      }
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
      return r.canceled ? [] : r.filePaths
    },

    importPacks: async (paths: string[]) => {
      if (!paths.length) throw this.toError('Aucun fichier.')
      const label = paths.length > 1 ? `${paths.length} packs` : path.basename(paths[0]).replace(/\.(zip|rar|7z)$/i, '')
      return this.startTask('import', `Ajout de ${label}`, null, async (report, signal) => {
        const imported: string[] = []
        const errors: string[] = []
        for (let i = 0; i < paths.length; i++) {
          try {
            const m = await this.library.import(paths[i], (pr) => report(pr.phase, pr.current, pr.total), signal)
            imported.push(m.name)
            await this.state.set(pushHistory(this.state.get(), { action: 'import', packName: m.name, ok: true, summary: `${m.fileCount} fichiers` }))
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
        title: 'Image du pack',
        defaultPath: plugins,
        properties: ['openFile' as const],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
      }
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths[0]) return null
      const name = await saveCover(r.filePaths[0], this.library.packDir(id))
      if (!name) throw this.toError('Image illisible.')
      const m = await this.library.setCover(id, name)
      this.changed()
      return toPublic(m)
    },

    deletePack: async (id: string) => {
      if (this.state.get().active?.packId === id) throw this.toError("Retire d'abord ce pack du jeu.")
      if (this.running) throw this.toError('Une opération est déjà en cours.')
      const m = await this.library.get(id)
      return this.startTask('delete', `Suppression de ${m.name}`, id, async (report) => {
        await this.library.remove(id, (done, total) => report('Suppression', done, total))
        await this.state.set(pushHistory(this.state.get(), { action: 'delete', packName: m.name, ok: true, summary: 'Supprimé' }))
      })
    },

    openPackFolder: async (id: string) => {
      if ((await this.library.get(id)).protection) throw this.toError('Pack protégé : ses fichiers restent chiffrés dans la bibliothèque.')
      if (await shell.openPath(this.library.contentDir(id))) throw this.toError('Impossible d’ouvrir ce dossier.')
    },

    applyPack: async (id: string) => {
      const m = await this.library.get(id)
      return this.startTask('apply', `Installation de ${m.name}`, id, (report) => this.installer.apply(id, report))
    },

    removeActive: async () => {
      const a = this.state.get().active
      if (!a) throw this.toError('Aucun pack installé.')
      return this.startTask('remove', `Retrait de ${a.packName}`, a.packId, (report) => this.installer.removeActive(report))
    },

    stashForeign: async (selection?: ForeignSelection[]) =>
      this.startTask('stash', 'Rangement des mods', 'foreign', (report) => this.installer.stashForeign(report, selection)),

    scanForeign: () => this.installer.scanForeign(),

    cacheInfo: () => this.installer.cacheInfo(),

    clearCache: async () => this.startTask('cache', 'Vidage du cache FiveM', 'cache', (report) => this.installer.clearCache(report)),

    openScreenshots: async (where: 'plugins' | 'pictures') => {
      let dir: string
      if (where === 'pictures') {
        dir = this.screenshotsDir()
        await fs.mkdir(dir, { recursive: true })
      } else {
        const fivem = (this.gamesCache ?? (await this.refreshGames())).fivem.path
        if (!fivem) throw this.toError('Dossier FiveM introuvable.')
        dir = path.join(fivem, 'plugins')
      }
      if (await shell.openPath(dir)) throw this.toError('Impossible d’ouvrir ce dossier.')
    },

    trashScreenshots: async () =>
      this.startTask('trash', 'Suppression des captures', 'screenshots', async (report) => {
        const fivem = (this.gamesCache ?? (await this.refreshGames())).fivem.path
        if (!fivem) throw this.toError('Dossier FiveM introuvable.')
        const shots = (await this.installer.scanForeign()).filter((i) => i.category === 'screenshot' && !i.isDir)
        let done = 0
        for (const s of shots) {
          // Corbeille de Windows : récupérable en cas d'erreur.
          await shell.trashItem(path.join(fivem, ...s.path.split('/')))
          report('Suppression', ++done, shots.length)
        }
        await this.state.set(pushHistory(this.state.get(), { action: 'clean', ok: true, summary: `${done} captures d'écran mises à la corbeille` }))
        return { trashed: done }
      }),

    cleanGame: async () => this.startTask('clean', 'Nettoyage du jeu', 'game', (report) => this.installer.cleanGame(report)),

    moveScreenshots: async () => {
      const dir = this.screenshotsDir()
      await fs.mkdir(dir, { recursive: true })
      return this.startTask('screenshots', 'Déplacement des captures', 'screenshots', (report) => this.installer.moveScreenshots(dir, report))
    },

    getGraphics: async (id?: GraphicsTarget['id']) => {
      const t = await this.graphicsTarget(id)
      return t ? this.graphics.read(t.target, t.targets) : null
    },

    saveGraphics: async (id: GraphicsTarget['id'], changes: Record<string, string>) => {
      const t = await this.graphicsTarget(id)
      if (!t) throw this.toError('Fichier de réglages introuvable. Lancez le jeu une première fois.')
      // Le jeu réécrit ce fichier en quittant : une modification faite pendant qu'il tourne serait perdue.
      if ((await runningGameProcesses()).length) throw this.toError('Fermez FiveM avant de modifier les réglages : le jeu les réécrit en quittant.')
      await this.graphics.write(t.target, changes)
      const n = Object.keys(changes).length
      await this.state.set(pushHistory(this.state.get(), { action: 'graphics', ok: true, summary: `${n} réglage${n > 1 ? 's' : ''} graphique${n > 1 ? 's' : ''} modifié${n > 1 ? 's' : ''} (${t.target.label})` }))
      this.changed()
      return this.graphics.read(t.target, t.targets)
    },

    setFpsLimit: async (limit: number | null) => {
      if (limit !== null && !(Number.isInteger(limit) && (limit === 0 || (limit >= FPS_LIMIT_MIN && limit <= FPS_LIMIT_MAX))))
        throw this.toError(`Limite invalide : choisissez entre ${FPS_LIMIT_MIN} et ${FPS_LIMIT_MAX} images par seconde.`)
      if (this.running) throw this.toError('Une opération est déjà en cours.')
      const previous = this.settings.get().fpsLimit ?? null
      await this.settings.patch({ fpsLimit: limit })
      let updated: number
      try {
        updated = await this.installer.applyFpsLimit(() => undefined)
      } catch (e) {
        await this.settings.patch({ fpsLimit: previous })
        throw e
      }
      const label = limit === null ? 'celle du pack' : limit === 0 ? 'aucune' : `${limit} FPS`
      await this.state.set(pushHistory(this.state.get(), { action: 'graphics', ok: true, summary: `Limite d'images par seconde : ${label}` }))
      this.changed()
      return updated
    },

    restoreGraphics: async (id: GraphicsTarget['id']) => {
      const t = await this.graphicsTarget(id)
      if (!t) throw this.toError('Fichier de réglages introuvable.')
      if ((await runningGameProcesses()).length) throw this.toError('Fermez FiveM avant de modifier les réglages : le jeu les réécrit en quittant.')
      await this.graphics.restore(t.target)
      await this.state.set(pushHistory(this.state.get(), { action: 'graphics', ok: true, summary: `Réglages graphiques d’origine restaurés (${t.target.label})` }))
      this.changed()
      return this.graphics.read(t.target, t.targets)
    },

    moveLibrary: async (newDir: string) => {
      const oldDir = this.settings.get().libraryDir
      const target = path.resolve(newDir)
      if (path.resolve(oldDir).toLowerCase() === target.toLowerCase()) throw this.toError('Les packs sont déjà dans ce dossier.')
      if (isInside(oldDir, target)) throw this.toError('Choisis un dossier en dehors du dossier actuel.')
      if (this.state.get().active) throw this.toError("Retire d'abord le pack installé.")
      return this.startTask('move-library', 'Déplacement des packs', null, async (report) => {
        await fs.mkdir(target, { recursive: true })
        const packs = await this.library.list()
        for (let i = 0; i < packs.length; i++) {
          report('', i, packs.length)
          const dest = path.join(target, packs[i].id)
          if (await exists(dest)) throw this.toError(`Le dossier ${dest} existe déjà.`)
          await moveDir(this.library.packDir(packs[i].id), dest)
        }
        await this.settings.patch({ libraryDir: target })
        this.library = new Library(target, this.keys)
        await fs.rm(path.join(oldDir, '.staging'), { recursive: true, force: true }).catch(() => undefined)
        return { moved: packs.length }
      })
    },

    openPath: async (p: string) => {
      if (await shell.openPath(p)) throw this.toError('Impossible d’ouvrir ce dossier.')
    },

    packMenu: async (id: string) => {
      const w = this.getWindow()
      const isActive = this.state.get().active?.packId === id
      const isProtected = !!(await this.library.get(id).catch(() => null))?.protection
      return new Promise<'rename' | 'image' | 'open' | 'delete' | null>((resolve) => {
        let choice: 'rename' | 'image' | 'open' | 'delete' | null = null
        const menu = Menu.buildFromTemplate([
          { label: 'Renommer', click: () => (choice = 'rename') },
          { label: 'Changer l’image…', click: () => (choice = 'image') },
          { label: 'Ouvrir le dossier', enabled: !isProtected, click: () => (choice = 'open') },
          { type: 'separator' },
          { label: 'Supprimer', enabled: !isActive, click: () => (choice = 'delete') }
        ])
        menu.popup({ window: w ?? undefined, callback: () => setTimeout(() => resolve(choice), 0) })
      })
    },

    confirm: async (message: string, detail: string, okLabel: string) => {
      const w = this.getWindow()
      const opts = { type: 'question' as const, message, detail, buttons: [okLabel, 'Annuler'], defaultId: 0, cancelId: 1, noLink: true }
      const r = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts)
      return r.response === 0
    },

    marketList: (query: MarketQuery) => this.marketplace.list(query),

    marketTags: () => this.marketplace.tags(),

    marketFeatured: () => this.marketplace.featured(),

    marketDetail: (idOrSlug: string) => this.marketplace.detail(idOrSlug),

    marketInstall: async (id: string) => {
      const remote = await this.marketplace.detail(id)
      const verb = remote.updateAvailable ? 'Mise à jour' : 'Téléchargement'
      return this.startTask('download', `${verb} de ${remote.name}`, remote.id, async (report, signal) => {
        const result = await this.marketplace.install(remote.id, report, signal, {
          activeId: () => this.state.get().active?.packId ?? null,
          apply: (packId, r) => this.installer.apply(packId, r)
        })
        if (result.status !== 'up-to-date') {
          const summary = { added: 'Téléchargé depuis la Marketplace', updated: 'Mis à jour depuis la Marketplace', linked: 'Relié à la Marketplace' }[result.status]
          await this.state.set(pushHistory(this.state.get(), { action: 'download', packName: result.name, ok: true, summary }))
        }
        return result
      })
    },

    marketAuthors: (query: AuthorQuery) => this.marketplace.authors(query),

    marketAuthor: (slugOrId: string) => this.marketplace.author(slugOrId),

    openSite: async (sitePath: string) => {
      if (!/^\/[a-z0-9/_-]*$/i.test(sitePath)) throw this.toError('Adresse invalide.')
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
      if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) throw this.toError('Lien invalide.')
      await shell.openExternal(parsed.toString())
    },

    openDiscordInvite: async (code: string) => {
      if (!/^[a-z0-9-]+$/i.test(code)) throw this.toError('Invitation invalide.')
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
        title: 'Photo de profil',
        defaultPath: app.getPath('pictures'),
        properties: ['openFile' as const],
        filters: [{ name: 'Images', extensions: AVATAR_EXTENSIONS }]
      }
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths[0]) return null
      return this.account.setAvatarFile(r.filePaths[0])
    },

    accountRemoveAvatar: () => this.account.removeAvatar(),

    accountChangePassword: (currentPassword: string | null, newPassword: string) => this.account.changePassword(currentPassword, newPassword),

    checkForUpdates: () => this.updater.check(),

    installUpdate: async () => {
      if (this.running) throw this.toError('Attendez la fin de l’opération en cours.')
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

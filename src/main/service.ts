// Service principal : état de l'application, tâches longues, et implémentation de l'API exposée à l'interface.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, nativeImage, nativeTheme, net, Notification, safeStorage, screen, shell, systemPreferences } from 'electron'
import type { AppState, FiveMInstance, GamesInfo, InstanceSummary, MarketKind, Overview, PackPatch, RootId, Settings, TaskProgress } from '@shared/types'
import type { AccountMe, BuilderBuild, BuilderSaveInput, BuilderTools, CheckoutInput, ItemCheckoutInput, ProfileInput, QuoteInput, ToolKey } from '@shared/types'
import type { AuthorQuery, CommentQuery, ComponentFile, ForeignSelection, MarketQuery, PackManagerApi } from '@shared/api'
import { canUseBuilder, IPC, PENDING } from '@shared/api'
import i18next, { t } from 'i18next'
import { currentLocale, initI18n, msg, supportedLocale } from '@shared/i18n'
import { formatDateTime, formatMegabytes, formatNumber, quote } from '@shared/intl'
import type { Maintenance } from '@shared/maintenance'
import { detectGames, inspectFiveM, inspectGta, normalizeFiveMPath, samePath } from './core/games'
import { Installer, type OtherInstall, type Report } from './core/installer'
import { FPS_LIMIT_MAX, FPS_LIMIT_MIN } from './core/enb'
import { Account, AVATAR_EXTENSIONS, TokenFile } from './core/account'
import { Community } from './core/community'
import { KeyRing, type SystemProtection } from './core/keys'
import { Library, toPublic, type StoredManifest } from './core/library'
import { GraphicsManager, screenSize } from './core/graphics'
import { Hardware } from './core/hardware'
import { PerformanceModels } from './core/performance'
import { languageFetch, MaintenanceError, onMaintenanceError, serverFetch } from './core/http'
import { accountLanguageAction, fetchLanguages, startupLocale } from './core/language'
import { MaintenanceWatch, PausedDownloads } from './core/maintenance'
import { LinksWatch } from './core/links'
import { WhatsNewWatch } from './core/changelog'
import { httpsUrl } from '@shared/links'
import { isCheckoutUrl } from '@shared/billing'
import { isThemeChoice, resolveTheme, themeBackground, type ThemeChoice } from '@shared/themes'
import { Marketplace } from './core/marketplace'
import { Builder, coverUrl } from './core/builder'
import { Purchases } from './core/purchases'
import { DownloadQueue, type DownloadContext, type DownloadJob } from './core/downloads'
import { AppUpdater } from './core/updater'
import { discordRunning, killProcesses, launchDetached, readVideoAdapters, runningGameProcesses } from './util/win'
import type { GraphicsTarget } from '@shared/graphics'
import type { HardwareOverride, MachineProfile } from '@shared/performance'
import { fileDestination } from './core/analyzer'
import { defaultSettings, emptyState, JsonStore, normalizeState, pushHistory } from './core/stores'
import { copyPlan, currentInstanceId, instanceStateFile, listInstances, MAIN_INSTANCE, runCopy, safeFileName, SECOND_CLIENT_ARG, suggestedName } from './core/instances'
import { exists, formatBytes, freeSpace, isInside, moveDir, newId, readJson, writeJsonAtomic } from './util/fsx'
import { log } from './util/log'

type ServerApi = Omit<PackManagerApi, 'onTask' | 'onDownloads' | 'onDownloadDone' | 'onChanged' | 'onUpdate' | 'onAccount' | 'onLanguage' | 'onMaintenance' | 'onLinks' | 'onChangelog' | 'onOpenMarketPack' | 'onOpenPurchase' | 'getPathForFile'>

const MARKET_REFRESH = 6 * 60 * 60 * 1000
/** Bibliothèque des mods : sous-dossier de la bibliothèque des packs (ignoré par celle-ci, comme tout dossier « . »). */
const modsDir = (libraryDir: string): string => path.join(libraryDir, '.mods')
/** FiveM lancé ou fermé : vérifié toutes les 4 secondes (liste des processus). */
const GAME_WATCH = 4000
/** Requêtes vers l'API, avec la langue affichée (Accept-Language) ; 503 « maintenance » levé en MaintenanceError. */
const apiFetch = serverFetch((url, init) => net.fetch(url, init))

/**
 * Adresse vers laquelle renvoie `url` (réponse 3xx), sans suivre le renvoi ; null pour une autre réponse. net.fetch
 * refuse `redirect: 'manual'` (« Redirect was cancelled ») : net.request le permet.
 */
function redirectOf(url: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'manual' })
    const timer = setTimeout(() => {
      req.abort()
      reject(new Error(t('errors.network')))
    }, 20_000)
    const done = (location: string | null): void => {
      clearTimeout(timer)
      resolve(location)
      req.abort()
    }
    req.on('redirect', (_status, _method, location) => done(location))
    req.on('response', () => done(null))
    req.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    req.end()
  })
}

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
  /** « Créer ton pack » : catalogue, créations du compte, packs construits. */
  builder!: Builder
  /** Achats du compte et packs payants du catalogue (packs à soi gardés pour les badges). */
  purchases!: Purchases
  updater: AppUpdater
  private gamesCache: GamesInfo | null = null
  /** Détection des jeux lancée au démarrage (null en cas d'échec). */
  private firstDetection: Promise<GamesInfo | null> = Promise.resolve(null)
  private foreign: Promise<Overview['foreign']> | null = null
  private running: { id: string; abort: AbortController } | null = null
  /** Attendent qu'aucune tâche ne tourne (téléchargement à ajouter à la bibliothèque). */
  private idleWaiters: (() => void)[] = []
  /** Téléchargements de la Marketplace : un à la fois, sans bloquer le reste tant qu'ils ne modifient pas la bibliothèque. */
  private downloads: DownloadQueue
  /** Clés des packs protégés : clé locale gardée chiffrée par Windows (DPAPI), clés des paquets remises par l'API. */
  private keys: KeyRing
  /** Compte reflect-fivem.com (facultatif) : jeton gardé chiffré par Windows. */
  account: Account
  /** Notes et commentaires des packs. */
  community!: Community
  /** Configuration de la machine (carte graphique en cache), comparée aux packs dans l'interface. */
  hardware: Hardware
  /** Modèle de comparaison des performances de l'API. */
  perfModels: PerformanceModels
  /** Maintenances prévues par l'admin (GET /maintenance), envoyées à l'interface. */
  maintenance: MaintenanceWatch
  /** Téléchargements arrêtés par une maintenance, repris à sa fin. */
  private paused: PausedDownloads
  /** Liens publics modifiables depuis le site (GET /links), envoyés à l'interface. */
  links: LinksWatch
  /** Fenêtre « Nouveautés » : notes des versions publiées depuis la dernière vue, envoyées à l'interface. */
  whatsNew: WhatsNewWatch
  private resumingPaused = false
  private resumeTimer: NodeJS.Timeout | null = null
  /** État de l'application changé (zone de notification : jeu lancé, changement en attente). */
  onStateChange: (() => void) | null = null
  private gameWasRunning = false
  private watching = false
  /**
   * Changement de pack demandé pendant que FiveM tourne : fait dès que le jeu est fermé. Le jeu garde les fichiers du
   * pack ouverts et réécrit ses réglages (ReShade, ENB) en quittant : changer de pack pendant qu'il tourne mélangerait
   * les fichiers des deux packs.
   */
  private pending: { title: string; packId: string | null; start: () => string } | null = null
  /** Tâche lancée pour le changement en attente. */
  private pendingTask: string | null = null
  private relaunchHint = false
  /** Compte connecté au dernier changement (une connexion se reconnaît à un compte différent). */
  private accountId: number | null = null
  /** Compte dont les créations de « Créer ton pack » ont été vérifiées (null : pas de compte, ou sans le droit). */
  private builderAccount: number | null = null
  /** État des instances autres que l'instance active, lu à la demande (il ne change pas tant qu'on ne les reprend pas). */
  private others = new Map<string, AppState>()

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
      discordApp: {
        running: async () => !!app.getApplicationNameForProtocol('discord://') && (await discordRunning()),
        redirectOf
      },
      onChange: (me) => {
        this.emit(IPC.account, me)
        this.accountLanguage(me)
        // Packs payants à soi : relus à la connexion, oubliés à la déconnexion.
        this.purchases?.accountChanged(me)
        // Créations d'un autre compte, plus de compte, droit « Peut créer un pack » donné ou retiré : mises à jour revérifiées.
        const builderAccount = me && canUseBuilder(me) ? me.id : null
        if (builderAccount !== this.builderAccount) {
          this.builderAccount = builderAccount
          this.builder?.forgetStatus()
          if (builderAccount !== null)
            void this.builder
              ?.refreshStatus()
              .then(() => this.changed())
              .catch((err: unknown) => log.info(`Créations non vérifiées : ${(err as Error).message}`))
          else this.changed()
        }
      }
    })
    this.settings = new JsonStore(path.join(dataDir, 'settings.json'), defaultSettings(dataDir))
    this.state = new JsonStore(path.join(dataDir, 'state.json'), emptyState())
    this.graphics = new GraphicsManager(path.join(dataDir, 'Graphismes'))
    this.updater = new AppUpdater(apiUrl, (s) => this.emit(IPC.update, s))
    this.hardware = new Hardware(path.join(dataDir, 'hardware.json'), {
      adapters: readVideoAdapters,
      gameScreen: async () => {
        // Résolution de FiveM (gta5_settings.xml), sinon celle de GTA V solo.
        const targets = await this.graphics.targets(app.getPath('documents'))
        for (const t of targets) {
          const size = screenSize(await fs.readFile(t.path, 'utf8').catch(() => ''))
          if (size) return size
        }
        return null
      },
      displayScreen: () => {
        const d = screen.getPrimaryDisplay()
        return { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) }
      }
    })
    this.perfModels = new PerformanceModels(apiUrl, path.join(dataDir, 'performance-model.json'), apiFetch)
    this.maintenance = new MaintenanceWatch({
      apiUrl,
      // GET /maintenance n'est jamais refusé pour maintenance.
      fetch: languageFetch((url, init) => net.fetch(url, init)),
      file: path.join(dataDir, 'maintenance.json'),
      onChange: (state) => this.emit(IPC.maintenance, state),
      notify: (m) => this.notifyMaintenance(m)
    })
    this.downloads = new DownloadQueue({
      run: (job, ctx) => this.runDownload(job, ctx),
      onChange: (items) => this.emit(IPC.downloads, items),
      onDone: (d) => {
        if (d.cancelled) log.info(`Téléchargement annulé : ${d.name}`)
        else if (!d.ok) log.error(`Téléchargement en échec : ${d.name} : ${d.error}`)
        this.emit(IPC.downloadDone, d)
        this.changed()
      }
    })
    this.paused = new PausedDownloads(path.join(dataDir, 'paused-downloads.json'), (d) =>
      d.claim ? this.api.marketClaim(d.id, d.kind) : this.api.marketInstall(d.id, d.kind)
    )
    this.links = new LinksWatch({
      apiUrl,
      // GET /links n'est jamais refusé pour maintenance.
      fetch: languageFetch((url, init) => net.fetch(url, init)),
      file: path.join(dataDir, 'links.json'),
      onChange: (links) => this.emit(IPC.links, links)
    })
    this.whatsNew = new WhatsNewWatch({
      apiUrl,
      // GET /app/releases/** n'est jamais refusé pendant une maintenance.
      fetch: languageFetch((url, init) => net.fetch(url, init)),
      version: app.getVersion(),
      lastSeen: () => this.settings.get().lastSeenChangelogVersion,
      save: async (version) => {
        await this.settings.patch({ lastSeenChangelogVersion: version })
      },
      onChange: (whatsNew) => this.emit(IPC.changelog, whatsNew)
    })
  }

  /** Notification de Windows 15 minutes avant le début d'une maintenance. */
  private notifyMaintenance(m: Maintenance): void {
    if (!Notification.isSupported()) return
    const time = { timeStyle: 'short' } as const
    new Notification({
      title: t('maintenance.notification.title'),
      body: t('maintenance.notification.body', { start: formatDateTime(m.startsAt, time), end: formatDateTime(m.endsAt, time) })
    }).show()
  }

  /**
   * Reprend un téléchargement arrêté par une maintenance, quand aucune n'est en cours et qu'aucune tâche ne tourne
   * (appelé à la fin d'une maintenance et après chaque tâche, jusqu'à ce que tous soient repris).
   */
  private resumePaused(): void {
    if (this.resumingPaused || this.running || this.maintenance.ongoing() || !this.paused.list().length) return
    this.resumingPaused = true
    void this.paused.resumeNext().finally(() => {
      this.resumingPaused = false
      this.emit(IPC.changed)
      // Reprise en échec (réseau, serveur) : nouvel essai un peu plus tard.
      const delay = this.paused.retryDelay()
      if (!delay || !this.paused.list().length) return
      if (this.resumeTimer) clearTimeout(this.resumeTimer)
      this.resumeTimer = setTimeout(() => this.resumePaused(), delay + 100)
    })
  }

  /** Machine et modèle de comparaison ; `refresh` : nouvelle détection de la carte graphique. */
  private async machineProfile(refresh = false): Promise<MachineProfile> {
    const [model, hardware] = await Promise.all([this.perfModels.get(), this.hardware.info(refresh)])
    return { model, hardware, override: this.settings.get().machine ?? {} }
  }

  private async graphicsTarget(id?: GraphicsTarget['id']): Promise<{ target: GraphicsTarget; targets: GraphicsTarget[] } | null> {
    const targets = await this.graphics.targets(app.getPath('documents'))
    const target = targets.find((t) => t.id === id) ?? targets[0]
    return target ? { target, targets } : null
  }

  // -------------------------------------------------------------------------
  // Instances (voir core/instances.ts)

  private instanceList(): FiveMInstance[] {
    return listInstances(this.settings.get(), t('instances.mainName'))
  }

  private async instanceState(id: string): Promise<AppState> {
    let s = this.others.get(id)
    if (!s) {
      s = normalizeState({ ...emptyState(), ...(await readJson<Partial<AppState>>(instanceStateFile(this.dataDir, id), {})) })
      this.others.set(id, s)
    }
    return s
  }

  private async saveInstanceState(id: string, s: AppState): Promise<void> {
    this.others.set(id, s)
    await writeJsonAtomic(instanceStateFile(this.dataDir, id), s)
  }

  /** Les instances autres que l'instance active, avec leur état. */
  private async otherInstances(): Promise<{ instance: FiveMInstance; state: AppState }[]> {
    const current = currentInstanceId(this.settings.get())
    const out: { instance: FiveMInstance; state: AppState }[] = []
    for (const instance of this.instanceList()) if (instance.id !== current) out.push({ instance, state: await this.instanceState(instance.id) })
    return out
  }

  /** Change l'état des autres instances (pack renommé, nouvelle version d'un pack ou d'un mod). */
  private async updateOthers(fn: (s: AppState) => AppState): Promise<void> {
    for (const { instance, state } of await this.otherInstances()) {
      const next = fn(state)
      if (next !== state) await this.saveInstanceState(instance.id, next)
    }
  }

  /** Autre instance où le pack est installé, ou le mod activé (null : aucune). */
  private async usedElsewhere(id: string, kind: MarketKind): Promise<string | null> {
    for (const { instance, state } of await this.otherInstances())
      if (kind === 'pack' ? state.active?.packId === id : state.mods.some((m) => m.id === id && m.enabled)) return instance.name
    return null
  }

  private async instanceSummaries(): Promise<InstanceSummary[]> {
    const current = currentInstanceId(this.settings.get())
    return Promise.all(
      this.instanceList().map(async (i) => {
        const isCurrent = i.id === current
        const s = isCurrent ? this.state.get() : await this.instanceState(i.id)
        // Instance active en détection automatique : le dossier trouvé.
        const fivemPath = isCurrent ? (i.fivemPath ?? this.gamesCache?.fivem.path ?? null) : i.fivemPath
        return { ...i, fivemPath, current: isCurrent, packId: s.active?.packId ?? null, packName: s.active?.packName ?? null, mods: s.mods.filter((m) => m.enabled).length }
      })
    )
  }

  private makeInstaller(state: JsonStore<AppState>, detect: () => Promise<GamesInfo>, others: () => Promise<OtherInstall[]>): Installer {
    return new Installer({
      jobsDir: path.join(this.dataDir, 'jobs'),
      library: () => this.library,
      modLibrary: () => this.modLibrary,
      state,
      detectGames: detect,
      saveCover: (src, packDir) => saveCover(src, packDir),
      fpsLimit: () => this.settings.get().fpsLimit ?? null,
      others
    })
  }

  /** Fichiers posés par les instances autres que {@link id} : pack installé et mods activés de chacune. */
  private async installsExcept(id: string): Promise<OtherInstall[]> {
    const current = currentInstanceId(this.settings.get())
    const out: OtherInstall[] = []
    for (const i of this.instanceList()) {
      if (i.id === id) continue
      const s = i.id === current ? this.state.get() : await this.instanceState(i.id)
      if (s.active) out.push({ instance: i.name, packId: s.active.packId, packName: s.active.packName, roots: s.active.roots, files: s.active.files })
      for (const m of s.mods) if (m.enabled) out.push({ instance: i.name, packId: null, packName: m.name, roots: m.roots, files: m.files })
    }
    return out
  }

  /**
   * Opération sur le pack d'une instance, active ou non. Une autre instance a son propre installateur, sur son état et
   * ses dossiers ; son état gardé en mémoire est mis à jour à la fin.
   */
  private async onInstance<T>(id: string, fn: (installer: Installer) => Promise<T>): Promise<T> {
    if (id === currentInstanceId(this.settings.get())) return fn(this.installer)
    const instance = this.instanceList().find((i) => i.id === id)
    if (!instance) throw this.toError(t('instances.errors.notFound'))
    const store = new JsonStore<AppState>(instanceStateFile(this.dataDir, id), await this.instanceState(id))
    const detect = (): Promise<GamesInfo> => detectGames({ ...this.settings.get(), fivemPath: instance.fivemPath, gtaPath: instance.gtaPath })
    try {
      return await fn(this.makeInstaller(store, detect, () => this.installsExcept(id)))
    } finally {
      this.others.set(id, store.get())
    }
  }

  /**
   * Thème choisi : menus et boîtes de Windows, et thème clair ou sombre vu par l'interface (prefers-color-scheme),
   * suivent sa base ; « system » laisse Windows décider.
   */
  private applyNativeTheme(): void {
    const choice = this.settings.get().theme
    nativeTheme.themeSource = !choice || choice === 'system' ? 'system' : resolveTheme(choice, false).base
  }

  /** Fond de la fenêtre, le même que celui de l'interface (pas d'éclair d'une autre couleur à l'ouverture). */
  windowBackground(): string {
    return themeBackground(resolveTheme(this.settings.get().theme, nativeTheme.shouldUseDarkColors))
  }

  /** Instance enregistrée (l'instance active ne change pas) ; le dossier FiveM de l'instance active est fixé. */
  private async addInstance(instance: FiveMInstance): Promise<void> {
    const s = this.settings.get()
    // Instance active en détection automatique : la détection suit le dernier FiveM lancé (lien fivem://) et pourrait
    // tomber sur le dossier d'une autre instance.
    const fixed = s.fivemPath ?? this.gamesCache?.fivem.path ?? null
    await this.settings.patch({ instances: [...this.instanceList(), instance], instance: currentInstanceId(s), fivemPath: fixed })
    if (fixed !== s.fivemPath) await this.refreshGames()
    this.changed()
  }

  /** Raccourci sur le bureau qui lance le FiveM de l'instance (avec -cl2, sauf l'instance principale, pour jouer en même temps). */
  private async createShortcut(instance: FiveMInstance): Promise<string> {
    const current = currentInstanceId(this.settings.get())
    const fivemApp = instance.fivemPath ?? (instance.id === current ? (this.gamesCache?.fivem.path ?? null) : null)
    const exe = fivemApp ? path.join(path.dirname(fivemApp), 'FiveM.exe') : null
    if (!exe || !(await exists(exe))) throw this.toError(t('instances.errors.exeMissing'))
    const file = path.join(app.getPath('desktop'), `${safeFileName(`FiveM - ${instance.name}`)}.lnk`)
    const ok = shell.writeShortcutLink(file, {
      target: exe,
      cwd: path.dirname(exe),
      args: instance.id === MAIN_INSTANCE ? '' : SECOND_CLIENT_ARG,
      description: `FiveM (${instance.name})`,
      icon: exe,
      iconIndex: 0
    })
    if (!ok) throw this.toError(t('instances.errors.shortcutFailed'))
    log.info(`Raccourci créé : ${file}`)
    return file
  }

  /** Dossier FiveM.app déjà utilisé par une autre instance que {@link except} : son nom (null sinon). */
  private fivemUsedBy(fivemApp: string, except: string): string | null {
    const current = currentInstanceId(this.settings.get())
    for (const i of this.instanceList()) {
      if (i.id === except) continue
      const p = i.fivemPath ?? (i.id === current ? (this.gamesCache?.fivem.path ?? null) : null)
      if (samePath(p, fivemApp)) return i.name
    }
    return null
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
    this.applyNativeTheme()
    // Instance active disparue de la liste (réglages modifiés à la main) : la première, avec ses dossiers.
    const loaded = this.settings.get()
    const first = loaded.instances?.[0]
    if (first && !loaded.instances!.some((i) => i.id === loaded.instance))
      await this.settings.patch({ instance: first.id, fivemPath: first.fivemPath, gtaPath: first.gtaPath })
    await this.state.open(instanceStateFile(this.dataDir, currentInstanceId(this.settings.get())), emptyState())
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
    this.installer = this.makeInstaller(this.state, () => this.refreshGames(), () => this.installsExcept(currentInstanceId(this.settings.get())))
    await fs.rm(path.join(this.dataDir, 'jobs'), { recursive: true, force: true }).catch(() => undefined)
    // Maintenances : dernier état connu (écran de maintenance tout de suite, même hors ligne), vérifié au démarrage.
    await this.maintenance.load()
    await this.paused.load()
    // Liens : derniers connus (hors ligne aussi), relus au démarrage.
    await this.links.load()
    onMaintenanceError((err) => this.maintenance.report(err))
    this.maintenance.onOver(() => this.resumePaused())
    // Téléchargements faits avec le jeton du compte connecté : comptés pour lui (et nécessaires pour noter).
    this.marketplace = new Marketplace(this.apiUrl, path.join(this.dataDir, 'Marketplace', 'images'), () => this.library, this.account, () => this.modLibrary)
    this.community = new Community(this.account, (items) => this.marketplace.toPacks(items))
    this.builder = new Builder({ apiUrl: this.apiUrl, dir: path.join(this.dataDir, 'builder'), account: this.account, library: () => this.library, fetch: apiFetch })
    this.purchases = new Purchases({
      account: this.account,
      file: path.join(this.dataDir, 'owned-packs.json'),
      siteUrl: (sitePath) => this.marketplace.siteUrl(sitePath),
      supportUrl: () => this.links.current.discord ?? null,
      kindOf: (id) => this.marketplace.kindOf(id),
      onOwnedChange: () => this.changed()
    })
    await this.purchases.load()
    const me = this.account.current()
    this.builderAccount = me && canUseBuilder(me) ? me.id : null
  }

  /** Langue changée : processus principal (menus, textes produits ici), toutes les fenêtres, caches des textes de l'API. */
  private async applyLanguage(code: string): Promise<void> {
    if (code === currentLocale()) return
    await i18next.changeLanguage(code)
    log.info(`Langue : ${code}`)
    // Libellés traduits par l'API (niveaux, classes de cartes) : redemandés dans la nouvelle langue.
    this.perfModels.clear()
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
    // Maintenances : vérifiées tout de suite (l'écran de maintenance ne doit pas attendre), puis à leur rythme.
    void this.maintenance.start().then(() => this.resumePaused())
    void this.links.refresh()
    // Nouveautés : premier lancement, ou première ouverture après une mise à jour.
    void this.whatsNew.check()
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
      void this.purchases.refreshOwned(true)
      void this.marketplace.pruneImageCache()
      void this.marketplace.pruneDownloads()
      // Créations installées : nouvelle révision en ligne ? Puis ménage des caches de « Créer ton pack ».
      void this.builder
        .refreshStatus()
        .then(() => this.changed())
        .catch((err: unknown) => log.info(`Créations non vérifiées : ${(err as Error).message}`))
      void this.builder.pruneImages()
      void this.builder.pruneBlobs().catch((err: unknown) => log.info(`Cache de « Créer ton pack » non nettoyé : ${(err as Error).message}`))
      // Carte graphique (détectée une fois, puis en cache) et modèle de comparaison, prêts pour la Marketplace.
      void this.machineProfile().catch(() => undefined)
    }, 5000)
    setInterval(() => void refreshMarket(), MARKET_REFRESH)
    setInterval(() => void this.watchGame(), GAME_WATCH)
    this.updater.start()
  }

  /** FiveM (ou GTA V) en cours d'exécution, d'après la dernière vérification. */
  get gameRunning(): boolean {
    return (this.gamesCache?.runningProcesses.length ?? 0) > 0
  }

  /** Processus du jeu relus : l'interface est prévenue quand FiveM est lancé ou fermé. */
  private async watchGame(): Promise<void> {
    if (this.watching || !this.gamesCache) return
    this.watching = true
    try {
      const running = (await runningGameProcesses()).sort()
      if (!this.gamesCache) return
      const differs = running.join() !== [...this.gamesCache.runningProcesses].sort().join()
      if (differs) this.gamesCache = { ...this.gamesCache, runningProcesses: running }
      // Aussi quand une détection complète l'a déjà vu, sans prévenir la zone de notification.
      if (differs || this.gameRunning !== this.gameWasRunning) this.changed()
    } finally {
      this.watching = false
    }
  }

  private emit(channel: string, payload?: unknown): void {
    const w = this.getWindow()
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
  }

  private changed(): void {
    this.foreign = null
    if (this.gameRunning !== this.gameWasRunning) {
      this.gameWasRunning = this.gameRunning
      log.info(this.gameRunning ? 'Jeu lancé' : 'Jeu fermé')
      if (this.gameRunning) this.relaunchHint = false
    }
    this.emit(IPC.changed)
    this.onStateChange?.()
    // FiveM fermé (ou opération précédente terminée) : le changement en attente est fait.
    if (this.pending && !this.gameRunning && !this.running) setTimeout(() => this.startPending(), 0)
    // Opération terminée : téléchargement en pause à reprendre (le changement en attente passe d'abord).
    else if (!this.running) setTimeout(() => this.resumePaused(), 0)
  }

  /** Changement de pack : tout de suite, ou à la fermeture du jeu s'il est lancé (le dernier demandé remplace l'autre). */
  private async whenGameClosed(title: string, packId: string | null, start: () => string): Promise<string> {
    if (!(await runningGameProcesses()).length) return start()
    this.pending = { title, packId, start }
    log.info(`Jeu lancé : « ${title} » fait à sa fermeture`)
    // Liste des processus à jour, pour que l'interface affiche le jeu lancé.
    await this.watchGame()
    this.changed()
    return PENDING
  }

  private startPending(): void {
    const p = this.pending
    if (!p || this.gameRunning || this.running) return
    this.pending = null
    try {
      this.pendingTask = p.start()
      this.relaunchHint = true
    } catch (err) {
      log.warn(`Changement en attente non fait : ${(err as Error).message}`)
    }
    this.changed()
  }

  get hasPending(): boolean {
    return !!this.pending
  }

  /** Une tâche « longue » qui modifie le jeu est en cours (installation, retrait...) : pas de lancement de FiveM. */
  private get switching(): boolean {
    return !!this.running && /^(apply|remove|clean|stash|mod)-/.test(this.running.id)
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

  /** Fenêtre ramenée au premier plan après une page ouverte dans le navigateur (Google, Discord) ; rend `value`. */
  private toFront<T>(value: T): T {
    const w = this.getWindow()
    if (w && !w.isDestroyed()) {
      if (w.isMinimized()) w.restore()
      w.focus()
    }
    return value
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
        if (id === this.pendingTask) this.relaunchHint = false
        this.emit(IPC.task, { ...base, done: true, ok: false, error: message } satisfies TaskProgress)
      } finally {
        this.release()
      }
    })()
    return id
  }

  /** Fin d'une tâche : la place est libre (téléchargement qui attendait son tour, changement en attente...). */
  private release(): void {
    this.running = null
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const wake of waiters) wake()
    this.changed()
  }

  /** Attend qu'aucune tâche ne tourne puis prend la place. Rejette si `abort` est déclenché pendant l'attente. */
  private async takeTurn(id: string, abort: AbortController): Promise<void> {
    while (this.running) {
      await new Promise<void>((resolve, reject) => {
        if (abort.signal.aborted) return reject(new Error(t('market.errors.cancelled')))
        const wake = (): void => {
          abort.signal.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = (): void => {
          this.idleWaiters = this.idleWaiters.filter((w) => w !== wake)
          reject(new Error(t('market.errors.cancelled')))
        }
        this.idleWaiters.push(wake)
        abort.signal.addEventListener('abort', onAbort, { once: true })
      })
    }
    if (abort.signal.aborted) throw new Error(t('market.errors.cancelled'))
    this.running = { id, abort }
  }

  /**
   * Téléchargement de la file : l'archive est téléchargée sans bloquer les autres tâches, puis ajoutée à la bibliothèque
   * une fois la place libre (tâche « download », qui ne peut plus être annulée).
   */
  private async runDownload(job: DownloadJob, ctx: DownloadContext): Promise<unknown> {
    const { id, kind, name } = job
    const taskId = `download-${Date.now().toString(36)}`
    const base: TaskProgress = { taskId, kind: 'download', title: job.title, phase: '', current: 0, total: 0, done: false, detail: id }
    let held = false
    const lock = async (): Promise<void> => {
      ctx.setStatus('waiting')
      await this.takeTurn(taskId, ctx.abort)
      held = true
      ctx.setStatus('installing')
      this.emit(IPC.task, base)
    }
    let ok = false
    log.info(`Téléchargement démarré : ${job.title}`)
    try {
      const result =
        kind === 'build' ? await this.installBuild(job, ctx, lock) : job.claim ? await this.claimDownload(job, kind, ctx) : await this.installDownload(job, kind, ctx, lock)
      ok = true
      log.info(`Téléchargement terminé : ${job.title}`)
      return result
    } catch (err) {
      // Création : les fichiers déjà reçus restent en cache (reprise), le ménage les retire s'ils ne servent plus.
      if (kind === 'build') throw err
      if (ctx.signal.aborted) {
        await this.marketplace.discardDownload(id)
        throw err
      }
      // Maintenance : téléchargement en pause (son fichier partiel est gardé), repris à la fin de la maintenance.
      if (!(err instanceof MaintenanceError)) throw err
      await this.paused.pause({ id, kind, name, ...(job.claim ? { claim: true } : {}) })
      ok = true
      return { name, kind, status: 'paused' }
    } finally {
      if (held) {
        this.emit(IPC.task, { ...base, done: true, ok } satisfies TaskProgress)
        this.release()
      }
    }
  }

  private async installDownload(job: DownloadJob, kind: MarketKind, ctx: DownloadContext, lock: () => Promise<void>): Promise<unknown> {
    const { id } = job
    const hooks = {
      activeId: () => this.state.get().active?.packId ?? null,
      apply: (packId: string, r: Report) => this.installer.apply(packId, r),
      enableMod: (modId: string, r: Report) => this.enableIfFree(modId, r),
      replaceMod: (oldId: string, next: StoredManifest, r: Report) => this.installer.replaceMod(oldId, next, r),
      lock
    }
    const result = await this.marketplace.install(id, ctx.report, ctx.signal, hooks, kind)
    await this.paused.forget(id)
    // Nouvelle version d'un pack installé (ou d'un mod activé) dans une autre instance : l'ancienne version y reste en
    // place, rattachée à la nouvelle (la réinstaller depuis cette instance la met à jour).
    const oldId = job.localId
    if (result.status === 'updated' && oldId && result.packId !== oldId) await this.updateOthers((s) => relink(s, kind, oldId, result.packId))
    if (result.status !== 'up-to-date') {
      const summary = msg({ added: 'history.downloaded', updated: 'history.updated', linked: 'history.linked' }[result.status])
      await this.state.set(pushHistory(this.state.get(), { action: 'download', packName: result.name, ok: true, msg: summary }))
    }
    return result
  }

  /** Création de « Créer ton pack » : construite dans la bibliothèque, ou mise à jour (réinstallée si elle était installée). */
  private async installBuild(job: DownloadJob, ctx: DownloadContext, lock: () => Promise<void>): Promise<unknown> {
    const hooks = {
      activeId: () => this.state.get().active?.packId ?? null,
      apply: (packId: string, r: Report) => this.installer.apply(packId, r),
      lock
    }
    const result = await this.builder.install(job.id, ctx.report, ctx.signal, hooks)
    // Nouvelle version installée dans une autre instance : rattachée à la nouvelle (comme un pack de la Marketplace).
    const oldId = job.localId
    if (result.status === 'updated' && oldId && result.packId !== oldId) await this.updateOthers((s) => relink(s, 'pack', oldId, result.packId))
    if (result.status !== 'up-to-date') {
      const summary = msg(result.status === 'updated' ? 'history.builtUpdated' : 'history.built')
      await this.state.set(pushHistory(this.state.get(), { action: 'download', packName: result.name, ok: true, msg: summary }))
      void this.builder.pruneBlobs().catch(() => undefined)
    }
    return result
  }

  /** Met une création dans la file des téléchargements (vignette : l'image de son style ReShade ou de ses composants). */
  private async queueBuild(build: BuilderBuild): Promise<string> {
    const cover = await this.builder.coverOf(build).catch(() => null)
    const title = t(build.localId ? 'builder.tasks.update' : 'builder.tasks.install', { name: build.name })
    this.downloads.add({
      id: build.id,
      kind: 'build',
      name: build.name,
      coverId: null,
      coverUrl: cover ? coverUrl(cover, true) : null,
      claim: false,
      title,
      localId: build.localId
    })
    return build.id
  }

  private async claimDownload(job: DownloadJob, kind: MarketKind, ctx: DownloadContext): Promise<unknown> {
    const result = await this.marketplace.claim(job.id, ctx.report, ctx.signal, kind)
    await this.paused.forget(job.id)
    return { ...result, kind, status: 'claimed' }
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
      const builds = await this.builder.status().catch(() => ({ updates: [], gone: [] }))
      const foreign = await pendingForeign
      return {
        settings: this.settings.get(),
        games,
        state: this.state.get(),
        library: library.map(toPublic),
        mods: mods.map(toPublic),
        instances: await this.instanceSummaries(),
        foreign,
        accent: accentColor(),
        version: app.getVersion(),
        dataDir: this.dataDir,
        apiUrl: this.apiUrl,
        // Packs de « Créer ton pack » avec une nouvelle révision : signalés comme une nouvelle version.
        market: { updates: [...market.updates, ...builds.updates], gone: market.gone },
        owned: this.purchases.ownedPacks(),
        builder: { gone: builds.gone },
        pausedDownloads: this.paused.list().map(({ id, kind, name }) => ({ id, kind, name })),
        update: this.updater.state,
        game: { pending: this.pending && { title: this.pending.title, packId: this.pending.packId }, relaunch: this.relaunchHint }
      }
    },

    refreshGames: async () => {
      const g = await this.refreshGames()
      this.changed()
      return g
    },

    setGamePath: async (which: RootId, p: string | null) => {
      // Plusieurs instances : chacune garde son dossier FiveM (la détection suit le dernier FiveM lancé, quel qu'il soit).
      if (!p && which === 'fivem' && this.instanceList().length > 1) throw this.toError(t('instances.errors.autoDetect'))
      if (p) {
        // Vérifié avant d'être enregistré : on refuse un dossier qui n'est manifestement pas le bon.
        if (which === 'fivem') {
          const info = await inspectFiveM(await normalizeFiveMPath(p), t('games.source.manual'))
          if (!info.valid) throw this.toError(t('service.errors.notFiveMDir'))
          const other = info.path && this.fivemUsedBy(info.path, currentInstanceId(this.settings.get()))
          if (other) throw this.toError(t('instances.errors.folderUsed', { name: quote(other) }))
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
      const renamed = (s: AppState): AppState => (s.active?.packId === id ? { ...s, active: { ...s.active, packName: m.name } } : s)
      if (this.state.get().active?.packId === id) await this.state.set(renamed(this.state.get()))
      await this.updateOthers(renamed)
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
      const elsewhere = await this.usedElsewhere(id, 'pack')
      if (elsewhere) throw this.toError(t('instances.errors.packInstalled', { name: quote(elsewhere) }))
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

    applyPack: async (id: string, instanceId?: string) => {
      const m = await this.library.get(id)
      const current = currentInstanceId(this.settings.get())
      const target = this.instanceList().find((i) => i.id === (instanceId ?? current))
      if (!target) throw this.toError(t('instances.errors.notFound'))
      if (target.id === current) {
        const title = t('service.tasks.apply', { name: m.name })
        return this.whenGameClosed(title, id, () => this.startTask('apply', title, id, (report) => this.installer.apply(id, report)))
      }
      const title = t('instances.applyTask', { name: m.name, instance: target.name })
      return this.whenGameClosed(title, null, () =>
        this.startTask('apply', title, id, (report) => this.onInstance(target.id, (installer) => installer.apply(id, report)))
      )
    },

    removeActive: async (instanceId?: string) => {
      const current = currentInstanceId(this.settings.get())
      const target = this.instanceList().find((i) => i.id === (instanceId ?? current))
      if (!target) throw this.toError(t('instances.errors.notFound'))
      const a = target.id === current ? this.state.get().active : (await this.instanceState(target.id)).active
      if (!a) throw this.toError(t('service.errors.noActivePack'))
      const title = target.id === current ? t('service.tasks.remove', { name: a.packName }) : t('instances.removeTask', { name: a.packName, instance: target.name })
      return this.whenGameClosed(title, null, () =>
        this.startTask('remove', title, a.packId, (report) => this.onInstance(target.id, (installer) => installer.removeActive(report)))
      )
    },

    stashForeign: async (selection?: ForeignSelection[]) => {
      const title = t('service.tasks.stash')
      return this.whenGameClosed(title, null, () => this.startTask('stash', title, 'foreign', (report) => this.installer.stashForeign(report, selection)))
    },

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

    cleanGame: async (withMods?: boolean) => {
      const title = t('service.tasks.clean')
      return this.whenGameClosed(title, null, () => this.startTask('clean', title, 'game', (report) => this.installer.cleanGame(report, withMods === true)))
    },

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
      const elsewhere = await this.usedElsewhere(id, 'mod')
      if (elsewhere) throw this.toError(t('instances.errors.modEnabled', { name: quote(elsewhere) }))
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

    launchGame: async () => {
      if ((await runningGameProcesses()).length) throw this.toError(t('service.errors.gameAlreadyRunning'))
      if (this.switching) throw this.toError(t('service.errors.waitForSwitch'))
      const games = this.gamesCache ?? (await this.refreshGames())
      if (!games.fivem.valid || !games.fivem.path) throw this.toError(t('service.errors.fivemNotFound'))
      // FiveM.exe est à côté du dossier FiveM.app ; sinon le lien fivem:// (enregistré par FiveM à chaque lancement).
      const exe = path.join(path.dirname(games.fivem.path), 'FiveM.exe')
      if (await exists(exe)) await launchDetached(exe)
      else await shell.openExternal('fivem://')
      log.info('FiveM lancé depuis l’application')
      setTimeout(() => void this.watchGame(), 2500)
    },

    closeGame: async () => {
      let running = await runningGameProcesses()
      if (!running.length) return true
      // Fermeture demandée (le jeu enregistre ses réglages en quittant), puis arrêt forcé au bout de 6 secondes.
      await killProcesses(running, false)
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500))
        running = await runningGameProcesses()
        if (!running.length) break
        if (i === 11) await killProcesses(running, true)
      }
      await this.watchGame()
      if (running.length) throw this.toError(t('service.errors.gameDidNotClose'))
      log.info('FiveM fermé depuis l’application')
      return true
    },

    restartGame: async () => {
      await this.api.closeGame()
      // Le changement en attente part à la fermeture : attendu avant de relancer le jeu (30 minutes au plus).
      this.startPending()
      for (let i = 0; this.switching && i < 3600; i++) await new Promise((r) => setTimeout(r, 500))
      await this.api.launchGame()
    },

    cancelPending: async () => {
      if (this.pending) log.info(`Changement en attente abandonné : ${this.pending.title}`)
      this.pending = null
      this.changed()
    },

    setCloseToTray: async (on: boolean) => {
      await this.settings.patch({ closeToTray: on })
      this.changed()
    },

    machineProfile: () => this.machineProfile(),

    refreshMachine: () => this.machineProfile(true),

    setMachineOverride: async (override: HardwareOverride) => {
      const next: HardwareOverride = { ...this.settings.get().machine, ...override }
      const { gpuClass, vramMb } = next
      if (gpuClass != null && !(Number.isInteger(gpuClass) && gpuClass >= 0 && gpuClass <= 9)) throw this.toError(t('service.errors.invalidGpuClass'))
      if (vramMb != null && !(Number.isInteger(vramMb) && vramMb >= 256 && vramMb <= 256 * 1024))
        throw this.toError(t('service.errors.invalidVram', { min: formatMegabytes(256), max: formatMegabytes(256 * 1024) }))
      await this.settings.patch({ machine: { gpuClass: gpuClass ?? null, vramMb: vramMb ?? null } })
      return this.machineProfile()
    },

    moveLibrary: async (newDir: string) => {
      const oldDir = this.settings.get().libraryDir
      const target = path.resolve(newDir)
      if (path.resolve(oldDir).toLowerCase() === target.toLowerCase()) throw this.toError(t('service.errors.libraryAlreadyThere'))
      if (isInside(oldDir, target)) throw this.toError(t('service.errors.libraryInsideCurrent'))
      // Les téléchargements en cours écrivent dans la bibliothèque.
      if (this.downloads.busy) throw this.toError(t('service.errors.waitForDownloads'))
      if (this.state.get().active) throw this.toError(t('service.errors.removeInstalledPackFirst'))
      if (this.state.get().mods.some((m) => m.enabled)) throw this.toError(t('service.errors.disableModsFirst'))
      for (const { instance, state } of await this.otherInstances())
        if (state.active || state.mods.some((m) => m.enabled)) throw this.toError(t('instances.errors.libraryInUse', { name: quote(instance.name) }))
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

    packInUse: async (id: string) => this.state.get().active?.packId === id || !!(await this.usedElsewhere(id, 'pack')),

    confirm: async (message: string, detail: string, okLabel: string) => {
      const w = this.getWindow()
      const opts = { type: 'question' as const, message, detail, buttons: [okLabel, t('common.cancel')], defaultId: 0, cancelId: 1, noLink: true }
      const r = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts)
      return r.response === 0
    },

    marketList: (query: MarketQuery) => this.marketplace.list(query),

    marketTags: (kind?: MarketKind) => this.marketplace.tags(kind),

    marketCategories: () => this.marketplace.categories(),

    marketFeatured: (kind?: MarketKind) => this.marketplace.featured(kind),

    marketDetail: (idOrSlug: string, kind?: MarketKind) => this.marketplace.detail(idOrSlug, kind),

    marketPerformance: (id: string, kind?: MarketKind) => this.marketplace.performance(id, kind),

    marketInstall: async (id: string, kind: MarketKind = 'pack') => {
      const remote = await this.marketplace.detail(id, kind)
      const title = t(remote.updateAvailable ? 'service.tasks.update' : 'service.tasks.download', { name: remote.name })
      const job = { id: remote.id, kind, name: remote.name, coverId: (remote.cover ?? remote.images[0])?.id ?? null, claim: false, title, localId: remote.localId }
      this.downloads.add(job)
      return remote.id
    },

    marketClaim: async (id: string, kind: MarketKind = 'pack') => {
      if (!this.account.current()) throw this.toError(t('service.errors.signInToClaim'))
      const remote = await this.marketplace.detail(id, kind)
      const title = t('service.tasks.claim', { name: remote.name })
      this.downloads.add({ id: remote.id, kind, name: remote.name, coverId: (remote.cover ?? remote.images[0])?.id ?? null, claim: true, title })
      return remote.id
    },

    downloadsGet: async () => this.downloads.list(),

    downloadCancel: async (id: string) => {
      if (!this.downloads.cancel(id) && this.downloads.has(id)) throw this.toError(t('service.errors.downloadInstalling'))
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

    linksGet: async () => this.links.current,

    openAppLink: async (name: string) => {
      // Adresse lue ici, jamais reçue de l'interface ; ouverte dans le navigateur par défaut, en https seulement.
      const url = httpsUrl(this.links.current[name])
      if (!url) throw this.toError(t('service.errors.linkUnavailable'))
      await shell.openExternal(url)
    },

    packRatings: (packId: string, kind?: MarketKind) => this.community.ratings(packId, kind),

    packRate: (packId: string, stars: number | null, kind?: MarketKind) => this.community.rate(packId, stars, kind),

    packComments: (packId: string, query: CommentQuery, kind?: MarketKind) => this.community.comments(packId, query, kind),

    packCommentReplies: (packId: string, commentId: string, page: number, size?: number, kind?: MarketKind) =>
      this.community.replies(packId, commentId, page, size, kind),

    packCommentPost: (packId: string, body: string, parentId?: string, kind?: MarketKind) => this.community.post(packId, body, parentId, kind),

    packCommentEdit: (packId: string, commentId: string, body: string, kind?: MarketKind) => this.community.edit(packId, commentId, body, kind),

    packCommentDelete: (packId: string, commentId: string, kind?: MarketKind) => this.community.remove(packId, commentId, kind),

    packCommentReport: (packId: string, commentId: string, reason?: string, kind?: MarketKind) =>
      this.community.report(packId, commentId, reason, kind),

    adminCommentHide: (commentId: string, hidden: boolean, reason?: string) => this.community.hide(commentId, hidden, reason),

    adminCommentPin: (commentId: string, pinned: boolean) => this.community.pin(commentId, pinned),

    adminCommentDelete: (commentId: string) => this.community.purge(commentId),

    myDownloads: (page: number, kind?: MarketKind) => this.community.myDownloads(page, kind),

    builderCatalog: (refresh?: boolean) => this.builder.catalog(refresh === true),

    builderComponent: (id: string) => this.builder.component(id),

    builderToolView: (tool: ToolKey, tools: BuilderTools) => this.builder.toolView(tool, tools),

    builderToolEffect: (component: string | null, file: string) => this.builder.toolEffect(component, file),

    builderPreview: (components: string[], tools: BuilderTools) => this.builder.preview(components, tools),

    builderBuilds: () => this.builder.builds(),

    builderBuildGet: (id: string) => this.builder.build(id),

    builderBuildSave: async (id: string | null, input: BuilderSaveInput) => {
      const build = await this.builder.save(id, input)
      // Création installée modifiée : la mise à jour est signalée dans la bibliothèque.
      if (build.localId) this.changed()
      return build
    },

    builderBuildDelete: async (id: string) => {
      await this.builder.remove(id)
      this.changed()
    },

    builderInstall: async (id: string | null, input?: BuilderSaveInput) => {
      const build = input ? await this.builder.save(id, input) : id ? await this.builder.build(id) : null
      if (!build) throw this.toError(t('builder.errors.notFound'))
      return this.queueBuild(build)
    },

    builderStatus: async () => {
      await this.builder.refreshStatus()
      this.changed()
      return this.builder.status()
    },

    builderCacheInfo: () => this.builder.cacheInfo(),

    builderCacheClear: async () => {
      await this.builder.clearCache()
      log.info('Cache de « Créer ton pack » vidé')
    },

    builderBilling: () => this.builder.billing(),

    builderQuote: (input: QuoteInput) => this.builder.quote(input),

    builderCheckout: (input: CheckoutInput) => this.builder.checkout(input),

    builderUnlockBuild: (id: string) => this.builder.unlockBuild(id),

    saleInfo: () => this.purchases.saleInfo(),

    itemAccess: (kind: MarketKind, id: string) => this.purchases.access(kind, id),

    ownedPacks: async (refresh?: boolean) => (refresh ? this.purchases.refreshOwned(true) : this.purchases.ownedPacks()),

    itemQuote: (kind: MarketKind, id: string, promoCode: string | null) => this.purchases.quote(kind, id, promoCode),

    itemCheckout: (kind: MarketKind, id: string, input: ItemCheckoutInput) => this.purchases.checkout(kind, id, input),

    openCheckout: async (url: string) => {
      // Adresse reçue de l'API : seule la page de paiement de Stripe s'ouvre (une autre page https en développement).
      if (!isCheckoutUrl(url, !app.isPackaged)) throw this.toError(t('builder.errors.badCheckoutUrl'))
      await shell.openExternal(url)
    },

    purchaseGet: (id: string) => this.purchases.purchase(id),

    purchaseCancel: (id: string) => this.purchases.cancel(id),

    purchaseList: () => this.purchases.list(),

    accountGet: async () => this.account.current(),

    accountLogin: (login: string, password: string) => this.account.login(login, password),

    accountRegister: (email: string, password: string, displayName: string) => this.account.register(email, password, displayName),

    accountLoginGoogle: async (): Promise<AccountMe> => this.toFront(await this.account.loginWithGoogle()),

    accountCancelGoogle: async () => this.account.cancelGoogle(),

    accountLoginDiscord: async (): Promise<AccountMe> => this.toFront(await this.account.loginWithDiscord()),

    accountLinkDiscord: async (): Promise<AccountMe> => this.toFront(await this.account.linkDiscord()),

    accountCancelDiscord: async () => this.account.cancelDiscord(),

    accountDiscordApp: () => this.account.discordAppOpen(),

    accountDiscordInBrowser: () => this.account.discordInBrowser(),

    accountUnlinkDiscord: () => this.account.unlinkDiscord(),

    accountServerTag: () => this.account.serverTag(),

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

    reportError: async (message: string) => {
      log.error(`Interface : ${String(message).slice(0, 8000)}`)
    },

    getLanguage: async () => currentLocale(),

    getTheme: async () => this.settings.get().theme ?? 'system',

    setTheme: async (theme: ThemeChoice) => {
      if (!isThemeChoice(theme)) throw this.toError(t('service.errors.invalidTheme'))
      await this.settings.patch({ theme })
      this.applyNativeTheme()
      this.getWindow()?.setBackgroundColor(this.windowBackground())
      this.changed()
    },

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
      if (this.running || this.downloads.busy) throw this.toError(t('service.errors.waitForTask'))
      this.updater.install()
    },

    changelogGet: async () => this.whatsNew.current,

    dismissChangelog: () => this.whatsNew.dismiss(),

    changelogLatest: () => this.whatsNew.latest(),

    instanceAdd: async (fivemPath: string, name?: string) => {
      const info = await inspectFiveM(await normalizeFiveMPath(fivemPath), t('games.source.manual'))
      if (!info.valid || !info.path) throw this.toError(t('service.errors.notFiveMDir'))
      const used = this.fivemUsedBy(info.path, '')
      if (used) throw this.toError(t('instances.errors.folderUsed', { name: quote(used) }))
      const instance: FiveMInstance = { id: newId('i'), name: cleanName(name) || suggestedName(info.path), fivemPath: info.path, gtaPath: null }
      await this.addInstance(instance)
      log.info(`Instance ajoutée : ${instance.name} (${info.path})`)
      return instance
    },

    instanceRename: async (id: string, name: string) => {
      const clean = cleanName(name)
      if (!clean) throw this.toError(t('instances.errors.nameRequired'))
      const list = this.instanceList()
      if (!list.some((i) => i.id === id)) throw this.toError(t('instances.errors.notFound'))
      await this.settings.patch({ instances: list.map((i) => (i.id === id ? { ...i, name: clean } : i)), instance: currentInstanceId(this.settings.get()) })
      this.changed()
    },

    instanceRemove: async (id: string) => {
      const s = this.settings.get()
      const list = this.instanceList()
      const target = list.find((i) => i.id === id)
      if (!target) throw this.toError(t('instances.errors.notFound'))
      if (id === currentInstanceId(s)) throw this.toError(t('instances.errors.removeCurrent'))
      const state = await this.instanceState(id)
      if (state.active || state.mods.some((m) => m.enabled)) throw this.toError(t('instances.errors.removeInstalled', { name: quote(target.name) }))
      await this.settings.patch({ instances: list.filter((i) => i.id !== id), instance: currentInstanceId(s) })
      this.others.delete(id)
      await fs.rm(instanceStateFile(this.dataDir, id), { force: true }).catch(() => undefined)
      if (id !== MAIN_INSTANCE) await fs.rm(path.dirname(instanceStateFile(this.dataDir, id)), { recursive: true, force: true }).catch(() => undefined)
      log.info(`Instance supprimée : ${target.name}`)
      this.changed()
    },

    instanceSwitch: async (id: string) => {
      const s = this.settings.get()
      const from = currentInstanceId(s)
      const list = this.instanceList()
      const target = list.find((i) => i.id === id)
      if (!target) throw this.toError(t('instances.errors.notFound'))
      if (id === from) throw this.toError(t('instances.errors.alreadyCurrent'))
      // Une tâche ou un changement en attente porte sur l'instance active : il se termine avant.
      if (this.running) throw this.toError(t('errors.busy'))
      if (this.pending) throw this.toError(t('instances.errors.pendingChange'))
      this.others.set(from, this.state.get())
      // Fiche de l'instance quittée : ses dossiers (ceux des réglages), dossier FiveM fixé s'il était détecté.
      const instances = list.map((i) => (i.id === from ? { ...i, fivemPath: s.fivemPath ?? this.gamesCache?.fivem.path ?? null, gtaPath: s.gtaPath } : i))
      await this.settings.patch({ instances, instance: id, fivemPath: target.fivemPath, gtaPath: target.gtaPath })
      await this.state.open(instanceStateFile(this.dataDir, id), emptyState())
      const state = normalizeState(this.state.get())
      if (state !== this.state.get()) await this.state.set(state)
      this.others.delete(id)
      this.relaunchHint = false
      await this.refreshGames()
      log.info(`Instance active : ${target.name}`)
      this.changed()
    },

    instanceCreate: async (sourceId: string, parentDir: string, name: string, shortcut: boolean) => {
      const clean = cleanName(name)
      if (!clean) throw this.toError(t('instances.errors.nameRequired'))
      const current = currentInstanceId(this.settings.get())
      const source = this.instanceList().find((i) => i.id === sourceId)
      if (!source) throw this.toError(t('instances.errors.notFound'))
      const fivemApp = source.fivemPath ?? (sourceId === current ? (this.gamesCache?.fivem.path ?? null) : null)
      if (!fivemApp) throw this.toError(t('service.errors.fivemFolderNotFound'))
      if (!(await exists(path.join(path.dirname(fivemApp), 'FiveM.exe')))) throw this.toError(t('instances.errors.exeMissing'))
      const dest = path.join(parentDir, safeFileName(clean))
      if (isInside(path.dirname(fivemApp), dest) || samePath(path.dirname(fivemApp), dest)) throw this.toError(t('instances.errors.insideSource'))
      if ((await fs.readdir(dest).catch(() => [])).length) throw this.toError(t('service.errors.folderExists', { path: dest }))
      // FiveM lancé : ses fichiers sont ouverts (et ceux qu'il écrit changeraient pendant la copie).
      if ((await runningGameProcesses()).length) throw this.toError(t('instances.errors.closeGame'))
      const state = sourceId === current ? this.state.get() : await this.instanceState(sourceId)
      const managed = [...(samePath(state.active?.roots.fivem ?? null, fivemApp) ? state.active!.files : []), ...state.mods.filter((m) => m.enabled).flatMap((m) => m.files)]
      return this.startTask('instance', t('instances.createTask', { name: clean }), null, async (report, signal) => {
        report(t('instances.phase.preparing'), 0, 0)
        const plan = await copyPlan(fivemApp, dest, managed)
        const free = await freeSpace(parentDir)
        if (free !== null && free < plan.bytes + 200 * 1024 * 1024) throw this.toError(t('installer.errors.noSpace', { size: formatBytes(plan.bytes) }))
        log.info(`Copie de ${fivemApp} vers ${dest} (${plan.files.length} fichiers, ${formatBytes(plan.bytes)})`)
        try {
          await runCopy(plan, (done, total) => report(t('instances.phase.copying'), done, total), signal)
        } catch (err) {
          await fs.rm(dest, { recursive: true, force: true }).catch(() => undefined)
          throw err
        }
        const instance: FiveMInstance = { id: newId('i'), name: clean, fivemPath: path.join(dest, 'FiveM.app'), gtaPath: sourceId === current ? this.settings.get().gtaPath : source.gtaPath }
        await this.addInstance(instance)
        let shortcutError: string | null = null
        if (shortcut) await this.createShortcut(instance).catch((err: unknown) => (shortcutError = (err as Error).message))
        log.info(`Instance créée : ${clean} (${instance.fivemPath})`)
        return { name: clean, created: true, note: shortcutError }
      })
    },

    instanceShortcut: async (id: string) => {
      const instance = this.instanceList().find((i) => i.id === id)
      if (!instance) throw this.toError(t('instances.errors.notFound'))
      await this.createShortcut(instance)
    },

    instanceSetPackTarget: async (target: 'active' | 'ask') => {
      await this.settings.patch({ packTarget: target })
      this.changed()
    },

    maintenanceGet: async () => this.maintenance.current,

    maintenanceCheck: () => this.maintenance.check()
  }
}

/** Nom d'instance : espaces superflus retirés, 60 caractères au plus. */
function cleanName(name: string | undefined): string {
  return (name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
}

/**
 * État d'une autre instance rattaché à la nouvelle version d'un pack (ou d'un mod) qui remplace {@link oldId} dans la
 * bibliothèque. Renvoie le même objet s'il n'y a rien à changer.
 */
function relink(s: AppState, kind: MarketKind, oldId: string, newId: string): AppState {
  if (kind === 'mod')
    return s.mods.some((m) => m.id === oldId) ? { ...s, mods: s.mods.map((m) => (m.id === oldId ? { ...m, id: newId } : m)) } : s
  if (s.active?.packId !== oldId) return s
  const mods = s.mods.map((m) => ({ ...m, shadowed: m.shadowed.map((f) => (f.packId === oldId ? { ...f, packId: newId } : f)) }))
  return { ...s, active: { ...s.active, packId: newId }, mods }
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

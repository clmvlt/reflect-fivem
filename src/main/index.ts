import os from 'node:os'
import path from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, net, protocol, screen, session, shell, Tray } from 'electron'
import { IPC, tagApiError } from '@shared/api'
import { t } from 'i18next'
import { initI18n } from '@shared/i18n'
import { ApiError } from './core/account'
import { resolveDataDir } from './core/dataDir'
import { describeLink, findDeepLink, type MarketLink, parseMarketLink, PROTOCOL } from './core/deepLink'
import { EXEC_FLAG, LOCALE_FLAG, runElevatedWorker } from './core/elevation'
import { Service } from './service'
import { isInside } from './util/fsx'
import { log } from './util/log'
import trayIconFile from '../../resources/icon.png?asset'

const isElevatedWorker = process.argv.some((a) => a.startsWith(EXEC_FLAG))

if (isElevatedWorker) {
  // Processus administrateur éphémère : exécute un plan puis quitte, sans fenêtre.
  app.setPath('userData', path.join(os.tmpdir(), 'reflect-fivem-elevated'))
  app.disableHardwareAcceleration()
  initI18n(process.argv.find((a) => a.startsWith(LOCALE_FLAG))?.slice(LOCALE_FLAG.length) ?? 'fr')
  void app.whenReady().then(async () => {
    const code = await runElevatedWorker(process.argv)
    app.exit(code)
  })
} else {
  startApp()
}

function startApp(): void {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  // PM_DATA_DIR : dossier de données alternatif (tests, installation portable).
  const { dir: dataDir, note } = process.env.PM_DATA_DIR ? { dir: process.env.PM_DATA_DIR, note: null } : resolveDataDir(localAppData)
  app.setPath('userData', path.join(dataDir, 'app'))
  log.init(path.join(dataDir, 'logs'))
  if (note) log.info(note)

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  // Notifications de Windows (maintenance prévue) : même identifiant que le raccourci créé par l'installateur (appId).
  if (process.platform === 'win32') app.setAppUserModelId('fr.fivem.packmanager')

  protocol.registerSchemesAsPrivileged([{ scheme: 'pm-media', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

  // Adresse de l'API (Marketplace et mises à jour) : production, sauf en développement (npm run dev) où l'API
  // tourne sur le poste. PM_API_URL force une autre adresse (tests).
  const devServer = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL
  const apiUrl = (process.env.PM_API_URL || (devServer ? 'http://192.168.1.13:8080/api' : 'https://reflect-fivem.com/api')).replace(/\/+$/, '')

  registerProtocol()

  let win: BrowserWindow | null = null
  const service = new Service(dataDir, () => win, apiUrl)

  // Lien « fivem-pack-manager://pack/<id> », « …://mod/<id> » ou « …://achat/<id> » (fin d'un paiement sur le site) :
  // gardé jusqu'à ce que la page de l'application soit chargée.
  let pendingLink: MarketLink | null = null
  let pageLoaded = false
  const sendPendingLink = (): void => {
    if (!pendingLink || !pageLoaded || !win || win.isDestroyed()) return
    if (pendingLink.kind === 'achat') win.webContents.send(IPC.openPurchase, pendingLink.id)
    else win.webContents.send(IPC.openMarketPack, pendingLink.id, pendingLink.kind)
    pendingLink = null
  }
  const receiveLink = (argv: readonly string[]): void => {
    const link = findDeepLink(argv)
    if (!link) return
    const target = parseMarketLink(link)
    if (!target) {
      log.warn(`Lien ignoré : ${describeLink(link)}`)
      return
    }
    log.info(`Lien reçu : ${target.kind} ${target.id}`)
    pendingLink = target
    sendPendingLink()
  }
  receiveLink(process.argv)

  app.on('second-instance', (_e, argv) => {
    receiveLink(argv)
    if (win) bringToFront(win)
  })

  app.on('window-all-closed', () => app.quit())
  // Vraie fermeture (Quitter, mise à jour) : la fenêtre n'est plus seulement cachée.
  let quitting = false
  app.on('before-quit', () => {
    quitting = true
  })
  let tray: Tray | null = null

  void app.whenReady().then(async () => {
    await service.init()
    log.info(`Démarrage v${app.getVersion()}, données : ${dataDir}`)

    // Images des packs : pm-media://pack/<id>/<chemin>, limité au dossier de la bibliothèque.
    // Images de la Marketplace : pm-media://market/<pack>/<image>[?size=thumb][&kind=mod], mises en cache sur le disque.
    // Photos des comptes : pm-media://avatar/<compte>/<version>, même cache.
    // Images des composants de « Créer ton pack » : pm-media://builder/<composant>/<image>[?size=thumb], des styles
    // d'ambiance : pm-media://builder-style/<style>/<version>[?size=thumb], et images de référence en jeu de l'aperçu :
    // pm-media://builder-reference/<image>/<version>[?size=thumb] ; en cache aussi.
    protocol.handle('pm-media', (req) => {
      const url = new URL(req.url)
      const parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p))
      if (url.host === 'market') {
        if (parts.length !== 2) return new Response('Interdit', { status: 403 })
        const kind = url.searchParams.get('kind') === 'mod' ? 'mod' : 'pack'
        return service.marketplace.image(parts[0], parts[1], url.searchParams.get('size') === 'thumb', kind)
      }
      if (url.host === 'builder') {
        if (parts.length !== 2) return new Response('Interdit', { status: 403 })
        return service.builder.image(parts[0], parts[1], url.searchParams.get('size') === 'thumb')
      }
      if (url.host === 'builder-style') {
        if (parts.length !== 2) return new Response('Interdit', { status: 403 })
        return service.builder.styleImage(parts[0], parts[1], url.searchParams.get('size') === 'thumb')
      }
      if (url.host === 'builder-reference') {
        if (parts.length !== 2) return new Response('Interdit', { status: 403 })
        return service.builder.referenceImage(parts[0], parts[1], url.searchParams.get('size') === 'thumb')
      }
      if (url.host === 'avatar') {
        if (parts.length !== 2) return new Response('Interdit', { status: 403 })
        return service.marketplace.avatar(parts[0], parts[1])
      }
      // Images des mods : pm-media://mod/<id>/<chemin>, limité au dossier de la bibliothèque des mods.
      const lib = url.host === 'mod' ? service.modLibrary.dir : service.library.dir
      const file = path.resolve(lib, ...parts)
      if ((url.host !== 'pack' && url.host !== 'mod') || !isInside(lib, file) || !/\.(png|jpe?g|webp|gif|bmp)$/i.test(file)) return new Response('Interdit', { status: 403 })
      return net.fetch(pathToFileURL(file).toString())
    })

    if (app.isPackaged) {
      // Page de l'application seulement : le lecteur YouTube (dans un cadre) garde ses propres règles.
      session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
        if (details.resourceType !== 'mainFrame') return cb({})
        cb({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [
              "default-src 'self'; img-src 'self' pm-media: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src https://www.youtube-nocookie.com"
            ]
          }
        })
      })
    }

    // Vidéos des packs : YouTube refuse de lire une vidéo intégrée sans l'adresse de la page qui l'affiche (« Erreur
    // 153 »), et une page chargée depuis un fichier n'en donne pas. On présente celle du site des packs.
    const referer = service.marketplace.siteUrl('/')
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://www.youtube-nocookie.com/*'] }, (details, cb) => {
      const headers = details.requestHeaders
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'referer')) headers.Referer = referer
      cb({ requestHeaders: headers })
    })

    ipcMain.handle(IPC.invoke, async (_e, method: string, args: unknown[]) => {
      const fn = (service.api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]
      if (typeof fn !== 'function') throw new Error(t('errors.unknownMethod', { method }))
      try {
        return await fn(...args)
      } catch (err) {
        log.warn(`${method} : ${(err as Error).message}`)
        // Statut et code de l'erreur de l'API : perdus dans l'IPC, ajoutés au message (l'interface s'en sert).
        if (err instanceof ApiError) throw new Error(tagApiError(err.message, err.status, err.code))
        throw err
      }
    })

    Menu.setApplicationMenu(null)
    win = createWindow(path.join(dataDir, 'window.json'), service.windowBackground())
    tray = createTray(service, () => win)
    // Fermer la fenêtre la cache : l'application reste dans la zone de notification (sauf si désactivé dans les réglages).
    win.on('close', (e) => {
      if (quitting || service.settings.get().closeToTray === false || !tray) return
      e.preventDefault()
      win?.hide()
    })
    // Lancée par un lien : au premier plan dès son affichage (après le show() de createWindow).
    if (pendingLink) win.once('ready-to-show', () => win && bringToFront(win))
    // isLoading() est encore vrai pendant did-finish-load : d'où l'indicateur.
    win.webContents.on('did-finish-load', () => {
      pageLoaded = true
      sendPendingLink()
    })
    service.startBackground()
    // Liens modifiables depuis le site, compte (droits donnés ou retirés par l'admin, comme « Peut créer un pack ») et
    // packs payants à soi (achetés sur le site, offerts par l'admin) : relus quand la fenêtre reprend le focus, au plus
    // une fois par minute.
    win.on('focus', () => {
      void service.links.refresh()
      service.account.refreshIfStale().catch((err: unknown) => log.info(`Compte non vérifié : ${(err as Error).message}`))
      void service.purchases.refreshOwned()
    })
    nativeTheme.on('updated', () => win?.setBackgroundColor(service.windowBackground()))
    // Fenêtre vide ou figée sans erreur de l'interface : processus de la page arrêté (rechargé), page qui ne répond plus,
    // processus de la carte graphique arrêté. Noté dans le journal pour en trouver la cause.
    win.webContents.on('render-process-gone', (_e, d) => {
      log.error(`Interface : processus de la page arrêté (${d.reason}, code ${d.exitCode})`)
      if (d.reason !== 'clean-exit' && win && !win.isDestroyed()) win.webContents.reload()
    })
    win.on('unresponsive', () => log.warn('Interface : la page ne répond plus'))
    win.on('responsive', () => log.info('Interface : la page répond de nouveau'))
    app.on('child-process-gone', (_e, d) => {
      if (d.type === 'GPU') log.warn(`Interface : processus graphique arrêté (${d.reason}, code ${d.exitCode})`)
    })
  })
}

/** Icône de la zone de notification : ouvrir la fenêtre, lancer ou fermer FiveM, quitter. */
function createTray(service: Service, getWindow: () => BrowserWindow | null): Tray {
  const tray = new Tray(nativeImage.createFromPath(trayIconFile).resize({ width: 16, height: 16, quality: 'best' }))
  tray.setToolTip('Reflect FiveM')
  const show = (): void => {
    const w = getWindow()
    if (w && !w.isDestroyed()) bringToFront(w)
  }
  const attempt = (fn: () => Promise<unknown>): void => {
    fn().catch((err: unknown) => tray.displayBalloon({ iconType: 'warning', title: 'Reflect FiveM', content: (err as Error).message }))
  }
  const update = (): void => {
    const running = service.gameRunning
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: t('tray.open'), click: show },
        { type: 'separator' },
        ...(running
          ? [
              ...(service.hasPending ? [{ label: t('tray.restart'), click: () => attempt(() => service.api.restartGame()) }] : []),
              { label: t('tray.close'), click: () => attempt(() => service.api.closeGame()) }
            ]
          : [{ label: t('tray.launch'), click: () => attempt(() => service.api.launchGame()) }]),
        { type: 'separator' },
        { label: t('tray.quit'), click: () => app.quit() }
      ])
    )
    tray.setToolTip(running ? t('tray.running') : 'Reflect FiveM')
  }
  tray.on('click', show)
  service.onStateChange = update
  update()
  return tray
}

/**
 * Associe les liens « fivem-pack-manager:// » à cet exécutable (HKCU). L'installateur le fait aussi ; ici pour la version
 * portable (le .exe portable, pas sa copie décompressée dans le dossier temporaire) et en développement (electron relancé
 * avec le dossier de l'application : getAppPath plutôt que argv[1], qui peut être une option comme --inspect).
 */
function registerProtocol(): void {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE
  const ok = !app.isPackaged
    ? app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [app.getAppPath()])
    : portable
      ? app.setAsDefaultProtocolClient(PROTOCOL, portable, [])
      : app.setAsDefaultProtocolClient(PROTOCOL)
  if (!ok) log.warn(`Liens ${PROTOCOL}:// non associés à l'application.`)
}

/** Fenêtre au premier plan (lien reçu, application relancée) : le site vérifie que sa page perd le focus. */
function bringToFront(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  // Windows peut refuser le premier plan à une application en arrière-plan, sans que isFocused() le montre (il reste
  // vrai) : la passer un instant au-dessus des autres fenêtres dans tous les cas.
  win.setAlwaysOnTop(true)
  win.focus()
  win.setAlwaysOnTop(false)
}

interface Bounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
  /** Version du format : une taille enregistrée avant la version 2 était l'ancienne taille par défaut, plus petite. */
  v?: number
}

const DEFAULT_SIZE = { width: 1120, height: 780 }

/** Taille enregistrée à la fermeture ; sinon la taille par défaut, réduite si l'écran est plus petit. */
function initialBounds(boundsFile: string): Bounds {
  let saved: Bounds | null = null
  try {
    saved = JSON.parse(readFileSync(boundsFile, 'utf8')) as Bounds
  } catch {
    /* première ouverture */
  }
  const work = screen.getPrimaryDisplay().workAreaSize
  const fallback: Bounds = {
    width: Math.min(DEFAULT_SIZE.width, work.width - 40),
    height: Math.min(DEFAULT_SIZE.height, work.height - 40),
    maximized: saved?.maximized
  }
  if (!saved || saved.v !== 2) return fallback
  // Position gardée seulement si la fenêtre reste visible sur un écran branché.
  const visible =
    saved.x !== undefined &&
    saved.y !== undefined &&
    screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return saved.x! < a.x + a.width - 80 && saved.x! + saved.width > a.x + 80 && saved.y! >= a.y - 10 && saved.y! < a.y + a.height - 80
    })
  return visible ? saved : { ...fallback, width: saved.width, height: saved.height }
}

/** `background` : même fond que l'interface (thème choisi), pas d'éclair d'une autre couleur à l'ouverture. */
function createWindow(boundsFile: string, background: string): BrowserWindow {
  const bounds = initialBounds(boundsFile)
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 560,
    minHeight: 420,
    show: false,
    backgroundColor: background,
    title: 'Reflect FiveM',
    icon: path.join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  win.once('ready-to-show', () => {
    if (bounds.maximized) win.maximize()
    win.show()
  })
  win.on('close', () => {
    try {
      writeFileSync(boundsFile, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized(), v: 2 }))
    } catch {
      /* sans importance */
    }
  })

  // Aucune navigation hors de l'application (ex. un fichier lâché à côté de la zone d'import).
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost') || app.isPackaged) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  return win
}

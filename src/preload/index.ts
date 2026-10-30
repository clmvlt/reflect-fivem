import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { PackManagerApi } from '../shared/api'
import type { AccountMe, DownloadDone, DownloadItem, MarketKind, TaskProgress, UpdateState } from '../shared/types'
import type { MaintenanceState } from '../shared/maintenance'
import type { AppLinks } from '../shared/links'
import type { WhatsNew } from '../shared/changelog'

// Canaux dupliqués ici : un preload « sandbox » ne peut importer que le module electron.
const IPC = {
  invoke: 'pm:invoke',
  task: 'pm:task',
  downloads: 'pm:downloads',
  downloadDone: 'pm:download-done',
  changed: 'pm:changed',
  update: 'pm:update',
  account: 'pm:account',
  language: 'pm:language',
  maintenance: 'pm:maintenance',
  links: 'pm:links',
  changelog: 'pm:changelog',
  openMarketPack: 'pm:open-market-pack',
  openPurchase: 'pm:open-purchase'
}

const call =
  (method: string) =>
  (...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(IPC.invoke, method, args)

const methods = [
  'getOverview',
  'refreshGames',
  'setGamePath',
  'pickFolder',
  'pickArchives',
  'importPacks',
  'renamePack',
  'updatePack',
  'resetUserConfigs',
  'getComponentFiles',
  'setCover',
  'setCoverFromFile',
  'setReshadePreset',
  'setFpsLimit',
  'deletePack',
  'openPackFolder',
  'applyPack',
  'removeActive',
  'stashForeign',
  'scanForeign',
  'cacheInfo',
  'clearCache',
  'moveScreenshots',
  'trashScreenshots',
  'openScreenshots',
  'cleanGame',
  'pickModFiles',
  'importMods',
  'modPreflight',
  'setModEnabled',
  'disableAllMods',
  'deleteMod',
  'openModFolder',
  'getGraphics',
  'saveGraphics',
  'restoreGraphics',
  'launchGame',
  'closeGame',
  'restartGame',
  'cancelPending',
  'cancelTask',
  'setCloseToTray',
  'machineProfile',
  'refreshMachine',
  'setMachineOverride',
  'moveLibrary',
  'openPath',
  'packInUse',
  'confirm',
  'marketList',
  'marketTags',
  'marketCategories',
  'marketFeatured',
  'marketDetail',
  'marketPerformance',
  'marketInstall',
  'downloadsGet',
  'downloadCancel',
  'marketClaim',
  'marketAuthors',
  'marketAuthor',
  'openSite',
  'openLink',
  'linksGet',
  'openAppLink',
  'packRatings',
  'packRate',
  'packComments',
  'packCommentReplies',
  'packCommentPost',
  'packCommentEdit',
  'packCommentDelete',
  'packCommentReport',
  'adminCommentHide',
  'adminCommentPin',
  'adminCommentDelete',
  'myDownloads',
  'builderCatalog',
  'builderComponent',
  'builderToolView',
  'builderToolEffect',
  'builderPreview',
  'builderBuilds',
  'builderBuildGet',
  'builderBuildSave',
  'builderBuildDelete',
  'builderInstall',
  'builderStatus',
  'builderCacheInfo',
  'builderCacheClear',
  'builderBilling',
  'builderQuote',
  'builderCheckout',
  'builderUnlockBuild',
  'saleInfo',
  'itemAccess',
  'ownedPacks',
  'itemQuote',
  'itemCheckout',
  'openCheckout',
  'purchaseGet',
  'purchaseCancel',
  'purchaseList',
  'accountGet',
  'accountLogin',
  'accountRegister',
  'accountLoginGoogle',
  'accountCancelGoogle',
  'accountLoginDiscord',
  'accountLinkDiscord',
  'accountCancelDiscord',
  'accountDiscordApp',
  'accountDiscordInBrowser',
  'accountUnlinkDiscord',
  'accountServerTag',
  'accountLogout',
  'accountProfile',
  'accountSaveProfile',
  'accountPickAvatar',
  'accountRemoveAvatar',
  'accountChangePassword',
  'reportError',
  'getLanguage',
  'getTheme',
  'setTheme',
  'setLanguage',
  'listLanguages',
  'checkForUpdates',
  'installUpdate',
  'changelogGet',
  'dismissChangelog',
  'changelogLatest',
  'instanceAdd',
  'instanceRename',
  'instanceRemove',
  'instanceSwitch',
  'instanceCreate',
  'instanceShortcut',
  'instanceSetPackTarget',
  'maintenanceGet',
  'maintenanceCheck',
  'optimizationsGet',
  'optimizationsApply',
  'optimizationsRevert',
  'optimizationsOpen'
] as const

const api = Object.fromEntries(methods.map((m) => [m, call(m)])) as unknown as PackManagerApi

api.getPathForFile = (file: File) => webUtils.getPathForFile(file)
api.onTask = (cb: (p: TaskProgress) => void) => {
  const h = (_e: unknown, p: TaskProgress): void => cb(p)
  ipcRenderer.on(IPC.task, h)
  return () => ipcRenderer.removeListener(IPC.task, h)
}
api.onDownloads = (cb: (items: DownloadItem[]) => void) => {
  const h = (_e: unknown, items: DownloadItem[]): void => cb(items)
  ipcRenderer.on(IPC.downloads, h)
  return () => ipcRenderer.removeListener(IPC.downloads, h)
}
api.onDownloadDone = (cb: (d: DownloadDone) => void) => {
  const h = (_e: unknown, d: DownloadDone): void => cb(d)
  ipcRenderer.on(IPC.downloadDone, h)
  return () => ipcRenderer.removeListener(IPC.downloadDone, h)
}
api.onChanged = (cb: () => void) => {
  const h = (): void => cb()
  ipcRenderer.on(IPC.changed, h)
  return () => ipcRenderer.removeListener(IPC.changed, h)
}

api.onUpdate = (cb: (s: UpdateState) => void) => {
  const h = (_e: unknown, s: UpdateState): void => cb(s)
  ipcRenderer.on(IPC.update, h)
  return () => ipcRenderer.removeListener(IPC.update, h)
}

api.onAccount = (cb: (me: AccountMe | null) => void) => {
  const h = (_e: unknown, me: AccountMe | null): void => cb(me)
  ipcRenderer.on(IPC.account, h)
  return () => ipcRenderer.removeListener(IPC.account, h)
}

api.onLanguage = (cb: (code: string) => void) => {
  const h = (_e: unknown, code: string): void => cb(code)
  ipcRenderer.on(IPC.language, h)
  return () => ipcRenderer.removeListener(IPC.language, h)
}

api.onMaintenance = (cb: (state: MaintenanceState) => void) => {
  const h = (_e: unknown, state: MaintenanceState): void => cb(state)
  ipcRenderer.on(IPC.maintenance, h)
  return () => ipcRenderer.removeListener(IPC.maintenance, h)
}

api.onLinks = (cb: (links: AppLinks) => void) => {
  const h = (_e: unknown, links: AppLinks): void => cb(links)
  ipcRenderer.on(IPC.links, h)
  return () => ipcRenderer.removeListener(IPC.links, h)
}

api.onChangelog = (cb: (whatsNew: WhatsNew | null) => void) => {
  const h = (_e: unknown, whatsNew: WhatsNew | null): void => cb(whatsNew)
  ipcRenderer.on(IPC.changelog, h)
  return () => ipcRenderer.removeListener(IPC.changelog, h)
}

// Pack ou mod demandé par un lien du site : gardé s'il arrive avant que l'interface ne s'abonne (démarrage).
const marketPackListeners = new Set<(id: string, kind: MarketKind) => void>()
let pendingMarketPack: { id: string; kind: MarketKind } | null = null
ipcRenderer.on(IPC.openMarketPack, (_e: unknown, id: string, kind: MarketKind) => {
  if (marketPackListeners.size) marketPackListeners.forEach((cb) => cb(id, kind))
  else pendingMarketPack = { id, kind }
})
api.onOpenMarketPack = (cb: (id: string, kind: MarketKind) => void) => {
  marketPackListeners.add(cb)
  if (pendingMarketPack) {
    cb(pendingMarketPack.id, pendingMarketPack.kind)
    pendingMarketPack = null
  }
  return () => {
    marketPackListeners.delete(cb)
  }
}

// Achat signalé par la page de fin de paiement du site : gardé de même jusqu'au premier abonné.
const purchaseListeners = new Set<(id: string) => void>()
let pendingPurchase: string | null = null
ipcRenderer.on(IPC.openPurchase, (_e: unknown, id: string) => {
  if (purchaseListeners.size) purchaseListeners.forEach((cb) => cb(id))
  else pendingPurchase = id
})
api.onOpenPurchase = (cb: (id: string) => void) => {
  purchaseListeners.add(cb)
  if (pendingPurchase) {
    cb(pendingPurchase)
    pendingPurchase = null
  }
  return () => {
    purchaseListeners.delete(cb)
  }
}

contextBridge.exposeInMainWorld('api', api)

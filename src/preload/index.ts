import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { PackManagerApi } from '../shared/api'
import type { AccountMe, MarketKind, TaskProgress, UpdateState } from '../shared/types'

// Canaux dupliqués ici : un preload « sandbox » ne peut importer que le module electron.
const IPC = {
  invoke: 'pm:invoke',
  task: 'pm:task',
  changed: 'pm:changed',
  update: 'pm:update',
  account: 'pm:account',
  language: 'pm:language',
  openMarketPack: 'pm:open-market-pack'
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
  'moveLibrary',
  'openPath',
  'packMenu',
  'confirm',
  'popupMenu',
  'marketList',
  'marketTags',
  'marketCategories',
  'marketFeatured',
  'marketDetail',
  'marketInstall',
  'marketAuthors',
  'marketAuthor',
  'openSite',
  'openLink',
  'openDiscordInvite',
  'accountGet',
  'accountLogin',
  'accountRegister',
  'accountLoginGoogle',
  'accountCancelGoogle',
  'accountLogout',
  'accountProfile',
  'accountSaveProfile',
  'accountPickAvatar',
  'accountRemoveAvatar',
  'accountChangePassword',
  'getLanguage',
  'setLanguage',
  'listLanguages',
  'checkForUpdates',
  'installUpdate'
] as const

const api = Object.fromEntries(methods.map((m) => [m, call(m)])) as unknown as PackManagerApi

api.getPathForFile = (file: File) => webUtils.getPathForFile(file)
api.onTask = (cb: (p: TaskProgress) => void) => {
  const h = (_e: unknown, p: TaskProgress): void => cb(p)
  ipcRenderer.on(IPC.task, h)
  return () => ipcRenderer.removeListener(IPC.task, h)
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

contextBridge.exposeInMainWorld('api', api)

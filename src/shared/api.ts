import type {
  AccountMe,
  AccountProfile,
  AuthorPage,
  AuthorProfile,
  ForeignItem,
  GamesInfo,
  MarketPack,
  MarketPackDetail,
  MarketPage,
  MarketTag,
  Overview,
  PackManifest,
  PackPatch,
  ProfileInput,
  RootId,
  TaskProgress,
  UpdateState
} from './types'
import type { GraphicsState, GraphicsTarget } from './graphics'

export interface ComponentFile {
  rel: string
  size: number
  dest: string | null
}

export interface ForeignSelection {
  root: RootId
  path: string
  isDir: boolean
}

/** API exposée à l'interface par le preload (window.api). */
export interface PackManagerApi {
  getOverview(): Promise<Overview>
  refreshGames(): Promise<GamesInfo>
  setGamePath(which: RootId, path: string | null): Promise<GamesInfo>
  pickFolder(title: string, defaultPath?: string): Promise<string | null>
  pickArchives(): Promise<string[]>
  getPathForFile(file: File): string

  importPacks(paths: string[]): Promise<string>
  renamePack(id: string, name: string): Promise<PackManifest>
  updatePack(id: string, patch: PackPatch): Promise<PackManifest>
  resetUserConfigs(id: string): Promise<PackManifest>
  getComponentFiles(packId: string, componentId: string): Promise<ComponentFile[]>
  /** Image du pack : une image de sa galerie (chemin relatif au pack) ou null pour revenir au choix automatique. */
  setCover(id: string, rel: string | null): Promise<PackManifest>
  /** Choisit une image sur le disque (les captures ReShade sont proposées par défaut). */
  setCoverFromFile(id: string): Promise<PackManifest | null>
  /** Preset ReShade chargé à chaque installation du pack. */
  setReshadePreset(id: string, rel: string): Promise<PackManifest>
  deletePack(id: string): Promise<string>
  openPackFolder(id: string): Promise<void>

  applyPack(id: string): Promise<string>
  removeActive(): Promise<string>
  stashForeign(selection?: ForeignSelection[]): Promise<string>

  scanForeign(): Promise<ForeignItem[]>
  cacheInfo(): Promise<{ size: number } | null>
  clearCache(): Promise<string>
  moveScreenshots(): Promise<string>
  /** Met les captures d'écran ReShade du dossier plugins à la corbeille. */
  trashScreenshots(): Promise<string>
  /** Ouvre le dossier des captures : plugins de FiveM, ou Images\FiveM (créé si besoin). */
  openScreenshots(where: 'plugins' | 'pictures'): Promise<void>
  /** Retire le pack installé et range les mods installés à la main : le jeu redevient d'origine. */
  cleanGame(): Promise<string>

  /** Réglages graphiques du jeu (null si aucun fichier de réglages n'a été trouvé). */
  getGraphics(target?: GraphicsTarget['id']): Promise<GraphicsState | null>
  saveGraphics(target: GraphicsTarget['id'], changes: Record<string, string>): Promise<GraphicsState>
  restoreGraphics(target: GraphicsTarget['id']): Promise<GraphicsState>
  /**
   * Limite d'images par seconde (null = celle du pack, 0 = aucune limite), écrite dans l'enblocal.ini (ENB) des packs
   * et appliquée tout de suite au pack installé. Renvoie le nombre de fichiers du jeu mis à jour.
   */
  setFpsLimit(limit: number | null): Promise<number>

  moveLibrary(newDir: string): Promise<string>
  openPath(p: string): Promise<void>

  /** Menu contextuel natif d'un pack. */
  packMenu(id: string): Promise<'rename' | 'image' | 'open' | 'delete' | null>
  /** Boîte de confirmation native de Windows. */
  confirm(message: string, detail: string, okLabel: string): Promise<boolean>

  /** Packs publiés sur la Marketplace. */
  marketList(query: MarketQuery): Promise<MarketPage>
  marketTags(): Promise<MarketTag[]>
  /** Packs mis en avant (« Pack du moment »), le plus récent en premier ; liste vide en cas d'erreur. */
  marketFeatured(): Promise<MarketPack[]>
  marketDetail(idOrSlug: string): Promise<MarketPackDetail>
  /** Télécharge le pack (ou sa nouvelle version) et l'ajoute à la bibliothèque. */
  marketInstall(id: string): Promise<string>
  /** Auteurs ayant au moins un pack publié. */
  marketAuthors(query: AuthorQuery): Promise<AuthorPage>
  /** Page publique d'un auteur (adresse ou identifiant de son compte). */
  marketAuthor(slugOrId: string): Promise<AuthorProfile>
  /** Ouvre une page du site des packs dans le navigateur (« /packs/<adresse> », « /application »). */
  openSite(path: string): Promise<void>
  /** Ouvre un lien (http ou https seulement) dans le navigateur. */
  openLink(url: string): Promise<void>
  /** Ouvre une invitation Discord dans l'application Discord si elle est installée, sinon dans le navigateur. */
  openDiscordInvite(code: string): Promise<void>

  /** Compte connecté sur cet appareil (gardé localement, vérifié en arrière-plan), null sans compte. */
  accountGet(): Promise<AccountMe | null>
  /** Connexion par e-mail (ou identifiant) et mot de passe. */
  accountLogin(login: string, password: string): Promise<AccountMe>
  accountRegister(email: string, password: string, displayName: string): Promise<AccountMe>
  /** Ouvre la connexion Google dans le navigateur et attend son retour (5 minutes au plus). */
  accountLoginGoogle(): Promise<AccountMe>
  /** Abandonne la connexion Google en attente. */
  accountCancelGoogle(): Promise<void>
  accountLogout(): Promise<void>
  accountProfile(): Promise<AccountProfile>
  accountSaveProfile(input: ProfileInput): Promise<AccountProfile>
  /** Choisit une photo sur le disque et l'envoie (null si aucun fichier n'a été choisi). */
  accountPickAvatar(): Promise<AccountProfile | null>
  accountRemoveAvatar(): Promise<AccountProfile>
  /** currentPassword : null pour un compte qui n'a pas encore de mot de passe. */
  accountChangePassword(currentPassword: string | null, newPassword: string): Promise<AccountMe>

  /** Recherche une mise à jour ; une nouvelle version est ensuite téléchargée et vérifiée automatiquement. */
  checkForUpdates(): Promise<UpdateState>
  /** Ferme l'application et installe tout de suite la mise à jour téléchargée et vérifiée. */
  installUpdate(): Promise<void>

  onTask(cb: (p: TaskProgress) => void): () => void
  onChanged(cb: () => void): () => void
  onUpdate(cb: (s: UpdateState) => void): () => void
  /** Connexion, déconnexion, profil modifié ou connexion expirée. */
  onAccount(cb: (me: AccountMe | null) => void): () => void
  /** Lien « fivem-pack-manager://pack/<id> » reçu du site : ouvrir la fiche de ce pack dans la Marketplace. */
  onOpenMarketPack(cb: (id: string) => void): () => void
}

export interface MarketQuery {
  q?: string
  tag?: string
  /** Packs d'un auteur (adresse de son compte). */
  author?: string
  sort?: 'recent' | 'popular' | 'name'
  page?: number
}

export interface AuthorQuery {
  q?: string
  sort?: 'popular' | 'name' | 'recent'
  page?: number
}

export const IPC = {
  invoke: 'pm:invoke',
  task: 'pm:task',
  changed: 'pm:changed',
  update: 'pm:update',
  account: 'pm:account',
  openMarketPack: 'pm:open-market-pack'
} as const

/** Erreur de marketDetail quand l'API ne connaît pas (ou plus) le pack : inutile de réessayer. */
export const PACK_GONE = 'Ce pack n’est plus disponible sur la Marketplace.'

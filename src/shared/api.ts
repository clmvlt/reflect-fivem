import type {
  AccountMe,
  AccountProfile,
  AuthorPage,
  AuthorProfile,
  ForeignItem,
  GamesInfo,
  MarketCategory,
  MarketKind,
  MarketPack,
  MarketPackDetail,
  MarketPage,
  MarketTag,
  ModPreflight,
  Overview,
  PackManifest,
  PackPatch,
  ProfileInput,
  RootId,
  TaskProgress,
  UpdateState
} from './types'
import type { GraphicsState, GraphicsTarget } from './graphics'
import type { HardwareOverride, MachineProfile, PerformanceDetail } from './performance'

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
  /**
   * Retire le pack installé et range les mods installés à la main : le jeu redevient d'origine. `withMods` : désactive
   * aussi les mods de la bibliothèque des mods (sinon ils restent en place).
   */
  cleanGame(withMods?: boolean): Promise<string>

  /** Choisit des mods sur le disque (archives .zip / .rar / .7z ou .rpf seuls). */
  pickModFiles(): Promise<string[]>
  /** Ajoute des mods à la bibliothèque des mods (désactivés). */
  importMods(paths: string[]): Promise<string>
  /** Ce que changerait l'activation d'un mod : conflits avec d'autres mods, fichiers du pack actif remplacés. */
  modPreflight(id: string): Promise<ModPreflight>
  /**
   * Active ou désactive un mod (FiveM doit être fermé). `disable` : mods en conflit à désactiver dans la même opération.
   */
  setModEnabled(id: string, enabled: boolean, disable?: string[]): Promise<string>
  /** Désactive d'un coup tous les mods activés (FiveM doit être fermé) ; le pack graphique reste installé. */
  disableAllMods(): Promise<string>
  /** Retire le mod du jeu s'il est activé, puis de la bibliothèque des mods. */
  deleteMod(id: string): Promise<string>
  openModFolder(id: string): Promise<void>

  /** Réglages graphiques du jeu (null si aucun fichier de réglages n'a été trouvé). */
  getGraphics(target?: GraphicsTarget['id']): Promise<GraphicsState | null>
  saveGraphics(target: GraphicsTarget['id'], changes: Record<string, string>): Promise<GraphicsState>
  restoreGraphics(target: GraphicsTarget['id']): Promise<GraphicsState>
  /**
   * Limite d'images par seconde (null = celle du pack, 0 = aucune limite), écrite dans l'enblocal.ini (ENB) des packs
   * et appliquée tout de suite au pack installé. Renvoie le nombre de fichiers du jeu mis à jour.
   */
  setFpsLimit(limit: number | null): Promise<number>

  /**
   * Configuration de la machine (carte graphique, mémoire, résolution) et modèle de comparaison de l'API : les packs y
   * sont comparés dans l'interface, la configuration n'est jamais envoyée à l'API.
   */
  machineProfile(): Promise<MachineProfile>
  /** Détecte de nouveau la carte graphique (sinon gardée en cache). */
  refreshMachine(): Promise<MachineProfile>
  /** Corrige à la main la classe de la carte ou sa mémoire vidéo (null : valeur détectée). */
  setMachineOverride(override: HardwareOverride): Promise<MachineProfile>

  moveLibrary(newDir: string): Promise<string>
  openPath(p: string): Promise<void>

  /** Menu contextuel natif d'un pack. */
  packMenu(id: string): Promise<'rename' | 'image' | 'open' | 'delete' | null>
  /** Boîte de confirmation native de Windows. */
  confirm(message: string, detail: string, okLabel: string): Promise<boolean>
  /** Menu natif : identifiant de l'élément choisi, null si le menu est fermé sans choix. */
  popupMenu(items: MenuItem[]): Promise<string | null>

  /** Packs (ou mods, query.kind) publiés sur la Marketplace. */
  marketList(query: MarketQuery): Promise<MarketPage>
  marketTags(kind?: MarketKind): Promise<MarketTag[]>
  /** Catégories des mods avec leur nombre de mods publiés. */
  marketCategories(): Promise<MarketCategory[]>
  /** Packs (ou mods) mis en avant (« du moment »), le plus récent en premier ; liste vide en cas d'erreur. */
  marketFeatured(kind?: MarketKind): Promise<MarketPack[]>
  marketDetail(idOrSlug: string, kind?: MarketKind): Promise<MarketPackDetail>
  /** Analyse détaillée du poids d'un pack (ou d'un mod) sur les performances ; null si l'API ne la fournit pas. */
  marketPerformance(id: string, kind?: MarketKind): Promise<PerformanceDetail | null>
  /**
   * Télécharge le pack (ou sa nouvelle version) et l'ajoute à la bibliothèque. Mod : ajouté à la bibliothèque des mods
   * puis activé s'il n'entre en conflit avec aucun autre mod (une mise à jour garde son état).
   */
  marketInstall(id: string, kind?: MarketKind): Promise<string>
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

  /** Langue affichée (choisie par le processus principal). */
  getLanguage(): Promise<string>
  /**
   * Change la langue de l'application (toutes les fenêtres, menus du processus principal), l'enregistre sur ce poste
   * et, si un compte est connecté, dans le compte.
   */
  setLanguage(code: string): Promise<void>
  /** Langues proposées (GET /locales, sinon la liste embarquée hors ligne). */
  listLanguages(): Promise<LanguageOption[]>

  /** Recherche une mise à jour ; une nouvelle version est ensuite téléchargée et vérifiée automatiquement. */
  checkForUpdates(): Promise<UpdateState>
  /** Ferme l'application et installe tout de suite la mise à jour téléchargée et vérifiée. */
  installUpdate(): Promise<void>

  onTask(cb: (p: TaskProgress) => void): () => void
  onChanged(cb: () => void): () => void
  onUpdate(cb: (s: UpdateState) => void): () => void
  /** Connexion, déconnexion, profil modifié ou connexion expirée. */
  onAccount(cb: (me: AccountMe | null) => void): () => void
  /** Langue changée (réglages, ou langue du compte appliquée à la connexion). */
  onLanguage(cb: (code: string) => void): () => void
  /** Lien « fivem-pack-manager://pack/<id> » ou « …://mod/<id> » reçu du site : ouvrir cette fiche dans la Marketplace. */
  onOpenMarketPack(cb: (id: string, kind: MarketKind) => void): () => void
}

export interface MarketQuery {
  /** Catalogue : packs graphiques (défaut) ou mods. */
  kind?: MarketKind
  q?: string
  tag?: string
  /** Mods d'une catégorie (clé). */
  category?: string
  /** Packs d'un auteur (adresse de son compte). */
  author?: string
  sort?: 'recent' | 'popular' | 'name'
  page?: number
  /**
   * « Compatibles avec mon PC » : packs dont les besoins minimaux en 1080p tiennent dans cette mémoire vidéo (Mo) et
   * cette classe de carte (0 à 5), plus ceux pas encore analysés. Envoyés seulement quand l'utilisateur le demande.
   */
  vram?: number
  gpuClass?: number
}

export interface MenuItem {
  id: string
  label: string
  enabled?: boolean
  /** Séparateur avant cet élément. */
  separator?: boolean
}

export interface LanguageOption {
  code: string
  /** Nom de la langue dans cette langue (« Français », « English »). */
  name: string
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
  language: 'pm:language',
  openMarketPack: 'pm:open-market-pack'
} as const

/** Codes d'erreur de marketDetail quand l'API ne connaît pas (ou plus) le pack ou le mod : inutile de réessayer. */
export const PACK_GONE = 'pack-gone'
export const MOD_GONE = 'mod-gone'

/**
 * Une erreur ne passe d'un processus à l'autre qu'avec son message : le statut HTTP et le `code` d'une erreur de l'API
 * y sont ajoutés à la fin, puis retirés par l'interface (le message seul est affiché, le code sert à la logique).
 */
const API_ERROR_TAG = /\s*\{api:(\d{3})(?::([A-Za-z0-9_-]+))?\}\s*$/

export function tagApiError(message: string, status: number, code?: string): string {
  return `${message} {api:${status}${code ? `:${code}` : ''}}`
}

export function readApiError(message: string): { message: string; status: number | null; code: string | null } {
  const m = API_ERROR_TAG.exec(message)
  if (!m) return { message, status: null, code: null }
  return { message: message.slice(0, m.index), status: Number(m[1]), code: m[2] ?? null }
}

// Types partagés entre le processus principal (Electron) et l'interface (React).

import type { HardwareOverride, PackPerformance } from './performance'
import type { Msg } from './i18n'

/** Racines de destination gérées par l'application. */
export type RootId = 'fivem' | 'gta'

/** Genre d'un élément : pack graphique (un seul installé à la fois) ou mod (plusieurs à la fois, en plus du pack). */
export type MarketKind = 'pack' | 'mod'

/** Emplacement de destination : une racine + un chemin relatif (séparateur « / », '' = racine). */
export interface Destination {
  root: RootId
  path: string
}

export type ComponentKind =
  | 'mods' // .rpf chargés par FiveM depuis FiveM.app/mods
  | 'plugins' // ReShade / ENB proxy / .asi dans FiveM.app/plugins
  | 'citizen' // remplacement de fichiers FiveM (citizen/...)
  | 'addons' // .rpf chargés depuis FiveM.app/addons (serveurs sans mode pur)
  | 'fivem-root' // dossier « FiveM Application Data » complet
  | 'gta-root' // fichiers à la racine de GTA V (config ENB, d3dcompiler_46e.dll...)
  | 'file' // fichier isolé classé par son type
  | 'docs' // documentation / aperçus, jamais installés
  | 'unsupported' // contenu non installable (OpenIV .oiv, ScriptHookV...)
  | 'unknown' // à assigner manuellement

/**
 * Un composant = un dossier (ou fichier) du pack auquel on associe une destination.
 * Chaque fichier du pack est rattaché au composant dont la source est le plus long préfixe de son chemin.
 */
export interface PackComponent {
  id: string
  source: string
  isFile: boolean
  label: string
  kind: ComponentKind
  destination: Destination | null
  suggested: Destination | null
  enabled: boolean
  optional: boolean
  fileCount: number
  size: number
  reason: string
  /** {@link label} à traduire à l'affichage (absent : nom de dossier ou de fichier, ou manifeste d'une version précédente). */
  labelMsg?: Msg
  /** {@link reason} à traduire à l'affichage (absent : manifeste d'une version précédente). */
  reasonMsg?: Msg
}

export interface PackFileEntry {
  rel: string
  size: number
}

/** Résultat d'une vérification de compatibilité FiveM sur un fichier du pack. */
export interface Insight {
  rel: string
  level: 'ok' | 'info' | 'warn' | 'bad'
  title: string
  text: string
  /** {@link title} à traduire à l'affichage (absent : nom de fichier, ou vérification d'une version précédente). */
  titleMsg?: Msg
  /** {@link text} à traduire à l'affichage (absent : vérification d'une version précédente). */
  textMsg?: Msg
  /** Builds du jeu déclarées par un .asi (FX_ASI_BUILD). */
  builds?: number[]
}

export interface PackManifest {
  schema: 1
  id: string
  name: string
  sourceArchive: string
  importedAt: string
  updatedAt: string
  contentSize: number
  fileCount: number
  components: PackComponent[]
  features: string[]
  warnings: string[]
  /** {@link warnings} à traduire à l'affichage, dans le même ordre (absent : manifeste d'une version précédente). */
  warningMsgs?: Msg[]
  /** Image principale (chemin relatif au dossier du pack), choisie par l'utilisateur ou automatiquement. */
  cover: string | null
  /** Images d'aperçu fournies dans le pack (chemins relatifs au dossier du pack). */
  gallery: string[]
  notes: string
  /** Pack créé à partir d'une installation manuelle existante. */
  captured: boolean
  /** Suppression en cours. */
  deleting?: boolean
  /** Réglages modifiés en jeu et conservés (fichiers dans user/). */
  userConfigCount: number
  insights: Insight[]
  insightsVersion?: number
  /** Version de ReShade fournie par le pack (null si aucune). */
  reshadeVersion: string | null
  /** Presets ReShade du pack (chemins relatifs au contenu). */
  reshadePresets?: string[]
  /** Preset chargé par ReShade à chaque installation du pack. */
  reshadePreset?: string | null
  /** Pack téléchargé depuis la Marketplace. */
  marketplace?: MarketplaceLink
  /** Description (Markdown) fournie par la Marketplace. */
  description?: string
  author?: string
  /** Vidéo YouTube de la fiche Marketplace (absent : pack téléchargé avant la version 1.5.2). */
  youtubeId?: string | null
  /**
   * Pack protégé (chiffré sur la Marketplace) : son contenu reste chiffré dans la bibliothèque et n'est en clair que
   * dans les dossiers du jeu, pendant qu'il y est installé.
   */
  protected?: boolean
  /** Mod (bibliothèque des mods) ; absent : pack graphique. */
  kind?: MarketKind
  /** Catégorie d'un mod de la Marketplace (clé de GET /mods/categories), null sinon. */
  category?: string | null
}

/** Lien entre un pack de la bibliothèque et sa fiche sur la Marketplace. */
export interface MarketplaceLink {
  id: string
  slug: string
  /** Empreinte de l'archive installée : une autre empreinte en ligne signale une mise à jour. */
  sha256: string
  version: string
  downloadedAt: string
  /** Catalogue de la fiche (absent : pack, avant l'arrivée des mods). */
  kind?: MarketKind
}

/** Fichier réellement présent dans les dossiers du jeu, installé par l'application. */
export interface InstalledFile {
  root: RootId
  path: string
  size: number
  mtimeMs: number
  linked: boolean
  /** Source dans la bibliothèque (relative au dossier du pack). */
  source: string
}

export interface ActiveInstall {
  id: string
  packId: string
  packName: string
  appliedAt: string
  roots: Record<RootId, string>
  files: InstalledFile[]
  createdDirs: Destination[]
  /** Fichiers qui n'ont pas pu être retirés lors d'une désinstallation précédente. */
  partial: boolean
}

/** Fichier du pack graphique actif remplacé par un mod : réinstallé depuis le pack quand le mod est retiré. */
export interface ShadowedFile {
  packId: string
  file: InstalledFile
}

/**
 * Mod de la bibliothèque des mods et son état dans le jeu. Plusieurs mods peuvent être activés en même temps, en plus du
 * pack graphique actif et indépendamment de lui.
 */
export interface InstalledMod {
  /** Identifiant du mod dans la bibliothèque des mods. */
  id: string
  name: string
  enabled: boolean
  /** Dernière activation (null : jamais activé, ou désactivé). */
  appliedAt: string | null
  roots: Record<RootId, string>
  /** Fichiers posés dans le jeu (vide quand le mod est désactivé). */
  files: InstalledFile[]
  createdDirs: Destination[]
  /** Fichiers du pack actif que ce mod remplace. */
  shadowed: ShadowedFile[]
}

export interface HistoryEntry {
  at: string
  action: 'apply' | 'remove' | 'capture' | 'clean' | 'restore' | 'import' | 'delete' | 'cache' | 'graphics' | 'download' | 'mod'
  packName?: string
  /** Texte de la version qui l'a écrit (repli quand `msg` est absent). */
  summary: string
  /** Résumé traduit à l'affichage, dans la langue courante. */
  msg?: Msg
  ok: boolean
}

export interface AppState {
  schema: 1
  active: ActiveInstall | null
  /** Mods (absent dans un state.json d'avant les mods : liste vide). */
  mods: InstalledMod[]
  history: HistoryEntry[]
}

export interface Settings {
  libraryDir: string
  fivemPath: string | null
  gtaPath: string | null
  /** Limite d'images par seconde, appliquée par l'ENB des packs : null ou absent = celle du pack, 0 = aucune limite. */
  fpsLimit?: number | null
  /** Fermer la fenêtre garde l'application dans la zone de notification (absent : oui). */
  closeToTray?: boolean
  /** Classe de carte graphique ou mémoire vidéo corrigées à la main (carte non reconnue). */
  machine?: HardwareOverride
  /** Langue choisie dans les réglages de l'application sur ce poste (absent : jamais choisie). */
  locale?: string
}

// ---------------------------------------------------------------------------
// Détection des jeux

export type GtaEdition = 'legacy' | 'enhanced' | 'unknown'
export type GtaStore = 'rockstar' | 'steam' | 'epic' | 'unknown'

export interface Check {
  /** Identifiant stable de la vérification (le libellé suit la langue). */
  id?: string
  label: string
  ok: boolean
  detail?: string
}

export interface FiveMInfo {
  path: string | null
  source: string
  valid: boolean
  writable: boolean
  checks: Check[]
  gtaPathFromIni: string | null
  buildNumber: string | null
}

export interface GtaInfo {
  path: string | null
  source: string
  valid: boolean
  writable: boolean
  checks: Check[]
  edition: GtaEdition
  store: GtaStore
  version: string | null
}

export interface GameCandidate {
  path: string
  source: string
}

export interface GamesInfo {
  fivem: FiveMInfo
  gta: GtaInfo
  gtaCandidates: GameCandidate[]
  fivemCandidates: GameCandidate[]
  /** Le dossier GTA configuré dans FiveM (CitizenFX.ini) diffère du dossier GTA utilisé. */
  mismatch: boolean
  runningProcesses: string[]
}

// ---------------------------------------------------------------------------
// Fichiers « étrangers » (mods installés à la main, hors application)

export type ForeignCategory =
  | 'enb'
  | 'reshade'
  | 'proxy-dll'
  | 'asi'
  | 'rpf'
  | 'plugin-config'
  | 'plugin-data'
  | 'sp-loader'
  | 'screenshot'
  | 'log'
  | 'other'

export interface ForeignItem {
  root: RootId
  path: string
  isDir: boolean
  size: number
  fileCount: number
  category: ForeignCategory
  label: string
  /** Sélectionné par défaut pour la capture / le nettoyage. */
  recommended: boolean
}

// ---------------------------------------------------------------------------
// Tâches longues

export interface TaskProgress {
  taskId: string
  kind: 'import' | 'apply' | 'remove' | 'delete' | 'stash' | 'clean' | 'cache' | 'screenshots' | 'trash' | 'move-library' | 'download' | 'mod'
  title: string
  phase: string
  current: number
  total: number
  detail?: string
  done: boolean
  ok?: boolean
  error?: string
  result?: unknown
}

export interface Overview {
  settings: Settings
  games: GamesInfo
  state: AppState
  library: PackManifest[]
  /** Bibliothèque des mods (leur état dans le jeu : state.mods). */
  mods: PackManifest[]
  /** Mods installés à la main, hors pack actif. */
  foreign: { files: number; size: number } | null
  /** Couleur d'accent de Windows (#rrggbb). */
  accent: string
  version: string
  dataDir: string
  /** Adresse de l'API de la Marketplace. */
  apiUrl: string
  /** Packs et mods de la bibliothèque dont une nouvelle version est en ligne, et ceux retirés de la Marketplace. */
  market: { updates: string[]; gone: string[] }
  /** Téléchargements arrêtés par une maintenance, repris automatiquement à sa fin. */
  pausedDownloads: PausedDownloadInfo[]
  game: GameState
  update: UpdateState
}

export interface PausedDownloadInfo {
  /** Identifiant du pack ou du mod sur la Marketplace. */
  id: string
  kind: MarketKind
  name: string
}

/** Changement de pack demandé pendant que FiveM tourne : fait dès que le jeu est fermé. */
export interface PendingChange {
  title: string
  /** Pack qui sera installé (null pour un retrait ou un nettoyage). */
  packId: string | null
}

export interface GameState {
  pending: PendingChange | null
  /** Pack changé depuis la dernière partie : relancer FiveM pour qu'il prenne effet. */
  relaunch: boolean
}

/** Ce que changerait l'activation d'un mod (rien n'est modifié). */
export interface ModPreflight {
  /** Raisons d'empêcher l'activation, en une phrase courte chacune. */
  blockers: string[]
  /** Mods activés qui écrivent les mêmes fichiers : à désactiver pour continuer. */
  conflicts: { id: string; name: string; files: string[] }[]
  /** Fichiers du pack graphique actif remplacés tant que le mod est activé (remis en place quand il est désactivé). */
  pack: { name: string; files: string[] } | null
}

export interface ComponentPatch {
  id: string
  destination?: Destination | null
  enabled?: boolean
}

export interface PackPatch {
  name?: string
  notes?: string
  components?: ComponentPatch[]
  resetComponents?: boolean
}

// ---------------------------------------------------------------------------
// Marketplace

export interface MarketImage {
  id: string
  width: number
  height: number
}

export interface MarketPack {
  id: string
  kind: MarketKind
  /** Catégorie d'un mod (clé), null pour un pack. */
  category: string | null
  slug: string
  name: string
  summary: string
  author: string
  version: string
  tags: string[]
  /** Taille du téléchargement (le paquet chiffré pour un pack protégé). */
  archiveSize: number
  sha256: string
  /** Pack protégé : installable seulement avec l'application, jamais extrait dans la bibliothèque. */
  protected: boolean
  downloadCount: number
  publishedAt: string | null
  updatedAt: string
  archiveUpdatedAt: string | null
  cover: MarketImage | null
  /** Compte de l'auteur, quand le pack est rattaché à un compte (sa page s'ouvre dans l'application). */
  authorProfile: AuthorRef | null
  /** « Pack du moment », mis en avant par l'admin du site (déjà en tête des listes de l'API). */
  featured: boolean
  /** Note moyenne (arrondie au dixième, null sans note) et nombre de notes. */
  rating: MarketRating
  commentCount: number
  /** Commentaires fermés par l'auteur ou l'admin. */
  commentsLocked: boolean
  /**
   * Poids sur les performances, estimé par l'API (null : pas encore analysé ; absent : API plus ancienne, rien à
   * afficher).
   */
  performance?: PackPerformance | null
  /** Pack correspondant dans la bibliothèque (null s'il n'a pas été téléchargé). */
  localId: string | null
  /** La version en ligne diffère de celle de la bibliothèque. */
  updateAvailable: boolean
}

export interface MarketPackDetail extends MarketPack {
  description: string
  archiveName: string
  images: MarketImage[]
  /** Identifiant de la vidéo YouTube de présentation (null si aucune). */
  youtubeId: string | null
}

export interface MarketRating {
  average: number | null
  count: number
}

export interface MarketPage {
  items: MarketPack[]
  page: number
  total: number
  totalPages: number
}

export interface MarketTag {
  tag: string
  count: number
}

/** Catégorie des mods (GET /mods/categories), dans l'ordre d'affichage ; `count` : mods publiés. */
export interface MarketCategory {
  key: string
  label: string
  count: number
}

/** Pourquoi le compte ne peut pas noter un pack ou un mod. */
export type RatingReason = 'login-required' | 'download-required' | 'own-pack' | 'muted'

/** Notes d'un pack, et la note du compte connecté. */
export interface PackRatings extends MarketRating {
  /** Nombre de notes par nombre d'étoiles (indices 1 à 5). */
  distribution: Record<1 | 2 | 3 | 4 | 5, number>
  mine: number | null
  /** Le compte a téléchargé ce pack (nécessaire pour le noter). */
  downloaded: boolean
  canRate: boolean
  reason: RatingReason | null
}

/** Commentaire ou réponse sur la fiche d'un pack. */
export interface PackComment {
  id: string
  packId: string
  parentId: string | null
  /** Réponse à une réponse : son auteur, affiché « @nom ». */
  replyTo: { id: string; author: AuthorRef | null } | null
  status: 'visible' | 'hidden' | 'deleted'
  /** Texte brut ; null pour un commentaire masqué ou supprimé (sauf pour un admin). */
  body: string | null
  author: AuthorRef | null
  byPackAuthor: boolean
  byAdmin: boolean
  /** Note donnée au pack par l'auteur du commentaire. */
  authorRating: number | null
  pinned: boolean
  createdAt: string
  editedAt: string | null
  editedByModerator: boolean
  /** Commentaires seulement (pas les réponses) : nombre de réponses et les 3 premières. */
  replyCount: number
  replies: PackComment[]
  mine: boolean
  canEdit: boolean
  canDelete: boolean
  canReply: boolean
  /** Admin seulement. */
  moderationReason: string | null
  reportCount: number | null
}

export interface CommentPage {
  items: PackComment[]
  page: number
  total: number
  totalPages: number
  commentCount: number
  locked: boolean
  canComment: boolean
}

export interface ReplyPage {
  items: PackComment[]
  page: number
  total: number
  totalPages: number
}

/** Pack ou mod téléchargé par le compte connecté (pack.kind). */
export interface MyDownload {
  pack: MarketPack
  firstDownloadedAt: string | null
  lastDownloadedAt: string | null
  downloadCount: number
  myRating: number | null
}

export interface MyDownloadsPage {
  items: MyDownload[]
  page: number
  total: number
  totalPages: number
}

// ---------------------------------------------------------------------------
// Comptes et auteurs

/** Auteur d'un pack. */
export interface AuthorRef {
  id: number
  slug: string
  displayName: string
  /** Photo servie par le processus principal (pm-media://avatar/<compte>/<version>), null sans photo. */
  avatarUrl: string | null
}

export interface ProfileLink {
  label: string
  url: string
}

/** Auteur dans la liste des auteurs de la Marketplace. */
export interface AuthorSummary extends AuthorRef {
  packCount: number
  modCount: number
  /** Total affiché des téléchargements de ses packs. */
  downloads: number
}

export interface AuthorPage {
  items: AuthorSummary[]
  page: number
  total: number
  totalPages: number
}

/** Page publique d'un auteur. Ses packs : marketList({ author: slug }). */
export interface AuthorProfile extends AuthorRef {
  bio: string
  links: ProfileLink[]
  createdAt: string | null
  packCount: number
  modCount: number
  downloads: number
}

/** Compte connecté sur cet appareil. */
export interface AccountMe {
  id: number
  /** Identifiant du compte d'administration d'origine (null pour les autres). */
  username: string | null
  email: string | null
  displayName: string
  slug: string
  /** pm-media://avatar/..., null sans photo. */
  avatarUrl: string | null
  role: 'user' | 'admin'
  admin: boolean
  canPublish: boolean
  /** Peut publier des mods (depuis le site). */
  canPublishMods: boolean
  /** Mot de passe imposé : à changer avant toute autre action. */
  mustChangePassword: boolean
  /** Faux pour un compte créé par Google qui n'a pas encore de mot de passe. */
  hasPassword: boolean
  googleLinked: boolean
  /** Compte réduit au silence par la modération : ni notes ni commentaires. */
  muted: boolean
  /** Langue enregistrée dans le compte (code de GET /locales), null si aucune n'a été choisie. */
  locale: string | null
}

/** Profil complet du compte connecté. */
export interface AccountProfile extends Omit<AccountMe, 'mustChangePassword'> {
  bio: string
  links: ProfileLink[]
  createdAt: string | null
}

export interface ProfileInput {
  displayName: string
  bio: string
  links: ProfileLink[]
}

// ---------------------------------------------------------------------------
// Mises à jour de l'application

export interface UpdateState {
  status: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'verifying' | 'ready' | 'error' | 'unsupported'
  version?: string
  notes?: string
  percent?: number
  /** Octets reçus et taille totale pendant le téléchargement. */
  transferred?: number
  total?: number
  error?: string
  /** La nouvelle version se télécharge sur le site (application lancée depuis ses sources, dossier non modifiable). */
  manual?: boolean
  /** installateur, version portable, ou lancée depuis les sources. */
  mode?: 'installer' | 'portable' | 'source'
  checkedAt?: string
}

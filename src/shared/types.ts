// Types partagés entre le processus principal (Electron) et l'interface (React).

import type { HardwareOverride, PackPerformance, PerfTier } from './performance'
import type { Msg } from './i18n'
import type { ReleaseNotes } from './changelog'
import type { ThemeChoice } from './themes'

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
  /** Pack construit par « Créer ton pack » à partir d'une création du compte. */
  built?: BuiltLink
}

/** Lien entre un pack de la bibliothèque et la création de « Créer ton pack » dont il est construit. */
export interface BuiltLink {
  buildId: string
  /** Révision du manifeste installée : une autre révision en ligne signale une mise à jour. */
  revision: string
  builtAt: string
  /** Composants installés (nom d'affichage). */
  components: { id: string; name: string }[]
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
  /**
   * Fichiers d'origine du jeu remplacés par le pack, gardés dans le dossier .fpm-originaux de leur racine et remis en
   * place quand le pack est retiré (absent : aucun).
   */
  originals?: Destination[]
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
  action: 'apply' | 'remove' | 'capture' | 'clean' | 'restore' | 'import' | 'delete' | 'cache' | 'graphics' | 'download' | 'mod' | 'optimize'
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
  /** Dernière version dont la fenêtre « Nouveautés » a été vue (absent : premier lancement). */
  lastSeenChangelogVersion?: string
  /**
   * Instances FiveM (absent : une seule, l'instance principale). Les dossiers de l'instance active sont
   * {@link fivemPath} et {@link gtaPath} ; ceux enregistrés dans sa fiche ne servent qu'une fois qu'on l'a quittée.
   */
  instances?: FiveMInstance[]
  /** Identifiant de l'instance active (absent : l'instance principale). */
  instance?: string
  /** Installation d'un pack avec plusieurs instances : dans l'instance active, ou dans celle choisie à chaque fois (absent : active). */
  packTarget?: 'active' | 'ask'
  /** Thème de l'application (absent : celui de Windows, clair ou sombre). */
  theme?: ThemeChoice
}

/** Dossier FiveM géré par l'application, avec son propre pack installé et ses propres mods (voir instances.ts). */
export interface FiveMInstance {
  id: string
  name: string
  /** Dossier FiveM.app (null : détection automatique, instance principale seule). */
  fivemPath: string | null
  /** Dossier de GTA V (null : celui indiqué par FiveM, sinon détecté). */
  gtaPath: string | null
}

export interface InstanceSummary extends FiveMInstance {
  current: boolean
  /** Pack installé dans cette instance (null : aucun). */
  packId: string | null
  packName: string | null
  /** Nombre de mods activés. */
  mods: number
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
  kind: 'import' | 'apply' | 'remove' | 'delete' | 'stash' | 'clean' | 'cache' | 'screenshots' | 'trash' | 'move-library' | 'download' | 'mod' | 'instance'
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

/** Téléchargement de la file : pack ou mod de la Marketplace, ou création de « Créer ton pack » (build). */
export type DownloadKind = MarketKind | 'build'

/**
 * Téléchargement de la Marketplace (ou d'une création de « Créer ton pack »), en cours ou en file d'attente (un seul à
 * la fois, dans l'ordre demandé). Le téléchargement des fichiers ne bloque pas le reste de l'application ; seul leur
 * ajout à la bibliothèque attend que les autres tâches soient finies.
 */
export interface DownloadItem {
  /** Fiche de la Marketplace, ou création (kind build). */
  id: string
  kind: DownloadKind
  name: string
  /** Image de couverture de la fiche (null sans image). */
  coverId: string | null
  /** Création : adresse pm-media de sa vignette (image d'un composant, d'un style ou image en jeu), à la place de {@link coverId}. */
  coverUrl?: string | null
  /** Pack déjà dans la bibliothèque, téléchargé de nouveau au nom du compte (rien n'est ajouté). */
  claim: boolean
  /**
   * queued : en file d'attente ; downloading : archive en cours de téléchargement (ou vérification) ; waiting : archive
   * téléchargée, attend la fin d'une autre tâche ; installing : ajout à la bibliothèque (ne peut plus être annulé).
   */
  status: 'queued' | 'downloading' | 'waiting' | 'installing'
  phase: string
  current: number
  total: number
  /** current et total sont des octets (téléchargement de l'archive). */
  bytes: boolean
  /** Débit moyen des dernières secondes, en octets par seconde (0 hors téléchargement de l'archive). */
  speed: number
}

/** Fin d'un téléchargement de la Marketplace (terminé, en échec, annulé ou mis en pause par une maintenance). */
export interface DownloadDone {
  id: string
  kind: DownloadKind
  name: string
  ok: boolean
  cancelled?: boolean
  error?: string
  /** Code de l'erreur de l'API (pack payant : PACK_LOGIN_REQUIRED, PACK_PURCHASE_REQUIRED). */
  code?: string
  /** Mise à jour d'un pack (ou d'un mod) déjà dans la bibliothèque. */
  update?: boolean
  result?: unknown
}

export interface Overview {
  settings: Settings
  games: GamesInfo
  state: AppState
  library: PackManifest[]
  /** Bibliothèque des mods (leur état dans le jeu : state.mods). */
  mods: PackManifest[]
  /** Instances FiveM, dans l'ordre d'ajout (une seule tant qu'aucune autre n'a été ajoutée). */
  instances: InstanceSummary[]
  /** Mods installés à la main, hors pack actif. */
  foreign: { files: number; size: number } | null
  /** Couleur d'accent de Windows (#rrggbb). */
  accent: string
  version: string
  dataDir: string
  /** Adresse de l'API de la Marketplace. */
  apiUrl: string
  /**
   * Packs et mods de la bibliothèque dont une nouvelle version est en ligne (packs de « Créer ton pack » compris), et
   * ceux retirés de la Marketplace.
   */
  market: { updates: string[]; gone: string[] }
  /** Packs et mods payants du compte connecté (achetés ou offerts), derniers connus ; vide sans compte. */
  owned: OwnedPack[]
  /** Packs de « Créer ton pack » dont la création a été supprimée du compte. */
  builder: { gone: string[] }
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
  /** Prix en centimes TTC, fixé par l'admin ; null : gratuit (absent d'une API plus ancienne : gratuit). */
  price: number | null
  /** Faux pour un brouillon (pas encore publié), que seul l'admin connecté voit. */
  published: boolean
  /** Identifiant de la vidéo YouTube de présentation (null si aucune, ou absente des listes d'une API plus ancienne). */
  youtubeId: string | null
  /** Pack correspondant dans la bibliothèque (null s'il n'a pas été téléchargé). */
  localId: string | null
  /** La version en ligne diffère de celle de la bibliothèque. */
  updateAvailable: boolean
}

export interface MarketPackDetail extends MarketPack {
  description: string
  archiveName: string
  images: MarketImage[]
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
  /** Droit « Peut créer un pack » donné par l'admin (« Créer ton pack » ; voir canUseBuilder). */
  canBuildPacks: boolean
  /** Mot de passe imposé : à changer avant toute autre action. */
  mustChangePassword: boolean
  /** Faux pour un compte créé par Google ou Discord qui n'a pas encore de mot de passe. */
  hasPassword: boolean
  googleLinked: boolean
  discordLinked: boolean
  /** Compte Discord lié, null sans liaison. */
  discord: DiscordAccount | null
  /** Compte réduit au silence par la modération : ni notes ni commentaires. */
  muted: boolean
  /** Langue enregistrée dans le compte (code de GET /locales), null si aucune n'a été choisie. */
  locale: string | null
}

/** Compte Discord lié : nom et photo de sa dernière connexion par Discord. */
export interface DiscordAccount {
  id: string
  username: string
  /** Nom affiché sur Discord, null s'il n'en a pas. */
  displayName: string | null
  /** https://cdn.discordapp.com/…, null si l'adresse reçue n'y est pas (le nom seul est alors affiché). */
  avatarUrl: string | null
  linkedAt: string | null
}

/**
 * Temps avec le tag du serveur Discord (GET /me/server-tag) : chaque tranche de `creditEverySeconds` de temps cumulé
 * avec le tag donne un crédit « Créer ton pack », `maxCredits` au plus. Règle actuelle : un seul crédit, puis le temps
 * est encore compté, seulement pour être affiché. Le bot du serveur relève les porteurs toutes les quelques minutes.
 */
export interface ServerTagStatus {
  /** Faux : récompense désactivée sur le serveur, rien n'est montré. */
  enabled: boolean
  discordLinked: boolean
  /** Heure de l'API à la réponse (ISO), pour dater `seenAt` sans l'horloge du PC ; null si illisible. */
  serverTime: string | null
  /** Temps cumulé qui donne un crédit : celui de la progression, null sans compte Discord lié (l'API ne le donne pas). */
  creditEverySeconds: number | null
  /** Progression du compte Discord lié, null sans liaison. */
  progress: ServerTagProgress | null
}

/** Progression d'un compte Discord au dernier relevé du bot. */
export interface ServerTagProgress {
  /** Le membre affichait le tag au dernier relevé. */
  wearing: boolean
  /** Début du port en cours (ISO), null sans le tag. */
  wearingSince: string | null
  /** Dernier relevé où le membre portait le tag (ISO), null sans le tag : le temps n'avance qu'à chaque relevé. */
  seenAt: string | null
  /** Temps cumulé avec le tag, jamais remis à zéro quand il est retiré. */
  totalSeconds: number
  creditEverySeconds: number
  /** Temps avec le tag avant le prochain crédit, null quand le plafond est atteint. */
  nextCreditInSeconds: number | null
  creditsEarned: number
  /** Crédits gagnés pas encore donnés au compte (le temps d'un relevé, pour un compte lié). */
  creditsWaiting: number
  /** Plafond de crédits, 0 : sans limite (1 aujourd'hui). */
  maxCredits: number
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
// Créer ton pack (GET /builder/..., compte de l'application connecté)

/** Ce qu'un composant fournit ou demande : une base QuantV, NVE ou ReShade. */
export type BuilderBase = 'quantv' | 'nve' | 'reshade'

/** Poids d'un composant sur les performances (mémoire vidéo en Mo, ms par image sur la carte de référence en 1080p). */
export interface BuilderPerformance {
  tier: PerfTier
  vramMb: number | null
  effectsMs: number | null
  worldMs: number | null
}

/** Composant dans le catalogue : un élément d'un pack (route, végétation, sang, preset ReShade...). */
export interface BuilderComponentCard {
  id: string
  slug: string
  /** Clé de sa catégorie (roads, reshade...). */
  category: string
  name: string
  summary: string
  credits: string
  cover: MarketImage | null
  imageCount: number
  size: number
  fileCount: number
  /** null : pas encore analysé. */
  performance: BuilderPerformance | null
  /** Archive chiffrée par FiveM : les fichiers du jeu qu'elle remplace sont inconnus. */
  unreadable: boolean
  provides: BuilderBase[]
  requires: BuilderBase[]
  /** Composants qui remplacent les mêmes fichiers du jeu : un seul des deux s'appliquerait. */
  conflictsWith: string[]
  tags: string[]
  /** Noms des packs où il a été trouvé. */
  sources: string[]
  updatedAt: string
}

/** Pack où un composant a été trouvé ; `packSlug` null si le pack n'est plus visible. */
export interface BuilderSource {
  packId: string
  packSlug: string | null
  packName: string
  packAuthor: string
  path: string
}

export interface BuilderComponentDetail extends BuilderComponentCard {
  /** Markdown. */
  description: string
  /** Page d'origine (http ou https), null sans page. */
  sourceUrl: string | null
  images: MarketImage[]
  foundIn: BuilderSource[]
  /** Fichiers du jeu remplacés. */
  targets: string[]
  files: { root: RootId; path: string; kind: 'file' | 'bundle'; size: number }[]
}

/** Étape de l'assistant (ambiance, world, combat, other), avec ses catégories dans l'ordre. */
export interface BuilderGroup {
  key: string
  label: string
  categories: string[]
}

export interface BuilderCategory {
  key: string
  label: string
  group: string
  /** Un seul composant de cette catégorie par pack. */
  single: boolean
  components: BuilderComponentCard[]
  /** Outil d'ambiance dont ces composants sont les choix « Importé d'un pack » (null pour les autres catégories). */
  tool: ToolKey | null
}

export type BuilderControlValue = number | boolean | string

/**
 * Réglage simple d'un outil d'ambiance, dans la langue affichée. Curseur : de `min` à `max`, 0 = la valeur de départ.
 * `value` : celle du joueur, sinon celle de départ (null dans le catalogue).
 */
export interface BuilderControl {
  key: string
  label: string
  description: string
  /** image, effects, quantv. */
  group: string
  groupLabel: string
  type: 'slider' | 'toggle' | 'select' | 'color'
  min: number | null
  max: number | null
  step: number | null
  options: { value: string; label: string }[]
  value: BuilderControlValue | null
  /** Outil auquel il appartient. */
  tool: ToolKey | null
}

/**
 * Outil d'ambiance : reshade (filtres de l'image), quantv (lumière et météo, a besoin de ReShade), nve, enb. Le joueur
 * n'en prend aucun (none), le règle lui-même avec un style (custom) ou l'importe d'un pack (pack).
 */
export type ToolKey = 'reshade' | 'quantv' | 'nve' | 'enb'
export type ToolMode = 'none' | 'custom' | 'pack'

/**
 * Aperçu d'un style sans image, dessiné sur l'image de référence de son outil : filtres (1 : inchangé ; sepia et
 * grayscale de 0 à 1, hueRotate en degrés), calque de couleur `tint` à l'opacité `tintOpacity`, vignettage et grain (0 à 1).
 */
export interface BuilderStylePreview {
  brightness: number | null
  contrast: number | null
  saturate: number | null
  sepia: number | null
  grayscale: number | null
  hueRotate: number | null
  tint: string | null
  tintOpacity: number | null
  vignette: number | null
  grain: number | null
}

/** Style d'un outil (« Cinéma », « Équilibré »...) : son image ou, sans image, son aperçu. */
export interface BuilderStyle {
  id: string
  key: string
  label: string
  description: string
  /** Version de l'image (pm-media://builder-style/<style>/<version>) ; null sans image : dessiner `preview`. */
  imageVersion: string | null
  preview: BuilderStylePreview | null
  costMs: number
  costLabel: string
  byDefault: boolean
}

export interface BuilderTool {
  key: ToolKey
  label: string
  description: string
  /** Catégorie de ses composants « Importé d'un pack ». */
  category: string
  /** Choix proposé d'abord (« Recommandé »). */
  defaultMode: ToolMode
  defaultStyle: string | null
  /** « Réglé par moi » possible. */
  custom: boolean
  /** Composants publiés à importer d'un pack. */
  packs: number
  /**
   * Image du composant `referenceComponent` pour l'aperçu des styles : repli quand le catalogue n'a aucune image de
   * référence en jeu ({@link BuilderCatalog.references}).
   */
  referenceComponent: string | null
  reference: MarketImage | null
  styles: BuilderStyle[]
  /** Outils dont il a besoin (QuantV : ReShade). */
  requires: ToolKey[]
}

/** Image de référence en jeu (« Voiture », « Centre-ville »...) sur laquelle dessiner l'aperçu des styles. */
export interface BuilderReference {
  id: string
  /** Nom dans la langue affichée. */
  label: string
  credits: string
  /** Version de l'image (pm-media://builder-reference/<image>/<version>), changée avec l'image. */
  version: string
  width: number
  height: number
  byDefault: boolean
}

/** Image de « Créer ton pack » servie par pm-media : image d'un composant, d'un style, ou image de référence en jeu. */
export type BuilderImageRef =
  | { kind: 'component'; componentId: string; imageId: string }
  | { kind: 'style'; styleId: string; version: string }
  | { kind: 'reference'; referenceId: string; version: string }

export interface BuilderCatalog {
  version: string
  groups: BuilderGroup[]
  categories: BuilderCategory[]
  /** Outils d'ambiance proposés, dans l'ordre reshade, quantv, nve, enb. */
  tools: BuilderTool[]
  /** Images de référence en jeu publiées, dans l'ordre choisi par l'admin (vide : ancienne API, ou aucune publiée). */
  references: BuilderReference[]
  controls: BuilderControl[]
  /** Copie gardée sur le disque, l'API n'ayant pas pu être jointe. */
  offline: boolean
  /** Vérifié auprès de l'API pendant cet appel (sinon : copie du disque, à revérifier). */
  checked: boolean
}

/** Effet d'un fichier de réglages (ReShade, NVE) : `name` (« Nom@fichier.fx ») activé ou non, coût estimé. */
export interface BuilderTechnique {
  name: string
  effect: string | null
  enabled: boolean
  costMs: number
  costLabel: string
}

/**
 * Paramètre d'un effet ReShade (lu dans son fichier .fx), ou clé d'une section d'un fichier .ini (QuantV, NVE, ENB :
 * `type` deviné, `tooltip` = commentaire du fichier). `type` : bool, int, float, float3... ; `ui` : slider, drag, color,
 * combo, radio, list, input ; `value` : valeur actuelle (null : celle par défaut de l'effet) ; `baseValue` : valeur de
 * départ (style ou preset du pack), avant les réglages du joueur. Valeurs au format des presets (nombres séparés par des
 * virgules, 0/1 pour un booléen).
 */
export interface BuilderParam {
  name: string
  type: string | null
  ui: string | null
  label: string | null
  tooltip: string | null
  category: string | null
  min: number | null
  max: number | null
  step: number | null
  items: string[]
  value: string | null
  defaultValue: string | null
  baseValue: string | null
}

/** Paramètres d'un fichier d'effet (ReShade), ou d'une section d'un fichier .ini (QuantV, NVE, ENB). */
export interface BuilderEffect {
  file: string
  params: BuilderParam[]
}

/**
 * Réglages d'un outil par le joueur, seulement ce qu'il a changé : réglages simples, puis mode avancé (effets activés
 * ou coupés, paramètres par fichier d'effet ou section), qui l'emporte.
 */
export interface BuilderAdjustments {
  controls: Record<string, BuilderControlValue>
  techniques: Record<string, boolean>
  values: Record<string, Record<string, string>>
}

/** Choix d'un outil : `component` pour « Importé d'un pack », `style` pour « Réglé par moi » (null : celui par défaut). */
export interface BuilderToolSettings extends BuilderAdjustments {
  mode: ToolMode
  component: string | null
  style: string | null
}

export type BuilderTools = Record<ToolKey, BuilderToolSettings>

/**
 * État d'un outil pour les choix en cours (POST /builder/tools/view) : fichier de réglages (`path`), effets
 * (`techniques`, ReShade et NVE ; `available` : effets qu'on peut ajouter, ReShade), paramètres (`effects`), réglages
 * simples applicables avec leur valeur, problèmes. À redemander quand un choix change.
 */
export interface BuilderToolView {
  tool: ToolKey
  mode: ToolMode
  componentId: string | null
  styleId: string | null
  path: string | null
  techniques: BuilderTechnique[] | null
  available: string[] | null
  effects: BuilderEffect[]
  controls: BuilderControl[]
  problems: BuilderProblem[]
}

/**
 * Point à signaler dans une composition. `type` : single (deux choix d'une catégorie unique), conflict (mêmes fichiers
 * du jeu remplacés), path (même fichier installé avec deux contenus), missing (il manque la base `requires`),
 * unknown-targets (archive protégée), unavailable (composant retiré), tool (outil `requires` indisponible), style (style
 * retiré de l'outil `requires`), needs-tool (il faut aussi l'outil `requires` : QuantV demande ReShade). Seules les
 * erreurs empêchent d'installer.
 */
export interface BuilderProblem {
  type: string
  severity: 'error' | 'warning'
  components: string[]
  message: string
  targets: string[]
  /** Base ou outil concerné (quantv, nve, reshade, enb). */
  requires: string | null
}

export interface BuilderEstimate {
  size: number
  fileCount: number
  performance: PackPerformance | null
}

export interface BuilderPreview {
  components: string[]
  valid: boolean
  problems: BuilderProblem[]
  estimate: BuilderEstimate
}

/** État d'une création dans la bibliothèque de ce PC. */
export interface BuilderLocal {
  /** Pack construit à partir de cette création (null : pas encore installée). */
  localId: string | null
  /** Une nouvelle révision est en ligne (fichiers d'un composant, ou création modifiée depuis). */
  updateAvailable: boolean
}

export interface BuilderBuildSummary extends BuilderLocal {
  id: string
  name: string
  componentCount: number
  /** Composants retirés depuis l'enregistrement. */
  unavailableCount: number
  plan: BuildPlan
  createdAt: string
  updatedAt: string
}

/** Composant d'une création ; `available` faux s'il a été retiré (`id` null s'il a été supprimé). */
export interface BuilderBuildComponent {
  id: string | null
  name: string
  category: string
  available: boolean
}

export interface BuilderBuild extends BuilderLocal {
  id: string
  name: string
  components: BuilderBuildComponent[]
  tools: BuilderTools
  problems: BuilderProblem[]
  estimate: BuilderEstimate | null
  plan: BuildPlan
  createdAt: string
  updatedAt: string
}

/** Création à enregistrer (nom de 80 caractères au plus) : composants hors outils d'ambiance, et choix par outil. */
export interface BuilderSaveInput {
  name: string
  components: string[]
  tools: BuilderTools
}

/** Packs de la bibliothèque construits par « Créer ton pack » : nouvelle révision en ligne, ou création supprimée. */
export interface BuilderStatus {
  updates: string[]
  gone: string[]
}

// ---------------------------------------------------------------------------
// Vente de « Créer ton pack » : packs gratuits, crédits de pack, paiement par Stripe Checkout (dans le navigateur)

/** Formule d'une création : pack gratuit (modifications comptées), payé par un crédit, ou offert (illimité). */
export type BuildPlanType = 'free' | 'credit' | 'open'

export interface BuildPlan {
  type: BuildPlanType
  /** Modifications illimitées (crédit, offert, admin, ou vente coupée). */
  unlimited: boolean
  editsAllowed: number
  editsUsed: number
  /** Modifications complètes restantes ; null quand le pack est illimité. */
  editsLeft: number | null
  /** La prochaine modification des éléments ou des réglages sera refusée (402 « builder-edit-locked ») : à débloquer. */
  locked: boolean
}

/** Achat de « Créer ton pack » : un pack de plus (un crédit), ou le déblocage d'un pack gratuit. */
export type BuilderProduct = 'pack' | 'unlock'

/** Achat : ceux de « Créer ton pack », ou un pack (ou un mod) payant du catalogue (`item`). */
export type BillingProduct = BuilderProduct | 'item'

/**
 * Vente en public (GET /billing/info, complété par l'application) : ce qu'il faut pour acheter un pack ou un mod du
 * catalogue sans accès à « Créer ton pack ». AccountBilling en a aussi tous les champs.
 */
export interface SaleInfo {
  currency: string
  /** Le paiement est possible (Stripe configuré). */
  checkout: boolean
  /** Paiements de test (clés Stripe de test de l'API de dev) : rien n'est débité. */
  testMode: boolean
  /** Conditions générales de vente du site. */
  termsUrl: string | null
  /** Discord (support), null sans lien. */
  supportUrl: string | null
}

/** Droit d'un compte (ou d'un visiteur) sur un pack ou un mod du catalogue (GET /{packs|mods}/{id}/access). */
export interface ItemAccess {
  packId: string
  /** Centimes TTC ; null : gratuit. */
  price: number | null
  currency: string
  /** Payant et à lui : acheté, offert, ou il en est l'auteur ou l'admin. */
  owned: boolean
  canDownload: boolean
}

/** Pack ou mod payant acheté (`purchase`) ou offert par l'admin (`admin`) au compte connecté (GET /me/packs/owned). */
export interface OwnedPack {
  packId: string
  kind: MarketKind
  slug: string
  name: string
  /** Toujours visible sur la Marketplace. */
  available: boolean
  source: 'purchase' | 'admin'
  purchaseId: string | null
  since: string
}

/** Commande d'un pack ou d'un mod payant : CGV acceptées et renonciation au droit de rétractation, obligatoires. */
export interface ItemCheckoutInput {
  promoCode?: string | null
  acceptTerms: boolean
  waiveWithdrawal: boolean
}

/** État de la vente de « Créer ton pack » pour le compte connecté (GET /builder/billing). Montants en centimes TTC. */
export interface AccountBilling extends SaleInfo {
  enabled: boolean
  /** Tout est illimité (admin, ou vente coupée) : aucune offre à montrer. */
  unlimited: boolean
  prices: { pack: number; unlock: number }
  free: { packs: number; used: number; remaining: number; edits: number }
  credits: { total: number; used: number; available: number }
  /** Formule d'un nouveau pack ; null s'il faut d'abord payer. */
  nextPlan: 'credit' | 'free' | 'open' | null
  canCreate: boolean
  builds: number
  maxBuilds: number
}

export interface QuoteInput {
  product: BuilderProduct
  /** Pack gratuit à débloquer (achat « unlock »). */
  buildId?: string | null
  promoCode?: string | null
}

/** Commande : CGV acceptées et renonciation au droit de rétractation, toutes deux obligatoires. */
export interface CheckoutInput extends QuoteInput {
  acceptTerms: boolean
  waiveWithdrawal: boolean
}

/** Prix d'un achat : `amount` à payer (0 : offert par le code), `discount` du code promo. */
export interface Quote {
  product: BillingProduct
  currency: string
  baseAmount: number
  discount: number
  amount: number
  promo: { code: string; percentOff: number | null; amountOff: number | null } | null
}

export type PurchaseStatus = 'pending' | 'paid' | 'free' | 'expired' | 'failed' | 'canceled' | 'refunded'

/** Achat du compte ; `checkoutUrl` (page Stripe) et `expiresAt` tant qu'il est `pending`. */
export interface Purchase {
  id: string
  product: BillingProduct
  buildId: string | null
  buildName: string | null
  /** Pack ou mod du catalogue (achat `item`). */
  packId: string | null
  packName: string | null
  /** Catalogue du pack, quand l'application le connaît (packs à soi, catalogue lu) ; null sinon. */
  packKind: MarketKind | null
  currency: string
  baseAmount: number
  discount: number
  amount: number
  promoCode: string | null
  status: PurchaseStatus
  checkoutUrl: string | null
  expiresAt: string | null
  createdAt: string
  paidAt: string | null
}

// ---------------------------------------------------------------------------
// Mises à jour de l'application

export interface UpdateState {
  status: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'verifying' | 'ready' | 'error' | 'unsupported'
  version?: string
  notes?: string
  /** Notes de la nouvelle version, par rubrique (« Voir les nouveautés »). */
  release?: ReleaseNotes
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

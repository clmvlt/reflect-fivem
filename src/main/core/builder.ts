// « Créer ton pack » : le joueur connecté compose son propre pack à partir des composants publiés (routes, végétation,
// sang...), règle son ambiance (outils ReShade, QuantV, NVE, ENB : aucun, réglé par lui avec un style, ou importé d'un
// pack ; voir @shared/ambiance), enregistre sa création sur son compte (privée) et l'installe comme un pack de la
// bibliothèque. Tout passe par /builder, réservé à une session de l'application (voir account.ts) dont le compte a le
// droit « Peut créer un pack » (canUseBuilder) : sans compte, erreur SIGNED_OUT ; sans le droit, BUILDER_NOT_ALLOWED,
// sans requête (l'interface cache la page). Un refus 403 « builder-not-allowed » de l'API (droit retiré depuis la
// dernière lecture du compte) fait relire le compte.
//
// Sur le disque (<données>/builder) :
//   catalog-<langue>.json   dernier catalogue reçu et son ETag : consultable hors ligne, revérifié par If-None-Match
//                           (304 : rien à faire) ;
//   images/                 images des composants, des styles et des images de référence en jeu (publiques, jamais
//                           modifiées), 200 Mo au plus ;
//   blobs/<xx>/<sha256>     fichiers des composants, rangés par empreinte : un fichier partagé par plusieurs composants
//                           n'est téléchargé qu'une fois ; <sha256>.part pendant le téléchargement (repris par Range).
//                           Gardés tant qu'un pack construit de la bibliothèque s'en sert (reconstruction sans tout
//                           retélécharger), ou que le téléchargement en cours en a besoin.
//
// Installation (file des téléchargements, voir service.ts) : manifeste de la création, dont chaque chemin est contrôlé
// avant d'écrire quoi que ce soit (racine fivem limitée à mods, plugins, addons et citizen ; racine gta sans les fichiers
// du jeu ; pas de « .. » ni de caractère interdit ; de même pour chaque entrée des zips), fichiers manquants téléchargés
// et vérifiés (SHA-256), puis un pack de la bibliothèque construit dans cet ordre : zips extraits, fichiers (un fichier
// remplace celui d'un zip au même endroit), fichiers de réglages écrits par l'API, chacun sous sa racine (preset
// ReShade, QuantV.ini, NVE.ini, enbseries.ini dans le dossier de GTA V), qui remplacent ceux des composants.
// Une nouvelle révision (fichier d'un composant changé, création modifiée) se propose comme une nouvelle version d'un
// pack de la Marketplace : reconstruit, même nom, mêmes réglages personnels, réinstallé s'il était installé.
//
// Vente (/builder/billing, mêmes règles d'accès) : chaque création a une formule (`plan` : pack gratuit aux
// modifications comptées, crédit de pack ou offert ; absente d'une ancienne API : offert, illimité). Une création
// refusée faute de pack libre, ou la modification d'un pack gratuit au bout de ses modifications, répond 402
// (BUILDER_PAYMENT_REQUIRED, BUILDER_EDIT_LOCKED) : l'interface propose alors l'achat. Le paiement se fait sur une page
// Stripe Checkout ouverte dans le navigateur ; l'application ne voit ni carte bancaire ni clé Stripe.
//
// Aucune dépendance à Electron ici (testé avec vitest) : le service fournit fetch, le compte et la bibliothèque.

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import { t } from 'i18next'
import { BUILDER_NOT_ALLOWED, canUseBuilder, SIGNED_OUT } from '@shared/api'
import { currentLocale } from '@shared/i18n'
import { formatBytes as displayBytes } from '@shared/intl'
import { httpsUrl } from '@shared/links'
import { parsePackPerformance } from '@shared/performance'
import { cleanTools, fromLegacy, isToolKey, isToolMode, lookImages, styleOf } from '@shared/ambiance'
import type {
  AccountBilling,
  AccountMe,
  BillingProduct,
  BuildPlan,
  BuilderBase,
  BuilderBuild,
  BuilderBuildComponent,
  BuilderBuildSummary,
  BuilderCatalog,
  BuilderCategory,
  BuilderComponentCard,
  BuilderComponentDetail,
  BuilderControl,
  BuilderControlValue,
  BuilderEffect,
  BuilderEstimate,
  BuilderImageRef,
  BuilderLocal,
  BuilderParam,
  BuilderPerformance,
  BuilderPreview,
  BuilderProblem,
  BuilderReference,
  BuilderSaveInput,
  BuilderStatus,
  BuilderStyle,
  BuilderStylePreview,
  BuilderTechnique,
  BuilderTool,
  BuilderTools,
  BuilderToolView,
  CheckoutInput,
  Destination,
  MarketImage,
  Purchase,
  PurchaseStatus,
  Quote,
  QuoteInput,
  RootId,
  ToolKey
} from '@shared/types'
import { decodeZipName } from '../archive/sanitize'
import { ApiError, MaintenanceError, type Fetch } from './http'
import type { Report } from './installer'
import { isAllowedFiveMPath, isProtectedGtaPath } from './knowledge'
import type { BuiltItem, Library, StoredManifest } from './library'
import type { DownloadAuth, InstallHooks } from './marketplace'
import { formatBytes, freeSpace, readJson, sameVolume, walkFiles, writeJsonAtomic } from '../util/fsx'
import { log } from '../util/log'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Version de l'image d'un style ou d'une image de référence en jeu (« ?v=… » de son adresse). */
const IMAGE_VERSION = /^[A-Za-z0-9_-]{1,64}$/
const SHA256 = /^[0-9a-f]{64}$/
const IMAGE_CACHE_MAX = 200 * 1024 * 1024
const NAME_MAX = 80
const BASES: readonly string[] = ['quantv', 'nve', 'reshade']
const TIERS: readonly string[] = ['light', 'medium', 'heavy', 'extreme']
const CONTROL_TYPES: readonly string[] = ['slider', 'toggle', 'select', 'color']
const ZIP_METHODS = new Set([0, 8])
/** Partie d'un chemin refusée : « . », « .. », séparateur ou caractère interdit sous Windows. */
const UNSAFE_PART = /^\.+$|[\\/:*?"<>|\x00-\x1f]/
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

// ------------------------------------------------------------------ contrôle des chemins (fonctions pures, testées)

/**
 * Chemin d'installation sûr (comme PackLayout.isSafeInstallPath de l'API) : relatif, séparé par « / », sans « .. », nom
 * réservé ni caractère interdit sous Windows ; sous FiveM.app seulement dans mods, plugins, addons et citizen ; sous
 * GTA V jamais un fichier du jeu (mêmes règles que knowledge.ts).
 */
export function isSafeInstallPath(root: unknown, rel: unknown): root is RootId {
  if (typeof rel !== 'string' || !rel || rel.length > 400 || rel.startsWith('/') || rel.endsWith('/')) return false
  for (const part of rel.split('/')) {
    if (!part.trim() || UNSAFE_PART.test(part) || / $|\.$/.test(part) || RESERVED.test(part)) return false
  }
  if (root === 'fivem') return isAllowedFiveMPath(rel)
  if (root === 'gta') return !isProtectedGtaPath(rel)
  return false
}

/** Fichier à télécharger (`url` relative à l'API) et à placer sous sa racine ; bundle : zip à extraire dans `path`. */
export interface ManifestFile {
  componentId: string | null
  root: RootId
  path: string
  kind: 'file' | 'bundle'
  size: number
  sha256: string
  url: string
  entryCount: number
}

/** Fichier écrit par l'API (preset ReShade avec les réglages du joueur), en UTF-8. */
export interface GeneratedFile {
  componentId: string | null
  root: RootId
  path: string
  content: string
}

/** Tout ce qu'il faut installer pour une création, contrôlé (voir checkManifest). */
export interface BuildManifest {
  buildId: string | null
  name: string
  revision: string
  /** Zips d'abord, puis fichiers, dans l'ordre de l'API. */
  files: ManifestFile[]
  generated: GeneratedFile[]
  /** Preset ReShade (chemin sous FiveM.app) à désigner dans ReShade.ini ; null sans preset. */
  preset: string | null
  unavailable: BuilderBuildComponent[]
  problems: BuilderProblem[]
  totalSize: number
}

const unsafePath = (root: unknown, p: unknown): Error => new Error(t('builder.errors.unsafePath', { path: `${String(root)}/${String(p)}` }))
const badResponse = (): Error => new Error(t('builder.errors.badResponse'))
/** Compte sans le droit « Peut créer un pack » (ou qui vient de le perdre). */
const notAllowed = (): ApiError => new ApiError(t('builder.errors.notAllowed'), 403, BUILDER_NOT_ALLOWED)

/**
 * Manifeste reçu de l'API, contrôlé entrée par entrée avant d'écrire quoi que ce soit : un seul chemin refusé (hors des
 * dossiers permis, fichier du jeu, « .. », chemin absolu, caractère interdit) et rien n'est installé.
 */
export function checkManifest(raw: unknown): BuildManifest {
  const r = obj(raw)
  const revision = str(r.revision)
  if (!revision) throw badResponse()
  const files: ManifestFile[] = []
  for (const item of arr(r.files)) {
    const f = obj(item)
    if (!isSafeInstallPath(f.root, f.path)) throw unsafePath(f.root, f.path)
    const size = f.size
    const entryCount = f.kind === 'bundle' ? f.entryCount : 1
    const url = f.url
    if (
      (f.kind !== 'file' && f.kind !== 'bundle') ||
      typeof f.sha256 !== 'string' ||
      !SHA256.test(f.sha256) ||
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      typeof entryCount !== 'number' ||
      !Number.isSafeInteger(entryCount) ||
      entryCount < 1 ||
      !isApiPath(url)
    )
      throw badResponse()
    files.push({ componentId: strOrNull(f.componentId), root: f.root, path: f.path as string, kind: f.kind, size, sha256: f.sha256, url, entryCount })
  }
  // Ordre d'installation : les zips d'abord (un fichier remplace ensuite celui d'un zip au même endroit).
  files.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'bundle' ? -1 : 1))
  const generated: GeneratedFile[] = []
  for (const item of arr(r.generated)) {
    const g = obj(item)
    if (!isSafeInstallPath(g.root, g.path)) throw unsafePath(g.root, g.path)
    if (typeof g.content !== 'string') throw badResponse()
    generated.push({ componentId: strOrNull(g.componentId), root: g.root, path: g.path as string, content: g.content })
  }
  const preset = strOrNull(r.preset)
  if (preset !== null && !isSafeInstallPath('fivem', preset)) throw unsafePath('fivem', preset)
  return {
    buildId: strOrNull(r.buildId),
    name: str(r.name),
    revision,
    files,
    generated,
    preset,
    unavailable: arr(r.unavailable).map(toBuildComponent),
    problems: arr(r.problems).map(toProblem),
    totalSize: num(r.totalSize) ?? files.reduce((s, f) => s + f.size, 0)
  }
}

/** Adresse relative à l'API (« /builder/files/... »), sans autre hôte ni remontée. */
function isApiPath(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') && !url.includes('..') && !/[\s\\#]/.test(url)
}

// ------------------------------------------------------------------ zips des composants (dossiers de shaders...)

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true, strictFileNames: false } as yauzl.Options, (err, zip) =>
      err || !zip ? reject(new Error(t('builder.errors.badBundle'))) : resolve(zip)
    )
  })
}

function listZip(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const out: yauzl.Entry[] = []
    zip.on('entry', (e: yauzl.Entry) => {
      out.push(e)
      zip.readEntry()
    })
    zip.on('end', () => resolve(out))
    zip.on('error', () => reject(new Error(t('builder.errors.badBundle'))))
    zip.readEntry()
  })
}

function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => (err || !stream ? reject(new Error(t('builder.errors.badBundle'))) : resolve(stream)))
  })
}

/**
 * Extrait le zip d'un composant (`bundle`) dans `target`, le dossier `base` sous la racine `root`. Toutes les entrées
 * sont contrôlées avant d'écrire quoi que ce soit : chemin sûr une fois placé sous `base` (pas de « zip slip »), ni
 * chiffrement ni compression inconnue, pas de doublon, exactement `expected` fichiers. Renvoie les fichiers écrits
 * (chemins relatifs à `base`).
 */
export async function extractBundle(file: string, target: string, root: RootId, base: string, expected: number, signal?: AbortSignal): Promise<{ rel: string; size: number }[]> {
  const zip = await openZip(file)
  try {
    const entries: { entry: yauzl.Entry; rel: string }[] = []
    const seen = new Set<string>()
    for (const entry of await listZip(zip)) {
      const raw = entry.fileName as unknown as Buffer | string
      const name = typeof raw === 'string' ? raw : decodeZipName(raw, (entry.generalPurposeBitFlag & 0x800) !== 0)
      if (name.endsWith('/')) continue
      if (!isSafeInstallPath(root, `${base}/${name}`)) throw unsafePath(root, `${base}/${name}`)
      if ((entry.generalPurposeBitFlag & 0x1) !== 0 || !ZIP_METHODS.has(entry.compressionMethod)) throw new Error(t('builder.errors.badBundle'))
      if (seen.has(name.toLowerCase())) throw new Error(t('builder.errors.badBundle'))
      seen.add(name.toLowerCase())
      entries.push({ entry, rel: name })
    }
    if (entries.length !== expected) throw new Error(t('builder.errors.badBundle'))
    const out: { rel: string; size: number }[] = []
    for (const { entry, rel } of entries) {
      if (signal?.aborted) throw new Error(t('market.errors.cancelled'))
      const dest = path.join(target, ...rel.split('/'))
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await pipeline(await openEntry(zip, entry), createWriteStream(dest))
      out.push({ rel, size: entry.uncompressedSize })
    }
    return out
  } finally {
    zip.close()
  }
}

// ------------------------------------------------------------------ réponses de l'API

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const obj = (x: unknown): Obj => (isObj(x) ? x : {})
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])
const str = (x: unknown): string => (typeof x === 'string' ? x : '')
const strOrNull = (x: unknown): string | null => (typeof x === 'string' && x ? x : null)
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
const strings = (x: unknown): string[] => arr(x).filter((s): s is string => typeof s === 'string')
const bases = (x: unknown): BuilderBase[] => strings(x).filter((b): b is BuilderBase => BASES.includes(b))
const ids = (x: unknown): string[] => strings(x).filter((s) => UUID.test(s))

function toImage(raw: unknown): MarketImage | null {
  const o = obj(raw)
  return typeof o.id === 'string' && UUID.test(o.id) ? { id: o.id, width: num(o.width) ?? 0, height: num(o.height) ?? 0 } : null
}

function toPerformance(raw: unknown): BuilderPerformance | null {
  const o = obj(raw)
  if (typeof o.tier !== 'string' || !TIERS.includes(o.tier)) return null
  return { tier: o.tier as BuilderPerformance['tier'], vramMb: num(o.vramMb), effectsMs: num(o.effectsMs), worldMs: num(o.worldMs) }
}

function toCard(raw: unknown): BuilderComponentCard | null {
  const o = obj(raw)
  if (typeof o.id !== 'string' || !UUID.test(o.id)) return null
  return {
    id: o.id,
    slug: str(o.slug),
    category: str(o.category),
    name: str(o.name) || str(o.slug),
    summary: str(o.summary),
    credits: str(o.credits),
    cover: toImage(o.cover),
    imageCount: num(o.imageCount) ?? 0,
    size: num(o.size) ?? 0,
    fileCount: num(o.fileCount) ?? 0,
    performance: toPerformance(o.performance),
    unreadable: o.unreadable === true,
    provides: bases(o.provides),
    requires: bases(o.requires),
    conflictsWith: ids(o.conflictsWith),
    tags: strings(o.tags),
    sources: strings(o.sources),
    updatedAt: str(o.updatedAt)
  }
}

function toControlValue(x: unknown): BuilderControlValue | null {
  return typeof x === 'number' || typeof x === 'boolean' || typeof x === 'string' ? x : null
}

function toControl(raw: unknown): BuilderControl | null {
  const o = obj(raw)
  if (typeof o.key !== 'string' || !o.key || typeof o.type !== 'string' || !CONTROL_TYPES.includes(o.type)) return null
  return {
    key: o.key,
    label: str(o.label) || o.key,
    description: str(o.description),
    group: str(o.group),
    groupLabel: str(o.groupLabel),
    type: o.type as BuilderControl['type'],
    min: num(o.min),
    max: num(o.max),
    step: num(o.step),
    options: arr(o.options)
      .map(obj)
      .filter((p) => typeof p.value === 'string')
      .map((p) => ({ value: p.value as string, label: str(p.label) || (p.value as string) })),
    value: toControlValue(o.value),
    tool: isToolKey(o.tool) ? o.tool : null
  }
}

const present = <T>(x: T | null): x is T => x !== null
const uuidOrNull = (x: unknown): string | null => (typeof x === 'string' && UUID.test(x) ? x : null)

/** Version de l'image d'un style, lue dans son adresse (« /builder/styles/<id>/image?v=<version> ») ; null sans image. */
export function styleImageVersion(id: string, url: unknown): string | null {
  return imageVersion('styles', id, url)
}

/**
 * Version lue dans l'adresse d'une image de l'API (« /builder/<route>/<id>/image?v=<version> ») ; null sans adresse,
 * ou pour celle d'une autre image ou d'un autre serveur.
 */
function imageVersion(route: 'styles' | 'references', id: string, url: unknown): string | null {
  const m = typeof url === 'string' ? /^\/builder\/(styles|references)\/([0-9a-f-]{36})\/image\?v=([A-Za-z0-9_-]{1,64})(&|$)/i.exec(url) : null
  return m && m[1].toLowerCase() === route && m[2].toLowerCase() === id.toLowerCase() ? m[3] : null
}

function toStylePreview(raw: unknown): BuilderStylePreview | null {
  if (!isObj(raw)) return null
  return {
    brightness: num(raw.brightness),
    contrast: num(raw.contrast),
    saturate: num(raw.saturate),
    sepia: num(raw.sepia),
    grayscale: num(raw.grayscale),
    hueRotate: num(raw.hueRotate),
    tint: typeof raw.tint === 'string' && /^#[0-9a-f]{6}$/i.test(raw.tint) ? raw.tint : null,
    tintOpacity: num(raw.tintOpacity),
    vignette: num(raw.vignette),
    grain: num(raw.grain)
  }
}

function toStyle(raw: unknown): BuilderStyle | null {
  const o = obj(raw)
  if (typeof o.id !== 'string' || !UUID.test(o.id)) return null
  return {
    id: o.id,
    key: str(o.key),
    label: str(o.label) || str(o.key),
    description: str(o.description),
    imageVersion: styleImageVersion(o.id, o.imageUrl),
    preview: toStylePreview(o.preview),
    costMs: num(o.costMs) ?? 0,
    costLabel: str(o.costLabel),
    byDefault: o.byDefault === true
  }
}

function toTool(raw: unknown): BuilderTool | null {
  const o = obj(raw)
  if (!isToolKey(o.key)) return null
  return {
    key: o.key,
    label: str(o.label) || o.key,
    description: str(o.description),
    category: str(o.category) || o.key,
    defaultMode: isToolMode(o.defaultMode) ? o.defaultMode : 'none',
    defaultStyle: uuidOrNull(o.defaultStyle),
    custom: o.custom === true,
    packs: num(o.packs) ?? 0,
    referenceComponent: uuidOrNull(o.referenceComponent),
    reference: toImage(o.reference),
    styles: arr(o.styles).map(toStyle).filter(present),
    requires: strings(o.requires).filter(isToolKey)
  }
}

/** Image de référence en jeu ; null sans identifiant ou sans adresse d'image valable. */
function toReference(raw: unknown): BuilderReference | null {
  const o = obj(raw)
  if (typeof o.id !== 'string' || !UUID.test(o.id)) return null
  const version = imageVersion('references', o.id, o.imageUrl)
  if (!version) return null
  return { id: o.id, label: str(o.label), credits: str(o.credits), version, width: num(o.width) ?? 0, height: num(o.height) ?? 0, byDefault: o.byDefault === true }
}

/** Catalogue reçu (ou gardé sur le disque) ; erreur s'il est inutilisable. */
export function toCatalog(raw: unknown, flags: { offline: boolean; checked: boolean }): BuilderCatalog {
  const r = obj(raw)
  if (!Array.isArray(r.groups) || !Array.isArray(r.categories)) throw badResponse()
  return {
    version: str(r.version),
    groups: r.groups
      .map(obj)
      .filter((g) => typeof g.key === 'string')
      .map((g) => ({ key: g.key as string, label: str(g.label) || (g.key as string), categories: strings(g.categories) })),
    categories: r.categories
      .map(obj)
      .filter((c) => typeof c.key === 'string')
      .map(
        (c): BuilderCategory => ({
          key: c.key as string,
          label: str(c.label) || (c.key as string),
          group: str(c.group),
          single: c.single === true,
          components: arr(c.components).map(toCard).filter(present),
          tool: isToolKey(c.tool) ? c.tool : null
        })
      ),
    tools: arr(r.tools).map(toTool).filter(present),
    // Chacune une seule fois (une pastille par image dans l'interface).
    references: arr(r.references)
      .map(toReference)
      .filter(present)
      .filter((x, i, all) => all.findIndex((y) => y.id === x.id) === i),
    controls: arr(r.controls).map(toControl).filter(present),
    ...flags
  }
}

function toDetail(raw: unknown): BuilderComponentDetail {
  const card = toCard(raw)
  if (!card) throw badResponse()
  const o = obj(raw)
  const url = str(o.sourceUrl)
  return {
    ...card,
    description: str(o.description),
    // Ouverte dans le navigateur : http(s) seulement.
    sourceUrl: /^https?:\/\//i.test(url) ? url : null,
    images: arr(o.images).map(toImage).filter(present),
    foundIn: arr(o.sources)
      .map(obj)
      .filter((s) => typeof s.packName === 'string')
      .map((s) => ({ packId: str(s.packId), packSlug: strOrNull(s.packSlug), packName: s.packName as string, packAuthor: str(s.packAuthor), path: str(s.path) })),
    targets: strings(o.targets),
    files: arr(o.files)
      .map(obj)
      .filter((f) => (f.root === 'fivem' || f.root === 'gta') && typeof f.path === 'string')
      .map((f) => ({ root: f.root as RootId, path: f.path as string, kind: f.kind === 'bundle' ? 'bundle' : 'file', size: num(f.size) ?? 0 }))
  }
}

function toParam(raw: unknown): BuilderParam | null {
  const o = obj(raw)
  if (typeof o.name !== 'string' || !o.name) return null
  return {
    name: o.name,
    type: strOrNull(o.type),
    ui: strOrNull(o.ui),
    label: strOrNull(o.label),
    tooltip: strOrNull(o.tooltip),
    category: strOrNull(o.category),
    min: num(o.min),
    max: num(o.max),
    step: num(o.step),
    items: strings(o.items),
    value: typeof o.value === 'string' ? o.value : null,
    defaultValue: typeof o.defaultValue === 'string' ? o.defaultValue : null,
    baseValue: typeof o.baseValue === 'string' ? o.baseValue : null
  }
}

function toTechnique(raw: unknown): BuilderTechnique | null {
  const o = obj(raw)
  if (typeof o.name !== 'string' || !o.name) return null
  return { name: o.name, effect: strOrNull(o.effect), enabled: o.enabled === true, costMs: num(o.costMs) ?? 0, costLabel: str(o.costLabel) }
}

function toEffect(raw: unknown): BuilderEffect | null {
  const o = obj(raw)
  return typeof o.file === 'string' && o.file ? { file: o.file, params: arr(o.params).map(toParam).filter(present) } : null
}

function toToolView(raw: unknown, tool: ToolKey): BuilderToolView {
  const o = obj(raw)
  return {
    tool,
    mode: isToolMode(o.mode) ? o.mode : 'none',
    componentId: uuidOrNull(o.componentId),
    styleId: uuidOrNull(o.styleId),
    path: strOrNull(o.path),
    techniques: Array.isArray(o.techniques) ? o.techniques.map(toTechnique).filter(present) : null,
    available: Array.isArray(o.available) ? strings(o.available) : null,
    effects: arr(o.effects).map(toEffect).filter(present),
    controls: arr(o.controls).map(toControl).filter(present),
    problems: arr(o.problems).map(toProblem)
  }
}

function toProblem(raw: unknown): BuilderProblem {
  const o = obj(raw)
  const requires = isToolKey(o.requires) ? o.requires : null
  return {
    type: str(o.type),
    severity: o.severity === 'error' ? 'error' : 'warning',
    components: ids(o.components),
    message: str(o.message),
    targets: strings(o.targets),
    requires
  }
}

function toEstimate(raw: unknown): BuilderEstimate {
  const o = obj(raw)
  return { size: num(o.size) ?? 0, fileCount: num(o.fileCount) ?? 0, performance: parsePackPerformance(o.performance) }
}

function toPreview(raw: unknown): BuilderPreview {
  const o = obj(raw)
  return { components: ids(o.components), valid: o.valid === true, problems: arr(o.problems).map(toProblem), estimate: toEstimate(o.estimate) }
}

function toBuildComponent(raw: unknown): BuilderBuildComponent {
  const o = obj(raw)
  const id = typeof o.id === 'string' && UUID.test(o.id) ? o.id : null
  return { id, name: str(o.name), category: str(o.category), available: id !== null && o.available !== false }
}

function toSummary(raw: unknown): Omit<BuilderBuildSummary, keyof BuilderLocal> | null {
  const o = obj(raw)
  if (typeof o.id !== 'string' || !UUID.test(o.id)) return null
  return {
    id: o.id,
    name: str(o.name),
    componentCount: num(o.componentCount) ?? 0,
    unavailableCount: num(o.unavailableCount) ?? 0,
    plan: toPlan(o.plan),
    createdAt: str(o.createdAt),
    updatedAt: str(o.updatedAt)
  }
}

function toBuild(raw: unknown): Omit<BuilderBuild, keyof BuilderLocal> {
  const o = obj(raw)
  if (typeof o.id !== 'string' || !UUID.test(o.id)) throw badResponse()
  const components = arr(o.components).map(toBuildComponent)
  // Création vue par une API d'avant les outils d'ambiance (réglages ReShade seulement) : son preset est importé d'un pack.
  const tools = isObj(o.tools)
    ? cleanTools(o.tools)
    : fromLegacy(
        components.filter((c) => c.available && c.id).map((c) => c.id!),
        (id) => components.find((c) => c.id === id)?.category,
        o.reshade
      ).tools
  return {
    id: o.id,
    name: str(o.name),
    components,
    tools,
    problems: arr(o.problems).map(toProblem),
    estimate: isObj(o.estimate) ? toEstimate(o.estimate) : null,
    plan: toPlan(o.plan),
    createdAt: str(o.createdAt),
    updatedAt: str(o.updatedAt)
  }
}

// ------------------------------------------------------------------ vente (formules, état du compte, achats)

const PLAN_TYPES: readonly string[] = ['free', 'credit', 'open']
const PURCHASE_STATUSES: readonly string[] = ['pending', 'paid', 'free', 'expired', 'failed', 'canceled', 'refunded']
/** Entier positif ou nul (montant en centimes, nombre de packs). */
const count = (x: unknown): number => Math.max(0, Math.round(num(x) ?? 0))
const product = (x: unknown): BillingProduct => (x === 'unlock' ? 'unlock' : 'pack')
const webUrl = (x: unknown): string | null => (typeof x === 'string' && /^https?:\/\/[^\s]+$/i.test(x) ? x : null)

/**
 * Formule d'une création. Absente (API d'avant la vente) ou illisible : offerte, illimitée. Un pack gratuit n'est
 * jamais à débloquer quand il est illimité.
 */
export function toPlan(raw: unknown): BuildPlan {
  if (!isObj(raw) || typeof raw.type !== 'string' || !PLAN_TYPES.includes(raw.type))
    return { type: 'open', unlimited: true, editsAllowed: 0, editsUsed: 0, editsLeft: null, locked: false }
  const type = raw.type as BuildPlan['type']
  const unlimited = typeof raw.unlimited === 'boolean' ? raw.unlimited : type !== 'free'
  return {
    type,
    unlimited,
    editsAllowed: count(raw.editsAllowed),
    editsUsed: count(raw.editsUsed),
    editsLeft: unlimited ? null : count(raw.editsLeft),
    locked: !unlimited && raw.locked === true
  }
}

/** État de la vente pour le compte ; réponse incomplète : rien de limité (aucune offre montrée). */
export function toBilling(raw: unknown): AccountBilling {
  const o = obj(raw)
  const prices = obj(o.prices)
  const free = obj(o.free)
  const credits = obj(o.credits)
  const next = o.nextPlan
  return {
    enabled: o.enabled === true,
    unlimited: o.unlimited !== false,
    currency: str(o.currency) || 'eur',
    prices: { pack: count(prices.pack), unlock: count(prices.unlock) },
    free: { packs: count(free.packs), used: count(free.used), remaining: count(free.remaining), edits: count(free.edits) },
    credits: { total: count(credits.total), used: count(credits.used), available: count(credits.available) },
    nextPlan: next === 'credit' || next === 'free' || next === 'open' ? next : null,
    canCreate: o.canCreate !== false,
    builds: count(o.builds),
    maxBuilds: count(o.maxBuilds) || 50,
    checkout: o.checkout === true,
    termsUrl: webUrl(o.termsUrl),
    // Ouvert dans le navigateur : https seulement, comme les liens du site.
    supportUrl: httpsUrl(o.supportUrl)
  }
}

export function toQuote(raw: unknown): Quote {
  const o = obj(raw)
  const promo = isObj(o.promo) && typeof o.promo.code === 'string' ? o.promo : null
  return {
    product: product(o.product),
    currency: str(o.currency) || 'eur',
    baseAmount: count(o.baseAmount),
    discount: count(o.discount),
    amount: count(o.amount),
    promo: promo ? { code: promo.code as string, percentOff: num(promo.percentOff), amountOff: num(promo.amountOff) } : null
  }
}

/** Achat ; statut inconnu : échoué (l'attente d'un paiement ne dure jamais sans fin). */
export function toPurchase(raw: unknown): Purchase {
  const o = obj(raw)
  if (typeof o.id !== 'string' || !UUID.test(o.id)) throw badResponse()
  return {
    id: o.id,
    product: product(o.product),
    buildId: uuidOrNull(o.buildId),
    buildName: strOrNull(o.buildName),
    currency: str(o.currency) || 'eur',
    baseAmount: count(o.baseAmount),
    discount: count(o.discount),
    amount: count(o.amount),
    promoCode: strOrNull(o.promoCode),
    status: typeof o.status === 'string' && PURCHASE_STATUSES.includes(o.status) ? (o.status as PurchaseStatus) : 'failed',
    checkoutUrl: strOrNull(o.checkoutUrl),
    expiresAt: strOrNull(o.expiresAt),
    createdAt: str(o.createdAt),
    paidAt: strOrNull(o.paidAt)
  }
}

/** Corps d'un prix ou d'une commande : produit connu, pack visé (UUID), code promo nettoyé (null s'il est vide). */
function order(input: QuoteInput): { product: BillingProduct; buildId: string | null; promoCode: string | null } {
  const code = typeof input.promoCode === 'string' ? input.promoCode.trim().slice(0, 32) : ''
  return { product: product(input.product), buildId: uuidOrNull(input.buildId), promoCode: code || null }
}

/** Corps d'une erreur de l'API (application/problem+json), lu sur une copie de la réponse. */
async function problemOf(response: Response): Promise<{ detail: string | null; code: string | null }> {
  const p = (await response.clone().json().catch(() => null)) as { detail?: unknown; code?: unknown } | null
  return { detail: typeof p?.detail === 'string' && p.detail.trim() ? p.detail : null, code: typeof p?.code === 'string' ? p.code : null }
}

async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    if (signal?.aborted) throw new Error(t('market.errors.cancelled'))
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error(t('market.errors.cancelled')))
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error(t('market.errors.cancelled')))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

// ------------------------------------------------------------------ « Créer ton pack »

/** Compte connecté (voir Account) : requêtes connectées, ETag du catalogue, jeton pour les fichiers, relecture du compte. */
export interface BuilderAccount extends DownloadAuth {
  current(): AccountMe | null
  refresh(): Promise<AccountMe | null>
  call<T>(method: string, pathname: string, opts?: { json?: unknown; auth?: 'optional' | 'required' }): Promise<T>
  fetchAuthed(method: string, pathname: string, opts?: { headers?: Record<string, string> }): Promise<Response>
}

export interface BuilderDeps {
  apiUrl: string
  /** Dossier du catalogue, des images et des fichiers des composants (<données>/builder). */
  dir: string
  account: BuilderAccount
  library: () => Library
  /** fetch des images et des fichiers (langue, 503 « maintenance » levé en MaintenanceError). */
  fetch: Fetch
  /** Attente avant de reprendre un téléchargement coupé (× numéro de l'essai) ; 2 s par défaut. */
  retryDelayMs?: number
}

export interface BuildInstallResult {
  packId: string
  name: string
  kind: 'build'
  status: 'added' | 'updated' | 'up-to-date'
  /** Composants retirés depuis l'enregistrement : pas installés. */
  unavailable: string[]
  /** Message à afficher (mise à jour faite mais pas encore installée dans le jeu, par exemple). */
  note?: string
}

/**
 * Adresse pm-media d'une image (couverture d'un pack construit, vignette de la file des téléchargements), servie par
 * Builder.image, Builder.styleImage ou Builder.referenceImage.
 */
export function coverUrl(ref: BuilderImageRef, thumb: boolean): string {
  const size = thumb ? '?size=thumb' : ''
  if (ref.kind === 'style') return `pm-media://builder-style/${ref.styleId}/${ref.version}${size}`
  if (ref.kind === 'reference') return `pm-media://builder-reference/${ref.referenceId}/${ref.version}${size}`
  return `pm-media://builder/${ref.componentId}/${ref.imageId}${size}`
}

interface CachedCatalog {
  etag: string | null
  savedAt: string
  catalog: unknown
}

export class Builder {
  /** Révision en ligne de chaque création installée (null : création supprimée du compte). */
  private revisions = new Map<string, string | null>()
  /** Fichiers du téléchargement en cours : jamais retirés par le ménage. */
  private inUse = new Set<string>()

  constructor(private deps: BuilderDeps) {}

  private get blobDir(): string {
    return path.join(this.deps.dir, 'blobs')
  }
  private get imageDir(): string {
    return path.join(this.deps.dir, 'images')
  }
  blobFile(sha256: string): string {
    return path.join(this.blobDir, sha256.slice(0, 2), sha256)
  }
  private catalogFile(locale = currentLocale()): string {
    return path.join(this.deps.dir, `catalog-${locale}.json`)
  }

  /** Compte connecté avec le droit « Peut créer un pack », sinon erreur sans requête. */
  private requireAccount(): void {
    const me = this.deps.account.current()
    if (!me) throw new ApiError(t('builder.errors.signedOut'), 401, SIGNED_OUT)
    if (!canUseBuilder(me)) throw notAllowed()
  }

  private call<T>(method: string, pathname: string, json?: unknown): Promise<T> {
    this.requireAccount()
    return this.guard(this.deps.account.call<T>(method, pathname, { json, auth: 'required' }))
  }

  /** Refus 403 « builder-not-allowed » : droit retiré depuis la dernière lecture du compte, qui est relu. */
  private async guard<T>(request: Promise<T>): Promise<T> {
    try {
      return await request
    } catch (err) {
      if (err instanceof ApiError && err.status === 403 && err.code === BUILDER_NOT_ALLOWED) throw this.rightLost()
      throw err
    }
  }

  /** Droit retiré : le compte est relu (l'interface ferme alors la page), erreur à afficher. */
  private rightLost(): ApiError {
    log.info('Créer ton pack : droit retiré au compte')
    this.deps.account.refresh().catch((err: unknown) => log.info(`Compte non relu : ${(err as Error).message}`))
    return notAllowed()
  }

  // ---------------------------------------------------------------- catalogue

  /**
   * Catalogue dans la langue affichée. Sans `refresh` : la copie du disque s'il y en a une. Avec : revérifié par
   * If-None-Match (304 : la copie est à jour) ; hors ligne ou serveur indisponible, la copie se consulte (`offline`).
   */
  async catalog(refresh = false): Promise<BuilderCatalog> {
    this.requireAccount()
    const file = this.catalogFile()
    const saved = await readJson<CachedCatalog | null>(file, null)
    const cached = isObj(saved) && isObj(saved.catalog) ? saved : null
    if (cached && !refresh) {
      try {
        return toCatalog(cached.catalog, { offline: false, checked: false })
      } catch {
        /* copie illisible : redemandée */
      }
    }
    let response: Response
    try {
      response = await this.guard(this.deps.account.fetchAuthed('GET', '/builder/catalog', cached?.etag ? { headers: { 'If-None-Match': cached.etag } } : {}))
    } catch (err) {
      // Connexion refusée (compte déconnecté, session du site) : rien à consulter.
      if (!cached || (err instanceof ApiError && (err.status === 401 || err.status === 403))) throw err
      log.info(`Créer ton pack : catalogue du disque (${(err as Error).message})`)
      return toCatalog(cached.catalog, { offline: true, checked: false })
    }
    if (response.status === 304) {
      if (!cached) throw badResponse()
      return toCatalog(cached.catalog, { offline: false, checked: true })
    }
    const body: unknown = await response.json().catch(() => null)
    const catalog = toCatalog(body, { offline: false, checked: true })
    const etag = response.headers.get('ETag')
    await writeJsonAtomic(file, { etag, savedAt: new Date().toISOString(), catalog: body } satisfies CachedCatalog).catch((err: unknown) =>
      log.warn(`Catalogue de « Créer ton pack » non enregistré : ${(err as Error).message}`)
    )
    log.info(`Créer ton pack : catalogue reçu (${catalog.categories.reduce((s, c) => s + c.components.length, 0)} composants)`)
    return catalog
  }

  /** Copie du disque, sans réseau (null s'il n'y en a pas). */
  private async cachedCatalog(): Promise<BuilderCatalog | null> {
    const saved = await readJson<CachedCatalog | null>(this.catalogFile(), null)
    try {
      return isObj(saved) ? toCatalog(saved.catalog, { offline: false, checked: false }) : null
    } catch {
      return null
    }
  }

  async component(id: string): Promise<BuilderComponentDetail> {
    if (!UUID.test(id)) throw new Error(t('builder.errors.componentGone'))
    return toDetail(await this.call<unknown>('GET', `/builder/components/${id}`))
  }

  /** Vérifie et estime une composition : composants (hors outils d'ambiance) et choix de chaque outil. */
  async preview(components: string[], tools: BuilderTools): Promise<BuilderPreview> {
    return toPreview(await this.call<unknown>('POST', '/builder/preview', { components: components.filter((c) => UUID.test(c)), tools: cleanTools(tools) }))
  }

  /**
   * État d'un outil d'ambiance pour ces choix : effets, paramètres, réglages simples applicables et leur valeur. À
   * redemander quand un choix change (un interrupteur peut ajouter un effet et ses réglages).
   */
  async toolView(tool: ToolKey, tools: BuilderTools): Promise<BuilderToolView> {
    if (!isToolKey(tool)) throw badResponse()
    return toToolView(await this.call<unknown>('POST', '/builder/tools/view', { tool, tools: cleanTools(tools) }), tool)
  }

  /**
   * Paramètres d'un effet ReShade que le joueur ajoute en mode avancé, lus dans les shaders du composant (sinon de la
   * base de l'outil) ; null si l'effet est inconnu.
   */
  async toolEffect(component: string | null, file: string): Promise<BuilderEffect | null> {
    this.requireAccount()
    if ((component !== null && !UUID.test(component)) || !/^[^\\/:*?"<>|\x00-\x1f]{1,200}\.fx$/i.test(file)) return null
    const params = new URLSearchParams({ file })
    if (component) params.set('component', component)
    const response = await this.guard(this.deps.account.fetchAuthed('GET', `/builder/tools/reshade/effects?${params}`))
    const text = await response.text()
    try {
      return text.trim() ? toEffect(JSON.parse(text)) : null
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------- créations

  async builds(): Promise<BuilderBuildSummary[]> {
    const [list, index] = await Promise.all([this.call<unknown>('GET', '/builder/builds'), this.builtIndex()])
    return arr(list)
      .map(toSummary)
      .filter(present)
      .map((b) => ({ ...b, ...this.localState(b.id, index) }))
  }

  async build(id: string): Promise<BuilderBuild> {
    if (!UUID.test(id)) throw new Error(t('builder.errors.notFound'))
    const [raw, index] = await Promise.all([this.call<unknown>('GET', `/builder/builds/${id}`), this.builtIndex()])
    const b = toBuild(raw)
    return { ...b, ...this.localState(b.id, index) }
  }

  /** Enregistre une création : nouvelle (id null) ou modifiée. Une création déjà installée est revérifiée (mise à jour). */
  async save(id: string | null, input: BuilderSaveInput): Promise<BuilderBuild> {
    if (id !== null && !UUID.test(id)) throw new Error(t('builder.errors.notFound'))
    const body = {
      name: input.name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX),
      components: [...new Set(input.components.filter((c) => UUID.test(c)))],
      tools: cleanTools(input.tools)
    }
    const raw = id ? await this.call<unknown>('PUT', `/builder/builds/${id}`, body) : await this.call<unknown>('POST', '/builder/builds', body)
    const b = toBuild(raw)
    log.info(`Créer ton pack : création ${id ? 'enregistrée' : 'ajoutée'} (${b.components.length} composants)`)
    const index = await this.builtIndex()
    if (index.has(b.id)) await this.refreshStatus([b.id])
    return { ...b, ...this.localState(b.id, index) }
  }

  async remove(id: string): Promise<void> {
    if (!UUID.test(id)) throw new Error(t('builder.errors.notFound'))
    await this.call<void>('DELETE', `/builder/builds/${id}`)
    if ((await this.builtIndex()).has(id)) this.revisions.set(id, null)
    log.info('Créer ton pack : création supprimée')
  }

  // ---------------------------------------------------------------- vente

  /** Packs gratuits et crédits du compte, prix, formule d'un nouveau pack ; tout illimité pour l'admin ou sans vente. */
  async billing(): Promise<AccountBilling> {
    return toBilling(await this.call<unknown>('GET', '/builder/billing'))
  }

  /** Prix d'un achat avec un code promo (refusé : 422 avec un code « promo-… »). */
  async quote(input: QuoteInput): Promise<Quote> {
    return toQuote(await this.call<unknown>('POST', '/builder/billing/quote', order(input)))
  }

  /**
   * Commande (CGV acceptées et droit de rétractation abandonné, sinon 400 « terms-required ») : `pending` avec la page
   * de paiement à ouvrir, ou `free` (offert par un code, crédit déjà donné). Une commande identique en cours est reprise.
   */
  async checkout(input: CheckoutInput): Promise<Purchase> {
    const body = { ...order(input), acceptTerms: input.acceptTerms === true, waiveWithdrawal: input.waiveWithdrawal === true }
    const purchase = toPurchase(await this.call<unknown>('POST', '/builder/billing/checkout', body))
    log.info(`Créer ton pack : achat ${purchase.product} commandé (${purchase.status})`)
    return purchase
  }

  /** Un achat ; l'API relit chez Stripe un paiement en cours (au plus toutes les 3 s). */
  async purchase(id: string): Promise<Purchase> {
    if (!UUID.test(id)) throw new Error(t('builder.errors.purchaseNotFound'))
    return toPurchase(await this.call<unknown>('GET', `/builder/billing/purchases/${id}`))
  }

  /** Abandon d'un paiement en cours (la page Stripe est fermée) ; un paiement déjà fait reste acquis. */
  async cancelPurchase(id: string): Promise<Purchase> {
    if (!UUID.test(id)) throw new Error(t('builder.errors.purchaseNotFound'))
    const purchase = toPurchase(await this.call<unknown>('POST', `/builder/billing/purchases/${id}/cancel`))
    log.info(`Créer ton pack : paiement abandonné (${purchase.status})`)
    return purchase
  }

  /** Achats du compte, le plus récent d'abord (ceux qui sont illisibles sont laissés de côté). */
  async purchases(): Promise<Purchase[]> {
    return arr(await this.call<unknown>('GET', '/builder/billing/purchases')).flatMap((raw) => {
      try {
        return [toPurchase(raw)]
      } catch {
        return []
      }
    })
  }

  /** Débloque un pack gratuit avec un crédit libre du compte : modifications illimitées (402 sans crédit libre). */
  async unlockBuild(id: string): Promise<BuilderBuild> {
    if (!UUID.test(id)) throw new Error(t('builder.errors.notFound'))
    const [raw, index] = await Promise.all([this.call<unknown>('POST', `/builder/builds/${id}/unlock`), this.builtIndex()])
    const b = toBuild(raw)
    log.info('Créer ton pack : création débloquée avec un crédit')
    return { ...b, ...this.localState(b.id, index) }
  }

  // ---------------------------------------------------------------- mises à jour

  /** Packs construits de la bibliothèque : le plus récent de chaque création. */
  private async builtIndex(): Promise<Map<string, StoredManifest>> {
    const index = new Map<string, StoredManifest>()
    for (const m of await this.deps.library().list()) {
      if (!m.built || m.deleting) continue
      const other = index.get(m.built.buildId)
      if (!other || other.built!.builtAt < m.built.builtAt) index.set(m.built.buildId, m)
    }
    return index
  }

  private localState(buildId: string, index: Map<string, StoredManifest>): BuilderLocal {
    const local = index.get(buildId)
    const revision = this.revisions.get(buildId)
    return { localId: local?.id ?? null, updateAvailable: !!local && !!revision && revision !== local.built!.revision }
  }

  /**
   * Revérifie la révision des créations installées (toutes, ou `ids`) : au démarrage, à l'ouverture de la page, après
   * un enregistrement. Hors ligne, l'état connu est gardé. Sans compte ou sans le droit : rien n'est demandé.
   */
  async refreshStatus(ids?: string[]): Promise<void> {
    if (!canUseBuilder(this.deps.account.current())) return
    for (const id of ids ?? [...(await this.builtIndex()).keys()]) {
      try {
        const revision = str(obj(await this.call<unknown>('GET', `/builder/builds/${id}/manifest`)).revision)
        if (revision) this.revisions.set(id, revision)
      } catch (err) {
        // Création supprimée, ou d'un autre compte.
        if (err instanceof ApiError && err.status === 404) this.revisions.set(id, null)
        else log.info(`Créer ton pack : création non vérifiée (${(err as Error).message})`)
      }
    }
  }

  /** Compte changé (connexion, déconnexion) : les révisions connues ne valent plus. */
  forgetStatus(): void {
    this.revisions.clear()
  }

  /**
   * Packs construits dont une autre révision est en ligne, et ceux dont la création a été supprimée. Sans le droit
   * « Peut créer un pack » : rien à signaler (les packs construits restent utilisables, sans mise à jour).
   */
  async status(): Promise<BuilderStatus> {
    const updates: string[] = []
    const gone: string[] = []
    if (!canUseBuilder(this.deps.account.current())) return { updates, gone }
    for (const [buildId, m] of await this.builtIndex()) {
      const revision = this.revisions.get(buildId)
      if (revision === null) gone.push(m.id)
      else if (revision && revision !== m.built!.revision) updates.push(m.id)
    }
    return { updates, gone }
  }

  // ---------------------------------------------------------------- images

  /** pm-media://builder/<composant>/<image>[?size=thumb] : image publique, mise en cache sur le disque (jamais modifiée). */
  async image(componentId: string, imageId: string, thumb: boolean): Promise<Response> {
    if (!UUID.test(componentId) || !UUID.test(imageId)) return new Response('Interdit', { status: 403 })
    try {
      return new Response(new Uint8Array(await this.imageData(componentId, imageId, thumb)), { headers: { 'Content-Type': 'image/jpeg' } })
    } catch {
      return new Response('', { status: 404 })
    }
  }

  private imageData(componentId: string, imageId: string, thumb: boolean): Promise<Buffer> {
    return this.cachedImage(`${imageId}${thumb ? '-thumb' : ''}.jpg`, `/builder/components/${componentId}/images/${imageId}${thumb ? '?size=thumb' : ''}`)
  }

  /**
   * pm-media://builder-style/<style>/<version>[?size=thumb] : image publique d'un style, en cache sur le disque (une
   * nouvelle image change la version, donc l'adresse).
   */
  async styleImage(styleId: string, version: string, thumb: boolean): Promise<Response> {
    if (!UUID.test(styleId) || !IMAGE_VERSION.test(version)) return new Response('Interdit', { status: 403 })
    try {
      return new Response(new Uint8Array(await this.styleImageData(styleId, version, thumb)), { headers: { 'Content-Type': 'image/jpeg' } })
    } catch {
      return new Response('', { status: 404 })
    }
  }

  private styleImageData(styleId: string, version: string, thumb: boolean): Promise<Buffer> {
    return this.cachedImage(`style-${styleId}-${version}${thumb ? '-thumb' : ''}.jpg`, `/builder/styles/${styleId}/image?v=${version}${thumb ? '&size=thumb' : ''}`)
  }

  /**
   * pm-media://builder-reference/<image>/<version>[?size=thumb] : image de référence en jeu (publique), en cache sur le
   * disque comme celles des styles (une nouvelle image change la version, donc l'adresse).
   */
  async referenceImage(referenceId: string, version: string, thumb: boolean): Promise<Response> {
    if (!UUID.test(referenceId) || !IMAGE_VERSION.test(version)) return new Response('Interdit', { status: 403 })
    try {
      return new Response(new Uint8Array(await this.referenceImageData(referenceId, version, thumb)), { headers: { 'Content-Type': 'image/jpeg' } })
    } catch {
      return new Response('', { status: 404 })
    }
  }

  private referenceImageData(referenceId: string, version: string, thumb: boolean): Promise<Buffer> {
    return this.cachedImage(
      `reference-${referenceId}-${version}${thumb ? '-thumb' : ''}.jpg`,
      `/builder/references/${referenceId}/image?v=${version}${thumb ? '&size=thumb' : ''}`
    )
  }

  /** Image du cache (`name`), sinon demandée à l'API (`pathname`) puis gardée. */
  private async cachedImage(name: string, pathname: string): Promise<Buffer> {
    const file = path.join(this.imageDir, name)
    const cached = await fs.readFile(file).catch(() => null)
    if (cached) return cached
    const response = await this.deps.fetch(`${this.deps.apiUrl}${pathname}`, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = Buffer.from(await response.arrayBuffer())
    // Toujours du JPEG (ré-encodé par le serveur).
    if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error('Image invalide')
    await fs.mkdir(this.imageDir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, data)
    await fs.rename(tmp, file).catch(() => fs.rm(tmp, { force: true }))
    return data
  }

  /** Garde le cache des images sous 200 Mo en supprimant les plus anciennes. */
  async pruneImages(): Promise<void> {
    const files = await walkFiles(this.imageDir).catch(() => [])
    let total = files.reduce((s, f) => s + f.size, 0)
    if (total <= IMAGE_CACHE_MAX) return
    for (const f of [...files].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= IMAGE_CACHE_MAX * 0.7) break
      await fs.rm(path.join(this.imageDir, ...f.rel.split('/')), { force: true }).catch(() => undefined)
      total -= f.size
    }
  }

  /**
   * Image de la création. ReShade « Réglé par moi » : celle de son style, sinon l'image de référence en jeu par défaut,
   * sinon l'image de référence de ReShade (catalogue sans image en jeu). Sinon : celle de son preset importé, sinon du
   * premier composant qui en a une.
   */
  async coverOf(build: Pick<BuilderBuild, 'components' | 'tools'>): Promise<BuilderImageRef | null> {
    const catalog = await this.cachedCatalog()
    const reshade = build.tools.reshade
    const tool = catalog?.tools.find((x) => x.key === 'reshade')
    if (reshade.mode === 'custom' && tool) {
      const image = lookImages(tool, styleOf(tool, reshade), catalog?.references ?? [], null)[0]
      if (image) return image
    }
    const available = build.components.filter((c): c is BuilderBuildComponent & { id: string } => c.available && !!c.id)
    const ordered = [...available.filter((c) => c.category === 'reshade'), ...available.filter((c) => c.category !== 'reshade')]
    const cards = new Map(catalog?.categories.flatMap((c) => c.components).map((c) => [c.id, c]) ?? [])
    for (const c of ordered) {
      const cover = cards.get(c.id)?.cover
      if (cover) return { kind: 'component', componentId: c.id, imageId: cover.id }
    }
    // Catalogue pas encore lu sur ce PC : la fiche du premier composant.
    const first = ordered[0]
    if (!first || cards.size) return null
    const image = (await this.component(first.id).catch(() => null))?.images[0]
    return image ? { kind: 'component', componentId: first.id, imageId: image.id } : null
  }

  // ---------------------------------------------------------------- fichiers des composants

  /** Place prise par les fichiers des composants gardés sur ce PC. */
  async cacheInfo(): Promise<{ size: number }> {
    const files = await walkFiles(this.blobDir).catch(() => [])
    return { size: files.reduce((s, f) => s + f.size, 0) }
  }

  /** Vide le cache des fichiers (sauf ceux du téléchargement en cours) ; retéléchargés si besoin. */
  async clearCache(): Promise<void> {
    await this.dropBlobs(new Set(this.inUse))
  }

  /** Ménage : fichiers dont aucun pack construit de la bibliothèque ni le téléchargement en cours ne se sert plus. */
  async pruneBlobs(): Promise<void> {
    const keep = new Set(this.inUse)
    for (const m of await this.deps.library().list()) for (const sha of m.builtBlobs ?? []) keep.add(sha)
    await this.dropBlobs(keep)
  }

  private async dropBlobs(keep: Set<string>): Promise<void> {
    let count = 0
    let freed = 0
    for (const f of await walkFiles(this.blobDir).catch(() => [])) {
      const sha = path.posix.basename(f.rel).replace(/\.part$/, '')
      // Relu à chaque fichier : un téléchargement a pu commencer pendant le ménage.
      if (keep.has(sha) || this.inUse.has(sha)) continue
      await fs.rm(path.join(this.blobDir, ...f.rel.split('/')), { force: true }).catch(() => undefined)
      count++
      freed += f.size
    }
    if (count) log.info(`Créer ton pack : ${count} fichiers retirés du cache (${formatBytes(freed)})`)
  }

  /**
   * Requête d'un fichier avec le jeton d'accès du compte, demandé à chaque fois (l'API ne le vérifie qu'au début de la
   * requête : il est renouvelé avant de lancer ou de reprendre un téléchargement). Refusé (401 « token-invalid ») :
   * renouvelé une fois, puis la requête est rejouée.
   */
  private async fetchFile(url: string, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<Response> {
    const signedOut = (): ApiError => new ApiError(t('builder.errors.signedOut'), 401, SIGNED_OUT)
    const send = async (token: string): Promise<Response> => {
      try {
        return await this.deps.fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } })
      } catch (err) {
        if (err instanceof MaintenanceError || init.signal.aborted) throw err
        throw new Error(t('errors.network'))
      }
    }
    const token = await this.deps.account.accessToken()
    if (!token) throw signedOut()
    const response = await send(token)
    if (response.status === 403) {
      const problem = await problemOf(response)
      if (problem.code === BUILDER_NOT_ALLOWED) throw Object.assign(this.rightLost(), { fatal: true })
      throw Object.assign(new Error(problem.detail ?? t('builder.errors.downloadFailed', { status: 403 })), { fatal: true })
    }
    if (response.status !== 401 || (await problemOf(response)).code !== 'token-invalid') return response
    const next = await this.deps.account.renewRejected(token)
    if (!next) throw signedOut()
    return send(next)
  }

  /** Télécharge `f` dans <sha256>.part, à partir de ce qui y est déjà (Range). */
  private async fetchInto(f: ManifestFile, part: string, onBytes: (received: number) => void, signal: AbortSignal): Promise<void> {
    let start = (await fs.stat(part).catch(() => null))?.size ?? 0
    if (start > f.size) {
      await fs.rm(part, { force: true })
      start = 0
    }
    if (start === f.size) return onBytes(start)
    const headers: Record<string, string> = start > 0 ? { Range: `bytes=${start}-`, 'If-Range': `"${f.sha256}"` } : {}
    const response = await this.fetchFile(`${this.deps.apiUrl}${f.url}`, { headers, signal })
    if (response.status === 200) start = 0
    else if (response.status === 206) {
      const range = response.headers.get('Content-Range')
      if (range && !range.startsWith(`bytes ${start}-`)) {
        await fs.rm(part, { force: true })
        throw new Error(t('builder.errors.incomplete'))
      }
    } else {
      const error = new Error((await problemOf(response)).detail ?? t('builder.errors.downloadFailed', { status: response.status }))
      if (response.status < 500) Object.assign(error, { fatal: true })
      throw error
    }
    if (!response.body) throw new Error(t('builder.errors.incomplete'))
    let received = start
    onBytes(received)
    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        onBytes(received)
        callback(null, chunk)
      }
    })
    await pipeline(
      Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream),
      progress,
      createWriteStream(part, { flags: start > 0 ? 'a' : 'w' }),
      { signal }
    )
    if (received !== f.size) throw new Error(t('builder.errors.incomplete'))
  }

  /**
   * Un fichier, avec reprise (5 essais, sauf maintenance ou refus du serveur) ; gardé seulement si son SHA-256 est le
   * bon. Une reprise qui aboutit à un fichier abîmé est refaite une fois depuis le début.
   */
  private async fetchBlob(f: ManifestFile, onBytes: (received: number) => void, signal: AbortSignal): Promise<void> {
    const final = this.blobFile(f.sha256)
    const part = `${final}.part`
    await fs.mkdir(path.dirname(final), { recursive: true })
    let restarted = false
    for (let attempt = 1; ; attempt++) {
      const resumed = (await fs.stat(part).catch(() => null))?.size ?? 0
      try {
        await this.fetchInto(f, part, onBytes, signal)
      } catch (err) {
        if (signal.aborted || attempt >= 5 || err instanceof MaintenanceError || (err as Error & { fatal?: boolean }).fatal) throw err
        log.warn(`Créer ton pack : téléchargement interrompu (${(err as Error).message}), reprise dans ${attempt * 2} s`)
        await sleep(attempt * (this.deps.retryDelayMs ?? 2000), signal)
        continue
      }
      if ((await sha256File(part, signal)) === f.sha256) break
      await fs.rm(part, { force: true })
      if (resumed > 0 && !restarted) {
        restarted = true
        log.warn('Créer ton pack : fichier repris abîmé, nouveau téléchargement depuis le début')
        continue
      }
      throw new Error(t('builder.errors.corrupted'))
    }
    await fs.rename(part, final)
  }

  /** Fichiers manquants du manifeste (chaque contenu une seule fois), avec la progression globale en octets. */
  private async fetchBlobs(manifest: BuildManifest, report: Report, signal: AbortSignal): Promise<void> {
    const unique = new Map<string, ManifestFile>()
    for (const f of manifest.files) if (!unique.has(f.sha256)) unique.set(f.sha256, f)
    const missing: ManifestFile[] = []
    let partial = 0
    for (const f of unique.values()) {
      if ((await fs.stat(this.blobFile(f.sha256)).catch(() => null))?.size === f.size) continue
      missing.push(f)
      partial += (await fs.stat(`${this.blobFile(f.sha256)}.part`).catch(() => null))?.size ?? 0
    }
    const total = missing.reduce((s, f) => s + f.size, 0)
    // Place : les fichiers à télécharger, puis le pack dans la bibliothèque (zips extraits : environ deux fois leur taille).
    const lib = this.deps.library()
    const content = manifest.totalSize + manifest.files.filter((f) => f.kind === 'bundle').reduce((s, f) => s + f.size, 0)
    const download = Math.max(0, total - partial)
    const checks = sameVolume(lib.dir, this.deps.dir) ? [{ dir: lib.dir, needed: download + content }] : [{ dir: this.deps.dir, needed: download }, { dir: lib.dir, needed: content }]
    for (const { dir, needed } of checks) {
      const free = await freeSpace(dir)
      if (free !== null && free < needed) throw new Error(t('market.errors.noSpace', { size: displayBytes(needed) }))
    }
    if (!missing.length) return
    log.info(`Créer ton pack : ${missing.length} fichiers à télécharger (${formatBytes(total)})`)
    const phase = t('builder.phase.downloading')
    let done = 0
    report(phase, 0, total, undefined, true)
    for (const f of missing) {
      await this.fetchBlob(f, (received) => report(phase, done + received, total, undefined, true), signal)
      done += f.size
    }
  }

  // ---------------------------------------------------------------- installation

  /** Pack construit le plus récent de cette création (null : jamais installée). */
  private async linkedPack(buildId: string): Promise<StoredManifest | null> {
    return (await this.builtIndex()).get(buildId) ?? null
  }

  /**
   * Installe une création dans la bibliothèque (ou la met à jour) : manifeste contrôlé, fichiers manquants téléchargés,
   * puis, une fois la place libre (`hooks.lock`), pack construit. Nouvelle révision d'une création déjà installée :
   * même nom, mêmes réglages personnels, réinstallée dans le jeu si l'ancienne y était.
   */
  async install(buildId: string, report: Report, signal: AbortSignal, hooks: InstallHooks): Promise<BuildInstallResult> {
    if (!UUID.test(buildId)) throw new Error(t('builder.errors.notFound'))
    report(t('builder.phase.manifest'), 0, 0)
    const manifest = checkManifest(await this.call<unknown>('GET', `/builder/builds/${buildId}/manifest`))
    this.revisions.set(buildId, manifest.revision)
    const unavailable = manifest.unavailable.map((c) => c.name).filter(Boolean)
    const upToDate = (m: StoredManifest): BuildInstallResult => ({ packId: m.id, name: m.name, kind: 'build', status: 'up-to-date', unavailable })
    let linked = await this.linkedPack(buildId)
    if (linked?.built?.revision === manifest.revision) return upToDate(linked)
    if (!manifest.files.length && !manifest.generated.length) throw new Error(t('builder.errors.empty'))
    const build = await this.build(buildId).catch(() => null)

    this.inUse = new Set(manifest.files.map((f) => f.sha256))
    try {
      await this.fetchBlobs(manifest, report, signal)
      // La bibliothèque n'est modifiée qu'une fois les autres tâches finies ; elle a pu changer pendant le téléchargement.
      await hooks.lock?.()
      linked = await this.linkedPack(buildId)
      if (linked?.built?.revision === manifest.revision) return upToDate(linked)
      const lib = this.deps.library()
      const name = linked?.name ?? (await lib.uniqueName(build?.name || manifest.name || t('builder.untitled')))
      const components = (build?.components ?? []).filter((c) => c.available && c.id).map((c) => ({ id: c.id!, name: c.name }))
      const cover = build ? await this.coverOf(build).catch(() => null) : null
      const next = await this.buildPack(lib, manifest, { buildId, name, components, cover }, report, signal)
      log.info(`Créer ton pack : ${next.name} construit (${next.fileCount} fichiers, révision ${manifest.revision.slice(0, 12)})`)
      if (!linked) return { packId: next.id, name: next.name, kind: 'build', status: 'added', unavailable }
      return await this.replace(lib, linked, next, manifest, report, hooks, unavailable)
    } finally {
      this.inUse = new Set()
    }
  }

  /**
   * Pack de la bibliothèque construit à partir des fichiers en cache, dans l'ordre : zips extraits, fichiers (un fichier
   * remplace celui d'un zip au même endroit), fichiers écrits par l'API. En cas d'échec, rien ne reste.
   */
  private async buildPack(
    lib: Library,
    manifest: BuildManifest,
    meta: { buildId: string; name: string; components: { id: string; name: string }[]; cover: BuilderImageRef | null },
    report: Report,
    signal: AbortSignal
  ): Promise<StoredManifest> {
    const id = lib.newCapturedId(meta.name)
    // Un fichier par destination (casse ignorée, comme sous Windows) : le dernier écrit l'emporte, sous le premier nom.
    const written = new Map<string, BuiltItem>()
    const keep = (root: RootId, rel: string, size: number): void => {
      const key = `${root}:${rel.toLowerCase()}`
      written.set(key, { root, rel: written.get(key)?.rel ?? rel, size })
    }
    const bundles = manifest.files.filter((f) => f.kind === 'bundle')
    const files = manifest.files.filter((f) => f.kind === 'file')
    const total = bundles.length + files.length + manifest.generated.length
    const phase = t('builder.phase.building')
    let done = 0
    try {
      for (const f of bundles) {
        report(phase, done++, total)
        const entries = await extractBundle(this.blobFile(f.sha256), lib.builtFile(id, f.root, f.path), f.root, f.path, f.entryCount, signal)
        for (const e of entries) keep(f.root, `${f.path}/${e.rel}`, e.size)
      }
      for (const f of files) {
        report(phase, done++, total)
        if (signal.aborted) throw new Error(t('market.errors.cancelled'))
        const target = lib.builtFile(id, f.root, f.path)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.copyFile(this.blobFile(f.sha256), target)
        keep(f.root, f.path, f.size)
      }
      for (const g of manifest.generated) {
        report(phase, done++, total)
        const data = Buffer.from(g.content, 'utf8')
        const target = lib.builtFile(id, g.root, g.path)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, data)
        keep(g.root, g.path, data.length)
      }
      report(phase, total, total)
      const preset = manifest.preset ? (written.get(`fivem:${manifest.preset.toLowerCase()}`) ?? null) : null
      const cover = meta.cover ? await this.saveCover(lib.packDir(id), meta.cover) : null
      return await lib.finalizeBuilt(id, meta.name, [...written.values()], {
        built: { buildId: meta.buildId, revision: manifest.revision, builtAt: new Date().toISOString(), components: meta.components },
        blobs: [...new Set(manifest.files.map((f) => f.sha256))],
        preset: preset ? { root: preset.root, rel: preset.rel } : null,
        cover
      })
    } catch (err) {
      await fs.rm(lib.packDir(id), { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
  }

  /**
   * Image du composant, du style ou image en jeu enregistrée dans le dossier du pack (builder-<image>.jpg) ; null si
   * elle n'a pas pu l'être.
   */
  private async saveCover(packDir: string, ref: BuilderImageRef): Promise<string | null> {
    const name = ref.kind === 'style' ? `style-${ref.styleId}-${ref.version}` : ref.kind === 'reference' ? `reference-${ref.referenceId}-${ref.version}` : ref.imageId
    try {
      const data =
        ref.kind === 'style'
          ? await this.styleImageData(ref.styleId, ref.version, false)
          : ref.kind === 'reference'
            ? await this.referenceImageData(ref.referenceId, ref.version, false)
            : await this.imageData(ref.componentId, ref.imageId, false)
      const rel = `builder-${name}.jpg`
      await fs.mkdir(packDir, { recursive: true })
      await fs.writeFile(path.join(packDir, rel), data)
      return rel
    } catch (err) {
      log.warn(`Image ${name} non récupérée : ${(err as Error).message}`)
      return null
    }
  }

  /**
   * Nouvelle version d'une création installée : réglages personnels repris (sauf la copie modifiée en jeu d'un fichier
   * que l'API a réécrit autrement, comme le preset réglé), réinstallée dans le jeu si l'ancienne y était, puis
   * l'ancienne retirée de la bibliothèque. Échec de la réinstallation : l'ancienne reste en place.
   */
  private async replace(
    lib: Library,
    linked: StoredManifest,
    next: StoredManifest,
    manifest: BuildManifest,
    report: Report,
    hooks: InstallHooks,
    unavailable: string[]
  ): Promise<BuildInstallResult> {
    const stale = await this.changedGenerated(lib, linked, manifest)
    const carry = async (): Promise<void> => {
      await lib.copyUserConfigs(linked.id, next.id)
      await lib.forgetUserFiles(next.id, stale)
    }
    await carry()
    if (hooks.activeId() === linked.id) {
      try {
        await hooks.apply(next.id, report)
        // Réglages modifiés pendant la dernière partie, récupérés au remplacement : repris pour la suite.
        await carry()
      } catch (err) {
        log.warn(`Nouvelle version de ${linked.name} non installée : ${(err as Error).message}`)
        const note = t('builder.notes.updateNotInstalled', { name: linked.name, error: (err as Error).message })
        return { packId: next.id, name: next.name, kind: 'build', status: 'updated', unavailable, note }
      }
    }
    await lib.remove(linked.id)
    return { packId: next.id, name: next.name, kind: 'build', status: 'updated', unavailable }
  }

  /** Fichiers écrits par l'API dont le contenu a changé depuis la version installée. */
  private async changedGenerated(lib: Library, linked: StoredManifest, manifest: BuildManifest): Promise<Destination[]> {
    const out: Destination[] = []
    for (const g of manifest.generated) {
      const before = await fs.readFile(lib.builtFile(linked.id, g.root, g.path), 'utf8').catch(() => null)
      if (before !== g.content) out.push({ root: g.root, path: g.path })
    }
    return out
  }
}

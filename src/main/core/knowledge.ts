// Base de connaissances sur les fichiers des packs graphiques FiveM / GTA V.
//
// Rappel du fonctionnement (voir README) :
//  - FiveM.app/mods     : archives .rpf chargées par FiveM par-dessus les fichiers du jeu (textures, modèles, météo...).
//  - FiveM.app/plugins  : ReShade (dxgi.dll / d3d11.dll), ENBSeries (d3d11.dll), .asi graphiques (NVE.asi, QuantV.asi),
//                         leurs .ini, reshade-shaders/, nve-shaders/, addons ReShade (*.addon / *.addon64).
//  - Racine GTA V       : configuration ENB (enbseries.ini, enblocal.ini, enbseries/, d3dcompiler_46e.dll) car ENB lit
//                         sa configuration dans le dossier du jeu, même sous FiveM.
//  - FiveM.app/citizen  : fichiers internes de FiveM (rarement modifiés par un pack, ex. visualsettings.dat).

import { t, type ParseKeys } from 'i18next'
import { msg, type Msg } from '@shared/i18n'
import type { Destination, ForeignCategory } from '@shared/types'

/** Texte enregistré dans le manifeste d'un pack : gardé sous forme de clé, traduit à l'affichage (voir tm()). */
export function textMsg(key: ParseKeys, params?: Msg['params']): Msg {
  return msg(key, params)
}

/** Normalise un nom de dossier pour la reconnaissance : minuscules, sans accents, séparateurs unifiés. */
export function normName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s_\-.'’]+/g, ' ')
    .replace(/[()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function ext(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i).toLowerCase() : ''
}

export function base(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i >= 0 ? rel.slice(i + 1) : rel
}

export function parent(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i >= 0 ? rel.slice(0, i) : ''
}

// ---------------------------------------------------------------------------
// Dossiers « ancres » : leur nom indique clairement leur destination.

export type AnchorType = 'mods' | 'plugins' | 'citizen' | 'addons' | 'fivem-root' | 'gta-root'

export function anchorOf(dirName: string): AnchorType | null {
  const n = normName(dirName)
  if (/^(mods?|dossier mods?|fivem mods?|mods fivem)$/.test(n)) return 'mods'
  if (/^(plugins?|dossier plugins?|fivem plugins?|plugins fivem)$/.test(n)) return 'plugins'
  if (n === 'citizen') return 'citizen'
  if (n === 'addons') return 'addons'
  if (
    /^(fivem|fivem app|fivem application data|fivem application|fivem app data|application data|citizenfx|fivem folder|dossier fivem|fivem directory)$/.test(
      n
    ) ||
    n.startsWith('fivem application data')
  )
    return 'fivem-root'
  if (
    /^(gta|gta ?v|gta ?5|gtav|gta5|grand theft auto v|grand theft auto v legacy|gta v legacy|gta ?v folder|gta ?5 folder|gta folder|gta directory|gta ?v directory|dossier gta( ?v| ?5)?|dossier du jeu|dossier jeu|racine|racine gta( ?v| ?5)?|root|game folder|game directory|main directory|main folder|gta root|gta ?v root|enb|enb files|enb folder|fichiers enb|dossier enb|enb gta( ?v)?|gta ?v enb)$/.test(
      n
    )
  )
    return 'gta-root'
  return null
}

export function anchorDestination(a: AnchorType): Destination {
  switch (a) {
    case 'mods':
      return { root: 'fivem', path: 'mods' }
    case 'plugins':
      return { root: 'fivem', path: 'plugins' }
    case 'citizen':
      return { root: 'fivem', path: 'citizen' }
    case 'addons':
      return { root: 'fivem', path: 'addons' }
    case 'fivem-root':
      return { root: 'fivem', path: '' }
    case 'gta-root':
      return { root: 'gta', path: '' }
  }
}

/** Dossiers optionnels / variantes : proposés mais désactivés par défaut. */
export function isOptionalDirName(dirName: string): boolean {
  const n = normName(dirName)
  return /^(optional|optionnel|optionnels|optionals|options?|extras?|bonus|addons? optionnels?|facultatif|variantes?|alternatives?|old|ancien|backup|sauvegarde)( .*)?$/.test(
    n
  )
}

/** Dossiers de documentation : jamais installés. */
export function isDocsDirName(dirName: string): boolean {
  const n = normName(dirName)
  return /^(readme|read me|docs?|documentation|tuto|tutoriel|tutorial|screens?|screenshots?|previews?|apercus?|images?|captures?|instructions?|install(ation)? guide|guide)$/.test(
    n
  )
}

// ---------------------------------------------------------------------------
// Dossiers spéciaux reconnus par leur nom exact.

export function specialDirDestination(dirName: string): { dest: Destination; label: Msg } | null {
  const n = dirName.toLowerCase()
  if (n === 'enbseries') return { dest: { root: 'gta', path: 'enbseries' }, label: textMsg('knowledge.labels.enbseries') }
  if (n === 'reshade-shaders' || n === 'reshade shaders')
    return { dest: { root: 'fivem', path: 'plugins/reshade-shaders' }, label: textMsg('knowledge.labels.reshadeShaders') }
  if (n === 'nve-shaders') return { dest: { root: 'fivem', path: 'plugins/nve-shaders' }, label: textMsg('knowledge.labels.nveShaders') }
  return null
}

// ---------------------------------------------------------------------------
// Fichiers isolés.

const DOC_EXT = new Set(['.txt', '.pdf', '.md', '.url', '.html', '.htm', '.rtf', '.doc', '.docx', '.nfo', '.lnk', '.website'])
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.avi', '.mov'])
export const ARCHIVE_EXT = new Set(['.zip', '.rar', '.7z'])
/** Fichiers de configuration texte : toujours copiés (jamais liés) car le jeu peut les réécrire. */
export const CONFIG_EXT = new Set(['.ini', '.cfg', '.txt', '.json', '.xml', '.log', '.toml', '.yaml', '.yml', '.meta'])

export const PROXY_DLLS = new Set(['d3d11.dll', 'dxgi.dll', 'd3d12.dll', 'd3d10.dll', 'd3d9.dll', 'opengl32.dll'])
export const SP_ONLY_FILES = new Set([
  'dinput8.dll',
  'scripthookv.dll',
  'scripthookvdotnet.asi',
  'scripthookvdotnet2.dll',
  'scripthookvdotnet3.dll',
  'openiv.asi',
  'asiloader.dll',
  'version.dll'
])

/** {@link reason} : texte à traduire à l'affichage. */
export type LooseClass =
  | { kind: 'install'; dest: Destination; label: string; reason: Msg }
  | { kind: 'docs'; label: string; reason: Msg }
  | { kind: 'unsupported'; label: string; reason: Msg }
  | { kind: 'unknown'; label: string; reason: Msg }

export function isEnbFile(name: string): boolean {
  const n = name.toLowerCase()
  if (n === 'd3dcompiler_46e.dll') return true
  // enbfeeder.asi / enbfeeder.ini sont un plugin .asi : sous FiveM ils vont dans plugins.
  if (n.startsWith('enbfeeder')) return false
  return /^enb[a-z0-9_]*\.(ini|fx|fxh|bmp|png|dds|tga|bin|txt)$/.test(n)
}

export function isReshadeConfig(name: string): boolean {
  const n = name.toLowerCase()
  return n === 'reshade.ini' || n === 'reshadepreset.ini' || n.endsWith('.addon') || n.endsWith('.addon64')
}

/**
 * Classe un fichier qui n'est dans aucun dossier reconnu.
 * `siblings` : noms (minuscules) des fichiers du même dossier, pour relier un .ini à son .asi.
 * `looksLikePreset` : vrai si le contenu du .ini ressemble à un preset ReShade (Techniques=...).
 */
export function classifyLooseFile(rel: string, siblings: Set<string>, looksLikePreset: boolean): LooseClass {
  const name = base(rel)
  const lower = name.toLowerCase()
  const e = ext(name)

  if (e === '.rpf') return { kind: 'install', dest: { root: 'fivem', path: `mods/${name}` }, label: name, reason: textMsg('knowledge.reasons.rpf') }
  if (e === '.oiv')
    return { kind: 'unsupported', label: name, reason: textMsg('knowledge.reasons.oiv') }
  if (SP_ONLY_FILES.has(lower))
    return { kind: 'unsupported', label: name, reason: textMsg('knowledge.reasons.spLoader') }
  if (isEnbFile(name))
    return { kind: 'install', dest: { root: 'gta', path: name }, label: name, reason: textMsg('knowledge.reasons.enbFile') }
  if (PROXY_DLLS.has(lower))
    return { kind: 'install', dest: { root: 'fivem', path: `plugins/${name}` }, label: name, reason: textMsg('knowledge.reasons.proxyDll') }
  if (e === '.asi') return { kind: 'install', dest: { root: 'fivem', path: `plugins/${name}` }, label: name, reason: textMsg('knowledge.reasons.asi') }
  if (isReshadeConfig(name))
    return { kind: 'install', dest: { root: 'fivem', path: `plugins/${name}` }, label: name, reason: textMsg('knowledge.reasons.reshadeConfig') }
  if (e === '.ini') {
    const stem = lower.slice(0, -4)
    if (siblings.has(`${stem}.asi`))
      return { kind: 'install', dest: { root: 'fivem', path: `plugins/${name}` }, label: name, reason: textMsg('knowledge.reasons.asiConfig', { stem }) }
    if (looksLikePreset)
      return { kind: 'install', dest: { root: 'fivem', path: `plugins/${name}` }, label: name, reason: textMsg('knowledge.reasons.preset') }
    return { kind: 'unknown', label: name, reason: textMsg('knowledge.reasons.unknownIni') }
  }
  if (lower === 'visualsettings.dat')
    return {
      kind: 'install',
      dest: { root: 'fivem', path: 'citizen/common/data/visualsettings.dat' },
      label: name,
      reason: textMsg('knowledge.reasons.visualSettings')
    }
  if (DOC_EXT.has(e)) return { kind: 'docs', label: name, reason: textMsg('knowledge.reasons.docs') }
  if (IMAGE_EXT.has(e) || VIDEO_EXT.has(e)) return { kind: 'docs', label: name, reason: textMsg('knowledge.reasons.preview') }
  return { kind: 'unknown', label: name, reason: textMsg('knowledge.reasons.unknownType') }
}

export function isImage(name: string): boolean {
  return IMAGE_EXT.has(ext(name))
}

export function isJunk(name: string): boolean {
  const n = name.toLowerCase()
  return n === '.ds_store' || n === 'thumbs.db' || n === 'desktop.ini' || n === '__macosx' || n.startsWith('._')
}

// ---------------------------------------------------------------------------
// Détection des technologies présentes dans un pack (badges).

export function detectFeatures(rels: string[]): string[] {
  const f = new Set<string>()
  for (const rel of rels) {
    const lower = rel.toLowerCase()
    const name = base(lower)
    if (name === 'enbseries.ini' || name === 'enblocal.ini' || lower.includes('enbseries/')) f.add('ENB')
    if (name === 'reshade.ini' || lower.includes('reshade-shaders/') || name.endsWith('.addon') || name.endsWith('.addon64')) f.add('ReShade')
    if (lower.includes('quantv') || /(^|\/)qv\d?_/.test(lower)) f.add('QuantV')
    if (name === 'nve.asi' || lower.includes('nve-shaders/') || /(^|[^a-z])nve([^a-z]|$)/.test(name)) f.add('NVE')
    if (lower.includes('visualv')) f.add('VisualV')
    if (lower.includes('redux')) f.add('Redux')
    if (name.endsWith('.rpf')) f.add('RPF')
    if (name.endsWith('.asi')) f.add('ASI')
    if (lower.startsWith('citizen/') || lower.includes('/citizen/')) f.add('Citizen')
  }
  const order = ['NVE', 'QuantV', 'VisualV', 'Redux', 'ENB', 'ReShade', 'ASI', 'RPF', 'Citizen']
  return order.filter((x) => f.has(x))
}

// ---------------------------------------------------------------------------
// Fichiers protégés : un pack ne doit JAMAIS écraser ces fichiers du jeu.

const GTA_PROTECTED = [
  /^[^/]+\.rpf$/i, // x64a.rpf ... common.rpf
  /^update\//i,
  /^x64\//i,
  /^redistributables\//i,
  /^battleye\//i,
  /^[^/]+\.exe$/i,
  /^bink2w64\.dll$/i,
  /^d3dcompiler_46\.dll$/i,
  /^d3dcsx_46\.dll$/i,
  /^gfsdk_[^/]+\.dll$/i,
  /^gpuperfapidx11-x64\.dll$/i,
  /^nvpmapi\.core\.win64\.dll$/i,
  /^(libcurl|libtox|opus|opusenc|xcurl|zlib1|fvad|steam_api64|amd_ags_x64|ffx_[^/]+)\.dll$/i,
  /^(index\.bin|title\.rgl|version\.txt|versioninfo\.txt|installscript\.vdf|commandline\.txt)$/i
]

export function isProtectedGtaPath(rel: string): boolean {
  return GTA_PROTECTED.some((re) => re.test(rel))
}

/** Sous FiveM.app, un pack ne peut écrire que dans mods/, plugins/, addons/ et citizen/. */
export function isAllowedFiveMPath(rel: string): boolean {
  return /^(mods|plugins|addons|citizen)\//i.test(rel)
}

// ---------------------------------------------------------------------------
// Reconnaissance des mods installés à la main (nettoyage / capture).

export interface ForeignRule {
  category: ForeignCategory
  label: string
  recommended: boolean
}

const RESHADE_SCREENSHOT = /\.(png|jpe?g|bmp|jxr)$/i

export function classifyPluginsEntry(name: string, isDir: boolean): ForeignRule {
  const lower = name.toLowerCase()
  if (isDir) {
    if (lower === 'reshade-shaders') return { category: 'reshade', label: t('knowledge.labels.reshadeShaders'), recommended: true }
    if (lower === 'nve-shaders') return { category: 'plugin-data', label: t('knowledge.labels.nveShaders'), recommended: true }
    if (lower === 'enbseries') return { category: 'enb', label: t('knowledge.foreign.enbEffects'), recommended: true }
    return { category: 'plugin-data', label: t('knowledge.foreign.pluginDir'), recommended: true }
  }
  if (RESHADE_SCREENSHOT.test(lower)) return { category: 'screenshot', label: t('knowledge.foreign.screenshot'), recommended: false }
  if (lower.endsWith('.log')) return { category: 'log', label: t('knowledge.foreign.log'), recommended: false }
  if (lower === 'openiv.asi') return { category: 'asi', label: t('knowledge.foreign.openiv'), recommended: true }
  if (PROXY_DLLS.has(lower)) return { category: 'proxy-dll', label: t('knowledge.foreign.proxyDll'), recommended: true }
  if (lower.endsWith('.asi')) return { category: 'asi', label: t('knowledge.foreign.asi'), recommended: true }
  if (isReshadeConfig(lower)) return { category: 'reshade', label: t('knowledge.foreign.reshadeConfig'), recommended: true }
  if (isEnbFile(lower)) return { category: 'enb', label: t('knowledge.foreign.enbFile'), recommended: true }
  if (lower.endsWith('.ini')) return { category: 'plugin-config', label: t('knowledge.foreign.configPreset'), recommended: true }
  if (lower.endsWith('.dll')) return { category: 'plugin-data', label: t('knowledge.foreign.pluginLibrary'), recommended: true }
  if (/^license(\.md|\.txt)?$/i.test(lower) || lower.endsWith('.txt') || lower.endsWith('.md'))
    return { category: 'other', label: t('knowledge.foreign.licenseText'), recommended: true }
  return { category: 'other', label: t('knowledge.foreign.otherFile'), recommended: true }
}

/** Retourne une règle si l'entrée de la racine GTA V est un fichier de mod graphique connu, sinon null. */
export function classifyGtaRootEntry(name: string, isDir: boolean): ForeignRule | null {
  const lower = name.toLowerCase()
  if (isDir) {
    if (lower === 'enbseries') return { category: 'enb', label: t('knowledge.foreign.enbEffects'), recommended: true }
    if (lower === 'enbcache') return { category: 'enb', label: t('knowledge.foreign.enbCache'), recommended: true }
    if (lower === 'reshade-shaders') return { category: 'reshade', label: t('knowledge.labels.reshadeShaders'), recommended: true }
    if (lower === 'nve-shaders') return { category: 'plugin-data', label: t('knowledge.labels.nveShaders'), recommended: true }
    return null
  }
  if (isProtectedGtaPath(name)) return null
  if (isEnbFile(lower)) return { category: 'enb', label: t('knowledge.foreign.enbFile'), recommended: true }
  if (PROXY_DLLS.has(lower)) return { category: 'proxy-dll', label: t('knowledge.foreign.proxyDll'), recommended: true }
  if (lower === 'dinput8.dll' || lower === 'scripthookv.dll' || lower === 'openiv.asi' || lower.startsWith('scripthookvdotnet'))
    return { category: 'sp-loader', label: t('knowledge.foreign.spLoader'), recommended: false }
  if (lower.endsWith('.asi')) return { category: 'asi', label: t('knowledge.foreign.asi'), recommended: true }
  if (lower.endsWith('.log')) return { category: 'log', label: t('knowledge.foreign.log'), recommended: false }
  if (isReshadeConfig(lower)) return { category: 'reshade', label: 'ReShade', recommended: true }
  if (lower === 'nve.ini' || lower === 'quantv.ini' || lower === 'quantv.preset.ini' || lower === 'enbfeeder.ini')
    return { category: 'plugin-config', label: t('knowledge.foreign.pluginConfig'), recommended: true }
  return null
}

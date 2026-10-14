// Analyse d'un pack extrait : découpe le contenu en composants et propose une destination pour chacun.
// Module pur (aucun accès disque) pour être testable.

import { createHash } from 'node:crypto'
import { tm, type Msg } from '@shared/i18n'
import type { ComponentKind, Destination, PackComponent, PackFileEntry } from '@shared/types'
import {
  anchorDestination,
  anchorOf,
  base,
  classifyLooseFile,
  detectFeatures,
  ext,
  isDocsDirName,
  isEnbFile,
  isAllowedFiveMPath,
  isImage,
  isOptionalDirName,
  parent,
  PROXY_DLLS,
  SP_ONLY_FILES,
  specialDirDestination,
  textMsg
} from './knowledge'

export interface AnalyzedComponent extends PackComponent {
  /** Préfixe retiré du chemin source pour obtenir le chemin sous la destination ('' ou 'dossier/'). */
  stripPrefix: string
  files: string[]
}

export interface AnalysisResult {
  components: AnalyzedComponent[]
  features: string[]
  warnings: string[]
  /** {@link warnings} à traduire à l'affichage (même ordre) : voir {@link tmNested}. */
  warningMsgs: Msg[]
  /** Images d'aperçu trouvées dans le pack (chemins relatifs au contenu), la plus pertinente en premier. */
  gallery: string[]
}

export interface AnalyzeOptions {
  /** Vrai si le fichier .ini ressemble à un preset ReShade (lu par l'appelant). */
  isPreset?: (rel: string) => boolean
}

interface DirNode {
  path: string
  name: string
  files: PackFileEntry[]
  children: DirNode[]
}

function buildTree(files: PackFileEntry[]): DirNode {
  const root: DirNode = { path: '', name: '', files: [], children: [] }
  const map = new Map<string, DirNode>([['', root]])
  const ensure = (p: string): DirNode => {
    const found = map.get(p)
    if (found) return found
    const par = ensure(parent(p))
    const node: DirNode = { path: p, name: base(p), files: [], children: [] }
    par.children.push(node)
    map.set(p, node)
    return node
  }
  for (const f of files) ensure(parent(f.rel)).files.push(f)
  const sortRec = (n: DirNode): void => {
    n.children.sort((a, b) => a.name.localeCompare(b.name))
    n.files.sort((a, b) => a.rel.localeCompare(b.rel))
    n.children.forEach(sortRec)
  }
  sortRec(root)
  return root
}

function allFiles(n: DirNode): PackFileEntry[] {
  const out = [...n.files]
  for (const c of n.children) out.push(...allFiles(c))
  return out
}

function componentId(source: string, kind: string, extra = ''): string {
  return createHash('sha1').update(`${kind}|${source}|${extra}`).digest('hex').slice(0, 12)
}

export function joinDest(dest: Destination, sub: string): Destination {
  const p = [dest.path, sub].filter(Boolean).join('/')
  return { root: dest.root, path: p }
}

/** Destination finale d'un fichier d'un composant. */
export function fileDestination(c: Pick<PackComponent, 'destination'> & { stripPrefix: string }, rel: string): Destination | null {
  if (!c.destination) return null
  // Journaux d'exécution de l'auteur (ReShade.log...) : jamais installés.
  if (/\.log\d*$/i.test(rel)) return null
  const sub = rel.startsWith(c.stripPrefix) ? rel.slice(c.stripPrefix.length) : base(rel)
  return joinDest(c.destination, sub)
}

export function analyzePack(entries: PackFileEntry[], opts: AnalyzeOptions = {}): AnalysisResult {
  const isPreset = opts.isPreset ?? (() => false)
  const tree = buildTree(entries)
  const components: AnalyzedComponent[] = []
  const warnings: string[] = []
  const warningMsgs: Msg[] = []
  const warn = (m: Msg): void => {
    warningMsgs.push(m)
    warnings.push(tmNested(m))
  }
  const sizeOf = new Map(entries.map((e) => [e.rel, e.size]))

  /** Libellé : nom de dossier ou de fichier (non traduit) ou texte à traduire ; raison : texte à traduire. */
  const push = (
    c: Omit<AnalyzedComponent, 'id' | 'fileCount' | 'size' | 'suggested' | 'enabled' | 'label' | 'labelMsg' | 'reason' | 'reasonMsg'> & {
      enabled?: boolean
      label: string | Msg
      reason: Msg
    },
    idExtra = ''
  ): void => {
    if (!c.files.length) return
    const counted = c.destination ? c.files.filter((f) => !/\.log\d*$/i.test(f)) : c.files
    const size = counted.reduce((s, f) => s + (sizeOf.get(f) ?? 0), 0)
    const enabled = c.enabled ?? (c.destination !== null && !c.optional)
    const { label, reason, ...rest } = c
    components.push({
      ...rest,
      ...(typeof label === 'string' ? { label } : { label: tm(label), labelMsg: label }),
      reason: tm(reason),
      reasonMsg: reason,
      id: componentId(c.source, c.kind, idExtra),
      suggested: c.destination,
      enabled,
      fileCount: counted.length,
      size
    })
  }

  /** Sépare les fichiers qui ne doivent pas suivre leur dossier (DLL graphiques, .asi, fichiers du mode solo). */
  const splitGtaRootExceptions = (node: DirNode, optional: boolean): Set<string> => {
    const taken = new Set<string>()
    const asiStems = new Set(node.files.filter((f) => ext(f.rel) === '.asi').map((f) => base(f.rel).toLowerCase().slice(0, -4)))
    for (const f of node.files) {
      const name = base(f.rel)
      const lower = name.toLowerCase()
      const iniOfAsi = ext(lower) === '.ini' && asiStems.has(lower.slice(0, -4))
      if (PROXY_DLLS.has(lower) || ext(lower) === '.asi' || iniOfAsi) {
        push(
          {
            source: f.rel,
            isFile: true,
            label: name,
            kind: 'plugins',
            destination: { root: 'fivem', path: 'plugins' },
            optional,
            reason: iniOfAsi ? textMsg('analyzer.reasons.asiConfig', { stem: lower.slice(0, -4) }) : textMsg('analyzer.reasons.proxyNotInGta'),
            stripPrefix: `${node.path ? node.path + '/' : ''}`,
            files: [f.rel]
          },
          'split'
        )
        taken.add(f.rel)
      } else if (SP_ONLY_FILES.has(lower)) {
        push(
          {
            source: f.rel,
            isFile: true,
            label: name,
            kind: 'unsupported',
            destination: null,
            optional,
            reason: textMsg('analyzer.reasons.spLoader'),
            stripPrefix: `${node.path ? node.path + '/' : ''}`,
            files: [f.rel]
          },
          'split'
        )
        taken.add(f.rel)
      }
    }
    return taken
  }

  const hasDirectFile = (node: DirNode, pred: (lowerName: string) => boolean): boolean =>
    node.files.some((f) => pred(base(f.rel).toLowerCase()))

  const visit = (node: DirNode, optional: boolean): void => {
    // 1) Fichiers placés directement dans ce dossier (hors dossiers reconnus) : classés un par un puis regroupés.
    classifyLooseGroup(node, optional)
    // 2) Sous-dossiers
    for (const child of node.children) visitDir(child, optional, node)
  }

  const visitDir = (node: DirNode, parentOptional: boolean, parentNode: DirNode): void => {
    let optional = parentOptional || isOptionalDirName(node.name)
    let anchor = anchorOf(node.name)
    // « Addons » n'est le dossier addons de FiveM que s'il est à côté de mods / plugins ; sinon ce sont des extras optionnels.
    if (anchor === 'addons' && !parentNode.children.some((c) => c !== node && ['mods', 'plugins', 'citizen'].includes(anchorOf(c.name) ?? ''))) {
      anchor = null
      optional = true
    }
    const prefix = `${node.path}/`
    const files = allFiles(node)

    if (isDocsDirName(node.name)) {
      push({
        source: node.path,
        isFile: false,
        label: node.name,
        kind: 'docs',
        destination: null,
        optional,
        reason: textMsg('analyzer.reasons.docs'),
        stripPrefix: prefix,
        files: files.map((f) => f.rel)
      })
      return
    }

    if (anchor) {
      const dest = anchorDestination(anchor)
      let kind: ComponentKind = anchor
      let destination: Destination | null = dest
      let reason = anchorReason(anchor)
      let exclude = new Set<string>()

      if (anchor === 'mods') {
        const spLayout = node.children.some((c) => /^(update|x64|x64[a-w]\.rpf)$/i.test(c.name)) ||
          files.some((f) => /\/(update|x64)\//i.test(f.rel.slice(prefix.length - 1)))
        if (spLayout) {
          kind = 'unsupported'
          destination = null
          reason = textMsg('analyzer.reasons.spMods')
        } else if (!files.some((f) => ext(f.rel) === '.rpf')) {
          reason = textMsg('analyzer.reasons.modsDirNoRpf')
        }
      }
      if (anchor === 'gta-root') exclude = splitGtaRootExceptions(node, optional)
      if (anchor === 'fivem-root') {
        const hasKnown = node.children.some((c) => ['mods', 'plugins', 'citizen', 'addons'].includes(anchorOf(c.name) ?? ''))
        if (!hasKnown) {
          // Dossier « FiveM » sans sous-dossiers mods/plugins : on analyse son contenu normalement.
          visit(node, optional)
          return
        }
        // Les sous-dossiers mods/plugins/citizen sont reconnus comme ancres lors de leur visite.
        for (const child of node.children) visitDir(child, optional, node)
        classifyLooseGroup(node, optional)
        return
      }

      push({
        source: node.path,
        isFile: false,
        label: node.name,
        kind,
        destination,
        optional,
        reason,
        stripPrefix: prefix,
        files: files.map((f) => f.rel).filter((r) => !exclude.has(r))
      })
      return
    }

    const special = specialDirDestination(node.name)
    if (special) {
      push({
        source: node.path,
        isFile: false,
        label: special.label,
        kind: special.dest.root === 'gta' ? 'gta-root' : 'plugins',
        destination: special.dest,
        optional,
        reason: textMsg('analyzer.reasons.specialDir', { name: node.name }),
        stripPrefix: prefix,
        files: files.map((f) => f.rel)
      })
      return
    }

    // Dossier contenant directement une configuration ENB : c'est le contenu de la racine GTA V.
    if (hasDirectFile(node, (n) => n === 'enbseries.ini' || n === 'enblocal.ini')) {
      const exclude = splitGtaRootExceptions(node, optional)
      push({
        source: node.path,
        isFile: false,
        label: node.name,
        kind: 'gta-root',
        destination: { root: 'gta', path: '' },
        optional,
        reason: textMsg('analyzer.reasons.enbConfigDir'),
        stripPrefix: prefix,
        files: files.map((f) => f.rel).filter((r) => !exclude.has(r))
      })
      return
    }

    // Dossier « plugins » non nommé : ReShade / .asi sans .rpf ni configuration ENB.
    const looksPlugins =
      hasDirectFile(node, (n) => n === 'reshade.ini' || PROXY_DLLS.has(n) || n.endsWith('.asi') || n.endsWith('.addon') || n.endsWith('.addon64')) &&
      !files.some((f) => ext(f.rel) === '.rpf') &&
      !hasDirectFile(node, (n) => isEnbFile(n))
    if (looksPlugins) {
      push({
        source: node.path,
        isFile: false,
        label: node.name,
        kind: 'plugins',
        destination: { root: 'fivem', path: 'plugins' },
        optional,
        reason: textMsg('analyzer.reasons.pluginsContent'),
        stripPrefix: prefix,
        files: files.map((f) => f.rel)
      })
      return
    }

    visit(node, optional)
  }

  const classifyLooseGroup = (node: DirNode, optional: boolean): void => {
    if (!node.files.length) return
    const siblings = new Set(node.files.map((f) => base(f.rel).toLowerCase()))
    const groups = new Map<string, { kind: ComponentKind; dest: Destination | null; reason: Msg; files: string[]; labels: string[] }>()
    for (const f of node.files) {
      const cls = classifyLooseFile(f.rel, siblings, isPreset(f.rel))
      let key: string
      let kind: ComponentKind
      let dest: Destination | null = null
      if (cls.kind === 'install') {
        const destDir = parent(cls.dest.path)
        dest = { root: cls.dest.root, path: destDir }
        kind = cls.dest.root === 'gta' ? 'gta-root' : destDir.startsWith('mods') ? 'mods' : destDir.startsWith('citizen') ? 'citizen' : 'plugins'
        key = `install|${dest.root}|${dest.path}`
        // Le nom de fichier final peut différer du nom source (ex. visualsettings.dat) : composant dédié.
        if (base(cls.dest.path) !== base(f.rel)) key += `|${f.rel}`
      } else {
        kind = cls.kind === 'docs' ? 'docs' : cls.kind === 'unsupported' ? 'unsupported' : 'unknown'
        key = `${cls.kind}|${cls.kind === 'unknown' ? f.rel : ''}`
      }
      const g = groups.get(key) ?? { kind, dest, reason: cls.reason, files: [], labels: [] }
      g.files.push(f.rel)
      g.labels.push(cls.label)
      groups.set(key, g)
    }
    for (const [key, g] of groups) {
      const where = node.path ? `${node.path}/` : ''
      const single = g.files.length === 1
      const label = single ? g.labels[0] : looseGroupLabel(g.kind, g.files.length, node.path)
      push(
        {
          source: single ? g.files[0] : node.path,
          isFile: single,
          label,
          kind: g.kind,
          destination: g.dest,
          optional,
          reason: single ? g.reason : groupReason(g.kind, g.reason),
          stripPrefix: where,
          files: g.files,
          enabled: g.dest !== null && !optional
        },
        key
      )
    }
  }

  // Racine du pack
  visit(tree, false)

  // Doublons de destination entre composants actifs : on garde le premier, on désactive les suivants.
  const seen = new Map<string, string>()
  for (const c of components) {
    if (!c.enabled || !c.destination) continue
    const dup = c.files.filter((f) => {
      const d = fileDestination(c, f)
      return d && seen.has(`${d.root}:${d.path.toLowerCase()}`)
    })
    if (dup.length) {
      const other = components.find((o) => o.id === seen.get(destKey(fileDestination(c, dup[0])!)))
      if (dup.length === c.files.length) {
        c.enabled = false
        warn(textMsg('analyzer.warnings.variant', { ...nestLabel('label', c), ...nestLabel('other', other) }))
      } else {
        warn(textMsg('analyzer.warnings.partialDuplicate', { count: dup.length, ...nestLabel('label', c), ...nestLabel('other', other) }))
      }
      if (dup.length === c.files.length) continue
    }
    for (const f of c.files) {
      const d = fileDestination(c, f)
      if (d && !seen.has(destKey(d))) seen.set(destKey(d), c.id)
    }
  }

  // Avertissements utiles
  const unknown = components.filter((c) => c.kind === 'unknown')
  if (unknown.length) warn(textMsg('analyzer.warnings.unknown', { count: unknown.length }))
  const unsupported = components.filter((c) => c.kind === 'unsupported')
  for (const u of unsupported) warn(textMsg('analyzer.warnings.unsupported', { ...nestLabel('label', u), ...nest('reason', u.reasonMsg ?? u.reason) }))
  const installable = components.filter((c) => c.enabled && c.destination)
  if (!installable.length) warn(textMsg(NOTHING_INSTALLABLE))

  const rels = entries.map((e) => e.rel)
  const gallery = galleryOf(entries, components)

  // Ordre d'affichage : installables d'abord (FiveM puis GTA), puis le reste.
  const rank = (c: AnalyzedComponent): number => {
    if (c.destination && c.enabled) return c.destination.root === 'fivem' ? (c.kind === 'mods' ? 0 : 1) : 2
    if (c.destination) return 3
    if (c.kind === 'unknown') return 4
    if (c.kind === 'unsupported') return 5
    return 6
  }
  components.sort((a, b) => rank(a) - rank(b) || a.source.localeCompare(b.source))

  return { components, features: detectFeatures(rels), warnings, warningMsgs, gallery }
}

const NOTHING_INSTALLABLE = 'analyzer.warnings.nothingInstallable'

/**
 * Paramètre d'un texte à traduire qui est lui-même un texte à traduire (libellé d'un composant...) : gardé sous la
 * forme `<nom>$key` + `<nom>$<paramètre>`, traduit par {@link tmNested}. Un texte simple (nom de fichier, texte d'une
 * version précédente) est gardé tel quel.
 */
function nest(name: string, m: Msg | string): Record<string, string | number> {
  if (typeof m === 'string') return { [name]: m }
  const out: Record<string, string | number> = { [`${name}$key`]: m.key }
  for (const [k, v] of Object.entries(m.params ?? {})) out[`${name}$${k}`] = v
  return out
}

const nestLabel = (name: string, c: Pick<PackComponent, 'label' | 'labelMsg'> | undefined): Record<string, string | number> =>
  c ? nest(name, c.labelMsg ?? c.label) : { [name]: '?' }

/** Traduit un texte dont des paramètres sont eux-mêmes des textes à traduire (voir {@link nest}). */
export function tmNested(m: Msg | string): string {
  if (typeof m === 'string' || !m.params) return tm(m)
  const params: Record<string, string | number> = {}
  const nested = new Map<string, Msg>()
  for (const [k, v] of Object.entries(m.params)) {
    const i = k.indexOf('$')
    if (i < 0) {
      params[k] = v
      continue
    }
    const name = k.slice(0, i)
    const n = nested.get(name) ?? { key: '', params: {} }
    if (k.slice(i + 1) === 'key') n.key = String(v)
    else n.params![k.slice(i + 1)] = v
    nested.set(name, n)
  }
  for (const [name, n] of nested) params[name] = tm(n)
  return tm({ key: m.key, params })
}

function destKey(d: Destination): string {
  return `${d.root}:${d.path.toLowerCase()}`
}

function anchorReason(a: string): Msg {
  switch (a) {
    case 'mods':
      return textMsg('analyzer.reasons.modsDir')
    case 'plugins':
      return textMsg('analyzer.reasons.pluginsDir')
    case 'citizen':
      return textMsg('analyzer.reasons.citizenDir')
    case 'addons':
      return textMsg('analyzer.reasons.addonsDir')
    case 'fivem-root':
      return textMsg('analyzer.reasons.fivemRootDir')
    default:
      return textMsg('analyzer.reasons.gtaRootDir')
  }
}

function looseGroupLabel(kind: ComponentKind, n: number, dir: string): Msg {
  const p: Msg['params'] = dir ? { count: n, dir: base(dir) } : { count: n }
  switch (kind) {
    case 'mods':
      return textMsg(dir ? 'analyzer.groups.modsIn' : 'analyzer.groups.mods', p)
    case 'plugins':
      return textMsg(dir ? 'analyzer.groups.pluginsIn' : 'analyzer.groups.plugins', p)
    case 'gta-root':
      return textMsg(dir ? 'analyzer.groups.enbIn' : 'analyzer.groups.enb', p)
    case 'docs':
      return textMsg(dir ? 'analyzer.groups.docsIn' : 'analyzer.groups.docs', p)
    case 'unsupported':
      return textMsg(dir ? 'analyzer.groups.unsupportedIn' : 'analyzer.groups.unsupported', p)
    default:
      return textMsg(dir ? 'analyzer.groups.filesIn' : 'analyzer.groups.files', p)
  }
}

function groupReason(kind: ComponentKind, fallback: Msg): Msg {
  switch (kind) {
    case 'mods':
      return textMsg('analyzer.reasons.groupMods')
    case 'plugins':
      return textMsg('analyzer.reasons.groupPlugins')
    case 'gta-root':
      return textMsg('analyzer.reasons.groupEnb')
    case 'docs':
      return textMsg('analyzer.reasons.docs')
    default:
      return fallback
  }
}

/** Images d'aperçu (captures fournies par l'auteur) : jamais installées, affichées dans la bibliothèque. */
export function galleryOf(entries: PackFileEntry[], components: AnalyzedComponent[]): string[] {
  const docFiles = new Set(components.filter((c) => c.kind === 'docs').flatMap((c) => c.files))
  return entries
    .filter((e) => docFiles.has(e.rel) && isImage(e.rel) && !/\.bmp$/i.test(e.rel) && e.size > 20_000 && e.size < 25_000_000)
    .sort((a, b) => {
      const pa = /(cover|couverture|preview|apercu|thumb|banner|logo)/i.test(a.rel) ? 1 : 0
      const pb = /(cover|couverture|preview|apercu|thumb|banner|logo)/i.test(b.rel) ? 1 : 0
      return pb - pa || a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel, 'fr', { numeric: true })
    })
    .slice(0, 24)
    .map((e) => e.rel)
}

/**
 * Mod : seuls les dossiers mods, plugins, addons et citizen de FiveM.app peuvent recevoir ses fichiers. Les composants
 * qui écriraient ailleurs (racine de GTA V : configuration ENB, DLL graphiques...) sont désactivés, avec un avertissement.
 * Renvoie le nombre de composants écartés.
 */
export function restrictToFiveM(analysis: Pick<AnalysisResult, 'components' | 'warnings' | 'warningMsgs'>): number {
  let dropped = 0
  for (const c of analysis.components) {
    if (!c.destination) continue
    const outside = c.files.some((rel) => {
      const d = fileDestination(c, rel)
      return d !== null && (d.root !== 'fivem' || !isAllowedFiveMPath(d.path))
    })
    if (!outside) continue
    c.destination = null
    c.suggested = null
    c.enabled = false
    c.reasonMsg = c.kind === 'gta-root' ? textMsg('analyzer.reasons.modGtaRoot') : textMsg('analyzer.reasons.modOutside')
    c.reason = tm(c.reasonMsg)
    dropped++
  }
  // Avertissement global de l'analyse, inutile maintenant que ces composants sont écartés.
  const installable = analysis.components.filter((c) => c.enabled && c.destination)
  const keep = analysis.warningMsgs.map((m) => m.key !== NOTHING_INSTALLABLE)
  analysis.warnings = analysis.warnings.filter((_, i) => keep[i])
  analysis.warningMsgs = analysis.warningMsgs.filter((_, i) => keep[i])
  const warn = (m: Msg): void => {
    analysis.warningMsgs.push(m)
    analysis.warnings.push(tmNested(m))
  }
  if (dropped) warn(textMsg('analyzer.warnings.modDropped', { count: dropped }))
  if (!installable.length) warn(textMsg('analyzer.warnings.modNothingInstallable'))
  return dropped
}

/** Calcule la liste finale (source → destination) des fichiers à installer. */
export function resolveInstallMap(
  components: AnalyzedComponent[]
): { rel: string; dest: Destination; componentId: string }[] {
  const out: { rel: string; dest: Destination; componentId: string }[] = []
  const seen = new Set<string>()
  for (const c of components) {
    if (!c.enabled || !c.destination) continue
    for (const rel of c.files) {
      const d = fileDestination(c, rel)
      if (!d) continue
      const k = destKey(d)
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ rel, dest: d, componentId: c.id })
    }
  }
  return out
}

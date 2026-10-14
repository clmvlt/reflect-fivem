// Bibliothèque de packs : import (extraction + analyse), stockage, modification, suppression.
//
// Organisation sur le disque :
//   <bibliothèque>/<id>/pack.json   manifeste (composants, destinations, fichiers)
//   <bibliothèque>/<id>/content/    contenu extrait du pack (jamais modifié)
//   <bibliothèque>/<id>/user/       réglages modifiés en jeu, conservés entre deux applications
//   <bibliothèque>/<id>/generated/  fichiers écrits à l'installation (ReShade.ini pointé sur le preset choisi...)
//   <bibliothèque>/<id>/cover-*.jpg image choisie pour le pack
//
// Pack protégé (chiffré sur la Marketplace) : rien n'est jamais extrait. content/ est remplacé par le paquet chiffré
// reçu du serveur (content.fpk), gardé tel quel ; user/, generated/ et fixed/ (fichiers corrigés à l'import) sont
// chiffrés avec la clé locale (voir keys.ts et sealed.ts). Le contenu n'est en clair que dans le jeu, une fois installé.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { t } from 'i18next'
import { tm } from '@shared/i18n'
import { formatBytes as sizeText, quote } from '@shared/intl'
import type { Destination, PackComponent, PackFileEntry, PackManifest, PackPatch, RootId } from '@shared/types'
import { analyzePack, galleryOf, resolveInstallMap, tmNested, type AnalyzedComponent } from './analyzer'
import { folderContent, packageContent, readSource, type ContentSource, type PackContent } from './content'
import { fixReshadeIni, fixReshadeIniText, insight, inspectPack, INSIGHTS_VERSION } from './inspect'
import type { PackKeys } from './keys'
import { choosePreset, detectPresets } from './reshade'
import { ARCHIVE_EXT, detectFeatures, ext, isJunk, textMsg } from './knowledge'
import { readPackageIndex, readSealedFile, sealedFileRef, sealFileFrom, unsealToBuffer, unwrapKey, wrapKey, writeSealedFile } from './sealed'
import { dropJunk, stripWrapper } from './wrapper'
import { extractInWorker } from '../archive'
import { rarVolumeIndex, sanitizeEntryPath } from '../archive/sanitize'
import { exists, freeSpace, isDir, moveDir, moveFile, newId, readJson, slugify, walkFiles, writeJsonAtomic, formatBytes } from '../util/fsx'
import { log } from '../util/log'

export interface StoredManifest extends Omit<PackManifest, 'components'> {
  components: AnalyzedComponent[]
  files: PackFileEntry[]
  sourceSize: number
  /** Preset ReShade recopié dans QuantV.preset.ini à la dernière installation (retouches en jeu gardées tant qu'il ne change pas). */
  quantvPresetFrom?: string | null
  /** Pack protégé : contenu gardé chiffré (content.fpk), jamais extrait. */
  protection?: PackProtection
}

export interface PackProtection {
  /** Identifiant du paquet (en-tête de content.fpk), celui dont le serveur remet la clé. */
  packageId: string
  /** Clé du paquet, chiffrée avec la clé locale. */
  key: string
  /** Dossier enveloppe retiré des chemins du paquet (voir stripWrapper). */
  prefix: string
  /** Fichiers corrigés à l'import (ReShade.ini de l'auteur), gardés chiffrés dans fixed/ et installés à la place. */
  fixed: string[]
}

/** Fichier à installer, avec sa taille. */
export type SizedSource = ContentSource & { size: number }

export interface ImportProgress {
  phase: string
  current: number
  total: number
  detail?: string
}

export class ImportError extends Error {}

const MAX_NESTED_DEPTH = 3

export class Library {
  /** {@link keys} : clés des packs protégés (sans elles, ces packs ne peuvent être ni ajoutés ni installés). */
  constructor(
    public dir: string,
    private keys?: PackKeys
  ) {}

  packDir(id: string): string {
    return path.join(this.dir, id)
  }
  contentDir(id: string): string {
    return path.join(this.dir, id, 'content')
  }
  /** Paquet chiffré d'un pack protégé. */
  packageFile(id: string): string {
    return path.join(this.dir, id, 'content.fpk')
  }
  userDir(id: string): string {
    return path.join(this.dir, id, 'user')
  }
  userFile(id: string, dest: Destination): string {
    return path.join(this.userDir(id), dest.root, ...dest.path.split('/'))
  }
  private fixedFile(id: string, rel: string): string {
    return path.join(this.dir, id, 'fixed', ...rel.split('/'))
  }

  // -------------------------------------------------------------------------
  // Contenu, réglages et fichiers générés (en clair, ou chiffrés pour un pack protégé)

  private localKey(): Promise<Buffer> {
    if (!this.keys) throw new Error(t('library.errors.protectedUnavailable'))
    return this.keys.local()
  }

  /** Clé du paquet d'un pack protégé ; redemandée au serveur si la clé locale a changé (autre PC, autre compte Windows). */
  private async packageKey(m: StoredManifest): Promise<Buffer> {
    const p = m.protection!
    const local = await this.localKey()
    const kept = unwrapKey(p.key, local)
    if (kept) return kept
    if (!m.marketplace) throw new Error(t('library.errors.keyMissing'))
    let fetched: { packageId: string; key: Buffer }
    try {
      fetched = await this.keys!.fetch(m.marketplace.id)
    } catch (err) {
      throw new Error(t('library.errors.unlockOnline', { error: (err as Error).message }))
    }
    if (fetched.packageId !== p.packageId)
      throw new Error(t('library.errors.newVersion'))
    p.key = wrapKey(fetched.key, local)
    await this.save(m)
    log.info(`Clé du pack protégé ${m.name} redemandée au serveur`)
    return fetched.key
  }

  /** Contenu du pack : dossier extrait, ou paquet chiffré d'un pack protégé. */
  async content(m: StoredManifest): Promise<PackContent> {
    if (!m.protection) return folderContent(this.contentDir(m.id))
    const index = await readPackageIndex(this.packageFile(m.id), await this.packageKey(m))
    const local = await this.localKey()
    const overrides = new Map<string, ContentSource>()
    for (const rel of m.protection.fixed) {
      // Illisible (clé locale changée) : le fichier d'origine du paquet est installé.
      const s = await this.sealedSource(this.fixedFile(m.id, rel), local)
      if (s) overrides.set(rel.toLowerCase(), s)
    }
    return packageContent(this.packageFile(m.id), index, m.protection.prefix, overrides)
  }

  /** Fichier chiffré localement et vérifié (petits fichiers : réglages) ; null s'il est absent ou illisible. */
  private async sealedSource(file: string, local: Buffer): Promise<SizedSource | null> {
    try {
      const ref = await sealedFileRef(file, local)
      return ref ? { src: file, sealed: ref, size: (await unsealToBuffer(file, ref)).length } : null
    } catch {
      return null
    }
  }

  /** Réglage modifié en jeu gardé pour ce pack ; null s'il n'y en a pas (ou s'il est illisible, pour un pack protégé). */
  async userSource(m: StoredManifest, dest: Destination): Promise<SizedSource | null> {
    const file = this.userFile(m.id, dest)
    const st = await fs.stat(file).catch(() => null)
    if (!st?.isFile()) return null
    return m.protection ? this.sealedSource(file, await this.localKey()) : { src: file, size: st.size }
  }

  async readUserFile(m: StoredManifest, dest: Destination): Promise<Buffer | null> {
    const s = await this.userSource(m, dest)
    return s ? readSource(s).catch(() => null) : null
  }

  /** Garde un réglage modifié en jeu d'un pack protégé : chiffré, jamais en clair dans la bibliothèque. */
  async sealUserFile(m: StoredManifest, dest: Destination, from: string): Promise<void> {
    await sealFileFrom(from, this.userFile(m.id, dest), await this.localKey())
  }

  /** Écrit un fichier généré à l'installation (generated/<rel>), chiffré pour un pack protégé. */
  async writeGenerated(m: StoredManifest, rel: string, data: Buffer): Promise<SizedSource & { source: string }> {
    const file = path.join(this.packDir(m.id), 'generated', ...rel.split('/'))
    const source = `generated/${rel}`
    if (m.protection) {
      const local = await this.localKey()
      await writeSealedFile(file, data, local)
      return { src: file, sealed: (await sealedFileRef(file, local))!, size: data.length, source }
    }
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, data)
    return { src: file, size: data.length, source }
  }

  /**
   * Réglages modifiés en jeu repris par une nouvelle version du pack ; chiffrés ou déchiffrés si la nouvelle version
   * est protégée et l'ancienne non, ou l'inverse.
   */
  async copyUserConfigs(fromId: string, toId: string): Promise<void> {
    const source = this.userDir(fromId)
    if (!(await exists(source))) return
    const [from, to] = [await this.get(fromId), await this.get(toId)]
    if (!!from.protection === !!to.protection) await fs.cp(source, this.userDir(toId), { recursive: true, force: true })
    else {
      const local = await this.localKey()
      for (const f of await walkFiles(source)) {
        const src = path.join(source, ...f.rel.split('/'))
        const dst = path.join(this.userDir(toId), ...f.rel.split('/'))
        if (to.protection) await sealFileFrom(src, dst, local)
        else {
          const data = await readSealedFile(src, local).catch(() => null)
          if (!data) continue
          await fs.mkdir(path.dirname(dst), { recursive: true })
          await fs.writeFile(dst, data)
        }
      }
    }
    to.userConfigCount = await this.countUserConfigs(toId)
    await this.save(to)
  }

  async list(): Promise<StoredManifest[]> {
    await fs.mkdir(this.dir, { recursive: true })
    const out: StoredManifest[] = []
    for (const e of await fs.readdir(this.dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      const m = await readJson<StoredManifest | null>(path.join(this.dir, e.name, 'pack.json'), null)
      if (!m || m.id !== e.name) continue
      if (m.insightsVersion !== INSIGHTS_VERSION || !Array.isArray(m.gallery)) {
        await this.refreshInsights(m).catch(() => undefined)
        // Les images de la Marketplace (market-*.jpg) ne viennent pas du contenu : conservées. Celles d'un pack protégé
        // restent dans son paquet chiffré.
        const market = (Array.isArray(m.gallery) ? m.gallery : []).filter((g) => /^market-/.test(g))
        m.gallery = [...market, ...(m.protection ? [] : galleryOf(m.files, m.components).map((r) => `content/${r}`))]
        await this.save(m).catch(() => undefined)
      }
      out.push(m)
    }
    out.sort((a, b) => b.importedAt.localeCompare(a.importedAt))
    return out
  }

  async get(id: string): Promise<StoredManifest> {
    const m = await readJson<StoredManifest | null>(path.join(this.packDir(id), 'pack.json'), null)
    if (!m) throw new Error(t('library.errors.notFound'))
    return m
  }

  async save(m: StoredManifest): Promise<void> {
    m.updatedAt = new Date().toISOString()
    await writeJsonAtomic(path.join(this.packDir(m.id), 'pack.json'), m)
  }

  async update(id: string, patch: PackPatch): Promise<StoredManifest> {
    const m = await this.get(id)
    if (patch.name !== undefined) m.name = patch.name.trim() || m.name
    if (patch.notes !== undefined) m.notes = patch.notes
    if (patch.resetComponents) {
      for (const c of m.components) {
        c.destination = c.suggested
        c.enabled = c.suggested !== null && !c.optional
      }
    }
    for (const p of patch.components ?? []) {
      const c = m.components.find((x) => x.id === p.id)
      if (!c) continue
      if (p.destination !== undefined) {
        c.destination = p.destination
        if (p.destination === null) c.enabled = false
        else if (p.enabled === undefined) c.enabled = true
      }
      if (p.enabled !== undefined) c.enabled = p.enabled && c.destination !== null
    }
    if (patch.components?.length || patch.resetComponents) await this.refreshInsights(m)
    await this.save(m)
    return m
  }

  /** Recalcule les vérifications de compatibilité (elles dépendent des destinations choisies). */
  async refreshInsights(m: StoredManifest): Promise<void> {
    const map = resolveInstallMap(m.components)
    const content = await this.content(m)
    const { insights, reshadeVersion } = await inspectPack(content, map)
    const notes = (m.insights ?? []).filter((i) => i.rel === '').map((i) => ({ ...i, ...insight(i.rel, i.level, 'ReShade.ini', RESHADE_FIXED) }))
    m.insights = [...insights, ...notes]
    m.reshadeVersion = reshadeVersion
    const { presets, fromIni } = await detectPresets(content, map)
    m.reshadePresets = presets
    // Le choix de l'utilisateur est conservé tant que ce preset existe encore dans le pack.
    if (!m.reshadePreset || !presets.includes(m.reshadePreset)) m.reshadePreset = choosePreset(presets, fromIni, m.name)
    m.insightsVersion = INSIGHTS_VERSION
  }

  async setReshadePreset(id: string, rel: string): Promise<StoredManifest> {
    const m = await this.get(id)
    if (!(m.reshadePresets ?? []).includes(rel)) throw new Error(t('library.errors.unknownPreset'))
    m.reshadePreset = rel
    await this.save(m)
    return m
  }

  /**
   * Supprime un pack en rapportant la progression. Le pack est d'abord marqué « en suppression » :
   * si l'application est fermée en cours de route, la suppression est terminée au démarrage suivant.
   */
  async remove(id: string, onProgress?: (done: number, total: number) => void): Promise<void> {
    const dir = this.packDir(id)
    const m = await this.get(id)
    m.deleting = true
    await this.save(m)
    // Le temps de suppression dépend du nombre de fichiers et, dans une moindre mesure, de leur taille.
    const files = (await walkFiles(dir)).filter((f) => f.rel !== 'pack.json')
    const weight = (size: number): number => size + 4 * 1024 * 1024
    const total = files.reduce((s, f) => s + weight(f.size), 0)
    let done = 0
    onProgress?.(0, total)
    for (const f of files) {
      const p = path.join(dir, ...f.rel.split('/'))
      try {
        await fs.unlink(p)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EPERM') {
          // Fichier en lecture seule (ex. venu du dossier GTA V) : on retire l'attribut puis on réessaie.
          await fs.chmod(p, 0o666).catch(() => undefined)
          await fs.unlink(p)
        } else if (code !== 'ENOENT') throw err
      }
      done += weight(f.size)
      onProgress?.(done, total)
    }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 })
    onProgress?.(total, total)
  }

  async resetUserConfigs(id: string): Promise<StoredManifest> {
    await fs.rm(this.userDir(id), { recursive: true, force: true })
    const m = await this.get(id)
    m.userConfigCount = 0
    await this.save(m)
    return m
  }

  /** Définit l'image du pack : une image de sa galerie ou un fichier enregistré dans le dossier du pack. */
  async setCover(id: string, rel: string | null): Promise<StoredManifest> {
    const m = await this.get(id)
    if (rel && !m.gallery.includes(rel) && !/^cover-[\w-]+\.(jpe?g|png|webp)$/i.test(rel)) throw new Error(t('library.errors.unknownImage'))
    // Ancienne image enregistrée : supprimée pour ne pas accumuler de fichiers.
    if (m.cover && m.cover !== rel && /^cover-/.test(m.cover)) await fs.rm(path.join(this.packDir(id), m.cover), { force: true }).catch(() => undefined)
    m.cover = rel
    await this.save(m)
    return m
  }

  async countUserConfigs(id: string): Promise<number> {
    if (!(await isDir(this.userDir(id)))) return 0
    return (await walkFiles(this.userDir(id))).length
  }

  /**
   * Nettoie les imports interrompus (fermeture de l'application pendant une extraction). Les téléchargements de la
   * Marketplace (.downloads) sont gardés pour reprendre là où ils s'étaient arrêtés.
   */
  async cleanupStaging(): Promise<void> {
    await fs.rm(path.join(this.dir, '.staging'), { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(path.join(this.dir, '.trash'), { recursive: true, force: true }).catch(() => undefined)
    // Suppressions interrompues (application fermée pendant la suppression d'un pack).
    for (const e of await fs.readdir(this.dir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      const m = await readJson<StoredManifest | null>(path.join(this.dir, e.name, 'pack.json'), null)
      if (m?.deleting) await fs.rm(path.join(this.dir, e.name), { recursive: true, force: true }).catch(() => undefined)
    }
  }

  // -------------------------------------------------------------------------
  // Import

  async findDuplicate(sourceName: string, sourceSize: number): Promise<StoredManifest | null> {
    return (await this.list()).find((m) => m.sourceArchive === sourceName && m.sourceSize === sourceSize) ?? null
  }

  /**
   * Importe une archive (.zip / .rar / .7z) ou un dossier déjà extrait. skipDuplicateCheck : nouvelle version d'un
   * pack de la Marketplace, qui peut porter le même nom de fichier que l'ancienne.
   */
  async import(
    source: string,
    onProgress: (p: ImportProgress) => void,
    signal?: AbortSignal,
    options: { skipDuplicateCheck?: boolean } = {}
  ): Promise<StoredManifest> {
    const st = await fs.stat(source).catch(() => null)
    if (!st) throw new ImportError(t('library.errors.fileNotFound'))
    const isFolder = st.isDirectory()
    const sourceName = path.basename(source)
    const sourceSize = isFolder ? 0 : st.size

    if (!isFolder) {
      const vol = rarVolumeIndex(sourceName)
      if (vol !== null && vol > 1) throw new ImportError(t('library.errors.firstPart'))
      if (!ARCHIVE_EXT.has(ext(sourceName))) throw new ImportError(t('library.errors.format'))
      const dup = options.skipDuplicateCheck ? null : await this.findDuplicate(sourceName, sourceSize)
      if (dup) throw new ImportError(t('library.errors.duplicate', { name: quote(dup.name) }))
    }

    const id = `${slugify(cleanName(sourceName))}-${newId()}`
    const staging = path.join(this.dir, '.staging', id)
    const raw = path.join(staging, 'raw')
    await fs.mkdir(raw, { recursive: true })

    try {
      if (isFolder) {
        onProgress({ phase: t('library.phases.copyFolder'), current: 0, total: 1, detail: sourceName })
        await fs.cp(source, raw, { recursive: true })
      } else {
        const free = await freeSpace(this.dir)
        const spaceError = (need: number): string => t('library.errors.noSpace', { size: sizeText(need) })
        if (free !== null && free < sourceSize * 1.05) throw new ImportError(spaceError(sourceSize))
        // La taille décompressée réelle n'est connue qu'après lecture de l'archive : on interrompt tôt si elle ne tient pas.
        const local = new AbortController()
        signal?.addEventListener('abort', () => local.abort())
        let tooBig: number | null = null
        try {
          await extractInWorker(
            source,
            raw,
            (p) => {
              if (p.phase === 'list' && free !== null && p.totalBytes > free - 100 * 1024 * 1024) {
                tooBig = p.totalBytes
                local.abort()
              }
              onProgress({
                phase: p.phase === 'list' ? t('library.phases.readArchive') : t('library.phases.extract'),
                current: p.totalBytes ? p.bytes : p.files,
                total: p.totalBytes || p.totalFiles,
                detail: p.current
              })
            },
            local.signal
          )
        } catch (err) {
          if (tooBig !== null) throw new ImportError(spaceError(tooBig))
          throw err
        }
      }

      await this.extractNested(raw, onProgress, signal)

      onProgress({ phase: t('library.phases.analyzePack'), current: 0, total: 1 })
      let entries = (await walkFiles(raw)).map((f) => ({ rel: f.rel, size: f.size }))
      // Supprime les fichiers parasites (__MACOSX, Thumbs.db...)
      const keep = new Set(dropJunk(entries).map((e) => e.rel))
      for (const e of entries) if (!keep.has(e.rel)) await fs.rm(path.join(raw, ...e.rel.split('/')), { force: true })
      entries = entries.filter((e) => keep.has(e.rel))
      if (!entries.length) throw new ImportError(t('library.errors.empty'))

      const { entries: stripped, prefix } = stripWrapper(entries)
      const contentSrc = prefix ? path.join(raw, ...prefix.replace(/\/$/, '').split('/')) : raw
      const presets = await findPresets(folderContent(contentSrc), stripped)
      const analysis = analyzePack(stripped, { isPreset: (rel) => presets.has(rel) })

      const packDir = this.packDir(id)
      await fs.mkdir(packDir, { recursive: true })
      await moveDir(contentSrc, this.contentDir(id))


      // ReShade.ini exporté depuis le PC de l'auteur : chemins absolus corrigés.
      let fixedPaths = 0
      for (const { rel } of resolveInstallMap(analysis.components)) {
        if (/(^|\/)reshade\.ini$/i.test(rel)) fixedPaths += await fixReshadeIni(path.join(this.contentDir(id), ...rel.split('/')))
      }

      const now = new Date().toISOString()
      const manifest: StoredManifest = {
        schema: 1,
        id,
        name: cleanName(sourceName),
        sourceArchive: sourceName,
        sourceSize,
        importedAt: now,
        updatedAt: now,
        contentSize: stripped.reduce((s, e) => s + e.size, 0),
        fileCount: stripped.length,
        components: analysis.components,
        features: analysis.features,
        warnings: analysis.warnings,
        warningMsgs: analysis.warningMsgs,
        cover: null,
        gallery: analysis.gallery.map((r) => `content/${r}`),
        notes: '',
        captured: false,
        userConfigCount: 0,
        insights: [],
        reshadeVersion: null,
        files: stripped
      }
      onProgress({ phase: t('library.phases.checkCompat'), current: 0, total: 1 })
      await this.refreshInsights(manifest)
      if (fixedPaths) manifest.insights.push(insight('', 'info', 'ReShade.ini', RESHADE_FIXED))
      await this.save(manifest)
      log.info(`Pack importé : ${manifest.name} (${manifest.fileCount} fichiers, ${formatBytes(manifest.contentSize)})`)
      return manifest
    } catch (err) {
      await fs.rm(this.packDir(id), { recursive: true, force: true }).catch(() => undefined)
      throw err
    } finally {
      await fs.rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
    }
  }

  /** Les packs contiennent souvent d'autres archives (ex. « mods.rar » dans un .zip) : on les extrait sur place. */
  private async extractNested(root: string, onProgress: (p: ImportProgress) => void, signal?: AbortSignal): Promise<void> {
    for (let depth = 0; depth < MAX_NESTED_DEPTH; depth++) {
      const archives = (await walkFiles(root)).filter((f) => {
        const name = path.posix.basename(f.rel)
        if (!ARCHIVE_EXT.has(ext(name)) || isJunk(name)) return false
        const vol = rarVolumeIndex(name)
        return vol === null || vol === 1
      })
      if (!archives.length) return
      for (const a of archives) {
        const abs = path.join(root, ...a.rel.split('/'))
        const name = path.posix.basename(a.rel)
        const stem = name.replace(/(\.part0*1)?\.(zip|rar|7z)$/i, '')
        let target = path.join(path.dirname(abs), stem)
        if (await exists(target)) target = path.join(path.dirname(abs), `${stem} (archive)`)
        try {
          await extractInWorker(
            abs,
            target,
            (p) =>
              onProgress({
                phase: t('library.phases.extractNamed', { name }),
                current: p.totalBytes ? p.bytes : p.files,
                total: p.totalBytes || p.totalFiles,
                detail: p.current
              }),
            signal
          )
          await fs.rm(abs, { force: true })
          // Parties suivantes d'une archive découpée
          if (rarVolumeIndex(name) === 1) {
            const base = name.replace(/\.part0*1\.rar$/i, '')
            for (const f of await fs.readdir(path.dirname(abs)))
              if (f.startsWith(base) && rarVolumeIndex(f) !== null) await fs.rm(path.join(path.dirname(abs), f), { force: true })
          }
        } catch (err) {
          await fs.rm(target, { recursive: true, force: true }).catch(() => undefined)
          log.warn(`Archive interne non extraite (${a.rel}) : ${(err as Error).message}`)
          // On renomme pour ne pas la retraiter à la profondeur suivante.
          await fs.rename(abs, `${abs}.non-extrait`).catch(() => undefined)
        }
      }
    }
  }

  /**
   * Ajoute un pack protégé à partir de son paquet chiffré (téléchargé depuis la Marketplace, déjà vérifié) : le paquet est
   * gardé tel quel (content.fpk, le fichier est déplacé) et rien n'est extrait ; l'analyse lit les fichiers utiles
   * directement dans le paquet. {@link source} : archive dont le paquet est tiré (nom et taille, comme pour un import).
   */
  async importPackage(
    file: string,
    key: Buffer,
    source: { name: string; size: number },
    onProgress: (p: ImportProgress) => void
  ): Promise<StoredManifest> {
    onProgress({ phase: t('library.phases.readPack'), current: 0, total: 1 })
    const index = await readPackageIndex(file, key)
    // Chemins nettoyés comme à l'extraction d'une archive ; un doublon (casse ignorée, comme sous Windows) remplace le
    // précédent.
    const byRel = new Map<string, PackFileEntry>()
    for (const e of index.entries) {
      const rel = sanitizeEntryPath(e.path)
      if (!rel) continue
      byRel.delete(rel.toLowerCase())
      byRel.set(rel.toLowerCase(), { rel, size: e.size })
    }
    const entries = dropJunk([...byRel.values()]).sort((a, b) => a.rel.localeCompare(b.rel))
    if (!entries.length) throw new ImportError(t('library.errors.empty'))

    onProgress({ phase: t('library.phases.analyzePack'), current: 0, total: 1 })
    const { entries: stripped, prefix } = stripWrapper(entries)
    const content = packageContent(file, index, prefix)
    const presets = await findPresets(content, stripped)
    const analysis = analyzePack(stripped, { isPreset: (rel) => presets.has(rel) })

    const id = `${slugify(cleanName(source.name))}-${newId()}`
    const local = await this.localKey()
    const protection: PackProtection = { packageId: index.id, key: wrapKey(key, local), prefix, fixed: [] }
    try {
      // ReShade.ini exporté depuis le PC de l'auteur : copie corrigée, chiffrée, installée à la place de l'originale.
      let fixedPaths = 0
      for (const { rel } of resolveInstallMap(analysis.components)) {
        if (!/(^|\/)reshade\.ini$/i.test(rel)) continue
        const raw = await content.read(rel)
        const { text, changes } = fixReshadeIniText(raw?.toString('utf8') ?? '')
        if (!raw || !changes) continue
        await writeSealedFile(this.fixedFile(id, rel), Buffer.from(text, 'utf8'), local)
        protection.fixed.push(rel)
        fixedPaths += changes
      }
      await moveFile(file, this.packageFile(id))

      const now = new Date().toISOString()
      const manifest: StoredManifest = {
        schema: 1,
        id,
        name: cleanName(source.name),
        sourceArchive: source.name,
        sourceSize: source.size,
        importedAt: now,
        updatedAt: now,
        contentSize: stripped.reduce((s, e) => s + e.size, 0),
        fileCount: stripped.length,
        components: analysis.components,
        features: analysis.features,
        warnings: analysis.warnings,
        warningMsgs: analysis.warningMsgs,
        cover: null,
        gallery: [],
        notes: '',
        captured: false,
        userConfigCount: 0,
        insights: [],
        reshadeVersion: null,
        files: stripped,
        protection
      }
      onProgress({ phase: t('library.phases.checkCompat'), current: 0, total: 1 })
      await this.refreshInsights(manifest)
      if (fixedPaths) manifest.insights.push(insight('', 'info', 'ReShade.ini', RESHADE_FIXED))
      await this.save(manifest)
      log.info(`Pack protégé ajouté : ${manifest.name} (${manifest.fileCount} fichiers, ${formatBytes(manifest.contentSize)})`)
      return manifest
    } catch (err) {
      await fs.rm(this.packDir(id), { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // Packs créés à partir d'une installation faite à la main.
  // Les fichiers sont déplacés (pas copiés) dans content/FiveM Application Data/... et content/GTA V/...,
  // puis le manifeste est écrit une fois le déplacement réussi.

  newCapturedId(name: string): string {
    return `${slugify(name)}-${newId()}`
  }

  capturedFile(id: string, root: RootId, rel: string): string {
    return path.join(this.contentDir(id), CAPTURE_TOP[root], ...rel.split('/'))
  }

  async uniqueName(base: string): Promise<string> {
    const names = new Set((await this.list()).map((m) => m.name.toLowerCase()))
    if (!names.has(base.toLowerCase())) return base
    for (let i = 2; ; i++) if (!names.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`
  }

  async finalizeCaptured(id: string, name: string, items: { root: RootId; rel: string; size: number }[]): Promise<StoredManifest> {
    const files: PackFileEntry[] = items.map((it) => ({ rel: `${CAPTURE_TOP[it.root]}/${it.rel}`, size: it.size }))
    const components: AnalyzedComponent[] = (['fivem', 'gta'] as RootId[])
      .map((root) => {
        const list = files.filter((f) => f.rel.startsWith(`${CAPTURE_TOP[root]}/`))
        const c: AnalyzedComponent = {
          id: `captured-${root}`,
          source: CAPTURE_TOP[root],
          isFile: false,
          label: root === 'fivem' ? 'FiveM' : 'GTA V',
          kind: root === 'fivem' ? 'fivem-root' : 'gta-root',
          destination: { root, path: '' },
          suggested: { root, path: '' },
          enabled: true,
          optional: false,
          fileCount: list.length,
          size: list.reduce((s, f) => s + f.size, 0),
          reason: tm(REINSTALLED),
          reasonMsg: REINSTALLED,
          stripPrefix: `${CAPTURE_TOP[root]}/`,
          files: list.map((f) => f.rel)
        }
        return c
      })
      .filter((c) => c.files.length)
    const now = new Date().toISOString()
    const manifest: StoredManifest = {
      schema: 1,
      id,
      name,
      sourceArchive: '',
      sourceSize: 0,
      importedAt: now,
      updatedAt: now,
      contentSize: files.reduce((s, f) => s + f.size, 0),
      fileCount: files.length,
      components,
      features: detectFeatures(items.map((it) => it.rel)),
      warnings: [],
      cover: null,
      gallery: [],
      notes: '',
      captured: true,
      userConfigCount: 0,
      insights: [],
      reshadeVersion: null,
      files
    }
    await this.refreshInsights(manifest)
    await this.save(manifest)
    return manifest
  }
}

const CAPTURE_TOP: Record<RootId, string> = { fivem: 'FiveM Application Data', gta: 'GTA V' }
const RESHADE_FIXED = textMsg('library.reshadeFixed')
const REINSTALLED = textMsg('library.reinstalledInPlace')

/** Presets ReShade parmi les .ini du pack (avant l'analyse, pour la guider). */
async function findPresets(content: PackContent, entries: PackFileEntry[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (const e of entries) {
    if (ext(e.rel) !== '.ini' || e.size > 2_000_000) continue
    // Illisible : ignoré.
    const head = (await content.head(e.rel, 256_000))?.toString('utf8').slice(0, 64_000)
    if (head && (/^\s*Techniques\s*=/im.test(head) || /^\s*\[[^\]]+\.fx\]\s*$/im.test(head))) out.add(e.rel)
  }
  return out
}

export function cleanName(fileName: string): string {
  return (
    fileName
      .replace(/(\.part0*\d+)?\.(zip|rar|7z)$/i, '')
      .replace(/[_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || t('library.unnamed')
  )
}

/**
 * Version « publique » du manifeste envoyée à l'interface (sans les listes de fichiers). Les textes produits à l'import
 * (raisons, avertissements, vérifications) sont traduits dans la langue affichée ; ceux d'un manifeste d'une version
 * précédente, sans clé, restent tels quels.
 */
export function toPublic(m: StoredManifest): PackManifest {
  const { files: _files, sourceSize: _s, protection, components, ...rest } = m
  void _files
  void _s
  const warnings = m.warningMsgs?.length === m.warnings.length ? m.warningMsgs.map(tmNested) : m.warnings
  return {
    ...rest,
    warnings,
    insights: (m.insights ?? []).map((i) => ({ ...i, title: i.titleMsg ? tm(i.titleMsg) : i.title, text: i.textMsg ? tm(i.textMsg) : i.text })),
    protected: !!protection,
    components: components.map(({ files: _f, stripPrefix: _p, ...c }) => {
      void _f
      void _p
      return {
        ...c,
        label: c.labelMsg ? tm(c.labelMsg) : c.label,
        reason: c.reasonMsg ? tm(c.reasonMsg) : c.reason
      } as PackComponent
    })
  }
}

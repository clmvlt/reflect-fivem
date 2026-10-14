// Mises à jour de l'application, entièrement automatiques.
//
// Vérification au démarrage puis toutes les heures. Une nouvelle version est téléchargée en arrière-plan, puis
// vérifiée : taille, SHA-512 et signature Ed25519 de la version (clé publique embarquée). Seule une version vérifiée
// est installée, à la fermeture de l'application, sans rien demander ; « Redémarrer maintenant » l'installe tout de suite.
//
// - installateur (NSIS) : electron-updater (<API>/app/updates/latest.yml) télécharge l'installateur, lancé en
//   silencieux à la fermeture ;
// - version portable : le nouveau .exe est téléchargé puis mis à la place de l'ancien à la fermeture (portableSwap) ;
// - lancée depuis les sources : impossible de se remplacer, la nouvelle version est seulement signalée.

import { constants, createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app, net } from 'electron'
import type { BaseUpdater, UpdateInfo } from 'electron-updater'
import { t } from 'i18next'
import type { UpdateState } from '@shared/types'
import { log } from '../util/log'
import { languageFetch } from './http'
import { launchSwap, prepareSwapScript } from './portableSwap'
import { releaseMessage, sha512File, verifyRelease } from './releaseSignature'

const FIRST_CHECK = 10_000
const CHECK_EVERY = 60 * 60 * 1000

/** Requêtes vers l'API, avec la langue affichée (notes de version). */
const apiFetch = languageFetch((url, init) => net.fetch(url, init))

type AutoUpdater = (typeof import('electron-updater'))['autoUpdater']

interface RemoteFile {
  kind: 'setup' | 'portable'
  fileName: string
  size: number
  sha512: string
  signature: string | null
  url: string
}

interface RemoteRelease {
  version: string
  notes: string
  files: RemoteFile[]
}

type Mode = 'installer' | 'portable' | 'source'

export class AppUpdater {
  state: UpdateState = { status: 'idle' }
  readonly mode: Mode
  private timer: NodeJS.Timeout | null = null
  private installRequested = false
  /** Version portable prête : fichier vérifié et script de remplacement préparé. */
  private portableReady: { file: string; script: string; workDir: string } | null = null
  /** electron-updater, chargé à la première vérification : son chargement retarderait l'ouverture de l'application. */
  private auto: AutoUpdater | null = null

  constructor(
    private apiUrl: string,
    private emit: (state: UpdateState) => void
  ) {
    const portableExe = process.env.PORTABLE_EXECUTABLE_FILE
    if (portableExe) this.mode = 'portable'
    else if (app.isPackaged || process.env.PM_UPDATER_DEV === '1') this.mode = 'installer'
    else this.mode = 'source'
  }

  start(): void {
    if (process.env.PM_NO_UPDATE === '1') {
      this.set({ status: 'unsupported' })
      return
    }
    // Ancienne version portable restée à côté (un .exe en cours d'exécution se renomme mais ne se supprime pas).
    if (this.mode === 'portable') void fs.rm(`${process.env.PORTABLE_EXECUTABLE_FILE}.old`, { force: true }).catch(() => undefined)
    // Cache d'electron-updater de l'ancien nom (FiveM Pack Manager) : l'installateur de la mise à jour vers le nouveau
    // nom y est resté. Plus tard qu'au démarrage : juste après la mise à jour, il peut encore être en train de se fermer.
    if (this.mode === 'installer' && process.env.LOCALAPPDATA) {
      const oldCache = path.join(process.env.LOCALAPPDATA, 'fivem-pack-manager-updater')
      setTimeout(() => void fs.rm(oldCache, { recursive: true, force: true }).catch(() => undefined), FIRST_CHECK)
    }
    // Installation de la version vérifiée à la fermeture de l'application.
    app.once('quit', (_event, exitCode) => {
      if (exitCode === 0) this.installOnQuit(false)
    })
    setTimeout(() => void this.check(), FIRST_CHECK)
    this.timer = setInterval(() => void this.check(), CHECK_EVERY)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  private set(state: UpdateState): void {
    this.state = { ...state, mode: this.mode }
    this.emit(this.state)
  }

  private installerUpdater(): AutoUpdater {
    if (this.auto) return this.auto
    // require plutôt que import() : le module CommonJS est chargé comme avant, sans passer par le chargeur ESM.
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')
    autoUpdater.logger = {
      info: (m: unknown) => log.info(`Mise à jour : ${String(m)}`),
      warn: (m: unknown) => log.warn(`Mise à jour : ${String(m)}`),
      error: (m: unknown) => log.error(`Mise à jour : ${String(m)}`),
      debug: () => undefined
    }
    // Téléchargement lancé par check(), installation gérée ici (jamais celle d'electron-updater : elle n'attendrait
    // pas la vérification de la signature).
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowPrerelease = false
    // Pas de fichiers .blockmap publiés : téléchargement complet directement, sans tentative différentielle.
    autoUpdater.disableDifferentialDownload = true
    autoUpdater.disableWebInstaller = true
    autoUpdater.forceDevUpdateConfig = !app.isPackaged
    autoUpdater.setFeedURL({ provider: 'generic', url: `${this.apiUrl}/app/updates` })

    autoUpdater.on('download-progress', (p) => {
      this.set({ ...this.state, status: 'downloading', percent: Math.floor(p.percent), transferred: p.transferred, total: p.total })
    })
    autoUpdater.on('update-downloaded', (event) => {
      void this.verifyInstaller(event.downloadedFile, event.version)
    })
    autoUpdater.on('error', (err) => {
      if (this.state.status === 'downloading' || this.state.status === 'checking')
        this.set({ ...this.state, status: 'error', error: friendly(err) })
    })
    this.auto = autoUpdater
    return autoUpdater
  }

  /** Recherche une nouvelle version et, si possible, la télécharge et la vérifie aussitôt. */
  async check(): Promise<UpdateState> {
    if (this.state.status === 'unsupported') return this.state
    if (['checking', 'downloading', 'verifying', 'ready'].includes(this.state.status)) return this.state
    const previous = this.state
    this.set({ ...previous, status: 'checking' })
    try {
      if (this.mode === 'installer') {
        const autoUpdater = this.installerUpdater()
        const result = await autoUpdater.checkForUpdates()
        const info: UpdateInfo | undefined = result?.updateInfo
        if (!result?.isUpdateAvailable || !info) {
          this.set({ status: 'none', checkedAt: now() })
          return this.state
        }
        const remote = await this.fetchRelease(info.version).catch(() => null)
        this.set({ status: 'downloading', version: info.version, notes: remote?.notes ?? '', percent: 0, checkedAt: now() })
        log.info(`Mise à jour ${info.version} trouvée : téléchargement`)
        // La suite (vérification puis « prête ») arrive par les évènements d'electron-updater.
        autoUpdater.downloadUpdate().catch((err) => this.set({ ...this.state, status: 'error', error: friendly(err) }))
        return this.state
      }

      const latest = await this.fetchRelease('latest')
      if (!latest || !isNewer(latest.version, app.getVersion())) {
        this.set({ status: 'none', checkedAt: now() })
        return this.state
      }
      const portable = latest.files.find((f) => f.kind === 'portable')
      if (this.mode === 'portable' && portable?.signature && (await this.canReplacePortable())) {
        void this.downloadPortable(latest, portable)
        return this.state
      }
      // Lancée depuis les sources, ou version portable impossible à remplacer : la nouvelle version est signalée.
      this.set({ status: 'available', version: latest.version, notes: latest.notes, manual: true, checkedAt: now() })
    } catch (err) {
      log.warn(`Recherche de mise à jour impossible : ${(err as Error).message}`)
      // Hors ligne ou serveur indisponible : nouvel essai à la prochaine vérification, sans alerter.
      this.set({ ...previous, status: previous.status === 'checking' ? 'none' : previous.status, checkedAt: now() })
    }
    return this.state
  }

  // ------------------------------------------------------------------ installateur

  /** Signature de la version, puis empreinte et taille du fichier réellement téléchargé. */
  private async verifyInstaller(file: string, version: string): Promise<void> {
    this.set({ ...this.state, status: 'verifying', version })
    try {
      const remote = await this.fetchRelease(version)
      const setup = remote?.files.find((f) => f.kind === 'setup')
      if (!setup) throw new Error(t('updater.errors.versionNotFound'))
      await verifyFile(file, version, setup)
      log.info(`Mise à jour ${version} téléchargée et vérifiée : installée à la fermeture`)
      this.set({ ...this.state, status: 'ready', version })
    } catch (err) {
      log.error(`Mise à jour ${version} refusée : ${(err as Error).message}`)
      await fs.rm(file, { force: true }).catch(() => undefined)
      this.set({ ...this.state, status: 'error', error: t('updater.errors.rejected', { error: (err as Error).message }) })
    }
  }

  // ------------------------------------------------------------------ version portable

  private async canReplacePortable(): Promise<boolean> {
    try {
      await fs.access(path.dirname(process.env.PORTABLE_EXECUTABLE_FILE!), constants.W_OK)
      return true
    } catch {
      return false
    }
  }

  private async downloadPortable(release: RemoteRelease, file: RemoteFile): Promise<void> {
    const workDir = path.join(app.getPath('temp'), 'Reflect FiveM', 'mise-a-jour')
    const target = path.join(workDir, `${release.version}-${file.fileName}`)
    this.set({ status: 'downloading', version: release.version, notes: release.notes, percent: 0, transferred: 0, total: file.size, checkedAt: now() })
    try {
      await fs.mkdir(workDir, { recursive: true })
      const already = await fs.stat(target).catch(() => null)
      if (already?.size !== file.size) {
        const response = await apiFetch(`${this.apiUrl}/${file.url}`)
        if (!response.ok || !response.body) throw new Error(t('updater.errors.downloadFailed', { status: response.status }))
        let received = 0
        const body = Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream)
        body.on('data', (chunk: Buffer) => {
          received += chunk.length
          const percent = Math.floor((received * 100) / file.size)
          if (percent !== this.state.percent) this.set({ ...this.state, percent, transferred: received })
        })
        await pipeline(body, createWriteStream(`${target}.part`))
        await fs.rename(`${target}.part`, target)
      }
      this.set({ ...this.state, status: 'verifying' })
      await verifyFile(target, release.version, file)
      this.portableReady = { file: target, script: await prepareSwapScript(workDir), workDir }
      log.info(`Mise à jour portable ${release.version} vérifiée : mise en place à la fermeture`)
      this.set({ ...this.state, status: 'ready' })
    } catch (err) {
      log.error(`Mise à jour portable ${release.version} refusée : ${(err as Error).message}`)
      await fs.rm(target, { force: true }).catch(() => undefined)
      this.set({ ...this.state, status: 'error', error: t('updater.errors.failed', { error: friendly(err) }) })
    }
  }

  // ------------------------------------------------------------------ installation

  /** « Redémarrer maintenant ». */
  install(): void {
    if (this.state.status !== 'ready') throw new Error(t('updater.errors.notReady'))
    if (this.mode === 'installer') {
      this.installRequested = true
      // Installation silencieuse puis relance de l'application (« ready » : electron-updater déjà chargé).
      this.auto!.quitAndInstall(true, true)
      return
    }
    this.installOnQuit(true)
    app.quit()
  }

  /** Installe la version vérifiée pendant la fermeture de l'application. */
  private installOnQuit(relaunch: boolean): void {
    if (this.state.status !== 'ready' || this.installRequested) return
    this.installRequested = true
    try {
      if (this.mode === 'installer') {
        log.info(`Installation de la version ${this.state.version} à la fermeture`)
        ;(this.auto as unknown as BaseUpdater).install(true, false)
      } else if (this.mode === 'portable' && this.portableReady) {
        log.info(`Remplacement de la version portable par la ${this.state.version}`)
        launchSwap(this.portableReady.script, {
          target: process.env.PORTABLE_EXECUTABLE_FILE!,
          source: this.portableReady.file,
          relaunch,
          workDir: this.portableReady.workDir
        })
      }
    } catch (err) {
      log.error(`Installation de la mise à jour impossible : ${(err as Error).message}`)
    }
  }

  private async fetchRelease(version: string): Promise<RemoteRelease | null> {
    const response = await apiFetch(`${this.apiUrl}/app/releases/${encodeURIComponent(version)}`)
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return (await response.json()) as RemoteRelease
  }
}

/** Taille, SHA-512 et signature Ed25519 du fichier téléchargé, comparés à la version publiée. */
async function verifyFile(file: string, version: string, expected: { size: number; sha512: string; signature: string | null }): Promise<void> {
  if (!expected.signature) throw new Error(t('updater.errors.unsigned'))
  const [size, sha512] = await Promise.all([fs.stat(file).then((s) => s.size), sha512File(file)])
  if (size !== expected.size || sha512 !== expected.sha512) throw new Error(t('updater.errors.mismatch'))
  if (!verifyRelease(releaseMessage(version, size, sha512), expected.signature)) throw new Error(t('updater.errors.badSignature'))
}

function now(): string {
  return new Date().toISOString()
}

function friendly(err: unknown): string {
  const m = (err as Error)?.message ?? String(err)
  if (/net::|ENOTFOUND|ECONN|ETIMEDOUT|socket/i.test(m)) return t('updater.errors.network')
  return m.split('\n')[0]
}

/** Comparaison « majeur.mineur.correctif » (les pré-versions ne sont pas proposées). */
export function isNewer(remote: string, local: string): boolean {
  const parse = (v: string): number[] => v.replace(/^v/, '').split('-')[0].split('.').map((n) => Number(n) || 0)
  const [a, b] = [parse(remote), parse(local)]
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return false
}

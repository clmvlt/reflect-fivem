import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import type { AccountMe, DownloadDone, DownloadItem, Overview, TaskProgress, UpdateState } from '@shared/types'
import { MAINTENANCE, PENDING, readApiError } from '@shared/api'
import type { MaintenanceState } from '@shared/maintenance'
import { emptyLinks, type AppLinks } from '@shared/links'
import type { WhatsNew } from '@shared/changelog'
import { paidProposal } from '@shared/billing'
import i18next, { t } from 'i18next'
import { num, q } from './lib/format'
import { applyTheme } from './lib/theme'

export interface Message {
  kind: 'error' | 'info'
  text: string
}

interface Store {
  overview: Overview | null
  refresh: () => Promise<void>
  task: TaskProgress | null
  /** Téléchargements de la Marketplace : celui en cours d'abord, puis la file d'attente. */
  downloads: DownloadItem[]
  /** Mise à jour de l'application. */
  update: UpdateState | null
  /** Compte connecté (null sans compte, undefined tant qu'il n'est pas chargé). */
  account: AccountMe | null | undefined
  setAccount: (me: AccountMe | null) => void
  /** Maintenances prévues par l'admin (null tant que l'état n'est pas chargé). */
  maintenance: MaintenanceState | null
  /** Interroge l'API tout de suite (« Réessayer »). */
  checkMaintenance: () => Promise<void>
  /** Liens modifiables depuis le site (null : bouton masqué). */
  links: AppLinks
  /** Ouvre un de ces liens dans le navigateur. */
  openLink: (name: keyof AppLinks & string) => void
  /** Fenêtre « Nouveautés » à montrer (null : rien à montrer). */
  whatsNew: WhatsNew | null
  /** « OK » : la version lancée est enregistrée comme vue. */
  dismissWhatsNew: () => void
  message: Message | null
  setMessage: (m: Message | null) => void
  /** Appelle l'API ; une erreur s'affiche dans la barre de message. */
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>
  /**
   * Change ce qui est installé dans le jeu (installer, retirer, nettoyer...). FiveM lancé : le changement est fait à
   * la fermeture du jeu, et un message demande de le redémarrer.
   */
  changeGame: (fn: () => Promise<string>) => Promise<void>
}

const Ctx = createContext<Store | null>(null)

export function StoreProvider({ children }: { children: ReactNode }): ReactElement {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [task, setTask] = useState<TaskProgress | null>(null)
  const [downloads, setDownloads] = useState<DownloadItem[]>([])
  const [message, setMessage] = useState<Message | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [account, setAccount] = useState<AccountMe | null | undefined>(undefined)
  const [maintenance, setMaintenance] = useState<MaintenanceState | null>(null)
  const [links, setLinks] = useState<AppLinks>(emptyLinks)
  const [whatsNew, setWhatsNew] = useState<WhatsNew | null>(null)
  const lastTask = useRef<string | null>(null)
  // Changement fait pendant une partie (à sa fermeture) : il prendra effet au prochain lancement.
  const relaunchRef = useRef(false)
  relaunchRef.current = !!overview?.game.relaunch

  const refresh = useCallback(async () => {
    try {
      const o = await window.api.getOverview()
      setOverview(o)
      setUpdate((u) => u ?? o.update)
    } catch (e) {
      setMessage({ kind: 'error', text: cleanError(e) })
    }
  }, [])

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn()
    } catch (e) {
      // Maintenance : pas une erreur, le bandeau ou l'écran de maintenance l'explique.
      if (apiError(e).code === MAINTENANCE) setMessage({ kind: 'info', text: t('maintenance.unavailable') })
      else setMessage({ kind: 'error', text: cleanError(e) })
      return undefined
    }
  }, [])

  const checkMaintenance = useCallback(async (): Promise<void> => {
    try {
      setMaintenance(await window.api.maintenanceCheck())
    } catch {
      /* état inchangé */
    }
  }, [])

  const openLink = useCallback((name: keyof AppLinks & string): void => void run(() => window.api.openAppLink(name)), [run])

  const dismissWhatsNew = useCallback((): void => {
    setWhatsNew(null)
    void run(() => window.api.dismissChangelog())
  }, [run])

  const changeGame = useCallback(
    async (fn: () => Promise<string>): Promise<void> => {
      if ((await run(fn)) === PENDING)
        setMessage({ kind: 'info', text: t('store.pendingChange') })
    },
    [run]
  )

  useEffect(() => {
    void refresh()
    const offChanged = window.api.onChanged(() => void refresh())
    const offUpdate = window.api.onUpdate(setUpdate)
    const offAccount = window.api.onAccount(setAccount)
    // Langue changée (réglages, ou langue du compte à la connexion) : textes de l'interface, puis données relues (les
    // textes produits par le processus principal ou par l'API suivent la nouvelle langue).
    const offLanguage = window.api.onLanguage((lng) => {
      document.documentElement.lang = lng
      void i18next.changeLanguage(lng).then(() => refresh())
    })
    window.api.accountGet().then(setAccount, () => setAccount(null))
    const offMaintenance = window.api.onMaintenance(setMaintenance)
    window.api.maintenanceGet().then(setMaintenance, () => undefined)
    const offLinks = window.api.onLinks(setLinks)
    window.api.linksGet().then(setLinks, () => undefined)
    const offChangelog = window.api.onChangelog(setWhatsNew)
    window.api.changelogGet().then(setWhatsNew, () => undefined)
    const offDownloads = window.api.onDownloads(setDownloads)
    window.api.downloadsGet().then(setDownloads, () => undefined)
    const offDownloadDone = window.api.onDownloadDone((d) => {
      // Pack payant refusé : pas d'erreur, la connexion ou l'achat sont proposés (voir usePurchases).
      if (paidProposal(d)) return
      const info = downloadMessage(d)
      if (info) setMessage(info)
    })
    const offTask = window.api.onTask((p) => {
      if (!p.done) {
        // Nouvelle action : l'ancien message n'a plus lieu d'être.
        if (lastTask.current !== p.taskId) setMessage(null)
        lastTask.current = p.taskId
        setTask(p)
        return
      }
      setTask(null)
      // Téléchargement : son résultat arrive avec la fin du téléchargement (onDownloadDone).
      if (p.kind === 'download') return
      if (!p.ok) setMessage({ kind: 'error', text: p.error ?? t('common.failed') })
      else {
        const info = resultMessage(p)
        // Changement fait à la fermeture du jeu : le rappeler.
        const restart = relaunchRef.current && ['apply', 'remove', 'clean', 'stash'].includes(p.kind)
        const text = t('store.doneNextLaunch')
        if (restart) setMessage({ kind: 'info', text: info ? `${info.text}\n${text}` : text })
        else if (info) setMessage(info)
      }
    })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'F5') void window.api.refreshGames()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offChanged()
      offTask()
      offDownloads()
      offDownloadDone()
      offUpdate()
      offAccount()
      offLanguage()
      offMaintenance()
      offLinks()
      offChangelog()
      window.removeEventListener('keydown', onKey)
    }
  }, [refresh])

  // Les messages disparaissent seuls (un peu plus tard pour une erreur, le temps de la lire).
  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(null), message.kind === 'error' ? 10000 : 7000)
    return () => window.clearTimeout(timer)
  }, [message])

  // Couleur d'accent de Windows (celle des thèmes qui n'ont pas la leur).
  useEffect(() => {
    if (overview?.accent) document.documentElement.style.setProperty('--system-accent', overview.accent)
  }, [overview?.accent])

  // Thème changé (réglages) ; le premier est posé avant l'affichage (main.tsx).
  const theme = overview?.settings.theme
  const loaded = overview !== null
  useEffect(() => {
    if (loaded) applyTheme(theme)
  }, [theme, loaded])

  const value = useMemo<Store>(
    () => ({ overview, refresh, task, downloads, update, account, setAccount, maintenance, checkMaintenance, links, openLink, whatsNew, dismissWhatsNew, message, setMessage, run, changeGame }),
    [overview, refresh, task, downloads, update, account, maintenance, checkMaintenance, links, openLink, whatsNew, dismissWhatsNew, message, run, changeGame]
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): Store {
  const s = useContext(Ctx)
  if (!s) throw new Error('StoreProvider manquant')
  return s
}

export function cleanError(e: unknown): string {
  return apiError(e).message
}

/** Message à afficher, et statut HTTP et `code` d'une erreur de l'API (null pour les autres erreurs). */
export function apiError(e: unknown): { message: string; status: number | null; code: string | null } {
  const msg = (e as Error)?.message ?? String(e)
  // Les erreurs IPC sont préfixées par « Error invoking remote method 'pm:invoke': Error: ».
  return readApiError(msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''))
}

/** Message de fin d'un téléchargement de la Marketplace. */
function downloadMessage(d: DownloadDone): Message | null {
  if (d.cancelled) return { kind: 'info', text: t('downloads.cancelled', { name: q(d.name) }) }
  if (!d.ok) return { kind: 'error', text: d.error ?? t('common.failed') }
  return resultMessage({ taskId: d.id, kind: 'download', title: d.name, phase: '', current: 1, total: 1, done: true, ok: true, result: d.result })
}

/** Création de « Créer ton pack » ajoutée à la bibliothèque, mise à jour ou déjà à jour ; composants retirés signalés. */
function buildMessage(d: { name?: string; status?: string; unavailable?: string[] }): Message {
  const name = q(d.name ?? t('store.thePack'))
  const text = d.status === 'updated' ? t('store.build.updated', { name }) : d.status === 'up-to-date' ? t('store.download.upToDate', { name }) : t('store.build.added', { name })
  const removed = d.unavailable?.length ? t('store.build.unavailable', { count: d.unavailable.length, names: d.unavailable.map(q).join(', ') }) : null
  return { kind: 'info', text: removed ? `${text}
${removed}` : text }
}

function resultMessage(p: TaskProgress): Message | null {
  if (p.kind === 'mod') {
    const r = (p.result ?? {}) as { name?: string; enabled?: boolean; deleted?: boolean; disabled?: number; imported?: string[]; errors?: string[] }
    if (r.disabled !== undefined) return { kind: 'info', text: r.disabled ? t('store.mod.disabledCount', { count: r.disabled }) : t('store.mod.noneEnabled') }
    if (r.imported) {
      const n = r.imported.length
      let added = ''
      if (n === 1) added = t('store.mod.importedOne', { name: q(r.imported[0]) })
      else if (n > 1) added = t('store.mod.importedMany', { n: num(n) })
      const text = [added, ...(r.errors ?? [])].filter(Boolean).join('\n')
      return text ? { kind: r.errors?.length ? 'error' : 'info', text } : null
    }
    const name = q(r.name ?? t('store.theMod'))
    if (r.deleted) return { kind: 'info', text: t('store.mod.deleted', { name }) }
    if (r.enabled !== undefined) return { kind: 'info', text: r.enabled ? t('store.mod.enabled', { name }) : t('store.mod.disabled', { name }) }
    return null
  }
  if (p.kind === 'instance') {
    const r = (p.result ?? {}) as { name?: string; note?: string | null }
    const text = t('instances.created', { name: q(r.name ?? '') })
    return r.note ? { kind: 'error', text: `${text}\n${r.note}` } : { kind: 'info', text }
  }
  if (p.kind === 'download') {
    const d = (p.result ?? {}) as { name?: string; status?: string; note?: string; kind?: string; enabled?: boolean; unavailable?: string[] }
    if (d.note) return { kind: 'info', text: d.note }
    if (d.kind === 'build') return buildMessage(d)
    if (d.status === 'paused') return { kind: 'info', text: t('maintenance.downloadPaused', { name: q(d.name ?? (d.kind === 'mod' ? t('store.theMod') : t('store.thePack'))) }) }
    if (d.kind === 'mod' && (d.status === 'added' || d.status === 'updated')) {
      const name = q(d.name ?? t('store.theMod'))
      if (d.status === 'updated') return { kind: 'info', text: d.enabled ? t('store.download.modUpdatedEnabled', { name }) : t('store.download.updated', { name }) }
      return { kind: 'info', text: d.enabled ? t('store.download.modInstalledEnabled', { name }) : t('store.download.modAdded', { name }) }
    }
    const name = q(d.name ?? (d.kind === 'mod' ? t('store.theMod') : t('store.thePack')))
    if (d.status === 'updated') return { kind: 'info', text: t('store.download.updated', { name }) }
    if (d.status === 'linked') return { kind: 'info', text: t('store.download.linked', { name }) }
    if (d.status === 'up-to-date') return { kind: 'info', text: t('store.download.upToDate', { name }) }
    if (d.status === 'claimed') return { kind: 'info', text: t('store.download.claimed', { name }) }
    return { kind: 'info', text: t('store.download.added', { name }) }
  }
  const r = (p.result ?? {}) as { captured?: string | null; errors?: string[]; mods?: number }
  if (p.kind === 'clean') {
    const restored = r.captured ? t('store.clean.restoredCaptured', { name: q(r.captured) }) : t('store.clean.restored')
    return { kind: 'info', text: r.mods ? `${restored} ${t('store.clean.modsDisabled', { count: r.mods })}` : restored }
  }
  if ((p.kind === 'apply' || p.kind === 'stash') && r.captured) return { kind: 'info', text: t('store.captured', { name: q(r.captured) }) }
  if (p.kind === 'import' && r.errors?.length) return { kind: 'error', text: r.errors.join('\n') }
  return null
}

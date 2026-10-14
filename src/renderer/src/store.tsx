import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import type { AccountMe, Overview, TaskProgress, UpdateState } from '@shared/types'
import { readApiError } from '@shared/api'
import i18next, { t } from 'i18next'
import { num, q } from './lib/format'

export interface Message {
  kind: 'error' | 'info'
  text: string
}

interface Store {
  overview: Overview | null
  refresh: () => Promise<void>
  task: TaskProgress | null
  /** Mise à jour de l'application. */
  update: UpdateState | null
  /** Compte connecté (null sans compte, undefined tant qu'il n'est pas chargé). */
  account: AccountMe | null | undefined
  setAccount: (me: AccountMe | null) => void
  message: Message | null
  setMessage: (m: Message | null) => void
  /** Appelle l'API ; une erreur s'affiche dans la barre de message. */
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>
}

const Ctx = createContext<Store | null>(null)

export function StoreProvider({ children }: { children: ReactNode }): ReactElement {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [task, setTask] = useState<TaskProgress | null>(null)
  const [message, setMessage] = useState<Message | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [account, setAccount] = useState<AccountMe | null | undefined>(undefined)
  const lastTask = useRef<string | null>(null)

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
      setMessage({ kind: 'error', text: cleanError(e) })
      return undefined
    }
  }, [])

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
    const offTask = window.api.onTask((p) => {
      if (!p.done) {
        // Nouvelle action : l'ancien message n'a plus lieu d'être.
        if (lastTask.current !== p.taskId) setMessage(null)
        lastTask.current = p.taskId
        setTask(p)
        return
      }
      setTask(null)
      if (!p.ok) setMessage({ kind: 'error', text: p.error ?? t('common.failed') })
      else {
        const info = resultMessage(p)
        if (info) setMessage(info)
      }
    })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'F5') void window.api.refreshGames()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offChanged()
      offTask()
      offUpdate()
      offAccount()
      offLanguage()
      window.removeEventListener('keydown', onKey)
    }
  }, [refresh])

  // Les messages disparaissent seuls (un peu plus tard pour une erreur, le temps de la lire).
  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(null), message.kind === 'error' ? 10000 : 7000)
    return () => window.clearTimeout(timer)
  }, [message])

  // Couleur d'accent de Windows
  useEffect(() => {
    if (overview?.accent) document.documentElement.style.setProperty('--accent', overview.accent)
  }, [overview?.accent])

  const value = useMemo<Store>(
    () => ({ overview, refresh, task, update, account, setAccount, message, setMessage, run }),
    [overview, refresh, task, update, account, message, run]
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
  if (p.kind === 'download') {
    const d = (p.result ?? {}) as { name?: string; status?: string; note?: string; kind?: string; enabled?: boolean }
    if (d.note) return { kind: 'info', text: d.note }
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

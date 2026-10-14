// Mods : « Mes mods » dans la bibliothèque (un interrupteur par mod), et les actions sur un mod (activer en réglant les
// conflits, désactiver, supprimer, importer) partagées avec la Marketplace.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18next, { t } from 'i18next'
import type { InstalledMod, MarketCategory, MarketKind, PackManifest, TaskProgress } from '@shared/types'
import type { MenuItem } from '@shared/api'
import { useStore } from '../store'
import { bytes, num, q } from '../lib/format'
import { Cover, EmptyState, Progress } from './common'
import { usePerfConfirm } from './Performance'
import type { PackPerformance } from '@shared/performance'

// Catégories de l'API (libellés et nombre de mods), lues une fois par lancement et par langue (libellés traduits par
// l'API).
let categoriesCache: Promise<MarketCategory[]> | null = null
i18next.on('languageChanged', () => {
  categoriesCache = null
})

export function useModCategories(): MarketCategory[] {
  const { i18n } = useTranslation()
  const [items, setItems] = useState<MarketCategory[]>([])
  useEffect(() => {
    let live = true
    categoriesCache ??= window.api.marketCategories().catch(() => {
      categoriesCache = null
      return []
    })
    void categoriesCache.then((c) => live && setItems(c))
    return () => {
      live = false
    }
  }, [i18n.language])
  return items
}

/** Libellé d'une catégorie (sa clé tant que les catégories ne sont pas chargées). */
export function categoryLabel(key: string | null | undefined, categories: MarketCategory[]): string | null {
  if (!key) return null
  return categories.find((c) => c.key === key)?.label ?? key
}

/** Quelques chemins, puis « … » s'il y en a plus. */
function fileList(files: string[]): string {
  const shown = files.slice(0, 3).join(', ')
  return files.length > 3 ? t('modsView.fileListMore', { files: shown, n: num(files.length) }) : shown
}

/** Mod de la bibliothèque relié à une fiche de la Marketplace (la version la plus récente s'il y en a deux). */
export function localMod(marketId: string, mods: PackManifest[]): PackManifest | null {
  const matches = mods.filter((m) => m.marketplace?.id === marketId).sort((a, b) => b.marketplace!.downloadedAt.localeCompare(a.marketplace!.downloadedAt))
  return matches[0] ?? null
}

export function modState(id: string, states: InstalledMod[]): InstalledMod | null {
  return states.find((m) => m.id === id) ?? null
}

/** Actions sur les mods ; les conflits sont toujours annoncés avant d'agir. */
export function useModActions() {
  const { run, setMessage } = useStore()

  const enable = useCallback(
    async (mod: { id: string; name: string }): Promise<void> => {
      const pre = await run(() => window.api.modPreflight(mod.id))
      if (!pre) return
      if (pre.blockers.length) return setMessage({ kind: 'error', text: pre.blockers[0] })
      let disable: string[] = []
      if (pre.conflicts.length) {
        const names = pre.conflicts.map((c) => q(c.name)).join(', ')
        const ok = await window.api.confirm(
          t('modsView.conflict.message', { names }),
          t('modsView.conflict.detail', { count: pre.conflicts.length, mod: q(mod.name), names, files: fileList(pre.conflicts.flatMap((c) => c.files)) }),
          t('modsView.conflict.ok')
        )
        if (!ok) return
        disable = pre.conflicts.map((c) => c.id)
      }
      if (pre.pack) {
        const ok = await window.api.confirm(
          t('modsView.overridePack.message', { pack: q(pre.pack.name) }),
          t('modsView.overridePack.detail', { mod: q(mod.name), count: pre.pack.files.length, n: num(pre.pack.files.length), files: fileList(pre.pack.files) }),
          t('modsView.overridePack.ok')
        )
        if (!ok) return
      }
      await run(() => window.api.setModEnabled(mod.id, true, disable))
    },
    [run, setMessage]
  )

  const disable = useCallback(async (mod: { id: string }): Promise<void> => void (await run(() => window.api.setModEnabled(mod.id, false))), [run])

  const remove = useCallback(
    async (mod: { id: string; name: string }, enabled: boolean): Promise<void> => {
      const ok = await window.api.confirm(
        t('modsView.delete.message', { mod: q(mod.name) }),
        enabled ? t('modsView.delete.detailEnabled') : t('modsView.delete.detail'),
        t('common.delete')
      )
      if (ok) await run(() => window.api.deleteMod(mod.id))
    },
    [run]
  )

  const disableAll = useCallback(
    async (count: number): Promise<void> => {
      const ok = await window.api.confirm(
        t('modsView.disableAll.message', { count, n: num(count) }),
        t('modsView.disableAll.detail'),
        t('modsView.disableAll.ok')
      )
      if (ok) await run(() => window.api.disableAllMods())
    },
    [run]
  )

  const importFiles = useCallback(
    async (paths?: string[]): Promise<void> => {
      const list = paths ?? (await window.api.pickModFiles())
      if (list.length) await run(() => window.api.importMods(list))
    },
    [run]
  )

  return { enable, disable, disableAll, remove, importFiles }
}

/** « Mes mods » : un mod par ligne, avec son interrupteur. */
export function ModLibrary({ query, onOpenMarket, onBrowse }: { query: string; onOpenMarket: (id: string, kind: MarketKind) => void; onBrowse: () => void }) {
  const { t, i18n } = useTranslation()
  const { overview, task } = useStore()
  const categories = useModCategories()
  const actions = useModActions()
  if (!overview) return null
  const states = overview.state.mods
  const enabledFirst = (m: PackManifest): number => (modState(m.id, states)?.enabled ? 0 : 1)
  const needle = query.trim().toLowerCase()
  const list = overview.mods
    .filter((m) => !needle || m.name.toLowerCase().includes(needle) || (categoryLabel(m.category, categories) ?? '').toLowerCase().includes(needle))
    .sort((a, b) => enabledFirst(a) - enabledFirst(b) || a.name.localeCompare(b.name, i18n.language))
  const importing = task?.kind === 'mod' && task.detail === 'mod-import' ? task : null
  const enabledCount = states.filter((s) => s.enabled).length

  return (
    <>
      <div className="mods-hint-row">
        <p className="hint mods-hint">{t('modsView.pureModeHint')}</p>
        {enabledCount > 0 && (
          <button onClick={() => void actions.disableAll(enabledCount)} disabled={!!task} title={t('modsView.disableAll.title')}>
            {t('modsView.disableAll.ok')}
          </button>
        )}
      </div>
      {!overview.mods.length && !importing ? (
        <EmptyState
          icon="mod"
          title={t('modsView.empty.title')}
          text={t('modsView.empty.text')}
          formats={['.zip', '.rar', '.7z', '.rpf']}
        >
          <button className="primary" onClick={() => void actions.importFiles()} disabled={!!task}>
            {t('modsView.import')}
          </button>
          <button onClick={onBrowse}>{t('modsView.browse')}</button>
        </EmptyState>
      ) : (
        <ul className="list mod-list">
          {importing && (
            <li className="row mod-row">
              <div className="mod-thumb">
                <div className="cover-empty" />
              </div>
              <div className="row-main">
                <div className="name">{importing.title}</div>
                <div className="meta">{importing.phase || t('modsView.preparing')}</div>
              </div>
              <Progress task={importing} />
            </li>
          )}
          {list.map((m) => (
            <ModRow
              key={m.id}
              mod={m}
              installed={modState(m.id, states)}
              update={overview.market.updates.includes(m.id)}
              gone={overview.market.gone.includes(m.id)}
              category={categoryLabel(m.category, categories)}
              task={task}
              actions={actions}
              onOpenMarket={onOpenMarket}
            />
          ))}
          {!list.length && !importing && <li className="row muted">{t('modsView.noMatch')}</li>}
        </ul>
      )}
    </>
  )
}

function ModRow({
  mod,
  installed,
  update,
  gone,
  category,
  task,
  actions,
  onOpenMarket
}: {
  mod: PackManifest
  installed: InstalledMod | null
  update: boolean
  gone: boolean
  category: string | null
  task: TaskProgress | null
  actions: ReturnType<typeof useModActions>
  onOpenMarket: (id: string, kind: MarketKind) => void
}) {
  const { t } = useTranslation()
  const { run, overview } = useStore()
  const [details, setDetails] = useState(false)
  const enabled = !!installed?.enabled
  // Mise à jour arrêtée par une maintenance : reprise toute seule à la fin.
  const paused = !!mod.marketplace && !!overview?.pausedDownloads.some((d) => d.id === mod.marketplace!.id)
  const mine = task && task.detail === mod.id ? task : task?.kind === 'download' && task.detail === mod.marketplace?.id ? task : null
  const meta = [
    category,
    t('modsView.files', { count: mod.fileCount, n: num(mod.fileCount) }),
    bytes(mod.contentSize),
    mod.author && t('modsView.byAuthor', { author: mod.author }),
    mod.protected && t('modsView.protected')
  ]
    .filter(Boolean)
    .join(' · ')
  const shadowed = enabled ? (installed?.shadowed.length ?? 0) : 0

  const menu = async (): Promise<void> => {
    const items: MenuItem[] = []
    if (mod.marketplace && !gone) items.push({ id: 'market', label: t('modsView.menu.market') })
    if (update) items.push({ id: 'update', label: t('modsView.update'), enabled: !task })
    items.push({ id: 'details', label: details ? t('modsView.menu.hideFiles') : t('modsView.menu.showFiles') })
    items.push({ id: 'open', label: t('modsView.menu.openFolder'), enabled: !mod.protected })
    items.push({ id: 'delete', label: t('common.delete'), enabled: !task, separator: true })
    switch (await window.api.popupMenu(items)) {
      case 'market':
        return onOpenMarket(mod.marketplace!.id, 'mod')
      case 'update':
        return void (await run(() => window.api.marketInstall(mod.marketplace!.id, 'mod')))
      case 'details':
        return setDetails(!details)
      case 'open':
        return void (await run(() => window.api.openModFolder(mod.id)))
      case 'delete':
        return actions.remove(mod, enabled)
    }
  }

  return (
    <li className={`row mod-row ${enabled ? 'is-enabled' : ''}`} onContextMenu={(e) => (e.preventDefault(), void menu())}>
      <div className="mod-thumb">
        <Cover pack={mod} />
      </div>
      <div className="row-main">
        <div className="name ellipsis" title={mod.name}>
          {mod.name}
        </div>
        <div className="meta">
          {meta}
          {update && <span className="accent-text small"> · {paused ? t('maintenance.pausedShort') : t('modsView.newVersion')}</span>}
          {gone && <span className="muted small"> · {t('modsView.gone')}</span>}
        </div>
        {shadowed > 0 && <div className="meta small">{t('modsView.shadowed', { count: shadowed, n: num(shadowed) })}</div>}
        {details && <ModFiles mod={mod} />}
      </div>
      {mine ? (
        <Progress task={mine} />
      ) : (
        <div className="actions">
          {update && !paused && (
            <button onClick={() => void run(() => window.api.marketInstall(mod.marketplace!.id, 'mod'))} disabled={!!task}>
              {t('modsView.update')}
            </button>
          )}
          <ModSwitch mod={mod} enabled={enabled} disabled={!!task} actions={actions} />
          <button className="more" onClick={() => void menu()} aria-label={t('modsView.moreOptions')} title={t('modsView.moreOptions')}>
            ⋯
          </button>
        </div>
      )}
    </li>
  )
}

function ModSwitch({ mod, enabled, disabled, actions }: { mod: PackManifest; enabled: boolean; disabled: boolean; actions: ReturnType<typeof useModActions> }) {
  const { t } = useTranslation()
  return (
    <label className="switch mod-switch" title={enabled ? t('modsView.switch.disable') : t('modsView.switch.enable')}>
      <input type="checkbox" checked={enabled} disabled={disabled} onChange={(e) => void (e.target.checked ? actions.enable(mod) : actions.disable(mod))} />
      <span className="switch-track" />
      <span className="switch-text">{enabled ? t('common.enabled') : t('common.disabled')}</span>
    </label>
  )
}

/** Où vont les fichiers du mod, et ce qui a été écarté. */
function ModFiles({ mod }: { mod: PackManifest }) {
  const { t } = useTranslation()
  const installed = mod.components.filter((c) => c.enabled && c.destination)
  return (
    <div className="mod-files">
      {installed.map((c) => (
        <div key={c.id} className="small">
          {c.label} <span className="muted">→ FiveM.app/{c.destination!.path || ''}</span>
          <span className="muted"> ({t('modsView.files', { count: c.fileCount, n: num(c.fileCount) })})</span>
        </div>
      ))}
      {mod.warnings.map((w, i) => (
        <div key={i} className="small warn-text">
          {w}
        </div>
      ))}
    </div>
  )
}

/** Actions d'un mod de la Marketplace : Installer, Mettre à jour, Activer / Désactiver, Supprimer. */
export function ModMarketAction({ item, wide = false }: { item: { id: string; sha256: string; name: string; performance?: PackPerformance | null }; wide?: boolean }) {
  const { t } = useTranslation()
  const { overview, task, run } = useStore()
  const actions = useModActions()
  const confirmHeavy = usePerfConfirm()
  if (!overview) return null
  const local = localMod(item.id, overview.mods)
  const update = !!local && !!item.sha256 && local.marketplace!.sha256 !== item.sha256
  const enabled = !!local && !!modState(local.id, overview.state.mods)?.enabled
  const cls = (primary: boolean): string => [primary && 'primary', wide && 'wide'].filter(Boolean).join(' ')
  const install = (): void => void run(() => window.api.marketInstall(item.id, 'mod'))
  // Premier téléchargement d'un mod trop lourd pour la machine : confirmation (qui n'empêche pas de l'installer).
  const installNew = async (): Promise<void> => {
    if (await confirmHeavy({ ...item, kind: 'mod' }, t('modsView.installAnyway'))) install()
  }

  if (!local)
    return (
      <>
        <div className="spacer" />
        <button className={cls(true)} onClick={() => void installNew()} disabled={!!task}>
          {t('modsView.install')}
        </button>
      </>
    )
  const toggle = (
    <button className={cls(!enabled && !update)} onClick={() => void (enabled ? actions.disable(local) : actions.enable(local))} disabled={!!task}>
      {enabled ? t('modsView.disable') : t('modsView.enable')}
    </button>
  )
  if (!wide)
    return (
      <>
        {update ? <span className="accent-text small">{t('modsView.newVersion')}</span> : <span className="state">{enabled ? t('common.enabled') : t('common.disabled')}</span>}
        <div className="spacer" />
        {update ? (
          <button className="primary" onClick={install} disabled={!!task}>
            {t('modsView.update')}
          </button>
        ) : (
          toggle
        )}
      </>
    )
  return (
    <>
      <span className="state big">{enabled ? t('modsView.stateEnabled') : t('modsView.stateDisabled')}</span>
      {update && (
        <button className={cls(true)} onClick={install} disabled={!!task}>
          {t('modsView.update')}
        </button>
      )}
      {toggle}
      <button className={cls(false)} onClick={() => void actions.remove(local, enabled)} disabled={!!task}>
        {t('common.delete')}
      </button>
    </>
  )
}

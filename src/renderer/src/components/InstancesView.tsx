import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { InstanceSummary } from '@shared/types'
import { q } from '../lib/format'
import { useStore } from '../store'
import { Progress } from './common'
import { Modal } from './Modal'

/** Nouvelle instance copiée depuis une autre : nom, instance copiée, dossier qui la recevra, raccourci sur le bureau. */
interface CreateForm {
  name: string
  from: string
  parent: string
  shortcut: boolean
}

/**
 * Instances FiveM (ouverte depuis les réglages) : plusieurs dossiers FiveM, chacun avec son pack et ses mods. On en crée
 * (copie d'une instance), on en ajoute (dossier existant), on choisit l'instance active et où s'installent les packs.
 */
export function InstancesView({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation()
  const { overview, task, run, changeGame, setMessage } = useStore()
  const [creating, setCreating] = useState<CreateForm | null>(null)
  // Dossier existant choisi, nom à confirmer.
  const [adding, setAdding] = useState<{ path: string; name: string } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  if (!overview) return null
  const { instances, settings } = overview
  const busy = task?.kind === 'instance' ? task : null

  const startCreate = (): void => {
    const base = instances.find((i) => i.id === 'main' && i.fivemPath) ?? instances.find((i) => i.current) ?? instances[0]
    setCreating({ name: '', from: base.id, parent: parentOf(base.fivemPath), shortcut: true })
  }
  const create = async (): Promise<void> => {
    if (!creating) return
    const id = await run(() => window.api.instanceCreate(creating.from, creating.parent, creating.name, creating.shortcut))
    if (id) setCreating(null)
  }
  const pickAdd = async (): Promise<void> => {
    const p = await window.api.pickFolder(t('instances.view.pickFolder'))
    if (p) setAdding({ path: p, name: folderName(p) })
  }
  const add = async (): Promise<void> => {
    if (!adding) return
    if (await run(() => window.api.instanceAdd(adding.path, adding.name))) setAdding(null)
  }
  const rename = async (): Promise<void> => {
    if (!renaming) return
    if (await run(() => window.api.instanceRename(renaming.id, renaming.name).then(() => true))) setRenaming(null)
  }
  const menu = async (i: InstanceSummary): Promise<void> => {
    const choice = await window.api.popupMenu([
      { id: 'open', label: t('instances.view.openFolder'), enabled: !!i.fivemPath },
      { id: 'shortcut', label: t('instances.view.shortcut'), enabled: !!i.fivemPath },
      { id: 'remove-pack', label: t('instances.view.removePack'), enabled: !!i.packName && !task, separator: true },
      { id: 'rename', label: t('instances.view.rename'), separator: true },
      { id: 'delete', label: t('common.delete'), enabled: !i.current && !task }
    ])
    if (choice === 'open') await run(() => window.api.openPath(i.fivemPath!))
    else if (choice === 'shortcut') {
      if ((await run(() => window.api.instanceShortcut(i.id).then(() => true))) === true) setMessage({ kind: 'info', text: t('instances.view.shortcutDone') })
    } else if (choice === 'remove-pack') await changeGame(() => window.api.removeActive(i.id))
    else if (choice === 'rename') setRenaming({ id: i.id, name: i.name })
    else if (choice === 'delete') {
      if (await window.api.confirm(t('instances.view.removeTitle', { name: q(i.name) }), t('instances.view.removeDetail'), t('common.delete')))
        await run(() => window.api.instanceRemove(i.id))
    }
  }
  const chooseParent = async (): Promise<void> => {
    if (!creating) return
    const p = await window.api.pickFolder(t('instances.view.pickDestination'), creating.parent || undefined)
    if (p) setCreating({ ...creating, parent: p })
  }

  return (
    <div className="page">
      <div className="back-row">
        <button className="link" onClick={onBack}>
          {t('instances.view.back')}
        </button>
      </div>
      <header className="page-head">
        <h1>{t('instances.view.title')}</h1>
      </header>
      <p className="instances-intro">{t('instances.view.intro')}</p>

      <div className="section-head">
        <h2>{t('instances.settings.title')}</h2>
        <div className="actions">
          <button onClick={() => void pickAdd()} disabled={!!task}>
            {t('instances.view.add')}
          </button>
          <button className="primary" onClick={startCreate} disabled={!!task}>
            {t('instances.view.create')}
          </button>
        </div>
      </div>
      <ul className="list">
        {instances.map((i) => (
          <li key={i.id} className="row top">
            <div className="row-main">
              <div className="name instance-name">
                <span className="ellipsis">{i.name}</span>
                {i.current && <span className="badge badge-accent">{t('instances.view.active')}</span>}
              </div>
              <div className="meta path">{i.fivemPath ?? t('settings.notFound')}</div>
              <div className="meta">
                {[i.packName ? t('instances.view.pack', { name: i.packName }) : t('instances.view.noPack'), i.mods > 0 && t('instances.view.mods', { count: i.mods })]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <div className="actions">
              {!i.current && (
                <button onClick={() => void run(() => window.api.instanceSwitch(i.id))} disabled={!!task}>
                  {t('instances.view.use')}
                </button>
              )}
              <button className="more" onClick={() => void menu(i)} aria-label={t('instances.view.menu')} title={t('instances.view.menu')}>
                ⋯
              </button>
            </div>
          </li>
        ))}
      </ul>
      {busy && (
        <div className="instance-progress">
          <span className="meta">{busy.title}</span>
          <Progress task={busy} />
        </div>
      )}

      {instances.length > 1 && (
        <>
          <div className="section-head">
            <h2>{t('instances.view.target')}</h2>
          </div>
          <ul className="list">
            <li className="row">
              <div className="row-main">
                <div className="name">{t('instances.view.target')}</div>
                <div className="meta">{t('instances.view.targetHelp')}</div>
              </div>
              <select
                value={settings.packTarget ?? 'active'}
                onChange={(e) => void run(() => window.api.instanceSetPackTarget(e.target.value as 'active' | 'ask'))}
              >
                <option value="active">{t('instances.view.targetActive')}</option>
                <option value="ask">{t('instances.view.targetAsk')}</option>
              </select>
            </li>
          </ul>
        </>
      )}
      <p className="hint">{t('instances.view.gtaNote')}</p>

      {creating && (
        <Modal
          title={t('instances.view.createTitle')}
          onClose={() => setCreating(null)}
          actions={
            <>
              <button className="primary" onClick={() => void create()} disabled={!creating.name.trim() || !creating.parent || !!task}>
                {t('instances.view.create')}
              </button>
              <button onClick={() => setCreating(null)}>{t('common.cancel')}</button>
            </>
          }
        >
          <div className="instance-form">
            <label className="field">
              <span className="field-label">{t('instances.view.name')}</span>
              <input
                className="input"
                data-autofocus
                maxLength={60}
                placeholder="FiveM 2"
                value={creating.name}
                onChange={(e) => setCreating({ ...creating, name: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">{t('instances.view.from')}</span>
              <select value={creating.from} onChange={(e) => setCreating({ ...creating, from: e.target.value })}>
                {instances.map((i) => (
                  <option key={i.id} value={i.id} disabled={!i.fivemPath}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              <span className="field-label">{t('instances.view.destination')}</span>
              <div className="instance-dest">
                <span className="meta path">{creating.parent ? joinPath(creating.parent, creating.name.trim() || 'FiveM 2') : t('settings.notFound')}</span>
                <button onClick={() => void chooseParent()}>{t('instances.view.change')}</button>
              </div>
            </div>
            <label className="instance-check">
              <input type="checkbox" checked={creating.shortcut} onChange={(e) => setCreating({ ...creating, shortcut: e.target.checked })} />
              <span>
                <span>{t('instances.view.shortcutOption')}</span>
                <span className="field-hint">{t('instances.view.shortcutHint')}</span>
              </span>
            </label>
            <p className="field-hint">{t('instances.view.copyHint')}</p>
          </div>
        </Modal>
      )}

      {adding && (
        <Modal
          title={t('instances.view.addTitle')}
          onClose={() => setAdding(null)}
          actions={
            <>
              <button className="primary" onClick={() => void add()} disabled={!adding.name.trim()}>
                {t('common.add')}
              </button>
              <button onClick={() => setAdding(null)}>{t('common.cancel')}</button>
            </>
          }
        >
          <div className="instance-form">
            <label className="field">
              <span className="field-label">{t('instances.view.name')}</span>
              <input
                className="input"
                data-autofocus
                maxLength={60}
                value={adding.name}
                onChange={(e) => setAdding({ ...adding, name: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && adding.name.trim() && void add()}
              />
            </label>
            <div className="field">
              <span className="field-label">{t('instances.view.folder')}</span>
              <span className="meta path">{adding.path}</span>
            </div>
          </div>
        </Modal>
      )}

      {renaming && (
        <Modal
          title={t('instances.view.renameTitle')}
          onClose={() => setRenaming(null)}
          actions={
            <>
              <button className="primary" onClick={() => void rename()} disabled={!renaming.name.trim()}>
                {t('common.save')}
              </button>
              <button onClick={() => setRenaming(null)}>{t('common.cancel')}</button>
            </>
          }
        >
          <label className="field">
            <span className="field-label">{t('instances.view.name')}</span>
            <input
              className="input"
              data-autofocus
              maxLength={60}
              value={renaming.name}
              onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && renaming.name.trim() && void rename()}
            />
          </label>
        </Modal>
      )}
    </div>
  )
}

const parts = (p: string): string[] => p.replace(/[\\/]+$/, '').split(/[\\/]/)

/** Nom proposé pour un dossier existant : celui qui contient FiveM.app. */
function folderName(p: string): string {
  const list = parts(p)
  const last = list[list.length - 1] ?? ''
  return (/^fivem\.app$/i.test(last) ? list[list.length - 2] : last) || 'FiveM'
}

/** Emplacement proposé pour une copie : à côté du dossier FiveM copié (« ...\Local\FiveM\FiveM.app » → « ...\Local »). */
function parentOf(fivemApp: string | null): string {
  if (!fivemApp) return ''
  const list = parts(fivemApp)
  return list.slice(0, /^fivem\.app$/i.test(list[list.length - 1] ?? '') ? -2 : -1).join('\\')
}

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, '')}\\${name.replace(/[<>:"/\\|?*]/g, '')}`
}

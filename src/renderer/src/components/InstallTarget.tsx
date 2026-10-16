import { useCallback, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { PackManifest } from '@shared/types'
import { q } from '../lib/format'
import { useStore } from '../store'
import { Modal } from './Modal'

/** Instance choisie (identifiant), undefined : l'instance active sans rien demander, null : abandon. */
export type InstallTarget = string | undefined | null

/**
 * Instance où installer un pack. Avec plusieurs instances et « Choisir l'instance à chaque installation » (page des
 * instances), une fenêtre demande laquelle ; sinon l'instance active. `picker` : la fenêtre, à afficher dans la page.
 * `always` : demander même dans le mode « instance active » (installer dans une autre instance).
 */
export function useInstallTarget(): { choose: (pack: PackManifest, always?: boolean) => Promise<InstallTarget>; picker: ReactNode } {
  const { t } = useTranslation()
  const { overview } = useStore()
  const [asking, setAsking] = useState<{ pack: PackManifest; resolve: (id: string | null) => void } | null>(null)
  const instances = overview?.instances ?? []
  const ask = overview?.settings.packTarget === 'ask'

  const choose = useCallback(
    (pack: PackManifest, always = false): Promise<InstallTarget> => {
      if (instances.length < 2 || (!ask && !always)) return Promise.resolve(undefined)
      return new Promise((resolve) => setAsking({ pack, resolve }))
    },
    [instances.length, ask]
  )
  const close = (id: string | null): void => {
    asking?.resolve(id)
    setAsking(null)
  }

  const picker = asking && (
    <Modal
      title={t('instances.picker.title', { name: q(asking.pack.name) })}
      onClose={() => close(null)}
      actions={
        <button data-autofocus onClick={() => close(null)}>
          {t('common.cancel')}
        </button>
      }
    >
      <p className="instance-picker-text">{t('instances.picker.text')}</p>
      <div className="instance-picker">
        {instances.map((i) => {
          const already = i.packId === asking.pack.id
          return (
            <button key={i.id} className="instance-choice" onClick={() => close(i.id)} disabled={already}>
              <span className="instance-name">
                <span className="ellipsis">{i.name}</span>
                {i.current && <span className="badge badge-accent">{t('instances.view.active')}</span>}
              </span>
              <span className="meta">
                {already ? t('instances.picker.already') : i.packName ? t('instances.picker.current', { name: i.packName }) : t('instances.picker.none')}
              </span>
            </button>
          )
        })}
      </div>
    </Modal>
  )
  return { choose, picker }
}

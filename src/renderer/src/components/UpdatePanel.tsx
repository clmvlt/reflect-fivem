import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { t } from 'i18next'
import type { UpdateState } from '@shared/types'
import { isChangelogEmpty } from '@shared/changelog'
import { bytes, num } from '../lib/format'
import { useStore } from '../store'
import { WhatsNew } from './WhatsNew'

/**
 * Mise à jour de l'application, en bas de la barre latérale. Tout se fait seul (téléchargement, vérification,
 * installation à la fermeture) : le panneau informe et propose seulement de redémarrer tout de suite.
 */
export function UpdatePanel() {
  const { t } = useTranslation()
  const { update } = useStore()
  const [notesOpen, setNotesOpen] = useState(false)
  if (!update) return null
  // Nouveautés de la version qui arrive, dans la même fenêtre qu'après une mise à jour (fermée sans rien enregistrer).
  // Fenêtre à part du panneau : elle reste ouverte quand le téléchargement passe à la vérification, puis à « prête ».
  const release = update.release && !isChangelogEmpty(update.release.changelog) ? update.release : null
  const notes = release && (
    <button className="link update-notes" onClick={() => setNotesOpen(true)}>
      {t('whatsNew.see')}
    </button>
  )
  return (
    <>
      <Panel update={update} notes={notes} />
      {notesOpen && release && <WhatsNew whatsNew={{ version: release.version, releases: [release] }} onClose={() => setNotesOpen(false)} />}
    </>
  )
}

function Panel({ update, notes }: { update: UpdateState; notes: ReactNode }) {
  const { t } = useTranslation()
  const { run } = useStore()
  const { status, version } = update

  if (status === 'downloading' || status === 'verifying') {
    const verifying = status === 'verifying'
    const percent = Math.min(100, update.percent ?? 0)
    return (
      <div className="update-panel" role="status" aria-live="polite">
        <div className="update-head">
          <span className="update-title">{t('updatePanel.title', { version })}</span>
          {!verifying && <span className="pct">{t('progress.percent', { value: num(percent) })}</span>}
        </div>
        <div
          className="track"
          role="progressbar"
          aria-label={verifying ? t('updatePanel.verifyingLabel') : t('updatePanel.downloadingLabel')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={verifying ? undefined : percent}
        >
          <div className={`fill ${verifying ? 'is-waiting' : ''}`} style={verifying ? undefined : { width: `${percent}%` }} />
        </div>
        <span className="update-sub">{verifying ? t('updatePanel.verifyingSignature') : downloadText(update)}</span>
        {notes}
      </div>
    )
  }
  if (status === 'ready')
    return (
      <div className="update-panel">
        <span>{t('updatePanel.ready', { version })}</span>
        {notes}
        <button className="primary" onClick={() => void run(() => window.api.installUpdate())}>
          {t('updatePanel.restartNow')}
        </button>
      </div>
    )
  if (status === 'available' && update.manual)
    return (
      <div className="update-panel">
        <span>{t('updatePanel.availableSite', { version })}</span>
        {notes}
        <button onClick={() => void run(() => window.api.openSite('/application/'))}>{t('updatePanel.download')}</button>
      </div>
    )
  if (status === 'error')
    return (
      <div className="update-panel">
        <span className="is-bad">{update.error ?? t('updatePanel.failed')}</span>
        <button onClick={() => void run(() => window.api.checkForUpdates())}>{t('common.retry')}</button>
      </div>
    )
  return null
}

/** « 12 Mo sur 85 Mo », ou seulement « Téléchargement… » tant que la taille est inconnue. */
function downloadText(update: UpdateState): string {
  if (!update.total) return t('updatePanel.downloading')
  return t('updatePanel.progress', { done: bytes(update.transferred ?? 0), total: bytes(update.total) })
}

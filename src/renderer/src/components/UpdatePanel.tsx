import { useTranslation } from 'react-i18next'
import { t } from 'i18next'
import type { UpdateState } from '@shared/types'
import { bytes, num } from '../lib/format'
import { useStore } from '../store'

/**
 * Mise à jour de l'application, en bas de la barre latérale. Tout se fait seul (téléchargement, vérification,
 * installation à la fermeture) : le panneau informe et propose seulement de redémarrer tout de suite.
 */
export function UpdatePanel() {
  const { t } = useTranslation()
  const { update, run } = useStore()
  if (!update) return null
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
      </div>
    )
  }
  if (status === 'ready')
    return (
      <div className="update-panel">
        <span>{t('updatePanel.ready', { version })}</span>
        <button className="primary" onClick={() => void run(() => window.api.installUpdate())}>
          {t('updatePanel.restartNow')}
        </button>
      </div>
    )
  if (status === 'available' && update.manual)
    return (
      <div className="update-panel">
        <span>{t('updatePanel.availableSite', { version })}</span>
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

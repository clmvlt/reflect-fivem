import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { q } from '../lib/format'
import { useStore } from '../store'
import { confirmDialog } from './Confirm'

/**
 * Lancer, fermer ou redémarrer FiveM, en bas de la barre latérale. Pack changé pendant une partie : le changement est
 * fait à la fermeture du jeu, d'où le rappel de le redémarrer.
 */
export function GameControl() {
  const { t } = useTranslation()
  const { overview, task, run } = useStore()
  const [busy, setBusy] = useState<'launch' | 'close' | 'restart' | null>(null)
  const running = (overview?.games.runningProcesses.length ?? 0) > 0
  const pending = overview?.game.pending ?? null
  const relaunch = !!overview?.game.relaunch

  // Le jeu vient de démarrer ou de se fermer : l'action est terminée (un redémarrage, quand il est relancé).
  useEffect(() => setBusy((b) => (b === 'restart' && !running ? b : null)), [running])
  // Sans effet visible (FiveM qui se met à jour, lancement refusé...) : le bouton revient au bout d'un moment.
  useEffect(() => {
    if (busy !== 'launch' && busy !== 'restart') return
    const timer = window.setTimeout(() => setBusy(null), busy === 'launch' ? 30_000 : 5 * 60_000)
    return () => window.clearTimeout(timer)
  }, [busy])

  if (!overview?.games.fivem.valid) return null

  const act = async (kind: 'launch' | 'close' | 'restart', fn: () => Promise<unknown>): Promise<void> => {
    setBusy(kind)
    const ok = (await run(() => fn().then(() => true))) === true
    if (!ok || kind === 'close') setBusy(null)
  }
  const close = async (): Promise<void> => {
    const detail = pending ? t('game.closeDetailPending', { title: q(pending.title) }) : t('game.closeDetail')
    if (await confirmDialog(t('game.closeTitle'), detail, t('game.close'))) await act('close', () => window.api.closeGame())
  }
  const restart = async (): Promise<void> => {
    if (await confirmDialog(t('game.restartTitle'), t('game.restartDetail'), t('game.restart')))
      await act('restart', () => window.api.restartGame())
  }

  const playIcon = (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M4 2.5v11a.5.5 0 0 0 .77.42l8.5-5.5a.5.5 0 0 0 0-.84l-8.5-5.5A.5.5 0 0 0 4 2.5z" />
    </svg>
  )

  if (busy === 'restart')
    return (
      <div className="game-panel is-relaunch">
        <div className="game-status">{t('game.restarting')}</div>
      </div>
    )

  if (running && pending)
    return (
      <div className="game-panel is-relaunch" role="status">
        <div className="game-status">
          <span className="game-dot" aria-hidden />
          <span>
            <Trans i18nKey="game.restartToApply" values={{ title: pending.title }} components={{ b: <strong /> }} />
          </span>
        </div>
        <button className="primary game-launch" onClick={() => void restart()} disabled={!!busy}>
          {t('game.restart')}
        </button>
        <div className="game-links">
          <button className="link small" onClick={() => void close()} disabled={!!busy}>
            {t('game.closeOnly')}
          </button>
          <button className="link small" onClick={() => void run(() => window.api.cancelPending())} disabled={!!busy}>
            {t('game.cancelChange')}
          </button>
        </div>
      </div>
    )

  if (running)
    return (
      <div className="game-panel is-running">
        <div className="game-status">
          <span className="game-dot" aria-hidden />
          {t('game.running')}
        </div>
        <button onClick={() => void close()} disabled={!!busy}>
          {busy === 'close' ? t('game.closing') : t('game.close')}
        </button>
      </div>
    )

  // Changement de pack en cours d'installation : pas de lancement avant la fin.
  const switching = !!task && ['apply', 'remove', 'clean', 'stash'].includes(task.kind)
  return (
    <div className={`game-panel ${relaunch ? 'is-relaunch' : ''}`}>
      {relaunch && <div className="game-status">{t('game.relaunchHint')}</div>}
      <button
        className="primary game-launch"
        onClick={() => void act('launch', () => window.api.launchGame())}
        disabled={!!busy || switching}
        title={switching ? t('game.waitSwitch') : undefined}
      >
        {playIcon}
        {busy === 'launch' ? t('game.launching') : relaunch ? t('game.relaunch') : t('game.launch')}
      </button>
    </div>
  )
}

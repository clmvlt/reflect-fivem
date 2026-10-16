import { useState, type ReactNode } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { t } from 'i18next'
import type { Check, GameCandidate, HistoryEntry, RootId, UpdateState } from '@shared/types'
import type { WhatsNew as WhatsNewData } from '@shared/changelog'
import { tm } from '@shared/i18n'
import { formatDateTime } from '@shared/intl'
import { bytes } from '../lib/format'
import { useStore } from '../store'
import { LanguageSelect } from './LanguageSelect'
import { ThemeSelect } from './ThemeSelect'
import { WhatsNew } from './WhatsNew'

const STORE_LABEL: Record<string, string> = { rockstar: 'Rockstar Games Launcher', steam: 'Steam', epic: 'Epic Games' }

/** Actions de l'historique (clés settings.history.action.*). */
const HISTORY_ACTIONS: readonly HistoryEntry['action'][] = ['apply', 'remove', 'capture', 'clean', 'restore', 'import', 'delete', 'cache', 'graphics', 'download', 'mod']

export function SettingsView({ onManageInstances }: { onManageInstances: () => void }) {
  const { t } = useTranslation()
  const { overview, task, update, run } = useStore()
  // Nouveautés de la version lancée, ouvertes à la demande (rien n'est enregistré).
  const [whatsNew, setWhatsNew] = useState<WhatsNewData | null>(null)
  if (!overview) return null
  const { games, settings, state, instances } = overview
  const instance = instances.find((i) => i.current)

  const choose = async (which: RootId): Promise<void> => {
    const current = which === 'fivem' ? games.fivem.path : games.gta.path
    const p = await window.api.pickFolder(which === 'fivem' ? t('settings.pickFivem') : t('settings.pickGta'), current ?? undefined)
    if (p) await run(() => window.api.setGamePath(which, p))
  }
  const moveLibrary = async (): Promise<void> => {
    const p = await window.api.pickFolder(t('settings.libraryDir'), settings.libraryDir)
    if (p) await run(() => window.api.moveLibrary(p))
  }

  const admin = (writable: boolean, p: string | null): string | null => (p && !writable ? t('settings.adminNeeded') : null)
  const fivemInfo = [games.fivem.source, games.fivem.buildNumber && t('settings.build', { build: games.fivem.buildNumber }), admin(games.fivem.writable, games.fivem.path)]
    .filter(Boolean)
    .join(' · ')
  const gtaInfo = [
    games.gta.source,
    games.gta.edition === 'legacy' ? 'Legacy' : games.gta.edition === 'enhanced' ? 'Enhanced' : null,
    STORE_LABEL[games.gta.store],
    games.gta.version && t('settings.gameVersion', { version: games.gta.version }),
    admin(games.gta.writable, games.gta.path)
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t('settings.title')}</h1>
      </header>
      <div className="section-head first">
        <h2>{t('instances.settings.title')}</h2>
      </div>
      <ul className="list">
        <li className="row">
          <div className="row-main">
            <div className="name">{t('instances.settings.current', { name: instance?.name ?? '' })}</div>
            <div className="meta">{t('instances.settings.count', { count: instances.length })}</div>
          </div>
          <div className="actions">
            <button onClick={onManageInstances}>{t('instances.settings.manage')}</button>
          </div>
        </li>
      </ul>

      <div className="section-head">
        <h2>{instances.length > 1 && instance ? t('instances.settings.locations', { name: instance.name }) : t('settings.locations')}</h2>
        <button onClick={() => void run(() => window.api.refreshGames())} disabled={!!task} title="F5">
          {t('settings.detectAgain')}
        </button>
      </div>
      <ul className="list">
        <Row
          label="FiveM"
          path={games.fivem.path}
          info={fivemInfo}
          checks={games.fivem.checks}
          candidates={games.fivemCandidates}
          onUse={(c) => void run(() => window.api.setGamePath('fivem', c.path))}
          actions={
            <>
              {settings.fivemPath && instances.length < 2 && (
                <button onClick={() => void run(() => window.api.setGamePath('fivem', null))}>{t('settings.autoDetect')}</button>
              )}
              {games.fivem.path && <button onClick={() => void run(() => window.api.openPath(games.fivem.path!))}>{t('common.open')}</button>}
              <button onClick={() => void choose('fivem')}>{t('common.change')}</button>
            </>
          }
        />
        <Row
          label="GTA V"
          path={games.gta.path}
          info={gtaInfo}
          checks={games.gta.checks}
          candidates={games.gtaCandidates}
          onUse={(c) => void run(() => window.api.setGamePath('gta', c.path))}
          actions={
            <>
              {settings.gtaPath && <button onClick={() => void run(() => window.api.setGamePath('gta', null))}>{t('settings.autoDetect')}</button>}
              {games.gta.path && <button onClick={() => void run(() => window.api.openPath(games.gta.path!))}>{t('common.open')}</button>}
              <button onClick={() => void choose('gta')}>{t('common.change')}</button>
            </>
          }
        />
        <Row
          label={t('settings.libraryDir')}
          path={settings.libraryDir}
          info=""
          checks={[]}
          candidates={[]}
          actions={
            <>
              <button onClick={() => void run(() => window.api.openPath(settings.libraryDir))}>{t('common.open')}</button>
              <button
                onClick={() => void moveLibrary()}
                disabled={!!task || !!state.active}
                title={state.active ? t('settings.removeActiveFirst') : undefined}
              >
                {t('common.change')}
              </button>
            </>
          }
        />
      </ul>

      {state.history.length > 0 && (
        <>
          <div className="section-head">
            <h2>{t('settings.history.title')}</h2>
          </div>
          <ul className="list compact">
            {state.history.slice(0, 10).map((h, i) => (
              <li key={i} className="row">
                <span className="hist-date">{formatDateTime(h.at, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                <span className="hist-action">{HISTORY_ACTIONS.includes(h.action) ? t(`settings.history.action.${h.action}`) : h.action}</span>
                <span className={`hist-text ${h.ok ? '' : 'is-bad'}`}>{[h.packName, h.msg ? tm(h.msg) : h.summary].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="section-head">
        <h2>{t('settings.app.title')}</h2>
        <div className="actions">
          <button onClick={() => void run(() => window.api.changelogLatest()).then((w) => w && setWhatsNew(w))}>{t('whatsNew.button')}</button>
          {update?.status !== 'unsupported' && (
            <button
              onClick={() => void run(() => window.api.checkForUpdates())}
              disabled={['checking', 'downloading', 'verifying', 'ready'].includes(update?.status ?? '')}
            >
              {t('settings.app.checkUpdate')}
            </button>
          )}
        </div>
      </div>
      {whatsNew && <WhatsNew whatsNew={whatsNew} onClose={() => setWhatsNew(null)} />}
      <ul className="list">
        <li className="row">
          <div className="row-main">
            <div className="name">{t('settings.app.version', { version: overview.version })}</div>
            <div className="meta">{updateText(update)}</div>
            <div className="meta">{t(`settings.mode.${update?.mode ?? 'installer'}`)}</div>
          </div>
          <div className="actions">
            <button onClick={() => void run(() => window.api.openPath(overview.dataDir))}>{t('settings.app.dataDir')}</button>
          </div>
        </li>
        <LanguageSelect />
        <ThemeSelect />
        <li className="row">
          <div className="row-main">
            <div className="name">{t('settings.app.trayTitle')}</div>
            <div className="meta">{t('settings.app.trayHelp')}</div>
          </div>
          <label className="switch">
            <input type="checkbox" checked={settings.closeToTray !== false} onChange={(e) => void run(() => window.api.setCloseToTray(e.target.checked))} />
            <span className="switch-track" />
            <span className="switch-text">{settings.closeToTray !== false ? t('common.enabled') : t('common.disabled')}</span>
          </label>
        </li>
        <li className="row">
          <div className="row-main">
            <div className="name">{t('settings.app.marketplace')}</div>
            <div className="meta path">{overview.apiUrl.replace(/\/api$/, '')}</div>
          </div>
          <div className="actions">
            <button onClick={() => void run(() => window.api.openSite('/'))}>{t('settings.app.openSite')}</button>
          </div>
        </li>
      </ul>
    </div>
  )
}

function updateText(update: UpdateState | null): string {
  if (!update) return ''
  const version = update.version ?? ''
  const percent = update.percent ?? 0
  switch (update.status) {
    case 'unsupported':
      return t('settings.update.unsupported')
    case 'checking':
      return t('settings.update.checking')
    case 'available':
      return update.manual ? t('settings.update.availableSite', { version }) : t('settings.update.available', { version })
    case 'downloading':
      return update.total
        ? t('settings.update.downloadingSize', { version, done: bytes(update.transferred ?? 0), total: bytes(update.total), percent })
        : t('settings.update.downloading', { version, percent })
    case 'verifying':
      return t('settings.update.verifying', { version })
    case 'ready':
      return t('settings.update.ready', { version })
    case 'error':
      return update.error ?? t('settings.update.error')
    case 'none':
      return update.checkedAt
        ? t('settings.update.upToDateAt', { time: formatDateTime(update.checkedAt, { hour: '2-digit', minute: '2-digit' }) })
        : t('settings.update.upToDate')
    default:
      return ''
  }
}

function Row({
  label,
  path,
  info,
  checks,
  candidates,
  onUse,
  actions
}: {
  label: string
  path: string | null
  info: string
  checks: Check[]
  candidates: GameCandidate[]
  onUse?: (c: GameCandidate) => void
  actions: ReactNode
}) {
  const { t } = useTranslation()
  // Le manque de droits d'écriture n'est pas une erreur : Windows demandera l'autorisation.
  const failed = checks.filter((c) => !c.ok && c.id !== 'writable' && c.id !== 'exists')
  const others = candidates.filter((c) => c.path.toLowerCase() !== (path ?? '').toLowerCase())
  return (
    <li className="row top">
      <div className="row-main">
        <div className="name">{label}</div>
        <div className="meta path">{path ?? t('settings.notFound')}</div>
        {info && <div className="meta">{info}</div>}
        {failed.map((c, i) => (
          <div key={i} className="meta is-bad">
            {c.detail ?? c.label}
          </div>
        ))}
        {others.map((c) => (
          <div key={c.path} className="meta other">
            <Trans i18nKey="settings.otherInstall" values={{ path: c.path }} components={{ path: <span className="path" /> }} />{' '}
            <button className="link" onClick={() => onUse?.(c)}>
              {t('settings.use')}
            </button>
          </div>
        ))}
      </div>
      <div className="actions">{actions}</div>
    </li>
  )
}

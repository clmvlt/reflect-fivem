// Page « Optimisations » : réglages du jeu et de Windows pour les PC modestes, appliqués en un clic (tous les
// recommandés, ou un par un) et annulables, puis ce qu'il reste à vérifier soi-même (voir @shared/optimizations).
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  OPTIMIZATION_GROUPS,
  OPTIMIZATIONS,
  recommendedToApply,
  undoableIds,
  type CheckState,
  type OptimizationDef,
  type OptimizationId,
  type OptimizationsOverview,
  type OptimizationsResult,
  type OptimizationState
} from '@shared/optimizations'
import { estimate, installedPerformance } from '@shared/performance'
import { useStore } from '../store'
import { q } from '../lib/format'
import { confirmDialog } from './Confirm'
import { usePerformance, usePerformanceDetail } from './Performance'

export function Optimizations({ onOpenPage }: { onOpenPage: (page: 'market') => void }) {
  const { t, i18n } = useTranslation()
  const { overview, run, setMessage } = useStore()
  const [state, setState] = useState<OptimizationsOverview | null | undefined>(undefined)
  // Optimisations en cours d'application ou d'annulation.
  const [busy, setBusy] = useState<Set<OptimizationId>>(new Set())
  const running = (overview?.games.runningProcesses.length ?? 0) > 0

  const load = useCallback(async () => {
    const s = await run(() => window.api.optimizationsGet())
    setState(s ?? null)
  }, [run])

  // Relue à l'ouverture, au changement de langue (textes du processus principal) et quand FiveM est lancé ou fermé.
  useEffect(() => {
    void load()
  }, [load, i18n.language, running])

  const title = (id: OptimizationId): string => t(`optimizations.items.${id}.title`)

  /** Message de fin : ce qui a été fait, ce qui reste à faire (relancer le jeu, redémarrer le PC), les échecs. */
  const report = (r: OptimizationsResult, ids: OptimizationId[], before: OptimizationState[], revert: boolean): void => {
    const changed = revert ? r.done : r.done.filter((id) => r.overview.items.find((i) => i.id === id)?.undoable && before.find((i) => i.id === id)?.status !== 'on')
    const lines: string[] = []
    if (changed.length) {
      lines.push(t(revert ? 'optimizations.result.reverted' : 'optimizations.result.applied', { count: changed.length }))
      if (!r.reboot && changed.some((id) => id !== 'priority')) lines.push(t('optimizations.result.nextLaunch'))
    } else if (!r.failed.length && ids.length) lines.push(t('optimizations.result.already'))
    if (r.reboot) lines.push(t('optimizations.result.reboot'))
    for (const f of r.failed) lines.push(t('optimizations.result.failed', { name: title(f.id), error: f.error }))
    if (lines.length) setMessage({ kind: r.failed.length && !changed.length ? 'error' : 'info', text: lines.join('\n') })
  }

  const act = async (ids: OptimizationId[], revert: boolean): Promise<void> => {
    if (!ids.length || !state) return
    setBusy(new Set(ids))
    const before = state.items
    const r = await run(() => (revert ? window.api.optimizationsRevert(ids) : window.api.optimizationsApply(ids)))
    setBusy(new Set())
    if (!r) return void load()
    setState(r.overview)
    report(r, ids, before, revert)
  }

  const revertAll = async (): Promise<void> => {
    if (!state) return
    const ok = await confirmDialog(t('optimizations.revertConfirm.title'), t('optimizations.revertConfirm.message'), t('optimizations.revertConfirm.confirm'))
    if (ok) await act(undoableIds(state.items), true)
  }

  // Clé « ready » : la page lue remplace la page vide par une nouvelle, animée à son arrivée.
  if (state === undefined)
    return (
      <div className="page">
        <header className="page-head">
          <h1>{t('optimizations.title')}</h1>
        </header>
        <p className="empty">{t('optimizations.loading')}</p>
      </div>
    )
  if (state === null)
    return (
      <div className="page" key="ready">
        <header className="page-head">
          <h1>{t('optimizations.title')}</h1>
          <div className="spacer" />
          <button onClick={() => void load()}>{t('common.refresh')}</button>
        </header>
      </div>
    )

  const items = state.items
  const applicable = items.filter((i) => i.status !== 'na')
  const inPlace = applicable.filter((i) => i.status === 'on' || i.status === 'native').length
  const toApply = recommendedToApply(items).filter((id) => !(OPTIMIZATIONS.find((d) => d.id === id)!.gameClosed && running))
  const toRevert = undoableIds(items)
  const working = busy.size > 0
  const adminNeeded = toApply.some((id) => OPTIMIZATIONS.find((d) => d.id === id)!.admin)

  return (
    <div className="page" key="ready">
      <header className="page-head">
        <h1>{t('optimizations.title')}</h1>
        <span className="page-note">{t('optimizations.summary', { on: inPlace, total: applicable.length })}</span>
        <div className="spacer" />
        <button onClick={() => void load()} disabled={working}>
          {t('common.refresh')}
        </button>
      </header>

      <p className="opt-intro">{t('optimizations.intro')}</p>

      {running && (
        <div className="bar bar-warning">
          <span className="bar-text">{t('optimizations.closeGame')}</span>
        </div>
      )}

      <div className="opt-all">
        <div className="row-main">
          <div className="meta meta-wrap">{toApply.length ? t('optimizations.applyAllHint') : t('optimizations.applyAllNone')}</div>
          {adminNeeded && <div className="meta meta-wrap">{t('optimizations.adminNote')}</div>}
        </div>
        <div className="actions">
          <button onClick={() => void revertAll()} disabled={working || !toRevert.length}>
            {t('optimizations.revertAll')}
          </button>
          <button className="primary" onClick={() => void act(toApply, false)} disabled={working || !toApply.length}>
            {t('optimizations.applyAll')}
          </button>
        </div>
      </div>

      {OPTIMIZATION_GROUPS.map((group) => (
        <section key={group}>
          <div className="section-head">
            <h2>{t(`optimizations.groups.${group}`)}</h2>
          </div>
          <ul className="list">
            {OPTIMIZATIONS.filter((d) => d.group === group).map((def) => {
              const item = items.find((i) => i.id === def.id)
              if (!item) return null
              return (
                <OptimizationRow
                  key={def.id}
                  def={def}
                  item={item}
                  busy={busy.has(def.id)}
                  locked={working || (!!def.gameClosed && running)}
                  onApply={() => void act([def.id], false)}
                  onRevert={() => void act([def.id], true)}
                />
              )
            })}
          </ul>
        </section>
      ))}

      <section>
        <div className="section-head">
          <h2>{t('optimizations.checks.title')}</h2>
        </div>
        <p className="hint opt-checks-intro">{t('optimizations.checks.intro')}</p>
        <ul className="list">
          <PackCheck onBrowse={() => onOpenPage('market')} />
          {state.checks.map((c) => (
            <CheckRow key={c.id} check={c} />
          ))}
        </ul>
      </section>
    </div>
  )
}

function OptimizationRow({
  def,
  item,
  busy,
  locked,
  onApply,
  onRevert
}: {
  def: OptimizationDef
  item: OptimizationState
  busy: boolean
  locked: boolean
  onApply: () => void
  onRevert: () => void
}) {
  const { t } = useTranslation()
  const on = item.status === 'on' || item.status === 'native'
  // Déjà en place sans l'application, ou sans objet sur ce PC : rien à changer ici.
  const fixed = item.status === 'native' || item.status === 'na'
  return (
    <li className={`row top opt-row ${item.status === 'na' ? 'is-na' : ''}`}>
      <div className="row-main">
        <div className="opt-head">
          <span className="name">{t(`optimizations.items.${def.id}.title`)}</span>
          <span className={`badge opt-gain g-${def.gain}`}>{t(`optimizations.gain.${def.gain}`)}</span>
          {def.optional && <span className="badge">{t('optimizations.badge.optional')}</span>}
          {def.admin && <span className="badge">{t('optimizations.badge.admin')}</span>}
          {def.reboot && <span className="badge">{t('optimizations.badge.reboot')}</span>}
        </div>
        <div className="meta meta-wrap">{t(`optimizations.items.${def.id}.text`)}</div>
        <div className="meta meta-wrap opt-tradeoff">{t(`optimizations.items.${def.id}.tradeoff`)}</div>
        <div className={`opt-status s-${item.status}`}>
          {t(`optimizations.status.${item.status}`)}
          {item.note ? ` · ${item.note}` : ''}
        </div>
      </div>
      <div className="opt-control">
        <label className="switch opt-switch" title={t(`optimizations.status.${item.status}`)}>
          <input
            type="checkbox"
            checked={on}
            disabled={fixed || locked || busy}
            onChange={() => (item.status === 'on' ? onRevert() : onApply())}
            aria-label={t(`optimizations.items.${def.id}.title`)}
          />
          <span className="switch-track" />
        </label>
        {/* Changée par l'application mais plus entièrement en place (ou plus applicable) : annulable à part. */}
        {(item.status === 'partial' || item.status === 'na') && item.undoable && (
          <button onClick={onRevert} disabled={locked || busy}>
            {t('optimizations.undo')}
          </button>
        )}
      </div>
    </li>
  )
}

function CheckRow({ check }: { check: CheckState }) {
  const { t } = useTranslation()
  const { run } = useStore()
  // Constat calculé par le processus principal, sinon texte fixe de la vérification.
  const id = check.id
  const text = check.detail ?? (id === 'single-channel' || id === 'overlays' || id === 'startup' ? t(`optimizations.checks.${id}.text`) : '')
  return (
    <li className="row top opt-row">
      <div className="row-main">
        <div className="opt-head">
          <span className="name">{t(`optimizations.checks.${check.id}.title`)}</span>
          <span className={`opt-level l-${check.level}`}>{t(`optimizations.checks.level.${check.level}`)}</span>
        </div>
        <div className="meta meta-wrap">{text}</div>
      </div>
      {check.link && (
        <div className="actions">
          <button onClick={() => void run(() => window.api.optimizationsOpen(check.link!))}>{t(`optimizations.checks.links.${check.link}`)}</button>
        </div>
      )}
    </li>
  )
}

/**
 * Pack graphique installé, comparé à la machine : ReShade et ENB sont ce qui coûte le plus. Poids connu pour les packs
 * de la Marketplace (analyse de l'API), avec le preset et les éléments choisis.
 */
function PackCheck({ onBrowse }: { onBrowse: () => void }) {
  const { t } = useTranslation()
  const { overview, task, changeGame } = useStore()
  const ctx = usePerformance()
  const active = overview?.state.active ?? null
  const pack = active ? overview?.library.find((p) => p.id === active.packId) : undefined
  const marketId = pack?.marketplace && pack.marketplace.kind !== 'mod' ? pack.marketplace.id : null
  const detail = usePerformanceDetail(marketId, 'pack')
  if (!overview) return null

  const name = q(pack?.name ?? active?.packName ?? '')
  let level: CheckState['level'] = 'ok'
  let text = t('optimizations.checks.pack.none')
  if (active) {
    const perf =
      pack && detail?.report ? installedPerformance(detail.report, { preset: pack.reshadePreset, components: pack.components.filter((c) => c.enabled && c.destination).map((c) => c.source) }) : null
    const verdict = perf && ctx ? estimate(ctx.profile.model, ctx.machine, perf).verdict : null
    if (verdict === 'too-heavy') {
      level = 'warn'
      text = t('optimizations.checks.pack.heavy', { pack: name })
    } else if (verdict === 'playable') {
      level = 'info'
      text = t('optimizations.checks.pack.playable', { pack: name })
    } else if (verdict === 'smooth') text = t('optimizations.checks.pack.smooth', { pack: name })
    else {
      level = 'info'
      text = t('optimizations.checks.pack.unknown', { pack: name })
    }
  }

  return (
    <li className="row top opt-row">
      <div className="row-main">
        <div className="opt-head">
          <span className="name">{t('optimizations.checks.pack.title')}</span>
          <span className={`opt-level l-${level}`}>{t(`optimizations.checks.level.${level}`)}</span>
        </div>
        <div className="meta meta-wrap">{text}</div>
      </div>
      {active && level !== 'ok' && (
        <div className="actions">
          <button onClick={onBrowse}>{t('optimizations.checks.pack.browse')}</button>
          <button onClick={() => void changeGame(() => window.api.removeActive())} disabled={!!task}>
            {t('optimizations.checks.pack.remove')}
          </button>
        </div>
      )}
    </li>
  )
}

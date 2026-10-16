import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { t as translate } from 'i18next'
import {
  GRAPHICS_GROUP_LABEL,
  GRAPHICS_GROUPS,
  GRAPHICS_PRESETS,
  GRAPHICS_SETTINGS,
  recommendationsFor,
  unmet,
  type GraphicsSettingDef,
  type GraphicsState,
  type GraphicsTarget
} from '@shared/graphics'
import { formatNumber } from '@shared/intl'
import { useStore } from '../store'
import { num, q } from '../lib/format'
import { MachinePanel } from './Performance'
import { confirmDialog } from './Confirm'

function displayRange(def: GraphicsSettingDef, v: string): string {
  const n = Number(v)
  if ((def.max ?? 1) <= 1) return formatNumber(Math.round(n * 100) / 100, { style: 'percent', maximumFractionDigits: 0 })
  return translate('graphics.multiplier', { value: formatNumber(n, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
}

export function Graphics() {
  const { t, i18n } = useTranslation()
  const { overview, run, setMessage } = useStore()
  const [state, setState] = useState<GraphicsState | null | undefined>(undefined)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const load = useCallback(
    async (target?: GraphicsTarget['id']) => {
      const s = await run(() => window.api.getGraphics(target))
      setState(s ?? null)
      setDraft(s?.values ?? {})
    },
    [run]
  )

  useEffect(() => {
    void load()
  }, [load])

  const changes = useMemo(() => {
    if (!state) return {}
    // « 1.000000 » et « 1 » sont la même valeur : seules les vraies différences comptent.
    const same = (a: string, b: string): boolean => a === b || (!Number.isNaN(Number(a)) && !Number.isNaN(Number(b)) && Number(a) === Number(b))
    return Object.fromEntries(Object.entries(draft).filter(([k, v]) => state.values[k] !== undefined && !same(v, state.values[k])))
  }, [draft, state])
  const count = Object.keys(changes).length

  const active = overview?.state.active ?? null
  const activePack = active ? overview?.library.find((p) => p.id === active.packId) : null
  // Raisons traduites à l'appel : recalculées au changement de langue.
  const recos = useMemo(() => unmet(recommendationsFor(activePack?.features ?? []), draft), [activePack, draft, i18n.language])
  const running = (overview?.games.runningProcesses.length ?? 0) > 0

  // Clé « ready » : la page lue remplace la page vide par une nouvelle, animée à son arrivée.
  if (state === undefined) return <div className="page" />
  if (state === null)
    return (
      <div className="page" key="ready">
        <header className="page-head">
          <h1>{t('graphics.title')}</h1>
        </header>
        <p className="empty">{t('graphics.notFound')}</p>
        <FpsLimit />
        <MachinePanel />
      </div>
    )

  const set = (key: string, value: string): void => setDraft((d) => ({ ...d, [key]: value }))
  const applyValues = (values: Record<string, string>): void => setDraft((d) => ({ ...d, ...Object.fromEntries(Object.entries(values).filter(([k]) => d[k] !== undefined)) }))

  const save = async (): Promise<void> => {
    setSaving(true)
    const s = await run(() => window.api.saveGraphics(state.target.id, changes))
    setSaving(false)
    if (s) {
      setState(s)
      setDraft(s.values)
      setMessage({ kind: 'info', text: t('graphics.saved', { game: state.target.label }) })
    }
  }
  const restore = async (): Promise<void> => {
    const ok = await confirmDialog(t('graphics.restore.title'), t('graphics.restore.message'), t('graphics.restore.confirm'))
    if (!ok) return
    const s = await run(() => window.api.restoreGraphics(state.target.id))
    if (s) {
      setState(s)
      setDraft(s.values)
    }
  }

  return (
    <div className="page with-savebar" key="ready">
      <header className="page-head">
        <h1>{t('graphics.title')}</h1>
        <span className="page-note">{[state.videoCard, state.resolution].filter(Boolean).join(' · ')}</span>
        <div className="spacer" />
        {state.targets.length > 1 && (
          <select value={state.target.id} onChange={(e) => void load(e.target.value as GraphicsTarget['id'])} aria-label={t('graphics.game')}>
            {state.targets.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
        )}
      </header>

      {running && (
        <div className="bar bar-warning">
          <span className="bar-text">{t('graphics.closeGame')}</span>
        </div>
      )}

      {activePack && recos.length > 0 && (
        <div className="bar">
          <span className="bar-text">{t('graphics.recommend', { pack: q(activePack.name), list: recos.map((r) => r.reason).join(', ') })}</span>
          <button onClick={() => applyValues(Object.fromEntries(recos.map((r) => [r.key, r.value])))}>{t('common.apply')}</button>
        </div>
      )}

      <div className="presets">
        <span className="muted">{t('graphics.presets')}</span>
        {GRAPHICS_PRESETS.map((p) => (
          <button key={p.id} onClick={() => applyValues(p.values)}>
            {p.label}
          </button>
        ))}
      </div>

      <FpsLimit />
      <MachinePanel />

      {GRAPHICS_GROUPS.map((group) => {
        const defs = GRAPHICS_SETTINGS.filter((d) => d.group === group && draft[d.key] !== undefined)
        if (!defs.length) return null
        return (
          <section key={group}>
            <div className="section-head">
              <h2>{GRAPHICS_GROUP_LABEL[group]}</h2>
            </div>
            <ul className="list settings-list">
              {defs.map((d) => (
                <li key={d.key} className={`row ${d.key in changes ? 'is-changed' : ''}`}>
                  <span className="row-main">{d.label}</span>
                  <Control def={d} value={draft[d.key]} onChange={(v) => set(d.key, v)} />
                </li>
              ))}
            </ul>
          </section>
        )
      })}

      <div className="gfx-foot">
        <span className="meta path">{state.target.path}</span>
        {state.readOnly && <span className="meta">{t('graphics.readOnly')}</span>}
        <div className="actions">
          <button onClick={() => void run(() => window.api.openPath(state.target.path.replace(/[\\/][^\\/]+$/, '')))}>{t('graphics.openFolder')}</button>
          {state.hasBackup && <button onClick={() => void restore()}>{t('graphics.restore.button')}</button>}
        </div>
      </div>

      {count > 0 && (
        <div className="savebar">
          <span>{t('graphics.changes', { count })}</span>
          <div className="spacer" />
          <button onClick={() => setDraft(state.values)} disabled={saving}>
            {t('common.cancel')}
          </button>
          <button className="primary" onClick={() => void save()} disabled={saving || running}>
            {t('common.save')}
          </button>
        </div>
      )}
    </div>
  )
}

const FPS_CHOICES = [60, 90, 120, 144, 165, 240]

/**
 * Limite d'images par seconde : FiveM n'en a pas, elle passe par le limiteur de l'ENB du pack (enblocal.ini). Le choix
 * est retenu pour toutes les installations et appliqué tout de suite au pack installé.
 */
function FpsLimit() {
  const { t } = useTranslation()
  const { overview, run, setMessage } = useStore()
  const [busy, setBusy] = useState(false)
  if (!overview) return null
  const limit = overview.settings.fpsLimit ?? null
  const active = overview.state.active
  const packName = active?.packName ?? null
  const hasEnb = !!active?.files.some((f) => /(^|\/)enblocal\.ini$/i.test(f.path))
  const value = limit === null ? 'pack' : String(limit)

  const change = async (v: string): Promise<void> => {
    const next = v === 'pack' ? null : Number(v)
    setBusy(true)
    const updated = await run(() => window.api.setFpsLimit(next))
    setBusy(false)
    if (updated === undefined) return
    const what = next === null ? 'pack' : next === 0 ? 'none' : 'max'
    const n = next ? num(next) : ''
    setMessage({
      kind: 'info',
      text: updated && packName ? t(`graphics.fps.savedPack.${what}`, { pack: packName, n }) : t(`graphics.fps.savedAll.${what}`, { n })
    })
  }

  const note = !active
    ? t('graphics.fps.noteNoPack')
    : hasEnb
      ? t('graphics.fps.noteEnb', { pack: q(packName ?? '') })
      : t('graphics.fps.noteNoEnb', { pack: q(packName ?? '') })

  return (
    <section>
      <div className="section-head">
        <h2>{t('graphics.fps.title')}</h2>
      </div>
      <ul className="list settings-list">
        <li className="row">
          <div className="row-main">
            <div>{t('graphics.fps.label')}</div>
            <div className="meta meta-wrap">{note}</div>
          </div>
          <select value={value} onChange={(e) => void change(e.target.value)} disabled={busy} aria-label={t('graphics.fps.label')}>
            <option value="pack">{t('graphics.fps.pack')}</option>
            <option value="0">{t('graphics.fps.none')}</option>
            {limit !== null && limit > 0 && !FPS_CHOICES.includes(limit) && <option value={String(limit)}>{t('graphics.fps.value', { n: num(limit) })}</option>}
            {FPS_CHOICES.map((c) => (
              <option key={c} value={String(c)}>
                {t('graphics.fps.value', { n: num(c) })}
              </option>
            ))}
          </select>
        </li>
      </ul>
    </section>
  )
}

function Control({ def, value, onChange }: { def: GraphicsSettingDef; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation()
  if (def.kind === 'bool')
    return (
      <label className="switch">
        <input type="checkbox" checked={value === 'true'} onChange={(e) => onChange(e.target.checked ? 'true' : 'false')} />
        <span className="switch-track" />
        <span className="switch-text">{value === 'true' ? t('common.enabled') : t('common.disabled')}</span>
      </label>
    )
  if (def.kind === 'range')
    return (
      <div className="range">
        <input type="range" min={def.min} max={def.max} step={def.step} value={Number(value)} onChange={(e) => onChange(e.target.value)} />
        <span className="range-value">{displayRange(def, value)}</span>
      </div>
    )
  const known = def.options?.some((o) => o.value === value)
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {!known && <option value={value}>{t('graphics.custom', { value })}</option>}
      {def.options?.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

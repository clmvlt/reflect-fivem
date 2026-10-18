// Réglages du preset ReShade choisi dans « Créer ton pack » : réglages simples (curseurs centrés sur le preset tel
// quel, interrupteurs, listes, couleurs), puis, repliés, les effets du preset et les paramètres de chaque effet. Seul
// ce que le joueur change est gardé dans la création.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BuilderControl, BuilderEffect, BuilderParam, BuilderPreset, BuilderReshade, BuilderTechnique } from '@shared/types'
import { costOnMachine } from '@shared/performance'
import { formatNumber } from '@shared/intl'
import {
  componentCount,
  controlValue,
  emptyReshade,
  fromHex,
  numbers,
  paramKind,
  paramStep,
  paramValue,
  presetValue,
  setControl,
  setParam,
  setTechnique,
  techniqueEnabled,
  toHex
} from '../lib/builder'
import { msText, usePerformance } from './Performance'

interface Props {
  preset: BuilderPreset | null
  /** Nom du preset choisi. */
  name: string
  error: string | null
  onRetry: () => void
  reshade: BuilderReshade
  onChange: (next: BuilderReshade) => void
}

export function ReshadePanel({ preset, name, error, onRetry, reshade, onChange }: Props) {
  const { t } = useTranslation()
  if (error)
    return (
      <div className="bar bar-error">
        <span className="bar-text">{error}</span>
        <button onClick={onRetry}>{t('common.retry')}</button>
      </div>
    )
  if (!preset) return <p className="muted loading">{t('common.loading')}</p>

  // Réglages simples regroupés (Image, Effets, QuantV), dans l'ordre de l'API.
  const groups: { key: string; label: string; controls: BuilderControl[] }[] = []
  for (const c of preset.controls) {
    const group = groups.find((g) => g.key === c.group) ?? groups[groups.push({ key: c.group, label: c.groupLabel || c.group, controls: [] }) - 1]
    group.controls.push(c)
  }
  const changed = reshadeChanges(reshade)
  const advanced = changed - Object.keys(reshade.controls).length

  return (
    <section className="reshade-panel">
      <div className="section-head first">
        <h2>{t('builder.reshade.title', { name })}</h2>
        <button onClick={() => onChange(emptyReshade())} disabled={!changed}>
          {t('builder.reshade.resetAll')}
        </button>
      </div>
      <p className="hint">{t('builder.reshade.intro')}</p>
      {groups.length ? (
        groups.map((g) => (
          <div key={g.key} className="reshade-group">
            <h3>{g.label}</h3>
            <ul className="list settings-list">
              {g.controls.map((c) => (
                <ControlRow key={c.key} control={c} reshade={reshade} onChange={onChange} />
              ))}
            </ul>
          </div>
        ))
      ) : (
        <p className="muted">{t('builder.reshade.noControls')}</p>
      )}

      <details className="reshade-advanced" open={advanced > 0 || undefined}>
        <summary>
          {t('builder.reshade.advanced')}
          {advanced > 0 && <span className="chip-count">{formatNumber(advanced)}</span>}
        </summary>
        <p className="hint">{t('builder.reshade.advancedHint')}</p>
        {preset.techniques.length > 0 && (
          <div className="reshade-group">
            <h3>{t('builder.reshade.effects')}</h3>
            <ul className="list settings-list">
              {preset.techniques.map((tq) => (
                <TechniqueRow key={tq.name} technique={tq} reshade={reshade} onChange={onChange} />
              ))}
            </ul>
          </div>
        )}
        {preset.effects.map((e) => (
          <EffectParams key={e.file} effect={e} reshade={reshade} onChange={onChange} />
        ))}
      </details>
    </section>
  )
}

/** Nombre de réglages ReShade changés par le joueur (simples et avancés). */
export function reshadeChanges(reshade: BuilderReshade): number {
  return Object.keys(reshade.controls).length + Object.keys(reshade.techniques).length + Object.values(reshade.values).reduce((s, v) => s + Object.keys(v).length, 0)
}

/** « +20 », « −15 », « 0 ». */
function signed(v: number): string {
  return v > 0 ? `+${formatNumber(v)}` : v < 0 ? `−${formatNumber(-v)}` : formatNumber(0)
}

function ControlRow({ control, reshade, onChange }: { control: BuilderControl; reshade: BuilderReshade; onChange: (next: BuilderReshade) => void }) {
  const { t } = useTranslation()
  const value = controlValue(control, reshade)
  const changed = reshade.controls[control.key] !== undefined
  const set = (v: BuilderControl['value']): void => onChange(setControl(reshade, control, v))
  let input
  if (control.type === 'slider') {
    const v = typeof value === 'number' ? value : 0
    input = (
      <div className="range builder-slider">
        <input
          type="range"
          min={control.min ?? -100}
          max={control.max ?? 100}
          step={control.step ?? 1}
          value={v}
          onChange={(e) => set(Number(e.target.value))}
          aria-label={control.label}
        />
        <span className="range-value">{signed(v)}</span>
      </div>
    )
  } else if (control.type === 'toggle') {
    input = (
      <label className="switch">
        <input type="checkbox" checked={value === true} onChange={(e) => set(e.target.checked)} aria-label={control.label} />
        <span className="switch-track" />
        <span className="switch-text">{value === true ? t('common.enabled') : t('common.disabled')}</span>
      </label>
    )
  } else if (control.type === 'select') {
    input = (
      <select value={typeof value === 'string' ? value : ''} onChange={(e) => set(e.target.value)} aria-label={control.label}>
        {typeof value !== 'string' && <option value="" />}
        {control.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )
  } else {
    input = (
      <input
        type="color"
        className="color-input"
        value={typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'}
        onChange={(e) => set(e.target.value)}
        aria-label={control.label}
      />
    )
  }
  return (
    <li className={`row reshade-row ${changed ? 'is-changed' : ''}`}>
      <div className="row-main" title={control.description || undefined}>
        <div>{control.label}</div>
      </div>
      {input}
      <button className="link reset-link" onClick={() => set(null)} disabled={!changed}>
        {t('builder.reshade.default')}
      </button>
    </li>
  )
}

function TechniqueRow({ technique, reshade, onChange }: { technique: BuilderTechnique; reshade: BuilderReshade; onChange: (next: BuilderReshade) => void }) {
  const { t } = useTranslation()
  const ctx = usePerformance()
  const on = techniqueEnabled(technique.name, technique.enabled, reshade)
  const ms = ctx ? costOnMachine(ctx.profile.model, ctx.machine, technique.costMs) : technique.costMs
  // Coût négligeable sur ce PC : son niveau seulement.
  const cost = ms >= 0.05 ? t('builder.reshade.cost', { label: technique.costLabel, ms: msText(ms) }) : technique.costLabel
  const [label] = technique.name.split('@')
  return (
    <li className={`row reshade-row ${on !== technique.enabled ? 'is-changed' : ''}`}>
      <div className="row-main">
        <div>{label}</div>
        <div className="meta">{[technique.effect, cost].filter(Boolean).join(' · ')}</div>
      </div>
      <label className="switch">
        <input type="checkbox" checked={on} onChange={(e) => onChange(setTechnique(reshade, technique.name, technique.enabled, e.target.checked))} aria-label={label} />
        <span className="switch-track" />
        <span className="switch-text">{on ? t('common.enabled') : t('common.disabled')}</span>
      </label>
    </li>
  )
}

/** Paramètres d'un fichier d'effet, regroupés par catégorie (ui_category), repliés. */
function EffectParams({ effect, reshade, onChange }: { effect: BuilderEffect; reshade: BuilderReshade; onChange: (next: BuilderReshade) => void }) {
  const { t } = useTranslation()
  const groups: [string, BuilderParam[]][] = []
  for (const p of effect.params) {
    const key = p.category ?? ''
    const group = groups.find(([k]) => k === key) ?? groups[groups.push([key, []]) - 1]
    group[1].push(p)
  }
  const changed = Object.keys(reshade.values[effect.file] ?? {}).length
  return (
    <details className="reshade-effect" open={changed > 0 || undefined}>
      <summary>
        <span className="reshade-file">{effect.file}</span>
        <span className="muted small">{t('builder.reshade.paramCount', { count: effect.params.length, n: formatNumber(effect.params.length) })}</span>
        {changed > 0 && <span className="chip-count">{formatNumber(changed)}</span>}
      </summary>
      {groups.map(([category, params]) => (
        <div key={category} className="reshade-category">
          {category && <div className="reshade-category-name">{category}</div>}
          <ul className="list settings-list">
            {params.map((p) => (
              <ParamRow key={p.name} file={effect.file} param={p} reshade={reshade} onChange={onChange} />
            ))}
          </ul>
        </div>
      ))}
    </details>
  )
}

function ParamRow({ file, param, reshade, onChange }: { file: string; param: BuilderParam; reshade: BuilderReshade; onChange: (next: BuilderReshade) => void }) {
  const { t } = useTranslation()
  const value = paramValue(file, param, reshade)
  const changed = reshade.values[file]?.[param.name] !== undefined
  const set = (v: string | null): void => onChange(setParam(reshade, file, param, v))
  const label = param.label || param.name
  return (
    <li className={`row reshade-row ${changed ? 'is-changed' : ''}`}>
      <div className="row-main" title={param.tooltip ?? undefined}>
        <div>{label}</div>
        {param.label && <div className="meta">{param.name}</div>}
      </div>
      <ParamInput param={param} value={value} label={label} onSet={set} />
      <button className="link reset-link" onClick={() => set(null)} disabled={!changed} title={t('builder.reshade.presetValueTitle', { value: presetValue(param) || '—' })}>
        {t('builder.reshade.presetValue')}
      </button>
    </li>
  )
}

function ParamInput({ param, value, label, onSet }: { param: BuilderParam; value: string; label: string; onSet: (v: string) => void }) {
  const { t } = useTranslation()
  const kind = paramKind(param)
  if (kind === 'bool') {
    const on = value.trim() === '1' || value.trim().toLowerCase() === 'true'
    return (
      <label className="switch">
        <input type="checkbox" checked={on} onChange={(e) => onSet(e.target.checked ? '1' : '0')} aria-label={label} />
        <span className="switch-track" />
        <span className="switch-text">{on ? t('common.enabled') : t('common.disabled')}</span>
      </label>
    )
  }
  if (kind === 'combo') {
    const current = Math.round(numbers(value)?.[0] ?? 0)
    return (
      <select value={current} onChange={(e) => onSet(e.target.value)} aria-label={label}>
        {current >= param.items.length && <option value={current}>{formatNumber(current)}</option>}
        {param.items.map((item, i) => (
          <option key={i} value={i}>
            {item}
          </option>
        ))}
      </select>
    )
  }
  if (kind === 'slider') {
    const v = numbers(value)?.[0] ?? param.min ?? 0
    const integer = /^u?int$/.test(param.type ?? '')
    return (
      <div className="range builder-slider">
        <input
          type="range"
          min={param.min!}
          max={param.max!}
          step={paramStep(param)}
          value={v}
          onChange={(e) => onSet(integer ? String(Math.round(Number(e.target.value))) : e.target.value)}
          aria-label={label}
        />
        <span className="range-value">{formatNumber(v, { maximumFractionDigits: integer ? 0 : 3 })}</span>
      </div>
    )
  }
  if (kind === 'color') {
    return (
      <input type="color" className="color-input" value={toHex(value) ?? '#000000'} onChange={(e) => onSet(fromHex(e.target.value, value, componentCount(param.type)))} aria-label={label} />
    )
  }
  return <TextParam param={param} value={value} label={label} onSet={onSet} />
}

/** Champ texte (nombre sans bornes, plusieurs composantes) : validé à la sortie du champ ou avec Entrée. */
function TextParam({ param, value, label, onSet }: { param: BuilderParam; value: string; label: string; onSet: (v: string) => void }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const valid = (v: string): boolean => {
    // Sur une ligne, sans crochet ni signe égal (format des presets).
    if (!v.trim() || /[\r\n=[\]]/.test(v)) return false
    if (!param.type) return true
    return numbers(v)?.length === componentCount(param.type)
  }
  const ok = valid(text)
  const commit = (): void => {
    if (ok && text !== value) onSet(text.trim())
    else if (!ok) setText(value)
  }
  return (
    <input
      className={`input param-input ${ok ? '' : 'is-invalid'}`}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setText(value)
      }}
      aria-label={label}
      spellCheck={false}
    />
  )
}

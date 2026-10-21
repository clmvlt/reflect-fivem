// Réglages d'un outil d'ambiance de « Créer ton pack » (ReShade, QuantV, NVE, ENB) : réglages simples (curseurs centrés
// sur la valeur de départ, interrupteurs, listes, couleurs), puis, pour les connaisseurs, le mode avancé : effets avec
// leur coût, ajout d'un effet (ReShade), et chaque paramètre d'effet ou clé de section du fichier de réglages. Seul ce
// que le joueur change est gardé dans la création.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BuilderAdjustments, BuilderControl, BuilderEffect, BuilderParam, BuilderTechnique, BuilderToolView } from '@shared/types'
import { costOnMachine } from '@shared/performance'
import { formatNumber } from '@shared/intl'
import {
  baseValue,
  componentCount,
  fromHex,
  noStarts,
  numbers,
  paramKind,
  paramStep,
  setControl,
  setParam,
  setTechnique,
  toHex,
  type Starts
} from '../lib/builder'
import { msText, usePerformance } from './Performance'

type Change = (next: BuilderAdjustments) => void

/**
 * Valeurs de départ de l'outil (relevées dans son état quand le joueur n'y avait rien changé) : revenir à l'une d'elles
 * efface le réglage. `fresh` : l'état reçu correspond aux choix en cours (sinon il peut encore montrer un ancien
 * réglage du joueur). `identity` : outil, mode, composant et style ; les valeurs de départ changent avec eux.
 */
export function useStarts(view: BuilderToolView | null, fresh: boolean, a: BuilderAdjustments, identity: string): Starts {
  const ref = useRef<{ identity: string; starts: Starts }>({ identity, starts: noStarts() })
  if (ref.current.identity !== identity) ref.current = { identity, starts: noStarts() }
  const s = ref.current.starts
  if (view) {
    const take = <T,>(map: Record<string, T>, key: string, value: T, mine: boolean): void => {
      if (!mine && (fresh || !(key in map))) map[key] = value
    }
    for (const c of view.controls) take(s.controls, c.key, c.type === 'slider' ? 0 : c.value, a.controls[c.key] !== undefined)
    for (const tq of view.techniques ?? []) take(s.techniques, tq.name, tq.enabled, a.techniques[tq.name] !== undefined)
    for (const e of view.effects)
      for (const p of e.params) take(s.values, `${e.file}/${p.name}`, p.value ?? baseValue(p), a.values[e.file]?.[p.name] !== undefined)
  }
  return s
}

/** « +20 », « −15 », « 0 ». */
function signed(v: number): string {
  return v > 0 ? `+${formatNumber(v)}` : v < 0 ? `−${formatNumber(-v)}` : formatNumber(0)
}

/** Réglages simples, regroupés (Image, Effets, Météo...), dans l'ordre de l'API ; description en info-bulle. */
export function SimpleControls({ controls, adjustments, starts, onChange }: { controls: BuilderControl[]; adjustments: BuilderAdjustments; starts: Starts; onChange: Change }) {
  const { t } = useTranslation()
  const groups: { key: string; label: string; controls: BuilderControl[] }[] = []
  for (const c of controls) {
    const group = groups.find((g) => g.key === c.group) ?? groups[groups.push({ key: c.group, label: c.groupLabel || c.group, controls: [] }) - 1]
    group.controls.push(c)
  }
  if (!groups.length) return <p className="muted small">{t('builder.tool.noControls')}</p>
  return (
    <>
      {groups.map((g) => (
        <div key={g.key} className="reshade-group">
          <h4>{g.label}</h4>
          <ul className="list settings-list">
            {g.controls.map((c) => (
              <ControlRow key={c.key} control={c} adjustments={adjustments} start={c.key in starts.controls ? starts.controls[c.key] : c.type === 'slider' ? 0 : c.value} onChange={onChange} />
            ))}
          </ul>
        </div>
      ))}
    </>
  )
}

function ControlRow({ control, adjustments, start, onChange }: { control: BuilderControl; adjustments: BuilderAdjustments; start: BuilderControl['value']; onChange: Change }) {
  const { t } = useTranslation()
  const mine = adjustments.controls[control.key]
  const value = mine ?? start
  const changed = mine !== undefined
  const set = (v: BuilderControl['value']): void => onChange(setControl(adjustments, control.key, v, start))
  let input
  if (control.type === 'slider') {
    const v = typeof value === 'number' ? value : 0
    input = (
      <div className="range builder-slider">
        <input type="range" min={control.min ?? -100} max={control.max ?? 100} step={control.step ?? 1} value={v} onChange={(e) => set(Number(e.target.value))} aria-label={control.label} />
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
        {t('builder.tool.reset')}
      </button>
    </li>
  )
}

/**
 * Mode avancé : effets du fichier avec leur coût (ReShade, NVE), ajout d'un effet (ReShade), paramètres de chaque effet
 * ou clés de chaque section (QuantV, NVE, ENB). `component` : composant dont les shaders décrivent un effet ajouté.
 */
export function AdvancedSettings({
  view,
  component,
  adjustments,
  starts,
  onChange
}: {
  view: BuilderToolView
  component: string | null
  adjustments: BuilderAdjustments
  starts: Starts
  onChange: Change
}) {
  const { t } = useTranslation()
  // Effets ajoutés à l'instant : leurs paramètres, en attendant que l'état de l'outil les donne.
  const [added, setAdded] = useState<BuilderEffect[]>([])
  const effects = [...view.effects, ...added.filter((e) => !view.effects.some((v) => v.file.toLowerCase() === e.file.toLowerCase()))]
  const techniques = view.techniques ?? []
  const add = async (name: string): Promise<void> => {
    onChange(setTechnique(adjustments, name, true, starts.techniques[name] ?? false))
    const file = name.split('@')[1]
    if (!file || effects.some((e) => e.file.toLowerCase() === file.toLowerCase())) return
    const effect = await window.api.builderToolEffect(component, file).catch(() => null)
    if (effect) setAdded((list) => [...list.filter((e) => e.file !== effect.file), effect])
  }
  return (
    <div className="tool-advanced">
      {techniques.length > 0 && (
        <div className="reshade-group">
          <h4>{t('builder.tool.effects')}</h4>
          <ul className="list settings-list">
            {techniques.map((tq) => (
              <TechniqueRow key={tq.name} technique={tq} adjustments={adjustments} start={starts.techniques[tq.name] ?? tq.enabled} onChange={onChange} />
            ))}
          </ul>
        </div>
      )}
      {view.available && <AddEffect available={view.available} listed={[...techniques.map((x) => x.name), ...Object.keys(adjustments.techniques)]} onAdd={(n) => void add(n)} />}
      {effects.map((e) => (
        <EffectParams key={e.file} effect={e} adjustments={adjustments} starts={starts} onChange={onChange} />
      ))}
      {!techniques.length && !effects.length && <p className="muted small">{t('builder.tool.noAdvanced')}</p>}
    </div>
  )
}

function TechniqueRow({ technique, adjustments, start, onChange }: { technique: BuilderTechnique; adjustments: BuilderAdjustments; start: boolean; onChange: Change }) {
  const { t } = useTranslation()
  const ctx = usePerformance()
  const mine = adjustments.techniques[technique.name]
  const on = mine ?? start
  const ms = ctx ? costOnMachine(ctx.profile.model, ctx.machine, technique.costMs) : technique.costMs
  // Coût négligeable sur ce PC : son niveau seulement.
  const cost = ms >= 0.05 ? t('builder.tool.cost', { label: technique.costLabel, ms: msText(ms) }) : technique.costLabel
  const [label] = technique.name.split('@')
  return (
    <li className={`row reshade-row ${mine !== undefined ? 'is-changed' : ''}`}>
      <div className="row-main">
        <div>{label}</div>
        <div className="meta">{[technique.effect, cost].filter(Boolean).join(' · ')}</div>
      </div>
      <label className="switch">
        <input type="checkbox" checked={on} onChange={(e) => onChange(setTechnique(adjustments, technique.name, e.target.checked, start))} aria-label={label} />
        <span className="switch-track" />
        <span className="switch-text">{on ? t('common.enabled') : t('common.disabled')}</span>
      </label>
    </li>
  )
}

/** « Ajouter un effet » : recherche parmi les effets qu'on peut activer (ReShade). */
function AddEffect({ available, listed, onAdd }: { available: string[]; listed: string[]; onAdd: (name: string) => void }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const known = useMemo(() => new Set(listed.map((n) => n.toLowerCase())), [listed])
  const candidates = available.filter((n) => !known.has(n.toLowerCase()))
  if (!candidates.length) return null
  const q = query.trim().toLowerCase()
  const shown = candidates.filter((n) => !q || n.toLowerCase().includes(q)).slice(0, 20)
  return (
    <details className="reshade-effect add-effect">
      <summary>
        <span className="reshade-file">{t('builder.tool.addEffect')}</span>
        <span className="muted small">{t('builder.tool.addEffectCount', { count: candidates.length, n: formatNumber(candidates.length) })}</span>
      </summary>
      <input className="input" type="search" placeholder={t('builder.tool.addEffectSearch')} value={query} onChange={(e) => setQuery(e.target.value)} />
      {shown.length > 0 && (
        <ul className="list compact add-effect-list">
          {shown.map((n) => {
          const [label, file] = n.split('@')
          return (
            <li key={n} className="row">
              <span className="row-main">
                <span>{label}</span>
                {file && <span className="meta"> · {file}</span>}
              </span>
              <button
                onClick={() => {
                  setQuery('')
                  onAdd(n)
                }}
              >
                {t('builder.tool.add')}
              </button>
            </li>
          )
          })}
        </ul>
      )}
    </details>
  )
}

/** Paramètres d'un fichier d'effet (ou clés d'une section), regroupés par catégorie (ui_category), repliés. */
function EffectParams({ effect, adjustments, starts, onChange }: { effect: BuilderEffect; adjustments: BuilderAdjustments; starts: Starts; onChange: Change }) {
  const { t } = useTranslation()
  const groups: [string, BuilderParam[]][] = []
  for (const p of effect.params) {
    const key = p.category ?? ''
    const group = groups.find(([k]) => k === key) ?? groups[groups.push([key, []]) - 1]
    group[1].push(p)
  }
  const changed = Object.keys(adjustments.values[effect.file] ?? {}).length
  return (
    <details className="reshade-effect" open={changed > 0 || undefined}>
      <summary>
        <span className="reshade-file">{effect.file}</span>
        <span className="muted small">{t('builder.tool.paramCount', { count: effect.params.length, n: formatNumber(effect.params.length) })}</span>
        {changed > 0 && <span className="chip-count">{formatNumber(changed)}</span>}
      </summary>
      {groups.map(([category, params]) => (
        <div key={category} className="reshade-category">
          {category && <div className="reshade-category-name">{category}</div>}
          <ul className="list settings-list">
            {params.map((p) => (
              <ParamRow key={p.name} file={effect.file} param={p} adjustments={adjustments} start={starts.values[`${effect.file}/${p.name}`] ?? p.value ?? baseValue(p)} onChange={onChange} />
            ))}
          </ul>
        </div>
      ))}
    </details>
  )
}

function ParamRow({ file, param, adjustments, start, onChange }: { file: string; param: BuilderParam; adjustments: BuilderAdjustments; start: string; onChange: Change }) {
  const { t } = useTranslation()
  const mine = adjustments.values[file]?.[param.name]
  const value = mine ?? start
  const set = (v: string | null): void => onChange(setParam(adjustments, file, param.name, v, start))
  const label = param.label || param.name
  return (
    <li className={`row reshade-row ${mine !== undefined ? 'is-changed' : ''}`}>
      <div className="row-main" title={param.tooltip ?? undefined}>
        <div>{label}</div>
        {param.label && <div className="meta">{param.name}</div>}
      </div>
      <ParamInput param={param} value={value} label={label} onSet={set} />
      <button className="link reset-link" onClick={() => set(null)} disabled={mine === undefined} title={t('builder.tool.startValueTitle', { value: baseValue(param) || '-' })}>
        {t('builder.tool.startValue')}
      </button>
    </li>
  )
}

function ParamInput({ param, value, label, onSet }: { param: BuilderParam; value: string; label: string; onSet: (v: string) => void }) {
  const { t } = useTranslation()
  const kind = paramKind(param)
  if (kind === 'bool') {
    const v = value.trim().toLowerCase()
    const on = v === '1' || v === 'true'
    // Même écriture que le fichier : 1/0 dans un preset, true/false dans un .ini.
    const word = v === 'true' || v === 'false'
    return (
      <label className="switch">
        <input type="checkbox" checked={on} onChange={(e) => onSet(e.target.checked ? (word ? 'true' : '1') : word ? 'false' : '0')} aria-label={label} />
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
    return <input type="color" className="color-input" value={toHex(value) ?? '#000000'} onChange={(e) => onSet(fromHex(e.target.value, value, componentCount(param.type)))} aria-label={label} />
  }
  return <TextParam param={param} value={value} label={label} onSet={onSet} />
}

/** Champ texte (nombre sans bornes, plusieurs composantes, texte) : validé à la sortie du champ ou avec Entrée. */
function TextParam({ param, value, label, onSet }: { param: BuilderParam; value: string; label: string; onSet: (v: string) => void }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const valid = (v: string): boolean => {
    // Sur une ligne, sans crochet ni signe égal (format des fichiers de réglages).
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

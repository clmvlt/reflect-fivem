// Réglages d'un mod de la Marketplace (couleur des flammes...), que l'application applique sur ce PC.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModOption, PackManifest } from '@shared/types'
import { colorCss, colorStops, isUsableColor, optionLabel, usableValues } from '@shared/modOptions'
import { useStore } from '../store'
import { Modal } from './Modal'

const SWATCHES = ['#ff2a1a', '#ff7a00', '#ffd400', '#1dff3c', '#00e5ff', '#2020ff', '#a020ff', '#ff2bbf', '#ffffff']
const GRADIENT_START = '#a020ff'
const GRADIENT_END = '#2020ff'

/** Bouton « Personnaliser » d'un mod qui a des options (rien sinon) et sa fenêtre. */
export function ModOptionsButton({ mod, className }: { mod: PackManifest; className?: string }) {
  const { t } = useTranslation()
  const { run, task } = useStore()
  const [open, setOpen] = useState(false)
  if (!mod.options?.length) return null
  return (
    <>
      <button className={className} onClick={() => setOpen(true)} disabled={!!task}>
        {t('modsView.options.button')}
      </button>
      {open && (
        <OptionsDialog
          name={mod.name}
          options={mod.options}
          current={mod.optionValues}
          onApply={(values) => void run(() => window.api.setModOptions(mod.id, values))}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/** Réglages d'un mod ou d'un élément de « Créer ton pack » ; `hint` : à la place du texte d'un mod déjà téléchargé. */
export function OptionsDialog({
  name,
  options,
  current,
  hint,
  onApply,
  onClose
}: {
  name: string
  options: ModOption[]
  current: Record<string, string> | undefined
  hint?: string
  onApply: (values: Record<string, string>) => void
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const { task } = useStore()
  const saved = usableValues(options, current)
  const [values, setValues] = useState<Record<string, string>>(saved)
  const set = (id: string, value: string | null): void =>
    setValues((current) => {
      const next = { ...current }
      if (value === null) delete next[id]
      else next[id] = value
      return next
    })
  const tooDark = Object.values(values).some((v) => !isUsableColor(v))
  const dirty = options.some((o) => (values[o.id] ?? null) !== (saved[o.id] ?? null))

  const apply = (): void => {
    onClose()
    onApply(values)
  }

  return (
    <Modal
      title={t('modsView.options.title', { mod: name })}
      onClose={onClose}
      className="mod-options"
      actions={
        <>
          <button onClick={onClose} data-autofocus>
            {t('common.cancel')}
          </button>
          <button className="primary" onClick={apply} disabled={!dirty || tooDark || !!task}>
            {t('modsView.options.apply')}
          </button>
        </>
      }
    >
      <p className="hint">{hint ?? t('modsView.options.hint')}</p>
      {options.map((option) => {
        const value = values[option.id] ?? null
        return (
          <fieldset key={option.id} className="mod-option">
            <legend>{optionLabel(option, i18n.language)}</legend>
            <OptionColors value={value} onChange={(next) => set(option.id, next)} />
            {value !== null && !isUsableColor(value) && <p className="small warn-text">{t('modsView.options.tooDark')}</p>}
          </fieldset>
        )
      })}
    </Modal>
  )
}

/** Choix d'une teinte : pastilles, ou couleur libre. */
function ColorRow({ value, onChange }: { value: string | null; onChange: (color: string) => void }) {
  const { t } = useTranslation()
  return (
    <div className="mod-option-swatches">
      {SWATCHES.map((color) => (
        <button key={color} className={`mod-option-swatch ${value === color ? 'is-selected' : ''}`} style={{ background: color }} onClick={() => onChange(color)} aria-label={color} aria-pressed={value === color} />
      ))}
      <label className="mod-option-custom">
        {t('modsView.options.custom')}
        <input type="color" value={value ?? '#ffffff'} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  )
}

/** Couleur d'une option : celle du mod, une couleur unie, ou un dégradé du début à la fin de la flamme. */
function OptionColors({ value, onChange }: { value: string | null; onChange: (value: string | null) => void }) {
  const { t } = useTranslation()
  const [start, end] = value === null ? [GRADIENT_START, GRADIENT_END] : colorStops(value)
  const gradient = value !== null && value.includes(',')
  const mode = (active: boolean, label: string, choose: () => void) => (
    <button className={`mod-option-mode ${active ? 'is-selected' : ''}`} onClick={choose} aria-pressed={active}>
      {label}
    </button>
  )
  return (
    <>
      <div className="mod-option-modes">
        {mode(value === null, t('modsView.options.original'), () => onChange(null))}
        {mode(value !== null && !gradient, t('modsView.options.solid'), () => onChange(start))}
        {mode(gradient, t('modsView.options.gradient'), () => onChange(`${start},${start === end ? GRADIENT_END : end}`))}
      </div>
      {value !== null && !gradient && <ColorRow value={start} onChange={onChange} />}
      {gradient && (
        <>
          <div className="mod-option-preview" style={{ background: colorCss(value) }} aria-hidden />
          <div className="mod-option-stop">{t('modsView.options.start')}</div>
          <ColorRow value={start} onChange={(color) => onChange(`${color},${end}`)} />
          <div className="mod-option-stop">{t('modsView.options.end')}</div>
          <ColorRow value={end} onChange={(color) => onChange(`${start},${color}`)} />
        </>
      )}
    </>
  )
}

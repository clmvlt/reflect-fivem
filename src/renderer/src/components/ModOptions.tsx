// Réglages d'un mod de la Marketplace (couleur des flammes...), que l'application applique sur ce PC.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModOption, PackManifest } from '@shared/types'
import { isUsableColor, optionLabel, usableValues } from '@shared/modOptions'
import { useStore } from '../store'
import { Modal } from './Modal'

const SWATCHES = ['#ff2a1a', '#ff7a00', '#ffd400', '#1dff3c', '#00e5ff', '#2020ff', '#a020ff', '#ff2bbf', '#ffffff']

/** Bouton « Personnaliser » d'un mod qui a des options (rien sinon) et sa fenêtre. */
export function ModOptionsButton({ mod, className }: { mod: PackManifest; className?: string }) {
  const { t } = useTranslation()
  const { task } = useStore()
  const [open, setOpen] = useState(false)
  if (!mod.options?.length) return null
  return (
    <>
      <button className={className} onClick={() => setOpen(true)} disabled={!!task}>
        {t('modsView.options.button')}
      </button>
      {open && <ModOptionsDialog mod={mod} options={mod.options} onClose={() => setOpen(false)} />}
    </>
  )
}

function ModOptionsDialog({ mod, options, onClose }: { mod: PackManifest; options: ModOption[]; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const { run, task } = useStore()
  const saved = usableValues(options, mod.optionValues)
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

  const apply = async (): Promise<void> => {
    onClose()
    await run(() => window.api.setModOptions(mod.id, values))
  }

  return (
    <Modal
      title={t('modsView.options.title', { mod: mod.name })}
      onClose={onClose}
      className="mod-options"
      actions={
        <>
          <button onClick={onClose} data-autofocus>
            {t('common.cancel')}
          </button>
          <button className="primary" onClick={() => void apply()} disabled={!dirty || tooDark || !!task}>
            {t('modsView.options.apply')}
          </button>
        </>
      }
    >
      <p className="hint">{t('modsView.options.hint')}</p>
      {options.map((option) => {
        const value = values[option.id] ?? null
        return (
          <fieldset key={option.id} className="mod-option">
            <legend>{optionLabel(option, i18n.language)}</legend>
            <div className="mod-option-swatches">
              <button className={`mod-option-original ${value === null ? 'is-selected' : ''}`} onClick={() => set(option.id, null)} aria-pressed={value === null}>
                {t('modsView.options.original')}
              </button>
              {SWATCHES.map((color) => (
                <button
                  key={color}
                  className={`mod-option-swatch ${value === color ? 'is-selected' : ''}`}
                  style={{ background: color }}
                  onClick={() => set(option.id, color)}
                  aria-label={color}
                  aria-pressed={value === color}
                />
              ))}
              <label className="mod-option-custom">
                {t('modsView.options.custom')}
                <input type="color" value={value ?? '#ffffff'} onChange={(e) => set(option.id, e.target.value)} />
              </label>
            </div>
            {value !== null && !isUsableColor(value) && <p className="small warn-text">{t('modsView.options.tooDark')}</p>}
          </fieldset>
        )
      })}
    </Modal>
  )
}

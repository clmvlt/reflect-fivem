import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LanguageOption } from '@shared/api'
import { LOCALES } from '@shared/locales'
import { useStore } from '../store'

/** Langues embarquées : affichées tout de suite, puis remplacées par celles de l'API (GET /locales). */
const LOCAL: LanguageOption[] = LOCALES.map((l) => ({ code: l.code, name: l.name }))

/** Choix de la langue de l'application (réglages). */
export function LanguageSelect() {
  const { t, i18n } = useTranslation()
  const { run } = useStore()
  const [languages, setLanguages] = useState<LanguageOption[]>(LOCAL)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    window.api.listLanguages().then(
      (list) => alive && list.length > 0 && setLanguages(list),
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [])

  const current = i18n.resolvedLanguage ?? i18n.language
  const options = languages.some((l) => l.code === current) ? languages : [...languages, { code: current, name: current }]

  const change = async (code: string): Promise<void> => {
    setBusy(true)
    await run(() => window.api.setLanguage(code))
    setBusy(false)
  }

  return (
    <li className="row">
      <div className="row-main">
        <div className="name">{t('language.title')}</div>
        <div className="meta">{t('language.help')}</div>
      </div>
      <div className="actions">
        <select value={current} disabled={busy} onChange={(e) => void change(e.target.value)} aria-label={t('language.title')}>
          {options.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
    </li>
  )
}

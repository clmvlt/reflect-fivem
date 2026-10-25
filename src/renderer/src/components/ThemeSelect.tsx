import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { resolveTheme, THEME_IDS, themeAllowed, themeBackground, type Theme, type ThemeChoice } from '@shared/themes'
import { useStore } from '../store'
import { applyTheme } from '../lib/theme'

const CHOICES: readonly ThemeChoice[] = ['system', ...THEME_IDS]

/** Choix du thème de l'application (réglages) : un aperçu par thème (les thèmes réservés à l'admin, pour lui seul). */
export function ThemeSelect() {
  const { t } = useTranslation()
  const { overview, run, account } = useStore()
  const admin = !!account?.admin
  const saved = overview?.settings.theme ?? 'system'
  // Affiché tout de suite, avant que le réglage ne soit enregistré.
  const [choice, setChoice] = useState<ThemeChoice>(saved)
  useEffect(() => setChoice(saved), [saved])

  const pick = (next: ThemeChoice): void => {
    setChoice(next)
    applyTheme(next)
    void run(() => window.api.setTheme(next))
  }

  return (
    <li className="row theme-row">
      <div className="row-main">
        <div className="name">{t('settings.theme.title')}</div>
        <div className="meta">{t('settings.theme.help')}</div>
      </div>
      <div className="theme-grid" role="radiogroup" aria-label={t('settings.theme.title')}>
        {CHOICES.filter((id) => themeAllowed(id, admin)).map((id) => (
          <button
            key={id}
            className={`theme-swatch ${choice === id ? 'is-selected' : ''}`}
            role="radio"
            aria-checked={choice === id}
            title={themeAllowed(id, false) ? undefined : t('settings.theme.adminOnly')}
            onClick={() => pick(id)}
          >
            {id === 'system' ? (
              <span className="theme-preview is-split" aria-hidden>
                <Preview theme={resolveTheme('light', false)} />
                <Preview theme={resolveTheme('dark', true)} />
              </span>
            ) : (
              <span className="theme-preview" aria-hidden>
                <Preview theme={resolveTheme(id, false)} />
              </span>
            )}
            <span className="theme-name">{t(`settings.theme.names.${id}`)}</span>
          </button>
        ))}
      </div>
    </li>
  )
}

/** Fenêtre miniature aux couleurs du thème : barre latérale, carte, bouton d'accent (et le fond dessiné des thèmes Aurore et Nuit). */
function Preview({ theme }: { theme: Theme }) {
  const dark = theme.base === 'dark'
  const c = theme.colors
  const surface = c.surface ?? (dark ? '#111111' : '#ffffff')
  const text = c.text ?? (dark ? '#ffffff' : '#1b1b1b')
  const accent = c.accent ?? 'var(--system-accent, #7c40fd)'
  const border = c.border ?? (dark ? 'rgba(255, 255, 255, 0.12)' : '#e5e5e5')
  return (
    <span className="theme-mini" data-theme={theme.id} style={{ backgroundColor: themeBackground(theme) }}>
      <span className="theme-mini-side">
        <span style={{ background: text }} />
        <span style={{ background: text }} />
      </span>
      <span className="theme-mini-card" style={{ background: surface, borderColor: border }}>
        <span className="theme-mini-line" style={{ background: text }} />
        <span className="theme-mini-btn" style={{ background: accent }} />
      </span>
    </span>
  )
}

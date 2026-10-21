import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initReactI18next } from 'react-i18next'
import { initI18n } from '@shared/i18n'
import { App } from './App'
import { PageBoundary } from './components/PageBoundary'
import { StoreProvider } from './store'
import { applyTheme } from './lib/theme'
import './styles.css'

// Erreurs hors affichage (gestionnaires d'événements, promesses sans suite) : notées dans le journal de l'application,
// 20 au plus par session (une erreur répétée ne le remplit pas).
let reported = 0
const report = (what: string, error: unknown): void => {
  if (reported++ >= 20) return
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  window.api.reportError(`${what} : ${text}`).catch(() => undefined)
}
window.addEventListener('error', (e) => {
  // Avertissement sans conséquence de Chromium.
  if (/ResizeObserver loop/.test(e.message)) return
  report('erreur', e.error ?? e.message)
})
window.addEventListener('unhandledrejection', (e) => report('promesse rejetée', e.reason))

// Langue et thème choisis, connus avant le premier affichage (pas d'éclair dans une autre langue ou d'autres couleurs).
void Promise.all([window.api.getLanguage().catch(() => 'fr'), window.api.getTheme().catch(() => 'system' as const)])
  .then(([lng, theme]) => {
    applyTheme(theme)
    initI18n(lng, initReactI18next)
    document.documentElement.lang = lng
    createRoot(document.getElementById('root') as HTMLElement).render(
      <StrictMode>
        {/* Dernier recours (barre latérale comprise) : jamais de fenêtre vide. */}
        <PageBoundary>
          <StoreProvider>
            <App />
          </StoreProvider>
        </PageBoundary>
      </StrictMode>
    )
  })

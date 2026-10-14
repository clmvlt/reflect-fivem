import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initReactI18next } from 'react-i18next'
import { initI18n } from '@shared/i18n'
import { App } from './App'
import { StoreProvider } from './store'
import './styles.css'

// Langue choisie par le processus principal, connue avant le premier affichage (pas d'éclair dans une autre langue).
void window.api
  .getLanguage()
  .catch(() => 'fr')
  .then((lng) => {
    initI18n(lng, initReactI18next)
    document.documentElement.lang = lng
    createRoot(document.getElementById('root') as HTMLElement).render(
      <StrictMode>
        <StoreProvider>
          <App />
        </StoreProvider>
      </StrictMode>
    )
  })

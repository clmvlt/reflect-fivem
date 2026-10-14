// Clés de traduction typées : t('cle.inconnue') est une erreur de compilation.

import 'i18next'
import type fr from './locales/fr.json'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation'
    resources: { translation: typeof fr }
  }
}

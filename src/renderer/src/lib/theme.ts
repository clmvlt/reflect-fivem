// Thème de l'interface : base claire ou sombre (data-base, couleurs de styles.css) et couleurs propres au thème posées
// sur la page. « Système » suit Windows, y compris quand il change de thème pendant que l'application est ouverte.

import { resolveTheme, THEME_TOKENS, type ThemeChoice } from '@shared/themes'

const systemDark = window.matchMedia('(prefers-color-scheme: dark)')
let choice: ThemeChoice = 'system'

function paint(): void {
  const theme = resolveTheme(choice, systemDark.matches)
  const root = document.documentElement
  root.dataset.theme = theme.id
  root.dataset.base = theme.base
  for (const token of THEME_TOKENS) {
    const value = theme.colors[token]
    if (value) root.style.setProperty(`--${token}`, value)
    else root.style.removeProperty(`--${token}`)
  }
}

systemDark.addEventListener('change', () => {
  if (choice === 'system') paint()
})

export function applyTheme(next: ThemeChoice | undefined): void {
  choice = next ?? 'system'
  paint()
}

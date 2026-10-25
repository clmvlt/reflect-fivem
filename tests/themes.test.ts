// Thèmes réservés à l'admin (Aurore, Nuit) : proposés et appliqués seulement à l'admin connecté, les autres ont celui du
// système, et le choix enregistré revient à la connexion de l'admin.
import { describe, expect, it } from 'vitest'
import { effectiveTheme, THEME_IDS, themeAllowed } from '../src/shared/themes'

describe('themeAllowed', () => {
  it('Aurore et Nuit : admin seulement', () => {
    for (const id of ['aurora', 'night'] as const) {
      expect(themeAllowed(id, true)).toBe(true)
      expect(themeAllowed(id, false)).toBe(false)
    }
  })

  it('les autres thèmes et « Système » : pour tous', () => {
    for (const id of ['system', ...THEME_IDS.filter((id) => id !== 'aurora' && id !== 'night')] as const) expect(themeAllowed(id, false)).toBe(true)
  })
})

describe('effectiveTheme', () => {
  it('thème réservé sans l’admin connecté : celui du système', () => {
    expect(effectiveTheme('aurora', false)).toBe('system')
    expect(effectiveTheme('night', false)).toBe('system')
  })

  it('admin connecté : son choix', () => {
    expect(effectiveTheme('aurora', true)).toBe('aurora')
    expect(effectiveTheme('night', true)).toBe('night')
  })

  it('autres thèmes inchangés, aucun choix : système', () => {
    expect(effectiveTheme('ocean', false)).toBe('ocean')
    expect(effectiveTheme(undefined, true)).toBe('system')
  })
})

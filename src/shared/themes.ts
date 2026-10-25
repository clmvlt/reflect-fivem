// Thèmes de l'application : clair ou sombre de base (couleurs de styles.css), et quelques couleurs remplacées par
// thème (fonds, cartes, boutons, accent). Source unique : l'interface les pose sur la page, le processus principal en
// tire le fond de la fenêtre (pas d'éclair d'une autre couleur à l'ouverture).

/** Couleurs qu'un thème peut remplacer (variables CSS du même nom). */
export type ThemeToken = 'bg' | 'layer' | 'surface' | 'surface-hover' | 'media' | 'border' | 'btn' | 'btn-hover' | 'info-bg' | 'accent' | 'text' | 'text-2'

export const THEME_TOKENS: readonly ThemeToken[] = ['bg', 'layer', 'surface', 'surface-hover', 'media', 'border', 'btn', 'btn-hover', 'info-bg', 'accent', 'text', 'text-2']

export const THEME_IDS = ['light', 'dark', 'aurora', 'gray', 'midnight', 'violet', 'forest', 'ocean', 'ember', 'raspberry', 'pink', 'lavender', 'sky', 'mint', 'sand'] as const
export type ThemeId = (typeof THEME_IDS)[number]
/** Choix des réglages : « system » suit le thème clair ou sombre de Windows. */
export type ThemeChoice = 'system' | ThemeId

export interface Theme {
  id: ThemeId
  base: 'light' | 'dark'
  /** Couleurs remplacées ; sans accent, celui de Windows. */
  colors: Partial<Record<ThemeToken, string>>
}

export const THEMES: readonly Theme[] = [
  { id: 'light', base: 'light', colors: {} },
  { id: 'dark', base: 'dark', colors: {} },
  // Noir, avec un ciel étoilé et une aurore boréale en fond (AuroraSky dans l'interface).
  { id: 'aurora', base: 'dark', colors: {} },
  {
    id: 'gray',
    base: 'dark',
    colors: { bg: '#1c1c1c', layer: '#232323', surface: '#2b2b2b', 'surface-hover': '#323232', media: '#191919', btn: '#333333', 'btn-hover': '#3b3b3b', 'info-bg': '#292929' }
  },
  {
    id: 'midnight',
    base: 'dark',
    colors: { bg: '#0b1020', layer: '#0f1528', surface: '#161d35', 'surface-hover': '#1c2442', media: '#0a0e1c', btn: '#1d2545', 'btn-hover': '#252e52', 'info-bg': '#141b31', accent: '#5b8cff' }
  },
  {
    id: 'violet',
    base: 'dark',
    colors: { bg: '#120b1f', layer: '#170e28', surface: '#201538', 'surface-hover': '#281b45', media: '#0e0818', btn: '#2a1d48', 'btn-hover': '#332357', 'info-bg': '#1c1330', accent: '#9d6bff' }
  },
  {
    id: 'forest',
    base: 'dark',
    colors: { bg: '#0b1510', layer: '#0f1b15', surface: '#15251c', 'surface-hover': '#1b2e23', media: '#09110d', btn: '#1c3026', 'btn-hover': '#233a2e', 'info-bg': '#13201a', accent: '#3fbf7f' }
  },
  {
    id: 'ocean',
    base: 'dark',
    colors: { bg: '#061519', layer: '#081c21', surface: '#0d272e', 'surface-hover': '#123139', media: '#051115', btn: '#12323a', 'btn-hover': '#183d46', 'info-bg': '#0b2228', accent: '#1fb5cc' }
  },
  {
    id: 'ember',
    base: 'dark',
    colors: { bg: '#1a0e0a', layer: '#20120d', surface: '#2b1912', 'surface-hover': '#352017', media: '#140a07', btn: '#37211a', 'btn-hover': '#432a20', 'info-bg': '#261610', accent: '#ff7a45' }
  },
  {
    id: 'raspberry',
    base: 'dark',
    colors: { bg: '#1a0a12', layer: '#210d17', surface: '#2c1220', 'surface-hover': '#371828', media: '#13070d', btn: '#3a1a2b', 'btn-hover': '#462135', 'info-bg': '#25101b', accent: '#ff5fa2' }
  },
  {
    id: 'pink',
    base: 'light',
    colors: { bg: '#fbeef3', layer: '#fdf5f8', surface: '#ffffff', 'surface-hover': '#fdf0f5', media: '#f6dfe8', border: '#f0d6e0', btn: '#fffafc', 'btn-hover': '#fcedf3', 'info-bg': '#f9e6ee', accent: '#d63384' }
  },
  {
    id: 'lavender',
    base: 'light',
    colors: { bg: '#f1eefb', layer: '#f7f5fd', surface: '#ffffff', 'surface-hover': '#f4f1fd', media: '#e4def6', border: '#ddd6f2', btn: '#fcfbff', 'btn-hover': '#f1edfc', 'info-bg': '#ebe6f9', accent: '#7c40fd' }
  },
  {
    id: 'sky',
    base: 'light',
    colors: { bg: '#edf3fb', layer: '#f4f8fd', surface: '#ffffff', 'surface-hover': '#f0f5fc', media: '#dce7f6', border: '#d6e2f2', btn: '#fbfdff', 'btn-hover': '#edf3fb', 'info-bg': '#e5eef9', accent: '#2f6fdb' }
  },
  {
    id: 'mint',
    base: 'light',
    colors: { bg: '#ebf6f0', layer: '#f3faf6', surface: '#ffffff', 'surface-hover': '#eff8f3', media: '#dcefe4', border: '#d3e8dc', btn: '#fbfefc', 'btn-hover': '#eef7f2', 'info-bg': '#e3f2ea', accent: '#1a8f5a' }
  },
  {
    id: 'sand',
    base: 'light',
    colors: {
      bg: '#f5efe4',
      layer: '#faf6ef',
      surface: '#fffdf9',
      'surface-hover': '#f8f2e8',
      media: '#ece3d3',
      border: '#e6dccb',
      btn: '#fffcf7',
      'btn-hover': '#f6efe3',
      'info-bg': '#f1e9db',
      accent: '#a86a12',
      text: '#2b2418',
      'text-2': '#6b5f4b'
    }
  }
]

export function isThemeChoice(v: unknown): v is ThemeChoice {
  return v === 'system' || (THEME_IDS as readonly unknown[]).includes(v)
}

/** Thème affiché pour un choix des réglages (absent ou inconnu : celui du système). */
export function resolveTheme(choice: string | null | undefined, systemDark: boolean): Theme {
  const id = choice && choice !== 'system' && isThemeChoice(choice) ? choice : systemDark ? 'dark' : 'light'
  return THEMES.find((t) => t.id === id)!
}

/** Fond de la fenêtre (le même que celui de l'interface). */
export function themeBackground(theme: Theme): string {
  return theme.colors.bg ?? (theme.base === 'dark' ? '#000000' : '#f3f3f3')
}

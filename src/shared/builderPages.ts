// Pages de l'assistant « Créer ton pack » (fonctions pures, testées) : une seule chose à regarder par page, pour que
// « Suivant » mène à tout sans qu'un sous-onglet passe inaperçu. Les étapes sont les groupes du catalogue (Ambiance
// graphique, Monde...), puis le récapitulatif.
import type { BuilderCatalog, BuilderCategory, BuilderGroup } from './types'

/** Étape finale de l'assistant, après les groupes du catalogue. */
export const SUMMARY = 'summary'
/** Page des outils d'ambiance (choix rapide, ou chaque outil réglé), en tête de leur étape. */
export const TOOLS = 'tools'

/** Page de l'assistant. `key` : celle de la catégorie, TOOLS ou SUMMARY. */
export interface WizardPage {
  key: string
  /** Étape (groupe du catalogue) ; null : le récapitulatif. */
  group: BuilderGroup | null
  /** null : la page des outils d'ambiance, ou le récapitulatif. */
  category: BuilderCategory | null
}

/** Étape de l'assistant (un groupe du catalogue, ou le récapitulatif) et ses pages. */
export interface WizardStep {
  key: string
  group: BuilderGroup | null
  pages: WizardPage[]
}

/** Étape qui porte les outils d'ambiance : celle de leurs catégories (null sans outil proposé). */
export function toolsGroup(catalog: BuilderCatalog): string | null {
  if (!catalog.tools.length) return null
  const tool = catalog.tools[0]
  return catalog.categories.find((c) => c.tool === tool.key || c.key === tool.category)?.group ?? catalog.groups[0]?.key ?? null
}

/**
 * Pages de l'assistant, dans l'ordre : pour chaque groupe, la page des outils d'ambiance (groupe qui les porte) puis
 * une page par catégorie non vide hors outils (les éléments des outils sont leurs choix « Importé d'un pack ») ; le
 * récapitulatif à la fin.
 */
export function wizardPages(catalog: BuilderCatalog): WizardPage[] {
  const tools = toolsGroup(catalog)
  const pages: WizardPage[] = []
  for (const group of catalog.groups) {
    if (group.key === tools) pages.push({ key: TOOLS, group, category: null })
    for (const key of group.categories) {
      const category = catalog.categories.find((c) => c.key === key)
      if (category && !category.tool && category.components.length > 0) pages.push({ key, group, category })
    }
  }
  pages.push({ key: SUMMARY, group: null, category: null })
  return pages
}

/** Pages regroupées par étape, dans le même ordre (une étape sans page n'est pas proposée). */
export function wizardSteps(pages: WizardPage[]): WizardStep[] {
  const steps: WizardStep[] = []
  for (const page of pages) {
    const key = page.group?.key ?? SUMMARY
    const last = steps[steps.length - 1]
    if (last?.key === key) last.pages.push(page)
    else steps.push({ key, group: page.group, pages: [page] })
  }
  return steps
}

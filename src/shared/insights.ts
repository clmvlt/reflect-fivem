import { t } from 'i18next'
import type { Insight, PackManifest } from './types'

export type Level = 'ok' | 'info' | 'warn' | 'bad'

/**
 * Niveau réel d'une vérification. Un .asi est chargé si la build utilisée par FiveM fait partie de celles qu'il
 * déclare ; sinon FiveM l'ignore simplement, sans conséquence pour le reste du pack : c'est une information, pas
 * une erreur (la build dépend du serveur rejoint).
 */
export function levelOf(i: Insight, build: number | null): Level {
  if (build && i.builds?.length) return i.builds.includes(build) ? 'ok' : 'info'
  return i.level
}

/** Texte d'un .asi selon la dernière build lancée par FiveM. */
export function asiBuildText(builds: number[], build: number): string {
  const p = { build, from: builds[0], to: builds[builds.length - 1] }
  const range = builds.length > 1
  if (builds.includes(build)) return range ? t('insights.asi.loadedRange', p) : t('insights.asi.loadedSingle', p)
  return range ? t('insights.asi.ignoredRange', p) : t('insights.asi.ignoredSingle', p)
}

export function problemCount(pack: PackManifest, build: number | null): number {
  return (pack.insights ?? []).filter((i) => {
    const l = levelOf(i, build)
    return l === 'warn' || l === 'bad'
  }).length
}

/** Libellés des niveaux, dans la langue affichée au moment de la lecture. */
export const LEVEL_LABEL: Record<Level, string> = {
  get ok() {
    return t('insights.level.ok')
  },
  get info() {
    return t('insights.level.info')
  },
  get warn() {
    return t('insights.level.warn')
  },
  get bad() {
    return t('insights.level.bad')
  }
}

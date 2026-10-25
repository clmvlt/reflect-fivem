// Tag du serveur Discord (GET /me/server-tag, voir account.ts) : avancée vers le prochain crédit « Créer ton pack »
// (fonction pure, testée). L'API compte le temps et donne les crédits ; ici, ce qu'il faut montrer.

import type { ServerTagProgress } from './types'

/**
 * Avancée vers le prochain crédit, de 0 à 1 : (creditEverySeconds - nextCreditInSeconds) / creditEverySeconds. null
 * quand le plafond de crédits est atteint (nextCreditInSeconds null) : plus rien à gagner.
 */
export function nextCreditProgress(p: Pick<ServerTagProgress, 'creditEverySeconds' | 'nextCreditInSeconds'>): number | null {
  if (p.nextCreditInSeconds === null) return null
  if (p.creditEverySeconds <= 0) return 0
  return Math.min(1, Math.max(0, (p.creditEverySeconds - p.nextCreditInSeconds) / p.creditEverySeconds))
}

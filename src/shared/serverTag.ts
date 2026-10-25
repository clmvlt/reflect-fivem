// Tag du serveur Discord (GET /me/server-tag, voir account.ts) : état de la récompense et avancée vers le crédit
// « Créer ton pack » (fonctions pures, testées). L'API compte le temps et donne les crédits ; ici, ce qu'il faut montrer.

import type { ServerTagProgress } from './types'

/**
 * Où en est la récompense : 'earning' tant qu'il reste un crédit à gagner, 'waiting' quand un crédit gagné n'est pas
 * encore donné au compte (le temps d'un relevé), 'done' quand le plafond est atteint (jamais avec maxCredits 0, sans
 * limite). Une fois le crédit gagné, le temps avec le tag est encore compté, seulement pour être affiché.
 */
export type RewardState = 'earning' | 'waiting' | 'done'

export function rewardState(p: Pick<ServerTagProgress, 'creditsEarned' | 'creditsWaiting' | 'maxCredits'>): RewardState {
  if (p.creditsWaiting > 0) return 'waiting'
  if (p.maxCredits > 0 && p.creditsEarned >= p.maxCredits) return 'done'
  return 'earning'
}

/**
 * Avancée vers le prochain crédit, de 0 à 1 : (creditEverySeconds - nextCreditInSeconds) / creditEverySeconds. null
 * quand le plafond de crédits est atteint (nextCreditInSeconds null) : plus rien à gagner.
 */
export function nextCreditProgress(p: Pick<ServerTagProgress, 'creditEverySeconds' | 'nextCreditInSeconds'>): number | null {
  if (p.nextCreditInSeconds === null) return null
  if (p.creditEverySeconds <= 0) return 0
  return Math.min(1, Math.max(0, (p.creditEverySeconds - p.nextCreditInSeconds) / p.creditEverySeconds))
}

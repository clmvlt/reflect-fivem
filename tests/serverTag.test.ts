// Tag du serveur Discord : état de la récompense (un seul crédit « Créer ton pack », puis le temps seulement) et
// avancée vers le crédit.
import { describe, expect, it } from 'vitest'
import { nextCreditProgress, rewardState } from '@shared/serverTag'

describe('état de la récompense', () => {
  it('crédit pas encore gagné', () => {
    expect(rewardState({ creditsEarned: 0, creditsWaiting: 0, maxCredits: 1 })).toBe('earning')
  })

  it('crédit gagné, en cours d’attribution le temps d’un relevé', () => {
    expect(rewardState({ creditsEarned: 0, creditsWaiting: 1, maxCredits: 1 })).toBe('waiting')
  })

  it('crédit obtenu : plus rien à gagner', () => {
    expect(rewardState({ creditsEarned: 1, creditsWaiting: 0, maxCredits: 1 })).toBe('done')
    expect(rewardState({ creditsEarned: 3, creditsWaiting: 0, maxCredits: 3 })).toBe('done')
    expect(rewardState({ creditsEarned: 1, creditsWaiting: 0, maxCredits: 3 })).toBe('earning')
  })

  it('sans limite (maxCredits 0) : jamais fini', () => {
    expect(rewardState({ creditsEarned: 0, creditsWaiting: 0, maxCredits: 0 })).toBe('earning')
    expect(rewardState({ creditsEarned: 12, creditsWaiting: 0, maxCredits: 0 })).toBe('earning')
    expect(rewardState({ creditsEarned: 12, creditsWaiting: 2, maxCredits: 0 })).toBe('waiting')
  })
})

describe('avancée vers le prochain crédit', () => {
  const every = 345_600

  it('part du temps déjà fait dans la tranche en cours', () => {
    expect(nextCreditProgress({ creditEverySeconds: every, nextCreditInSeconds: 155_600 })).toBeCloseTo(0.5498, 4)
    expect(nextCreditProgress({ creditEverySeconds: every, nextCreditInSeconds: every })).toBe(0)
    expect(nextCreditProgress({ creditEverySeconds: every, nextCreditInSeconds: 0 })).toBe(1)
  })

  it('crédit gagné (nextCreditInSeconds null) : plus de barre', () => {
    expect(nextCreditProgress({ creditEverySeconds: every, nextCreditInSeconds: null })).toBeNull()
    expect(nextCreditProgress({ creditEverySeconds: 0, nextCreditInSeconds: null })).toBeNull()
  })

  it('reste entre 0 et 1 pour des valeurs hors limites', () => {
    expect(nextCreditProgress({ creditEverySeconds: every, nextCreditInSeconds: every * 2 })).toBe(0)
    expect(nextCreditProgress({ creditEverySeconds: every, nextCreditInSeconds: -10 })).toBe(1)
    expect(nextCreditProgress({ creditEverySeconds: 0, nextCreditInSeconds: 10 })).toBe(0)
  })
})

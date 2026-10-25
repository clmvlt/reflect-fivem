// Tag du serveur Discord : avancée vers le prochain crédit « Créer ton pack », et plafond atteint.
import { describe, expect, it } from 'vitest'
import { nextCreditProgress } from '@shared/serverTag'

describe('avancée vers le prochain crédit', () => {
  const every = 345_600

  it('part du temps déjà fait dans la tranche en cours', () => {
    expect(nextCreditProgress({ creditEverySeconds: every, nextCreditInSeconds: 155_600 })).toBeCloseTo(0.5498, 4)
    expect(nextCreditProgress({ creditEverySeconds: every, nextCreditInSeconds: every })).toBe(0)
    expect(nextCreditProgress({ creditEverySeconds: every, nextCreditInSeconds: 0 })).toBe(1)
  })

  it('plafond atteint : rien à montrer', () => {
    expect(nextCreditProgress({ creditEverySeconds: every, nextCreditInSeconds: null })).toBeNull()
  })

  it('reste entre 0 et 1 pour des valeurs hors limites', () => {
    expect(nextCreditProgress({ creditEverySeconds: every, nextCreditInSeconds: every * 2 })).toBe(0)
    expect(nextCreditProgress({ creditEverySeconds: every, nextCreditInSeconds: -10 })).toBe(1)
    expect(nextCreditProgress({ creditEverySeconds: 0, nextCreditInSeconds: 10 })).toBe(0)
  })
})

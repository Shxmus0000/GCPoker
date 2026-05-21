import { Card, HandRank } from '@gcpoker/shared'
import { createDeck, shuffle } from './deck'
import { evaluateHand, compareHands } from './evaluator'

export function calculateWinProbability(
  holeCards: Card[],
  communityCards: Card[],
  iterations: number = 500
): number {
  const fullDeck = createDeck()
  const knownCards = [...holeCards, ...communityCards]
  const remaining = fullDeck.filter(c =>
    !knownCards.some(kc => kc.rank === c.rank && kc.suit === c.suit)
  )

  const remainingBoard = 5 - communityCards.length
  let wins = 0
  let ties = 0

  for (let i = 0; i < iterations; i++) {
    const shuffled = shuffle(remaining)
    const oppHole = shuffled.slice(0, 2)
    const board = shuffled.slice(2, 2 + remainingBoard)
    const fullBoard = [...communityCards, ...board]

    const ourHand = evaluateHand(holeCards, fullBoard)
    const oppHand = evaluateHand(oppHole, fullBoard)

    const cmp = compareHands(ourHand, oppHand)
    if (cmp > 0) wins++
    else if (cmp === 0) ties++
  }

  return (wins + ties * 0.5) / iterations
}

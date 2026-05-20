import {
  Card, Rank, Suit,
  HandRank, EvaluatedHand,
} from '@gcpoker/shared'

// ─── Hand Evaluation ─────────────────────────────────────

export function evaluateHand(holeCards: Card[], communityCards: Card[]): EvaluatedHand {
  const allCards = [...holeCards, ...communityCards]
  if (allCards.length < 5) {
    throw new Error('Need at least 5 cards to evaluate')
  }

  const combos = getCombinations(allCards, 5)
  let best: EvaluatedHand | null = null

  for (const combo of combos) {
    const result = evaluateFive(combo)
    if (!best || compareHands(result, best) > 0) {
      best = result
    }
  }

  return best!
}

function evaluateFive(cards: Card[]): EvaluatedHand {
  const ranks = cards.map(c => c.rank).sort((a, b) => b - a)
  const suits = cards.map(c => c.suit)
  const isFlush = suits.every(s => s === suits[0])
  const straightRank = getStraightRank(ranks)

  const rankCounts = new Map<Rank, number>()
  for (const r of ranks) {
    rankCounts.set(r, (rankCounts.get(r) || 0) + 1)
  }

  const groups = [...rankCounts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0] - a[0])

  const isStraight = straightRank !== null

  // Royal Flush
  if (isFlush && isStraight && straightRank === Rank.Ace) {
    return { rank: HandRank.RoyalFlush, kickers: [], bestCards: cards }
  }

  // Straight Flush
  if (isFlush && isStraight) {
    return { rank: HandRank.StraightFlush, kickers: [straightRank!], bestCards: cards }
  }

  // Four of a Kind
  if (groups[0][1] === 4) {
    const kickers = [groups[0][0], groups[1]?.[0] ?? 0].filter(k => k > 0)
    return { rank: HandRank.FourOfAKind, kickers, bestCards: cards }
  }

  // Full House
  if (groups[0][1] === 3 && groups[1]?.[1] === 2) {
    return {
      rank: HandRank.FullHouse,
      kickers: [groups[0][0], groups[1][0]],
      bestCards: cards,
    }
  }

  // Flush
  if (isFlush) {
    return { rank: HandRank.Flush, kickers: ranks, bestCards: cards }
  }

  // Straight
  if (isStraight) {
    return { rank: HandRank.Straight, kickers: [straightRank!], bestCards: cards }
  }

  // Three of a Kind
  if (groups[0][1] === 3) {
    const kickers = [groups[0][0], ...groups.slice(1).map(g => g[0])]
    return { rank: HandRank.ThreeOfAKind, kickers, bestCards: cards }
  }

  // Two Pair
  if (groups[0][1] === 2 && groups[1]?.[1] === 2) {
    const highPair = Math.max(groups[0][0], groups[1][0])
    const lowPair = Math.min(groups[0][0], groups[1][0])
    const kickers = [highPair, lowPair, groups[2]?.[0] ?? 0]
    return { rank: HandRank.TwoPair, kickers, bestCards: cards }
  }

  // One Pair
  if (groups[0][1] === 2) {
    const kickers = [groups[0][0], ...groups.slice(1).map(g => g[0])]
    return { rank: HandRank.OnePair, kickers, bestCards: cards }
  }

  // High Card
  return { rank: HandRank.HighCard, kickers: ranks, bestCards: cards }
}

// ─── Comparison ──────────────────────────────────────────

export function compareHands(a: EvaluatedHand, b: EvaluatedHand): number {
  if (a.rank !== b.rank) return a.rank - b.rank
  for (let i = 0; i < Math.max(a.kickers.length, b.kickers.length); i++) {
    const ak = a.kickers[i] ?? 0
    const bk = b.kickers[i] ?? 0
    if (ak !== bk) return ak - bk
  }
  return 0
}

export function getWinner(
  handResults: { playerId: string; hand: EvaluatedHand }[]
): { playerId: string; hand: EvaluatedHand }[] {
  let best: { playerId: string; hand: EvaluatedHand }[] = [{ ...handResults[0] }]

  for (let i = 1; i < handResults.length; i++) {
    const cmp = compareHands(handResults[i].hand, best[0].hand)
    if (cmp > 0) {
      best = [{ ...handResults[i] }]
    } else if (cmp === 0) {
      best.push({ ...handResults[i] })
    }
  }

  return best
}

// ─── Helpers ─────────────────────────────────────────────

function getStraightRank(ranks: number[]): number | null {
  const unique = [...new Set(ranks)].sort((a, b) => b - a)

  // Check regular straight
  for (let i = 0; i <= unique.length - 5; i++) {
    if (unique[i] - unique[i + 4] === 4) {
      return unique[i]
    }
  }

  // Check ace-low straight (A-2-3-4-5)
  if (unique.includes(Rank.Ace) &&
      unique.includes(Rank.Two) &&
      unique.includes(Rank.Three) &&
      unique.includes(Rank.Four) &&
      unique.includes(Rank.Five)) {
    return Rank.Five
  }

  return null
}

function getCombinations(arr: Card[], k: number): Card[][] {
  if (k === 0) return [[]]
  if (arr.length < k) return []

  const result: Card[][] = []
  const first = arr[0]
  const rest = arr.slice(1)

  // combos including first
  for (const combo of getCombinations(rest, k - 1)) {
    result.push([first, ...combo])
  }

  // combos without first
  for (const combo of getCombinations(rest, k)) {
    result.push(combo)
  }

  return result
}

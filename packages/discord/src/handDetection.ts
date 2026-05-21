import { HandRank, HAND_RANK_NAMES } from '@gcpoker/shared'
import type { HandRecord } from '@gcpoker/engine'

const BIG_HAND_MIN_RANK = HandRank.Flush
const HUGE_HAND_MIN_RANK = HandRank.FullHouse
const BIG_POT_MULTIPLIER = 30

export interface DetectedHand {
  isBigHand: boolean
  isHugeHand: boolean
  isBadBeat: boolean
  description: string
  winningHand: string
  losingHand: string | null
  potSize: number
}

export function analyzeHand(hand: HandRecord): DetectedHand | null {
  const potSize = hand.pots.reduce((s, p) => s + p.main + p.sidePots.reduce((ss, sp) => ss + sp.amount, 0), 0)
  const bigBlind = hand.blinds.big
  const potInBB = potSize / bigBlind

  const results = hand.hands.filter(h => h.hand && !h.playerId.startsWith('sys-'))
  if (results.length < 2) return null

  const sorted = [...results].sort((a, b) => {
    if (!a.hand || !b.hand) return 0
    return compareRanks(a.hand.rank, b.hand.rank)
  })

  const best = sorted[sorted.length - 1]
  const second = sorted[sorted.length - 2]
  if (!best.hand || !second.hand) return null

  const winningName = HAND_RANK_NAMES[best.hand.rank]
  const losingName = HAND_RANK_NAMES[second.hand.rank]

  const isBigHand = best.hand.rank >= BIG_HAND_MIN_RANK || potInBB >= BIG_POT_MULTIPLIER
  const isHugeHand = best.hand.rank >= HUGE_HAND_MIN_RANK && potInBB >= BIG_POT_MULTIPLIER

  const isBadBeat = detectBadBeat(hand, best, second, sorted)

  const winnerPlayer = hand.winners.length > 0
    ? hand.players.find(p => p.id === hand.winners[0].playerId)
    : null

  const bestPlayer = hand.players.find(p => p.id === best.playerId)
  const secondPlayer = hand.players.find(p => p.id === second.playerId)

  let description = ''
  if (isBadBeat) {
    description = `**Bad Beat!** ${secondPlayer?.name ?? 'Unknown'} had ${losingName} but ${winnerPlayer?.name ?? 'Unknown'} hit ${winningName} on the river to take a ${potSize} chip pot!`
  } else if (isHugeHand) {
    description = `🔥 **HUGE HAND!** ${winnerPlayer?.name ?? 'Unknown'} wins ${potSize} chip pot with ${winningName}!`
  } else if (isBigHand) {
    description = `👀 ${winnerPlayer?.name ?? 'Unknown'} wins ${potSize} chip pot with ${winningName}`
  } else {
    return null
  }

  return {
    isBigHand: isBigHand || isHugeHand,
    isHugeHand,
    isBadBeat,
    description,
    winningHand: `${winnerPlayer?.name ?? 'Unknown'} - ${winningName}`,
    losingHand: isBadBeat ? `${secondPlayer?.name ?? 'Unknown'} - ${losingName}` : null,
    potSize,
  }
}

function detectBadBeat(
  hand: HandRecord,
  best: { playerId: string; hand: { rank: HandRank } | null },
  second: { playerId: string; hand: { rank: HandRank } | null },
  sorted: Array<{ playerId: string; hand: { rank: HandRank } | null }>
): boolean {
  if (!second.hand || !best.hand) return false

  if (second.hand.rank < HandRank.TwoPair) return false

  const riverCard = hand.communityCards.length >= 5 ? hand.communityCards[4] : null
  if (!riverCard) return false

  const lastAction = hand.actions[hand.actions.length - 1]
  if (!lastAction) return false

  const lastBetStreet = getStreetFromActionIndex(hand.actions, hand.communityCards.length)
  const isRiverDecision = lastBetStreet >= 4

  return isRiverDecision && best.hand.rank > second.hand.rank
}

function getStreetFromActionIndex(actions: Array<{ timestamp: number }>, communityCount: number): number {
  if (communityCount <= 3) return 2
  if (communityCount === 4) return 3
  return 4
}

function compareRanks(a: HandRank, b: HandRank): number {
  return a - b
}

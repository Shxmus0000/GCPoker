import {
  ActionType, Card, GameState, HandRank, PlayerAction, Rank,
} from '@gcpoker/shared'
import { evaluateHand } from './evaluator'

const AI_NAMES = [
  'Bot-Alice', 'Bot-Bob', 'Bot-Charlie', 'Bot-Diana', 'Bot-Evan',
]

export function generateAINames(count: number, start = 0): string[] {
  return AI_NAMES.slice(start, start + count)
}

export function isAI(id: string): boolean {
  return id.startsWith('ai-')
}

// ─── Pre-flop hand strength ─────────────────────────────

function preflopStrength(cards: [Card, Card]): number {
  const [a, b] = cards
  const high = Math.max(a.rank, b.rank)
  const low = Math.min(a.rank, b.rank)
  const suited = a.suit === b.suit
  const pair = a.rank === b.rank

  if (pair) {
    if (high >= Rank.Ten) return 0.95  // TT+
    if (high >= Rank.Seven) return 0.75  // 77-99
    return 0.55  // 22-66
  }

  let strength = 0

  // High card value
  strength += (high - 2) / 12 * 0.5
  strength += (low - 2) / 12 * 0.2

  // Suited bonus
  if (suited) strength += 0.1

  // Connectedness bonus
  if (high - low === 1) strength += 0.08
  else if (high - low === 2) strength += 0.05

  return Math.min(strength, 0.9)
}

// ─── Hand rank to strength (post-flop) ──────────────────

function postflopStrength(handRank: HandRank, kickers: number[]): number {
  const base = handRank / 8
  const kickerBonus = (kickers[0] ?? 0) / 14 * 0.1
  return Math.min(base + kickerBonus, 1.0)
}

// ─── Decision ───────────────────────────────────────────

export function aiDecide(
  playerId: string,
  state: GameState,
  rng: () => number = Math.random,
): PlayerAction {
  const player = state.players.find(p => p.id === playerId)
  if (!player || !player.holeCards) throw new Error('AI player has no hand')

  const legal = getLegalActions(state, playerId)
  if (legal.length === 0) throw new Error('AI has no legal actions')

  // Determine hand strength
  let strength: number
  if (state.phase === 1) {
    // Pre-flop
    strength = preflopStrength(player.holeCards)
  } else {
    // Post-flop — use evaluator if community cards exist
    if (state.communityCards.length >= 3) {
      const hand = evaluateHand(player.holeCards, state.communityCards)
      strength = postflopStrength(hand.rank, hand.kickers)
    } else {
      strength = preflopStrength(player.holeCards)
    }
  }

  const toCall = state.currentBet - player.currentBet
  const pot = state.pot.main
  const potOdds = toCall > 0 && pot > 0 ? toCall / (pot + toCall) : 0

  // Fold weak hands facing a bet
  if (toCall > 0 && strength < 0.25 && rng() < 0.8) {
    return { playerId, type: ActionType.Fold, amount: 0, timestamp: Date.now() }
  }

  // Check if possible
  if (legal.includes(ActionType.Check)) {
    if (strength > 0.6 && rng() < strength * 0.6) {
      // Bet between 1/2 and 2/3 pot
      const bet = Math.min(
        Math.floor(pot * (0.4 + rng() * 0.3)),
        player.stack,
      )
      return { playerId, type: ActionType.Bet, amount: bet, timestamp: Date.now() }
    }
    return { playerId, type: ActionType.Check, amount: 0, timestamp: Date.now() }
  }

  // Must call, raise, or fold
  if (legal.includes(ActionType.Raise)) {
    if (strength > 0.7 && rng() < (strength - 0.5)) {
      const minRaise = state.currentBet + (state.lastRaise || state.blinds.big)
      const raise = Math.min(
        Math.floor(pot * (0.6 + rng() * 0.4)),
        player.stack + player.currentBet,
      )
      const amount = Math.max(minRaise, raise)
      return { playerId, type: ActionType.Raise, amount, timestamp: Date.now() }
    }
  }

  // Call if pot odds are favorable or hand is decent
  if (legal.includes(ActionType.Call)) {
    if (strength > potOdds + 0.1 || rng() < strength) {
      return { playerId, type: ActionType.Call, amount: toCall, timestamp: Date.now() }
    }
  }

  // Default: fold
  return { playerId, type: ActionType.Fold, amount: 0, timestamp: Date.now() }
}

// ─── Get legal actions helper (same logic as GameEngine) ─

function getLegalActions(state: GameState, playerId: string): ActionType[] {
  const player = state.players.find(p => p.id === playerId)
  if (!player || player.isFolded || player.isAllIn) return []

  const toCall = state.currentBet - player.currentBet

  if (toCall === 0) {
    if (state.currentBet === 0) {
      return [ActionType.Check, ActionType.Bet, ActionType.AllIn]
    }
    return [ActionType.Check, ActionType.Raise, ActionType.AllIn]
  }

  const actions: ActionType[] = [ActionType.Fold, ActionType.Call]
  if (player.stack > toCall) actions.push(ActionType.Raise)
  actions.push(ActionType.AllIn)
  return actions
}

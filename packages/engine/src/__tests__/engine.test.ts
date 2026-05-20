import { GameEngine } from '../game'
import { evaluateHand, compareHands, getWinner } from '../evaluator'
import {
  Card, Rank, Suit, ActionType, GamePhase, HandRank,
} from '@gcpoker/shared'

function act(game: GameEngine, playerId: string, type: ActionType, amount = 0) {
  game.processAction({ playerId, type, amount, timestamp: Date.now() })
}

// Seats for a fresh 3-player game (button starts at 0, advanced to p2 on first hand):
//   button = p2, SB = p3, BB = p1
// Preflop order: p2(btn) → p3(SB) → p1(BB)
// Postflop order: p3(SB) → p1(BB) → p2(btn)

const CONFIG = { smallBlind: 5, bigBlind: 10 }
const STACK = 200
const STACK3 = 200

function threePlayerGame(): GameEngine {
  const g = new GameEngine(CONFIG)
  g.addPlayer('p1', 'Alice', STACK)
  g.addPlayer('p2', 'Bob', STACK)
  g.addPlayer('p3', 'Charlie', STACK3)
  g.startHand()
  return g
}

// ─── Basic Engine ───────────────────────────────────────

describe('GameEngine', () => {
  it('should start a hand with 2 players', () => {
    const game = new GameEngine(CONFIG)
    game.addPlayer('p1', 'Alice', 500)
    game.addPlayer('p2', 'Bob', 500)
    game.startHand()

    const state = game.getState()
    expect(state.phase).toBe(GamePhase.PreFlop)
    expect(state.players.length).toBe(2)
    expect(state.players[0].holeCards).toBeDefined()
    expect(state.players[1].holeCards).toBeDefined()
  })

  it('should process a fold and end the hand', () => {
    const game = new GameEngine(CONFIG)
    game.addPlayer('p1', 'Alice', 500)
    game.addPlayer('p2', 'Bob', 500)
    game.startHand()

    // Heads-up: dealer/SB (p2) acts first
    const current = game.getState().players[game.getState().currentPlayerIndex]
    act(game, current.id, ActionType.Fold)

    const state = game.getState()
    expect(state.phase).toBe(GamePhase.Complete)
    // Winner started 500, posted BB(10), won pot(15) → 505
    expect(state.players.find(p => p.id !== current.id)!.stack).toBe(505)
  })

  it('should handle a full betting round heads-up', () => {
    const game = new GameEngine(CONFIG)
    game.addPlayer('p1', 'Alice', 500)
    game.addPlayer('p2', 'Bob', 500)
    game.startHand()

    // p2(SB/dealer) calls, p1(BB) checks
    act(game, 'p2', ActionType.Call)
    act(game, 'p1', ActionType.Check)

    const state = game.getState()
    expect(state.phase).toBe(GamePhase.Flop)
    expect(state.communityCards.length).toBe(3)
    expect(state.pot.main).toBe(20)
  })

  it('should reject out-of-turn actions', () => {
    const game = new GameEngine(CONFIG)
    game.addPlayer('p1', 'Alice', 500)
    game.addPlayer('p2', 'Bob', 500)
    game.startHand()

    expect(() => act(game, 'p1', ActionType.Call)).toThrow('Not your turn')
  })

  // ─── Multi-Way ─────────────────────────────────────────

  it('two folds leave one winner', () => {
    const game = threePlayerGame()
    // Preflop: p2(btn) folds, p3(SB) folds → p1(BB) wins
    act(game, 'p2', ActionType.Fold)
    act(game, 'p3', ActionType.Fold)

    const state = game.getState()
    expect(state.phase).toBe(GamePhase.Complete)
    // p1 wins blinds (15), started 200, posted 10 → 205
    expect(state.players.find(p => p.id === 'p1')!.stack).toBe(205)
  })

  it('three-way to the flop', () => {
    const game = threePlayerGame()
    // Preflop: p2(btn) calls, p3(SB) completes, p1(BB) checks
    act(game, 'p2', ActionType.Call)   // btn calls 10
    act(game, 'p3', ActionType.Call)   // SB completes (adds 5)
    act(game, 'p1', ActionType.Check)  // BB checks

    const state = game.getState()
    expect(state.phase).toBe(GamePhase.Flop)
    expect(state.communityCards.length).toBe(3)
    expect(state.pot.main).toBe(30)
  })

  it('deal through all streets to showdown', () => {
    const game = threePlayerGame()
    // Preflop: p2(btn) calls, p3(SB) completes, p1(BB) checks
    act(game, 'p2', ActionType.Call)
    act(game, 'p3', ActionType.Call)
    act(game, 'p1', ActionType.Check)
    // Flop: p3 → p1 → p2
    act(game, 'p3', ActionType.Check)
    act(game, 'p1', ActionType.Check)
    act(game, 'p2', ActionType.Check)
    // Turn: p3 → p1 → p2
    act(game, 'p3', ActionType.Check)
    act(game, 'p1', ActionType.Check)
    act(game, 'p2', ActionType.Check)
    // River: p3 → p1 → p2
    act(game, 'p3', ActionType.Check)
    act(game, 'p1', ActionType.Check)
    act(game, 'p2', ActionType.Check)

    const state = game.getState()
    expect(state.phase).toBe(GamePhase.Complete)
    expect(state.communityCards.length).toBe(5)
    // All money preserved (each put in 10, returned via showdown)
    expect(state.players.reduce((s, p) => s + p.stack, 0)).toBe(600)
  })

  // ─── Side Pots ─────────────────────────────────────────

  it('creates side pots with different stack all-ins', () => {
    // p1=100, p2=60, p3=200
    // btn=p2, sb=p3, bb=p1
    const game = new GameEngine(CONFIG)
    game.addPlayer('p1', 'Alice', 100)
    game.addPlayer('p2', 'Bob', 60)
    game.addPlayer('p3', 'Charlie', 200)
    game.startHand()

    // Preflop: p2(btn) calls, p3(SB) completes, p1(BB) shoves
    act(game, 'p2', ActionType.Call)   // btn calls 10
    act(game, 'p3', ActionType.Call)   // SB completes (adds 5)
    act(game, 'p1', ActionType.AllIn)  // BB all-in (100 total)
    // p1's shove re-opens — p2 calls off (60 total), p3 calls
    act(game, 'p2', ActionType.Call)   // btn calls (60 total, all-in)
    act(game, 'p3', ActionType.Call)   // SB calls (100 total)

    // Preflop done. p1&p2 all-in. Flop: p3 acts first.
    act(game, 'p3', ActionType.Check)
    act(game, 'p3', ActionType.Check)
    act(game, 'p3', ActionType.Check)

    const state = game.getState()
    expect(state.phase).toBe(GamePhase.Complete)

    // p1 totalBet=100, p2=60, p3=100. Total pot=260
    const total = state.players.reduce((s, p) => s + p.stack, 0)
    expect(total).toBe(360)
  })

  it('post-flop betting with one all-in creates side pot', () => {
    const game = new GameEngine(CONFIG)
    game.addPlayer('p1', 'Alice', 80)
    game.addPlayer('p2', 'Bob', 200)
    game.addPlayer('p3', 'Charlie', 200)
    game.startHand()

    // Preflop: p2(btn) calls, p3(SB) completes, p1(BB) checks
    act(game, 'p2', ActionType.Call)
    act(game, 'p3', ActionType.Call)
    act(game, 'p1', ActionType.Check)

    // Flop: p3(sb) → p1(bb) → p2(btn)
    act(game, 'p3', ActionType.Check)
    act(game, 'p1', ActionType.AllIn) // all-in for 70 remaining
    act(game, 'p2', ActionType.Fold)
    act(game, 'p3', ActionType.Fold)

    const state = game.getState()
    expect(state.phase).toBe(GamePhase.Complete)
    const p1 = state.players.find(p => p.id === 'p1')!
    expect(p1.stack).toBeGreaterThan(0)
  })
})

// ─── Hand Evaluator ──────────────────────────────────────

describe('HandEvaluator', () => {
  it('should detect a pair', () => {
    const hand: [Card, Card] = [
      { rank: Rank.Ace, suit: Suit.Hearts },
      { rank: Rank.Ace, suit: Suit.Diamonds },
    ]
    const board: Card[] = [
      { rank: Rank.Two, suit: Suit.Clubs },
      { rank: Rank.Five, suit: Suit.Spades },
      { rank: Rank.Nine, suit: Suit.Hearts },
      { rank: Rank.Jack, suit: Suit.Diamonds },
      { rank: Rank.Three, suit: Suit.Spades },
    ]
    const result = evaluateHand(hand, board)
    expect(result.rank).toBe(HandRank.OnePair)
  })

  it('should detect a flush', () => {
    const hand: [Card, Card] = [
      { rank: Rank.Ace, suit: Suit.Hearts },
      { rank: Rank.King, suit: Suit.Hearts },
    ]
    const board = [
      { rank: Rank.Two, suit: Suit.Hearts },
      { rank: Rank.Five, suit: Suit.Hearts },
      { rank: Rank.Nine, suit: Suit.Hearts },
      { rank: Rank.Jack, suit: Suit.Diamonds },
      { rank: Rank.Three, suit: Suit.Spades },
    ]
    const result = evaluateHand(hand, board)
    expect(result.rank).toBe(HandRank.Flush)
  })

  it('should detect a straight', () => {
    const hand = [
      { rank: Rank.Nine, suit: Suit.Hearts },
      { rank: Rank.Ten, suit: Suit.Diamonds },
    ]
    const board = [
      { rank: Rank.Jack, suit: Suit.Clubs },
      { rank: Rank.Queen, suit: Suit.Spades },
      { rank: Rank.King, suit: Suit.Hearts },
      { rank: Rank.Two, suit: Suit.Diamonds },
      { rank: Rank.Three, suit: Suit.Spades },
    ]
    const result = evaluateHand(hand, board)
    expect(result.rank).toBe(HandRank.Straight)
  })

  it('should detect a full house', () => {
    const hand = [
      { rank: Rank.Ace, suit: Suit.Hearts },
      { rank: Rank.Ace, suit: Suit.Diamonds },
    ]
    const board = [
      { rank: Rank.Ace, suit: Suit.Clubs },
      { rank: Rank.King, suit: Suit.Spades },
      { rank: Rank.King, suit: Suit.Hearts },
      { rank: Rank.Two, suit: Suit.Diamonds },
      { rank: Rank.Three, suit: Suit.Spades },
    ]
    const result = evaluateHand(hand, board)
    expect(result.rank).toBe(HandRank.FullHouse)
  })

  it('should detect four of a kind', () => {
    const hand = [
      { rank: Rank.Ace, suit: Suit.Hearts },
      { rank: Rank.Ace, suit: Suit.Diamonds },
    ]
    const board = [
      { rank: Rank.Ace, suit: Suit.Clubs },
      { rank: Rank.Ace, suit: Suit.Spades },
      { rank: Rank.King, suit: Suit.Hearts },
      { rank: Rank.Two, suit: Suit.Diamonds },
      { rank: Rank.Three, suit: Suit.Spades },
    ]
    const result = evaluateHand(hand, board)
    expect(result.rank).toBe(HandRank.FourOfAKind)
  })

  it('should compare hands correctly', () => {
    const pair = {
      rank: HandRank.OnePair,
      kickers: [Rank.Ace, Rank.King, Rank.Queen, Rank.Jack],
      bestCards: [],
    }
    const highCard = {
      rank: HandRank.HighCard,
      kickers: [Rank.Ace, Rank.King, Rank.Queen, Rank.Jack, Rank.Nine],
      bestCards: [],
    }
    expect(compareHands(pair, highCard)).toBeGreaterThan(0)
  })

  it('should find the correct winner', () => {
    const winner = { playerId: 'p1', hand: { rank: HandRank.Flush, kickers: [], bestCards: [] } }
    const loser = { playerId: 'p2', hand: { rank: HandRank.HighCard, kickers: [], bestCards: [] } }
    const result = getWinner([loser, winner])
    expect(result[0].playerId).toBe('p1')
  })

  it('should detect ace-low straight', () => {
    const hand = [
      { rank: Rank.Ace, suit: Suit.Hearts },
      { rank: Rank.Two, suit: Suit.Diamonds },
    ]
    const board = [
      { rank: Rank.Three, suit: Suit.Clubs },
      { rank: Rank.Four, suit: Suit.Spades },
      { rank: Rank.Five, suit: Suit.Hearts },
      { rank: Rank.Nine, suit: Suit.Diamonds },
      { rank: Rank.Queen, suit: Suit.Spades },
    ]
    const result = evaluateHand(hand, board)
    expect(result.rank).toBe(HandRank.Straight)
  })
})

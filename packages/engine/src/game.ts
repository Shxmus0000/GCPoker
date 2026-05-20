import {
  GameState, GamePhase, GameVariant, GameFormat,
  Player, PlayerAction, ActionType, Card, Pot,
} from '@gcpoker/shared'
import { createDeck, shuffle, dealCards } from './deck'
import { evaluateHand, getWinner } from './evaluator'
import {
  generateServerSeed, generateClientSeed, computeCombinedSeed,
  provablyFairShuffle,
} from './crypto'
import { storeHand, HandRecord } from './handHistory'

export interface GameConfig {
  variant?: GameVariant
  format?: GameFormat
  smallBlind?: number
  bigBlind?: number
  maxPlayers?: number
  minPlayers?: number
  buyIn?: number
}

interface PotAssignment {
  amount: number
  eligiblePlayerIds: string[]
}

export class GameEngine {
  private state: GameState

  constructor(config: GameConfig = {}) {
    this.state = this.createInitialState(config)
  }

  getState(): GameState {
    return this.state
  }

  addPlayer(id: string, name: string, stack: number): void {
    if (this.state.players.length >= 9) throw new Error('Table full')
    if (this.state.phase !== GamePhase.Waiting) throw new Error('Game in progress')

    const seatIndex = this.findEmptySeat()
    this.state.players.push({
      id,
      name,
      stack,
      holeCards: undefined,
      seatIndex,
      isDealer: false,
      currentBet: 0,
      isFolded: false,
      isAllIn: false,
      actedThisRound: false,
      totalBet: 0,
    })

  }

  removePlayer(id: string): void {
    this.state.players = this.state.players.filter(p => p.id !== id)
    const realPlayers = this.state.players.filter(p => !p.id.startsWith('ai-'))
    if (realPlayers.length === 0) {
      this.state.phase = GamePhase.Waiting
      this.state.communityCards = []
      this.state.pot = { main: 0, sidePots: [] }
      this.state.currentBet = 0
      this.state.lastRaise = 0
      this.state.deck = []
      this.state.currentPlayerIndex = -1
      this.state.actionHistory = []
      for (const p of this.state.players) {
        p.holeCards = undefined
        p.currentBet = 0
        p.totalBet = 0
        p.isFolded = false
        p.isAllIn = false
        p.actedThisRound = false
        p.cardsRevealed = false
        p.bestHand = undefined
      }
    }
  }

  // ─── Hand Lifecycle ────────────────────────────────────

  startHand(): boolean {
    this.state.phase = GamePhase.Waiting
    const players = this.getActivePlayers()
    if (players.length < 2) return false

    // Reset player states
    for (const p of this.state.players) {
      p.holeCards = undefined
      p.currentBet = 0
      p.isFolded = false
      p.isAllIn = false
      p.actedThisRound = false
      p.totalBet = 0
      p.cardsRevealed = false
      p.bestHand = undefined
    }

    // Advance button
    this.state.buttonIndex = this.nextActiveIndex(this.state.buttonIndex)
    this.state.handCount++

    // Provably fair deck generation
    const serverSeed = generateServerSeed()
    const clientSeed = generateClientSeed()
    const nonce = this.state.handCount
    const combinedSeed = computeCombinedSeed(serverSeed, clientSeed, nonce)
    this.state.serverSeed = serverSeed
    this.state.clientSeed = clientSeed
    this.state.nonce = nonce

    const deck = provablyFairShuffle(combinedSeed)
    this.state.deck = deck
    this.state.communityCards = []

    // Reset pot
    this.state.pot = { main: 0, sidePots: [] }

    // Post blinds
    this.postBlinds()

    // Deal hole cards
    let remaining = deck
    for (const p of players) {
      const result = dealCards(remaining, 2)
      p.holeCards = result.cards as [Card, Card]
      remaining = result.remaining
    }
    this.state.deck = remaining

    // Set first to act
    this.state.phase = GamePhase.PreFlop
    this.state.currentPlayerIndex = this.getUTGIndex()
    this.state.actionHistory = []
    return true
  }

  toggleCardsRevealed(playerId: string): void {
    const player = this.state.players.find(p => p.id === playerId)
    if (player && player.holeCards) {
      player.cardsRevealed = !player.cardsRevealed
    }
  }

  // ─── Actions ───────────────────────────────────────────

  getLegalActions(playerId: string): ActionType[] {
    const player = this.state.players.find(p => p.id === playerId)
    if (!player || player.isFolded || player.isAllIn) return []

    const toCall = this.state.currentBet - player.currentBet

    if (toCall === 0) {
      if (this.state.currentBet === 0) {
        return [ActionType.Check, ActionType.Bet, ActionType.AllIn]
      }
      return [ActionType.Check, ActionType.Raise, ActionType.AllIn]
    }

    const actions: ActionType[] = [ActionType.Fold, ActionType.Call]
    if (player.stack > toCall) {
      actions.push(ActionType.Raise)
    }
    if (player.stack > 0) {
      actions.push(ActionType.AllIn)
    }
    return actions
  }

  processAction(action: PlayerAction): void {
    const player = this.state.players.find(p => p.id === action.playerId)
    if (!player) throw new Error('Player not found')

    const currentPlayer = this.state.players[this.state.currentPlayerIndex]
    if (!currentPlayer || currentPlayer.id !== action.playerId) {
      throw new Error(`Not your turn: ${action.playerId}`)
    }

    const legal = this.getLegalActions(action.playerId)
    if (!legal.includes(action.type)) {
      throw new Error(`Illegal action: ${action.type} for player ${action.playerId}`)
    }

    player.actedThisRound = true

    const allInEffectiveBet = action.type === ActionType.AllIn ? player.currentBet + player.stack : 0
    const isAggressive = action.type === ActionType.Bet
                       || action.type === ActionType.Raise
                       || (action.type === ActionType.AllIn && allInEffectiveBet > this.state.currentBet)

    switch (action.type) {
      case ActionType.Fold:
        player.isFolded = true
        break

      case ActionType.Check:
        break

      case ActionType.Call: {
        const toCall = this.state.currentBet - player.currentBet
        const callAmount = Math.min(toCall, player.stack)
        player.stack -= callAmount
        player.currentBet += callAmount
        if (player.stack === 0) player.isAllIn = true
        break
      }

      case ActionType.Bet:
      case ActionType.Raise: {
        const totalBet = action.amount
        const added = totalBet - player.currentBet
        player.stack -= added
        player.currentBet = totalBet
        this.state.currentBet = totalBet
        this.state.lastRaise = totalBet
        if (player.stack === 0) player.isAllIn = true
        break
      }

      case ActionType.AllIn: {
        const allInAmount = player.stack
        player.currentBet += allInAmount
        player.stack = 0
        player.isAllIn = true
        if (player.currentBet > this.state.currentBet) {
          this.state.currentBet = player.currentBet
        }
        break
      }
    }

    // When someone raises, everyone else needs to act again
    if (isAggressive) {
      for (const p of this.state.players) {
        if (p.id !== player.id && !p.isFolded && !p.isAllIn) {
          p.actedThisRound = false
        }
      }
    }

    this.state.actionHistory.push(action)

    if (this.isBettingRoundComplete()) {
      this.advancePhase()
    } else {
      this.advancePlayer()
    }
  }

  // ─── Phase Transitions ─────────────────────────────────

  private advancePhase(): void {
    // Move current bets into total tracking
    this.collectBets()

    const activePlayers = this.state.players.filter(p => !p.isFolded)

    // If only one player left, they win
    if (activePlayers.length <= 1) {
      this.resolveHand(activePlayers[0])
      return
    }

    switch (this.state.phase) {
      case GamePhase.PreFlop:
        this.state.phase = GamePhase.Flop
        this.dealCommunity(3)
        break
      case GamePhase.Flop:
        this.state.phase = GamePhase.Turn
        this.dealCommunity(1)
        break
      case GamePhase.Turn:
        this.state.phase = GamePhase.River
        this.dealCommunity(1)
        break
      case GamePhase.River:
        this.state.phase = GamePhase.Showdown
        this.runShowdown()
        return
    }

    // Reset for new betting round
    for (const p of this.state.players) {
      if (!p.isFolded && !p.isAllIn) p.actedThisRound = false
    }
    this.state.currentBet = 0

    // If no one can act (all all-in or folded), reveal all cards and auto-advance
    const canAct = this.state.players.filter(p => !p.isFolded && !p.isAllIn)
    if (canAct.length === 0) {
      this.revealAllCards()
      this.autoAdvanceToShowdown()
      return
    }

    this.state.currentPlayerIndex = this.firstToActAfterFlop()
  }

  private revealAllCards(): void {
    for (const p of this.state.players) {
      if (!p.isFolded && p.holeCards) {
        p.cardsRevealed = true
      }
    }
  }

  private autoAdvanceToShowdown(): void {
    while (this.state.phase !== GamePhase.Showdown && this.state.phase !== GamePhase.Complete) {
      switch (this.state.phase) {
        case GamePhase.Flop:
          this.state.phase = GamePhase.Turn
          this.dealCommunity(1)
          break
        case GamePhase.Turn:
          this.state.phase = GamePhase.River
          this.dealCommunity(1)
          break
        case GamePhase.River:
          this.state.phase = GamePhase.Showdown
          this.runShowdown()
          return
      }
    }
  }

  // ─── Pot Distribution ──────────────────────────────────

  private collectBets(): void {
    for (const p of this.state.players) {
      p.totalBet += p.currentBet
      p.currentBet = 0
    }
    this.state.pot.main = this.state.players.reduce((s, p) => s + p.totalBet, 0)
  }

  private computePots(): PotAssignment[] {
    const involved = this.state.players.filter(p => p.totalBet > 0)
    const levels = [...new Set(involved.map(p => p.totalBet))].sort((a, b) => a - b)

    const pots: PotAssignment[] = []
    let previousLevel = 0

    for (const level of levels) {
      const contribution = level - previousLevel
      const contributors = involved.filter(p => p.totalBet >= level)
      const amount = contributors.length * contribution

      pots.push({
        amount,
        eligiblePlayerIds: involved
          .filter(p => p.totalBet >= level && !p.isFolded)
          .map(p => p.id),
      })

      previousLevel = level
    }

    return pots
  }

  private runShowdown(): void {
    const pots = this.computePots()
    this.state.pot.sidePots = pots.map(p => ({
      amount: p.amount,
      eligiblePlayerIds: p.eligiblePlayerIds,
    }))

    // Reveal non-folded players' cards and evaluate their best hand
    for (const p of this.state.players) {
      if (!p.isFolded && p.holeCards && this.state.communityCards.length >= 3) {
        p.cardsRevealed = true
        p.bestHand = evaluateHand(p.holeCards, this.state.communityCards)
      }
    }

    const winners: Array<{ playerId: string; amount: number }> = []

    for (const pot of pots) {
      const eligiblePlayers = this.state.players.filter(
        p => pot.eligiblePlayerIds.includes(p.id)
      )

      const results = eligiblePlayers.map(p => ({
        playerId: p.id,
        hand: p.bestHand ?? evaluateHand(p.holeCards!, this.state.communityCards),
      }))

      const potWinners = getWinner(results)
      const share = Math.floor(pot.amount / potWinners.length)

      for (const w of potWinners) {
        const player = this.state.players.find(p => p.id === w.playerId)!
        player.stack += share
        winners.push({ playerId: w.playerId, amount: share })
      }
    }

    this.state.phase = GamePhase.Complete
    for (const p of this.state.players) p.totalBet = 0

    this.recordHand(winners)
  }

  private resolveHand(winner: Player): void {
    this.state.phase = GamePhase.Complete
    this.collectBets()
    const totalPot = this.state.players.reduce((s, p) => s + p.totalBet, 0)
    winner.stack += totalPot
    for (const p of this.state.players) p.totalBet = 0

    this.recordHand([{ playerId: winner.id, amount: totalPot }])
  }

  private recordHand(winners: Array<{ playerId: string; amount: number }>): void {
    const players = this.state.players
    const hands = players
      .filter(p => p.holeCards && !p.id.startsWith('sys-'))
      .map(p => ({
        playerId: p.id,
        hand: this.state.phase === GamePhase.Showdown
          ? evaluateHand(p.holeCards!, this.state.communityCards)
          : null,
      }))

    const record: HandRecord = {
      handId: this.state.handCount,
      tableId: this.state.tableId ?? 'unknown',
      timestamp: Date.now(),
      serverSeed: this.state.serverSeed ?? '',
      clientSeed: this.state.clientSeed ?? '',
      nonce: this.state.nonce ?? 0,
      players: players
        .filter(p => !p.id.startsWith('sys-'))
        .map(p => ({
          id: p.id,
          name: p.name,
          holeCards: p.holeCards ?? null,
          stackAtStart: p.stack + p.totalBet,
          stackAtEnd: p.stack,
        })),
      communityCards: [...this.state.communityCards],
      actions: [...this.state.actionHistory],
      pots: [this.state.pot],
      hands,
      winners,
      blinds: { ...this.state.blinds },
    }

    storeHand(record)
  }

  // ─── Player Rotation ───────────────────────────────────

  private advancePlayer(): void {
    this.state.currentPlayerIndex = this.nextActiveIndex(
      this.state.currentPlayerIndex
    )
  }

  private nextActiveIndex(current: number): number {
    const players = this.state.players
    for (let i = 1; i <= players.length; i++) {
      const idx = (current + i) % players.length
      const p = players[idx]
      if (!p.isFolded && !p.isAllIn && p.stack > 0) return idx
    }
    return current
  }

  private isBettingRoundComplete(): boolean {
    const remaining = this.state.players.filter(p => !p.isFolded)
    if (remaining.length <= 1) return true

    const canAct = remaining.filter(p => !p.isAllIn)
    if (canAct.length === 0) return true

    return canAct.every(
      p => p.currentBet === this.state.currentBet && p.actedThisRound
    )
  }

  private firstToActAfterFlop(): number {
    return this.nextActiveIndex(this.state.buttonIndex)
  }

  private getUTGIndex(): number {
    const players = this.getActivePlayers()
    if (players.length === 2) {
      // Heads-up: button/SB acts first pre-flop
      return this.state.buttonIndex
    }
    // Multi-way: player to the left of the big blind acts first
    const sbIdx = this.nextActiveIndex(this.state.buttonIndex)
    const bbIdx = this.nextActiveIndex(sbIdx)
    return this.nextActiveIndex(bbIdx)
  }

  // ─── Dealing ───────────────────────────────────────────

  private dealCommunity(count: number): void {
    const [, ...rest] = this.state.deck
    const result = dealCards(rest, count)
    this.state.communityCards.push(...result.cards)
    this.state.deck = result.remaining
  }

  // ─── Blinds ────────────────────────────────────────────

  private postBlinds(): void {
    const players = this.getActivePlayers()
    const isHeadsUp = players.length === 2
    const sbIdx = isHeadsUp ? this.state.buttonIndex : this.nextActiveIndex(this.state.buttonIndex)
    const bbIdx = this.nextActiveIndex(sbIdx)

    players[sbIdx].stack -= this.state.blinds.small
    players[sbIdx].currentBet = this.state.blinds.small
    players[bbIdx].stack -= this.state.blinds.big
    players[bbIdx].currentBet = this.state.blinds.big
    this.state.currentBet = this.state.blinds.big
  }

  // ─── Helpers ───────────────────────────────────────────

  private getActivePlayers(): Player[] {
    return this.state.players.filter(p => p.stack > 0)
  }

  private findEmptySeat(): number {
    const taken = new Set(this.state.players.map(p => p.seatIndex))
    for (let i = 0; i < 9; i++) {
      if (!taken.has(i)) return i
    }
    throw new Error('No seats available')
  }

  private createInitialState(config: GameConfig): GameState {
    return {
      id: crypto.randomUUID?.() ?? Math.random().toString(36),
      variant: config.variant ?? GameVariant.TexasHoldem,
      format: config.format ?? GameFormat.Cash,
      phase: GamePhase.Waiting,
      players: [],
      communityCards: [],
      deck: [],
      pot: { main: 0, sidePots: [] },
      currentPlayerIndex: 0,
      dealerIndex: 0,
      buttonIndex: 0,
      minBet: config.bigBlind ?? 10,
      maxBet: Infinity,
      currentBet: 0,
      lastRaise: 0,
      actionHistory: [],
      handCount: 0,
      blinds: {
        small: config.smallBlind ?? 5,
        big: config.bigBlind ?? 10,
      },
    }
  }
}

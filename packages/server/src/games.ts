import { Router, Request, Response } from 'express'
import { v4 as uuid } from 'uuid'
import { GameEngine, calculatePayouts, calculateStartingBlinds } from '@gcpoker/engine'
import {
  PlayerGame, PlayerGameSummary, GameStatus, PlayerGamePlayer,
  GamePhase, GameFormat, GameVariant, TableStatus, ActionType,
  PlayerAction,
} from '@gcpoker/shared'
import { getSessionUser, debitBalance, creditBalance } from './users'

// ─── Game Store ─────────────────────────────────────────

const games = new Map<string, PlayerGame>()
const gameEngines = new Map<string, GameEngine>()

// ─── Router ─────────────────────────────────────────────

export const gameRouter = Router()

// List all joinable games
gameRouter.get('/', (_req, res) => {
  const list: PlayerGameSummary[] = []
  for (const [id, game] of games) {
    const { smallBlind, bigBlind } = calculateStartingBlinds(game.startingChips)
    list.push({
      id, name: game.name, creatorId: game.creatorId, creatorName: game.creatorName,
      maxPlayers: game.maxPlayers, buyIn: game.buyIn,
      startingChips: game.startingChips,
      smallBlind, bigBlind,
      status: game.status,
      playerCount: game.players.length,
      prizePool: Math.floor(game.buyIn * game.maxPlayers * 0.9),
    })
  }
  res.json(list)
})

// Create a new game
gameRouter.post('/create', (req, res) => {
  const { name, maxPlayers, buyIn, startingChips, token } = req.body
  if (!name || !maxPlayers || !buyIn || !startingChips || !token) {
    return res.status(400).json({ error: 'name, maxPlayers, buyIn, startingChips, token required' })
  }

  const user = getSessionUser(token)
  if (!user) return res.status(401).json({ error: 'Not authenticated' })

  if (maxPlayers < 2 || maxPlayers > 9) {
    return res.status(400).json({ error: 'maxPlayers must be 2-9' })
  }
  if (buyIn < 1) return res.status(400).json({ error: 'buyIn must be at least 1' })
  if (startingChips < 100) return res.status(400).json({ error: 'startingChips must be at least 100' })
  if (user.balance < buyIn) return res.status(400).json({ error: 'Insufficient balance' })

  const id = uuid().slice(0, 8)
  const { smallBlind, bigBlind } = calculateStartingBlinds(startingChips)

  const game: PlayerGame = {
    id, name, creatorId: user.id, creatorName: user.name,
    maxPlayers, buyIn, startingChips,
    smallBlind, bigBlind,
    status: GameStatus.Waiting,
    players: [], createdAt: Date.now(),
  }

  games.set(id, game)

  res.json({ id, game })
})

// Get game detail
gameRouter.get('/:id', (req, res) => {
  const game = games.get(req.params.id)
  if (!game) return res.status(404).json({ error: 'Game not found' })
  res.json(game)
})

// Join a game (returns game state; caller should then wire up socket for real-time play)
gameRouter.post('/:id/join', (req, res) => {
  const { token } = req.body
  const game = games.get(req.params.id)
  if (!game) return res.status(404).json({ error: 'Game not found' })

  const user = getSessionUser(token)
  if (!user) return res.status(401).json({ error: 'Not authenticated' })

  if (game.status !== GameStatus.Waiting) return res.status(400).json({ error: 'Game already started' })
  if (game.players.find(p => p.userId === user.id)) return res.status(400).json({ error: 'Already joined' })
  if (game.players.length >= game.maxPlayers) return res.status(400).json({ error: 'Game full' })
  if (user.balance < game.buyIn) return res.status(400).json({ error: 'Insufficient balance' })

  // Debit buy-in
  debitBalance(user.id, game.buyIn)

  game.players.push({
    userId: user.id, name: user.name,
    stack: game.startingChips,
  })

  // Auto-start when full
  if (game.players.length >= game.maxPlayers) {
    startGame(game)
  }

  res.json({ game, isReady: game.status !== GameStatus.Waiting })
})

// Leave a game (before it starts)
gameRouter.post('/:id/leave', (req, res) => {
  const { token } = req.body
  const game = games.get(req.params.id)
  if (!game) return res.status(404).json({ error: 'Game not found' })

  const user = getSessionUser(token)
  if (!user) return res.status(401).json({ error: 'Not authenticated' })

  const idx = game.players.findIndex(p => p.userId === user.id)
  if (idx === -1) return res.status(400).json({ error: 'Not in this game' })

  if (game.status !== GameStatus.Waiting) return res.status(400).json({ error: 'Game already started' })

  game.players.splice(idx, 1)
  creditBalance(user.id, game.buyIn)

  res.json({ ok: true })
})

// Cancel a game (creator only, before it starts)
gameRouter.post('/:id/cancel', (req, res) => {
  const { token } = req.body
  const game = games.get(req.params.id)
  if (!game) return res.status(404).json({ error: 'Game not found' })

  const user = getSessionUser(token)
  if (!user) return res.status(401).json({ error: 'Not authenticated' })

  if (game.creatorId !== user.id) return res.status(403).json({ error: 'Only the creator can cancel' })
  if (game.status !== GameStatus.Waiting) return res.status(400).json({ error: 'Game already started' })

  // Refund all players
  for (const p of game.players) {
    creditBalance(p.userId, game.buyIn)
  }

  games.delete(req.params.id)
  res.json({ ok: true })
})

// ─── Game Start Callback ────────────────────────────────

let onGameStartCallback: ((gameId: string) => void) | null = null

export function setOnGameStartCallback(cb: (gameId: string) => void): void {
  onGameStartCallback = cb
}

// ─── Internal Functions ─────────────────────────────────

function startGame(game: PlayerGame): void {
  game.status = GameStatus.Playing

  const { smallBlind, bigBlind } = calculateStartingBlinds(game.startingChips)

  const engine = new GameEngine({ smallBlind, bigBlind })

  for (const p of game.players) {
    engine.addPlayer(p.userId, p.name, p.stack)
  }

  gameEngines.set(game.id, engine)
  engine.startHand()

  if (onGameStartCallback) {
    onGameStartCallback(game.id)
  }
}

export function getGameEngine(gameId: string): GameEngine | undefined {
  return gameEngines.get(gameId)
}

export function getGame(gameId: string): PlayerGame | undefined {
  return games.get(gameId)
}

// Called by socket.io handler to process actions during a game
export function processGameAction(gameId: string, action: PlayerAction): PlayerGame | null {
  const game = games.get(gameId)
  const engine = gameEngines.get(gameId)
  if (!game || !engine) return null

  engine.processAction(action)

  const state = engine.getState()

  // On hand complete, check eliminations (do NOT auto-start next hand)
  if (state.phase === GamePhase.Complete) {
    checkGameEliminations(game, engine)

    // Check for game over
    const alive = state.players.filter(p => p.stack > 0)
    if (alive.length <= 1) {
      endGame(game, engine, alive[0]?.id)
    }
  }

  return game
}

function checkGameEliminations(game: PlayerGame, engine: GameEngine): void {
  const state = engine.getState()
  for (const p of game.players) {
    if (!p.finishPosition) {
      const enginePlayer = state.players.find(sp => sp.id === p.userId)
      if (enginePlayer && enginePlayer.stack <= 0) {
        p.finishPosition = game.players.filter(pp => pp.finishPosition).length + 1
      }
    }
  }
}

function endGame(game: PlayerGame, engine: GameEngine, winnerId?: string): void {
  game.status = GameStatus.Complete

  // Eliminate remaining players who haven't been eliminated
  const state = engine.getState()
  for (const p of game.players) {
    if (!p.finishPosition) {
      const enginePlayer = state.players.find(sp => sp.id === p.userId)
      if (enginePlayer && enginePlayer.stack <= 0) {
        p.finishPosition = game.players.filter(pp => pp.finishPosition).length + 1
      }
    }
  }

  // Mark winner
  const winner = game.players.find(p => p.userId === winnerId)
  if (winner) {
    winner.finishPosition = 1
  }

  // Distribute payouts
  const payouts = calculatePayouts(game.players.length, game.buyIn)
  const sorted = [...game.players].sort((a, b) => (a.finishPosition ?? 999) - (b.finishPosition ?? 999))
  for (let i = 0; i < payouts.prizes.length && i < sorted.length; i++) {
    if (sorted[i].finishPosition) {
      creditBalance(sorted[i].userId, payouts.prizes[i])
    }
  }

  // Clean up engine after a delay
  setTimeout(() => {
    gameEngines.delete(game.id)
  }, 60000)
}

export function getJoinableGames(): PlayerGameSummary[] {
  const list: PlayerGameSummary[] = []
  for (const [id, game] of games) {
    if (game.status === GameStatus.Waiting || game.status === GameStatus.Playing) {
      const { smallBlind, bigBlind } = calculateStartingBlinds(game.startingChips)
      list.push({
        id, name: game.name, creatorId: game.creatorId, creatorName: game.creatorName,
        maxPlayers: game.maxPlayers, buyIn: game.buyIn,
        startingChips: game.startingChips,
        smallBlind, bigBlind, status: game.status,
        playerCount: game.players.length,
        prizePool: Math.floor(game.buyIn * game.maxPlayers * 0.9),
      })
    }
  }
  return list
}

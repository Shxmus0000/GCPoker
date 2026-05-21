import { Router, Request, Response } from 'express'
import { v4 as uuid } from 'uuid'
import {
  TournamentConfig, TournamentState, TournamentStatus,
  TournamentFormat, TournamentSummary, BlindLevel,
} from '@gcpoker/shared'
import { TournamentEngine, calculatePayouts, generateBlindLevels } from '@gcpoker/engine'
import { getSessionUser, debitBalance, creditBalance } from './users'
import { emitServerEvent } from './events'
import { readJSON, writeJSON } from './db'

// ─── Tournament Store ───────────────────────────────────

const TOURNAMENTS_FILE = 'tournaments.json'

function loadTournaments(): Map<string, TournamentEngine> {
  const data = readJSON<Array<{ id: string; config: TournamentConfig }>>(TOURNAMENTS_FILE, [])
  const map = new Map<string, TournamentEngine>()
  for (const entry of data) {
    const engine = new TournamentEngine(entry.config)
    engine.setOnStartCallback((tid) => {
      emitServerEvent('tournament:started', tid, entry.config.name)
    })
    engine.setOnEndCallback((state) => {
      const statePrizes = engine.getPrizes()
      for (const player of state.players) {
        if (player.finishPosition && player.finishPosition <= statePrizes.length) {
          const prize = statePrizes[player.finishPosition - 1]
          if (prize > 0) {
            creditBalance(player.userId, prize)
          }
        }
      }
      emitServerEvent('tournament:ended', state)
    })
    map.set(entry.id, engine)
  }
  return map
}

function saveTournaments(): void {
  const arr: Array<{ id: string; config: TournamentConfig }> = []
  for (const [id, engine] of tournaments) {
    arr.push({ id, config: engine.getConfig() })
  }
  writeJSON(TOURNAMENTS_FILE, arr)
}

// ─── Default Tournament Templates ───────────────────────

function generateBlindLevelsFor(startingChips: number, isMultiTable: boolean): BlindLevel[] {
  return generateBlindLevels(startingChips, isMultiTable).map(l => ({
    level: l.level,
    smallBlind: l.smallBlind,
    bigBlind: l.bigBlind,
    duration: l.duration,
  }))
}

function generatePrizePercentages(playerCount: number): number[] {
  if (playerCount < 2) return []
  const { prizePool, prizes } = calculatePayouts(playerCount, 100)
  // Convert fixed amounts to percentages
  const remaining = prizes.reduce((s, p) => s + p, 0)
  if (remaining === 0) return []
  return prizes.map(p => p / remaining)
}

// ─── Merge persisted tournaments with defaults ────────────

const tournaments = loadTournaments()

function createDefaultTournaments(): void {
  const defaults: TournamentConfig[] = [
    {
      id: 'sng-6',
      name: 'Turbo SNG (6-max)',
      format: TournamentFormat.SitNGo,
      buyIn: 50,
      rake: 0.10,
      startingStack: 1500,
      maxPlayers: 6,
      maxPerTable: 6,
      minPlayers: 2,
      lateRegistrationMinutes: 0,
      rebuyDuration: 0,
      blindLevels: generateBlindLevelsFor(1500, false),
      prizeStructure: generatePrizePercentages(6),
    },
    {
      id: 'sng-8',
      name: 'SNG (8-max)',
      format: TournamentFormat.SitNGo,
      buyIn: 100,
      rake: 0.10,
      startingStack: 3000,
      maxPlayers: 8,
      maxPerTable: 8,
      minPlayers: 2,
      lateRegistrationMinutes: 0,
      rebuyDuration: 0,
      blindLevels: generateBlindLevelsFor(3000, false),
      prizeStructure: generatePrizePercentages(9),
    },
    {
      id: 'mtt-daily',
      name: 'Daily Freezeout MTT',
      format: TournamentFormat.MultiTable,
      buyIn: 200,
      rake: 0.10,
      startingStack: 5000,
      maxPlayers: 100,
      maxPerTable: 8,
      minPlayers: 10,
      lateRegistrationMinutes: 30,
      rebuyDuration: 0,
      blindLevels: generateBlindLevelsFor(5000, true),
      prizeStructure: generatePrizePercentages(100),
    },
  ]

  for (const cfg of defaults) {
    if (!tournaments.has(cfg.id)) {
      const engine = new TournamentEngine(cfg)
      engine.setOnStartCallback((tid) => {
        emitServerEvent('tournament:started', tid, cfg.name)
      })
      engine.setOnEndCallback((state) => {
        const statePrizes = engine.getPrizes()
        for (const player of state.players) {
          if (player.finishPosition && player.finishPosition <= statePrizes.length) {
            const prize = statePrizes[player.finishPosition - 1]
            if (prize > 0) {
              creditBalance(player.userId, prize)
            }
          }
        }
        emitServerEvent('tournament:ended', state)
      })
      tournaments.set(cfg.id, engine)
    }
  }
  saveTournaments()
}

createDefaultTournaments()

// ─── Router ─────────────────────────────────────────────

export const tournamentRouter = Router()

// List all tournaments
tournamentRouter.get('/', (_req, res) => {
  const list: TournamentSummary[] = [...tournaments.entries()].map(([id, eng]) => {
    const cfg = eng.getConfig()
    const state = eng.getState()
    return {
      id,
      name: cfg.name,
      format: cfg.format,
      status: state.status,
      buyIn: cfg.buyIn,
      prizePool: state.prizePool || cfg.buyIn * state.registrations * (1 - cfg.rake),
      maxPlayers: cfg.maxPlayers,
      maxPerTable: cfg.maxPerTable,
      registrations: state.registrations,
      currentLevel: state.currentLevel + 1,
      creatorId: cfg.creatorId,
      creatorName: cfg.creatorName,
    }
  })
  res.json(list)
})

// Create a new tournament
tournamentRouter.post('/create', (req, res) => {
  const { name, maxPlayers, buyIn, startingChips, token, rebuyDuration } = req.body
  if (!name || !maxPlayers || !buyIn || !startingChips || !token) {
    return res.status(400).json({ error: 'name, maxPlayers, buyIn, startingChips, token required' })
  }

  const user = getSessionUser(token)
  if (!user) return res.status(401).json({ error: 'Not authenticated' })

  if (maxPlayers < 2 || maxPlayers > 1000) {
    return res.status(400).json({ error: 'maxPlayers must be 2-1000' })
  }
  if (buyIn < 1) return res.status(400).json({ error: 'buyIn must be at least 1' })
  if (startingChips < 100) return res.status(400).json({ error: 'startingChips must be at least 100' })
  if (user.balance < buyIn) return res.status(400).json({ error: 'Insufficient balance' })

  const id = uuid().slice(0, 8)
  const maxPerTable = Math.min(8, maxPlayers)
  const isMultiTable = maxPlayers > maxPerTable
  const format = isMultiTable ? TournamentFormat.MultiTable : TournamentFormat.SitNGo

  const blindLevels = generateBlindLevelsFor(startingChips, isMultiTable)
  const prizeStructure = generatePrizePercentages(maxPlayers)

  const config: TournamentConfig = {
    id,
    name,
    format,
    buyIn,
    rake: 0.10,
    startingStack: startingChips,
    maxPlayers,
    maxPerTable,
    minPlayers: 2,
    lateRegistrationMinutes: 0,
    rebuyDuration: rebuyDuration ?? 60,
    blindLevels,
    prizeStructure,
    creatorId: user.id,
    creatorName: user.name,
  }

  const engine = new TournamentEngine(config)
  tournaments.set(id, engine)
  saveTournaments()

  engine.setOnStartCallback((tid) => {
    saveTournaments()
    emitServerEvent('tournament:started', tid, config.name)
  })

  engine.setOnEndCallback((state) => {
    const statePrizes = engine.getPrizes()
    for (const player of state.players) {
      if (player.finishPosition && player.finishPosition <= statePrizes.length) {
        const prize = statePrizes[player.finishPosition - 1]
        if (prize > 0) {
          creditBalance(player.userId, prize)
        }
      }
    }
    emitServerEvent('tournament:ended', state)
  })

  // Auto-register creator
  debitBalance(user.id, buyIn)
  engine.registerPlayer(user.id, user.name)

  const state0 = engine.getState()
  emitServerEvent('tournament:created', {
    id,
    name: config.name,
    format: config.format,
    status: state0.status,
    buyIn: config.buyIn,
    prizePool: state0.prizePool || config.buyIn * config.maxPlayers * (1 - config.rake),
    maxPlayers: config.maxPlayers,
    maxPerTable: config.maxPerTable,
    registrations: state0.registrations,
    currentLevel: state0.currentLevel + 1,
    creatorId: config.creatorId,
    creatorName: config.creatorName,
  })

  res.json({ id, config: engine.getConfig(), state: engine.getState() })
})

// Get tournament detail
tournamentRouter.get('/:id', (req, res) => {
  const eng = tournaments.get(req.params.id)
  if (!eng) return res.status(404).json({ error: 'Tournament not found' })
  res.json({
    config: eng.getConfig(),
    state: eng.getState(),
  })
})

// Cancel a player-created tournament
tournamentRouter.post('/:id/cancel', (req, res) => {
  const { token } = req.body
  if (!token) return res.status(400).json({ error: 'token required' })

  const user = getSessionUser(token)
  if (!user) return res.status(401).json({ error: 'Not authenticated' })

  const eng = tournaments.get(req.params.id)
  if (!eng) return res.status(404).json({ error: 'Tournament not found' })

  const cfg = eng.getConfig()
  if (cfg.creatorId !== user.id) return res.status(403).json({ error: 'Only the creator can cancel' })

  const state = eng.getState()
  if (state.status !== 0) return res.status(400).json({ error: 'Can only cancel a registering tournament' })

  // Refund all registered players
  for (const player of state.players) {
    creditBalance(player.userId, cfg.buyIn)
  }

  tournaments.delete(req.params.id)
  saveTournaments()
  emitServerEvent('tournament:cancelled', req.params.id)
  res.json({ ok: true })
})

// Register for tournament
tournamentRouter.post('/:id/register', (req, res) => {
  const { token } = req.body
  if (!token) {
    return res.status(400).json({ error: 'token required' })
  }

  const user = getSessionUser(token)
  if (!user) return res.status(401).json({ error: 'Not authenticated' })

  const eng = tournaments.get(req.params.id)
  if (!eng) return res.status(404).json({ error: 'Tournament not found' })

  const cfg = eng.getConfig()
  if (user.balance < cfg.buyIn) return res.status(400).json({ error: 'Insufficient balance' })

  const ok = eng.registerPlayer(user.id, user.name)
  if (!ok) return res.status(400).json({ error: 'Unable to register' })

  debitBalance(user.id, cfg.buyIn)
  saveTournaments()

  const regState = eng.getState()
  emitServerEvent('tournament:register', req.params.id, user.id, user.name, regState.registrations, cfg.maxPlayers)

  res.json({ ok: true, state: eng.getState() })
})

// Rebuy for eliminated player
tournamentRouter.post('/:id/rebuy', (req, res) => {
  const { token } = req.body
  if (!token) return res.status(400).json({ error: 'token required' })

  const user = getSessionUser(token)
  if (!user) return res.status(401).json({ error: 'Not authenticated' })

  const eng = tournaments.get(req.params.id)
  if (!eng) return res.status(404).json({ error: 'Tournament not found' })

  const cfg = eng.getConfig()
  const check = eng.canRebuy(user.id)
  if (!check.can) return res.status(400).json({ error: check.reason || 'Cannot rebuy' })

  if (user.balance < cfg.buyIn) return res.status(400).json({ error: 'Insufficient balance for rebuy' })

  debitBalance(user.id, cfg.buyIn)
  const ok = eng.rebuyPlayer(user.id)
  if (!ok) return res.status(400).json({ error: 'Rebuy failed' })

  saveTournaments()
  res.json({ success: true, state: eng.getState() })
})

// Get tournament leaderboard
tournamentRouter.get('/:id/leaderboard', (req, res) => {
  const eng = tournaments.get(req.params.id)
  if (!eng) return res.status(404).json({ error: 'Tournament not found' })

  const state = eng.getState()
  const standings = state.players
    .sort((a, b) => (b.finishPosition ?? 999) - (a.finishPosition ?? 999))
    .map(p => ({
      name: p.name,
      stack: p.stack,
      position: p.finishPosition,
      eliminated: !!p.eliminatedAt,
      prize: p.finishPosition ? eng.getPrizeForPosition(p.finishPosition) : 0,
    }))

  res.json(standings)
})

// ─── Exports for socket integration ─────────────────────

export function getTournamentEngine(id: string): TournamentEngine | undefined {
  return tournaments.get(id)
}

export function getTournamentEngineByTableId(tableId: string): TournamentEngine | undefined {
  for (const [, eng] of tournaments) {
    if (eng.getState().tables.includes(tableId)) return eng
  }
  return undefined
}

export function getAllTournaments(): TournamentEngine[] {
  return [...tournaments.values()]
}

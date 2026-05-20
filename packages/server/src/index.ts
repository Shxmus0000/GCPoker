import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import {
  ServerEvent, ClientEvent, ActionType, GamePhase, GameState, JoinTableRequest,
  HandRank, HAND_RANK_NAMES, ChatMessage,
} from '@gcpoker/shared'
import { TableManager } from './tables'
import { debitBalance, creditBalance, getUser, getSessionUser } from './users'
import { authRouter } from './auth'
import { cashierRouter } from './cashier'
import { tournamentRouter, getTournamentEngineByTableId, getAllTournaments } from './tournaments'
import { gameRouter, getGameEngine, getGame, processGameAction, getJoinableGames, setOnGameStartCallback } from './games'
import { aiDecide, isAI, evaluateHand, getHand, getRecentHands, getAllHands } from '@gcpoker/engine'
import type { HandRecord } from '@gcpoker/engine'

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
})

app.use(cors())
app.use(express.json())

app.use('/api/auth', authRouter)
app.use('/api/cashier', cashierRouter)
app.use('/api/tournaments', tournamentRouter)
app.use('/api/games', gameRouter)

const tables = new TableManager()
const socketTable = new Map<string, string>()
const socketUser = new Map<string, string>() // socketId → userId
const socketGame = new Map<string, string>() // socketId → gameId (player-created games)
const socketTTable = new Map<string, string>() // socketId → tournamentTableId

// ─── REST API ────────────────────────────────────────────

app.get('/api/lobby', (_req, res) => {
  const cashTables = tables.getLobby()
  const playerGames = getJoinableGames()
  res.json({ cashTables, playerGames })
})

app.get('/api/table/:id', (req, res) => {
  const config = tables.getTableConfig(req.params.id)
  const engine = tables.getTable(req.params.id)
  if (!config || !engine) return res.status(404).json({ error: 'Table not found' })
  res.json({ config, state: engine.getState() })
})

app.post('/api/practice/create', (req, res) => {
  const { userId, name } = req.body
  if (!userId || !name) return res.status(400).json({ error: 'userId and name required' })

  const { tableId, engine } = tables.createPracticeTable()
  engine.addPlayer(userId, name, 1000)
  engine.startHand()
  res.json({ tableId, state: engine.getState() })
})

// ─── Hand History API ──────────────────────────────────────

app.get('/api/hands', (_req, res) => {
  const all = getAllHands()
  const summaries = all.slice(0, 100).map(h => {
    const winnerName = h.winners.length > 0
      ? h.players.find(p => p.id === h.winners[0].playerId)?.name ?? 'Unknown'
      : 'Split'
    return {
      handId: h.handId,
      tableId: h.tableId,
      timestamp: h.timestamp,
      playerNames: h.players.map(p => p.name),
      winnerName,
      winAmount: h.winners.reduce((s, w) => s + w.amount, 0),
      potSize: h.pots.reduce((s, p) => s + p.main + p.sidePots.reduce((ss, sp) => ss + sp.amount, 0), 0),
      actionCount: h.actions.length,
    }
  })
  res.json(summaries)
})

app.get('/api/hands/:id', (req, res) => {
  const id = parseInt(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid hand ID' })
  const hand = getHand(id)
  if (!hand) return res.status(404).json({ error: 'Hand not found' })
  res.json(hand)
})

app.get('/api/hands/table/:tableId', (req, res) => {
  const hands = getRecentHands(req.params.tableId, 50)
  const summaries = hands.map(h => {
    const winnerName = h.winners.length > 0
      ? h.players.find(p => p.id === h.winners[0].playerId)?.name ?? 'Unknown'
      : 'Split'
    return {
      handId: h.handId,
      tableId: h.tableId,
      timestamp: h.timestamp,
      playerNames: h.players.map(p => p.name),
      winnerName,
      winAmount: h.winners.reduce((s, w) => s + w.amount, 0),
      potSize: h.pots.reduce((s, p) => s + p.main + p.sidePots.reduce((ss, sp) => ss + sp.amount, 0), 0),
      actionCount: h.actions.length,
    }
  })
  res.json(summaries)
})

// ─── Socket.IO ───────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`)
  socket.join('lobby')

  // ── Join Cash/Practice Table ──

  socket.on(ClientEvent.JoinTable, (data: JoinTableRequest) => {
    try {
      leaveCurrentTable(socket)

      let state: GameState
      if (data.tableId === 'practice') {
        const { tableId: pid } = tables.createPracticeTable()
        data.tableId = pid
        state = tables.joinTable(pid, socket.id, data.name, 1000)
        socket.join(pid)
        socketTable.set(socket.id, pid)
        const engine = tables.getTable(pid)!
        engine.startHand()
        state = engine.getState()
        io.to(pid).emit(ServerEvent.GameState, state)
        emitLobbyUpdate()
        scheduleAIActions(pid)
      } else {
        const user = data.token ? getSessionUser(data.token) : undefined
        if (!user) {
          return socket.emit(ServerEvent.Error, { message: 'Not authenticated' })
        }
        if (data.buyIn > user.balance) {
          return socket.emit(ServerEvent.Error, { message: 'Insufficient balance' })
        }
        debitBalance(user.id, data.buyIn)
        socketUser.set(socket.id, user.id)
        state = tables.joinTable(data.tableId, socket.id, data.name, data.buyIn)
        socket.join(data.tableId)
        socketTable.set(socket.id, data.tableId)
        io.to(data.tableId).emit(ServerEvent.GameState, state)
        emitLobbyUpdate()
        socket.emit(ServerEvent.TableState, tables.getTableConfig(data.tableId))
      }

      notifyTurn(socket, data.tableId)
    } catch (err: any) {
      socket.emit(ServerEvent.Error, { message: err.message })
    }
  })

  // ── Join Player-Created Game (Sit & Go) ──

  socket.on('game:join', (data: { gameId: string; token: string }) => {
    try {
      const user = getSessionUser(data.token)
      if (!user) return socket.emit(ServerEvent.Error, { message: 'Not authenticated' })

      const engine = getGameEngine(data.gameId)
      if (!engine) return socket.emit(ServerEvent.Error, { message: 'Game not found' })

      leaveCurrentTable(socket)
      socket.join(data.gameId)
      socketGame.set(socket.id, data.gameId)
      socketUser.set(socket.id, user.id)

      const state = engine.getState()
      io.to(data.gameId).emit(ServerEvent.GameState, state)
      emitLobbyUpdate()
      notifyTurn(socket, data.gameId)
    } catch (err: any) {
      socket.emit(ServerEvent.Error, { message: err.message })
    }
  })

  // ── Join Tournament Table ──

  socket.on('tournament:join', (data: { tableId: string; token: string }) => {
    try {
      const user = getSessionUser(data.token)
      if (!user) return socket.emit(ServerEvent.Error, { message: 'Not authenticated' })

      const tEngine = getTournamentEngineByTableId(data.tableId)
      if (!tEngine) return socket.emit(ServerEvent.Error, { message: 'Tournament table not found' })

      const engine = tEngine.getTable(data.tableId)
      if (!engine) return socket.emit(ServerEvent.Error, { message: 'Table not found in tournament' })

      leaveCurrentTable(socket)
      socket.join(data.tableId)
      socketTTable.set(socket.id, data.tableId)
      socketUser.set(socket.id, user.id)

      const state = engine.getState()
      io.to(data.tableId).emit(ServerEvent.GameState, state)
      notifyTurn(socket, data.tableId)
    } catch (err: any) {
      socket.emit(ServerEvent.Error, { message: err.message })
    }
  })

  // ── Game Actions (cash, player-game, tournament) ──

  socket.on(ClientEvent.PlayerAction, (data: {
    type: ActionType; amount?: number
  }) => {
    const tableId = socketTable.get(socket.id)
    const gameId = socketGame.get(socket.id)
    const tTableId = socketTTable.get(socket.id)
    const roomId = tableId || gameId || tTableId
    if (!roomId) return socket.emit(ServerEvent.Error, { message: 'Not at a table or game' })

    try {
      const action = {
        type: data.type,
        amount: data.amount ?? 0,
        playerId: socket.id,
        timestamp: Date.now(),
      }

      let state: GameState

      if (gameId) {
        // Player-created game — processGameAction handles eliminations
        const game = processGameAction(gameId, action)
        if (!game) return socket.emit(ServerEvent.Error, { message: 'Game not found' })
        state = getGameEngine(gameId)!.getState()

        io.to(roomId).emit(ServerEvent.GameState, state)

        if (game.status === 'complete') {
          io.to(roomId).emit('game:ended', { game })
          setTimeout(() => {
            socketGame.forEach((gid, sid) => {
              if (gid === gameId) {
                io.sockets.sockets.get(sid)?.leave(gameId)
                socketGame.delete(sid)
              }
            })
          }, 5000)
          return
        }
      } else if (tTableId) {
        // Tournament table
        const tEng = getTournamentEngineByTableId(tTableId)
        const engine = tEng?.getTable(tTableId)
        if (!engine) return socket.emit(ServerEvent.Error, { message: 'Table not found' })
        engine.processAction(action)
        state = engine.getState()
        io.to(roomId).emit(ServerEvent.GameState, state)

        if (state.phase === GamePhase.Complete) {
          tEng!.onHandComplete()
          const tState = tEng!.getState()
          if (tState.status === 2) { // Completed
            io.to(roomId).emit('tournament:ended', {
              state: tState,
              prizes: tEng!.getPrizes(),
            })
            return
          }
        }
      } else {
        // Cash table
        const engine = tables.getTable(tableId!)
        if (!engine) return socket.emit(ServerEvent.Error, { message: 'Table not found' })
        engine.processAction(action)
        state = engine.getState()
        io.to(roomId).emit(ServerEvent.GameState, state)
      }

      if (state.phase === GamePhase.Complete) {
        setTimeout(() => {
          if (tableId) {
            const eng = tables.getTable(tableId)
            if (eng) {
              eng.startHand()
              io.to(roomId).emit(ServerEvent.GameState, eng.getState())
              if (tables.isPracticeTable(tableId)) scheduleAIActions(tableId)
              notifyTurn(socket, roomId)
            }
          } else if (gameId) {
            const eng = getGameEngine(gameId)
            if (eng) {
              eng.startHand()
              io.to(roomId).emit(ServerEvent.GameState, eng.getState())
              notifyTurn(socket, roomId)
            }
          } else if (tTableId) {
            const tEng = getTournamentEngineByTableId(tTableId)
            const eng = tEng?.getTable(tTableId)
            if (eng && tEng && tEng.getState().status === 1) { // Running
              eng.startHand()
              io.to(roomId).emit(ServerEvent.GameState, eng.getState())
              notifyTurn(socket, roomId)
            }
          }
        }, 2000)
      }

      if (tableId && tables.isPracticeTable(tableId)) {
        scheduleAIActions(tableId)
      }

      if (state.phase !== GamePhase.Complete) {
        notifyTurn(socket, roomId)
      }
    } catch (err: any) {
      socket.emit(ServerEvent.Error, { message: err.message })
    }
  })

  // ── Leave Table/Game ──

  socket.on(ClientEvent.LeaveTable, () => {
    cashOutAndLeave(socket)
    leavePlayerGame(socket)
    leaveTournamentTable(socket)
  })

  socket.on(ClientEvent.ShowCards, () => {
    const tableId = socketTable.get(socket.id)
    const gameId = socketGame.get(socket.id)
    const tTableId = socketTTable.get(socket.id)
    const room = tableId || gameId || tTableId
    if (!room) return

    const engine = tableId ? tables.getTable(tableId)
      : gameId ? getGameEngine(gameId)
      : tTableId ? getTournamentEngineByTableId(tTableId)?.getTable(tTableId)
      : undefined
    if (!engine) return

    engine.toggleCardsRevealed(socket.id)
    io.to(room).emit(ServerEvent.GameState, engine.getState())
  })

  // ── Chat ──

  socket.on(ClientEvent.Chat, (data: { text: string }) => {
    const roomId = socketTable.get(socket.id) || socketGame.get(socket.id) || socketTTable.get(socket.id)
    if (!roomId) return

    const engine = tables.getTable(roomId) || getGameEngine(roomId)
      || getTournamentEngineByTableId(roomId)?.getTable(roomId)
    if (!engine) return

    const state = engine.getState()
    const player = state.players.find(p => p.id === socket.id)
    if (!player) return

    const msg: ChatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      playerId: socket.id,
      playerName: player.name,
      text: data.text.slice(0, 200),
      timestamp: Date.now(),
    }
    io.to(roomId).emit(ServerEvent.Chat, msg)
  })

  socket.on('disconnect', () => {
    cashOutAndLeave(socket)
    leavePlayerGame(socket)
    leaveTournamentTable(socket)
    console.log(`Disconnected: ${socket.id}`)
  })

  socket.on('table:cashOut', () => {
    cashOutAndLeave(socket)
  })
})

// ─── AI Action Scheduler ─────────────────────────────────

const AI_DELAY = 800

function scheduleAIActions(tableId: string): void {
  const engine = tables.getTable(tableId)
  if (!engine) return

  const state = engine.getState()
  if (state.phase === GamePhase.Complete || state.phase === GamePhase.Waiting || state.phase === GamePhase.Showdown) return

  const currentPlayer = state.players[state.currentPlayerIndex]
  if (!currentPlayer) return

  // If it's a human's turn, notify them
  if (!isAI(currentPlayer.id)) {
    const actions = engine.getLegalActions(currentPlayer.id)
    io.to(tableId).emit(ServerEvent.ActionRequired, {
      playerId: currentPlayer.id,
      legalActions: actions,
    })
    return
  }

  setTimeout(() => {
    const eng = tables.getTable(tableId)
    if (!eng) return
    const st = eng.getState()
    if (st.phase === GamePhase.Complete || st.phase === GamePhase.Waiting) return

    const cp = st.players[st.currentPlayerIndex]
    if (!cp || !isAI(cp.id)) return

    try {
      const action = aiDecide(cp.id, st)
      const newState = tables.processAction(tableId, action)
      io.to(tableId).emit(ServerEvent.GameState, newState)

      if (newState.phase === GamePhase.Complete) {
        setTimeout(() => {
          const e = tables.getTable(tableId)
          if (e) {
            e.startHand()
            const ns = e.getState()
            io.to(tableId).emit(ServerEvent.GameState, ns)
            scheduleAIActions(tableId)
          }
        }, 2000)
      } else {
        scheduleAIActions(tableId)
      }
    } catch {
      // AI error — stop scheduling
    }
  }, AI_DELAY)
}

// ─── Helpers ─────────────────────────────────────────────

function leaveCurrentTable(socket: any): void {
  const currentTableId = socketTable.get(socket.id)
  if (currentTableId) {
    socket.leave(currentTableId)
    socketTable.delete(socket.id)
  }
}

function leavePlayerGame(socket: any): void {
  const gameId = socketGame.get(socket.id)
  if (gameId) {
    socket.leave(gameId)
    socketGame.delete(socket.id)
  }
}

function leaveTournamentTable(socket: any): void {
  const tTableId = socketTTable.get(socket.id)
  if (tTableId) {
    socket.leave(tTableId)
    socketTTable.delete(socket.id)
  }
}

function cashOutAndLeave(socket: any): void {
  const tableId = socketTable.get(socket.id)
  if (!tableId) return

  const userId = socketUser.get(socket.id)
  leaveCurrentTable(socket)
  if (userId) socketUser.delete(socket.id)

  const engine = tables.getTable(tableId)
  if (engine) {
    const state = engine.getState()
    const player = state.players.find(p => p.id === socket.id)
    if (player && !tables.isPracticeTable(tableId) && userId) {
      creditBalance(userId, player.stack)
    }
    const newState = tables.leaveTable(tableId, socket.id)
    io.to(tableId).emit(ServerEvent.GameState, newState)
    emitLobbyUpdate()
  }
}

function emitLobbyUpdate(): void {
  io.to('lobby').emit('lobby:update', {
    cashTables: tables.getLobby(),
    playerGames: getJoinableGames(),
  })
}

function notifyTurn(socket: any, roomId: string): void {
  const engine = tables.getTable(roomId)
    || getGameEngine(roomId)
    || getTournamentEngineByTableId(roomId)?.getTable(roomId)
  if (!engine) return

  const state = engine.getState()
  const current = state.players[state.currentPlayerIndex]
  if (current && !isAI(current.id)) {
    const actions = engine.getLegalActions(current.id)
    io.to(roomId).emit(ServerEvent.ActionRequired, {
      playerId: current.id,
      legalActions: actions,
    })
  }
}

// ─── Tournament End Callback Setup ──────────────────────

function setupTournamentEndCallbacks(): void {
  for (const eng of getAllTournaments()) {
    eng.setOnEndCallback((state) => {
      console.log(`Tournament ${state.id} completed. Distributing prizes...`)
      const prizes = eng.getPrizes()
      for (const player of state.players) {
        if (player.finishPosition && player.finishPosition <= prizes.length) {
          const prize = prizes[player.finishPosition - 1]
          if (prize > 0) {
            creditBalance(player.userId, prize)
            console.log(`  Credited ${player.name} (${player.finishPosition}) with $${prize}`)
          }
        }
      }
    })
  }
}
setupTournamentEndCallbacks()

// ─── Game Start Callback ────────────────────────────────

setOnGameStartCallback((gameId: string) => {
  const engine = getGameEngine(gameId)
  if (engine) {
    const state = engine.getState()
    io.to(gameId).emit(ServerEvent.GameState, state)
    emitLobbyUpdate()
  }
})

// ─── Server Start ────────────────────────────────────────

const PORT = process.env.PORT ?? 3001
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})

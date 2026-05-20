import { GameEngine, GameConfig, isAI, generateAINames } from '@gcpoker/engine'
import {
  GameState, GamePhase, Player, PlayerAction,
  ActionType, TableConfig, TableStatus, GameVariant, GameFormat,
} from '@gcpoker/shared'

const AI_STACK = 1000

export interface TableInfo {
  config: TableConfig
  state: GameState
  playerCount: number
}

export class TableManager {
  private tables = new Map<string, GameEngine>()
  private tableConfigs = new Map<string, TableConfig>()
  private practiceCount = 0

  constructor() {
    this.createTable('nl2', {
      smallBlind: 1, bigBlind: 2, minPlayers: 2, maxPlayers: 6,
      name: 'NL2',
    })
    this.createTable('nl10', {
      smallBlind: 5, bigBlind: 10, minPlayers: 2, maxPlayers: 6,
      name: 'NL10',
    })
    this.createTable('nl50', {
      smallBlind: 25, bigBlind: 50, minPlayers: 2, maxPlayers: 6,
      name: 'NL50',
    })
  }

  createTable(id: string, opts: {
    smallBlind: number
    bigBlind: number
    minPlayers: number
    maxPlayers: number
    name: string
  }): void {
    const engine = new GameEngine({
      smallBlind: opts.smallBlind,
      bigBlind: opts.bigBlind,
    })

    this.tables.set(id, engine)
    this.tableConfigs.set(id, {
      id,
      name: opts.name,
      maxPlayers: opts.maxPlayers,
      minPlayers: opts.minPlayers,
      smallBlind: opts.smallBlind,
      bigBlind: opts.bigBlind,
      buyInMin: opts.bigBlind * 10,
      buyInMax: opts.bigBlind * 100,
      status: TableStatus.Waiting,
      variant: GameVariant.TexasHoldem,
      format: GameFormat.Cash,
      playerCount: 0,
    })
  }

  getTable(id: string): GameEngine | undefined {
    return this.tables.get(id)
  }

  getTableConfig(id: string): TableConfig | undefined {
    return this.tableConfigs.get(id)
  }

  getLobby(): TableConfig[] {
    const lobby: TableConfig[] = []
    for (const [id, engine] of this.tables) {
      const config = this.tableConfigs.get(id)!
      const state = engine.getState()
      if (id.startsWith('practice-')) continue
      lobby.push({
        ...config,
        playerCount: state.players.filter(p => !isAI(p.id)).length,
        status: state.phase === GamePhase.Waiting
          ? TableStatus.Waiting
          : TableStatus.Playing,
      })
    }
    return lobby
  }

  joinTable(tableId: string, playerId: string, name: string, buyIn: number): GameState {
    const engine = this.tables.get(tableId)
    if (!engine) throw new Error('Table not found')

    engine.addPlayer(playerId, name, buyIn)
    return engine.getState()
  }

  leaveTable(tableId: string, playerId: string): GameState {
    const engine = this.tables.get(tableId)
    if (!engine) throw new Error('Table not found')

    engine.removePlayer(playerId)
    return engine.getState()
  }

  processAction(tableId: string, action: PlayerAction): GameState {
    const engine = this.tables.get(tableId)
    if (!engine) throw new Error('Table not found')

    engine.processAction(action)
    return engine.getState()
  }

  getLegalActions(tableId: string, playerId: string): ActionType[] {
    const engine = this.tables.get(tableId)
    if (!engine) return []
    return engine.getLegalActions(playerId)
  }

  // ─── Practice / AI Mode ──────────────────────────────

  createPracticeTable(): { tableId: string; engine: GameEngine } {
    this.practiceCount++
    const tableId = `practice-${this.practiceCount}`
    const engine = new GameEngine({ smallBlind: 5, bigBlind: 10 })

    this.tables.set(tableId, engine)
    this.tableConfigs.set(tableId, {
      id: tableId,
      name: `Practice #${this.practiceCount}`,
      maxPlayers: 6,
      minPlayers: 2,
      smallBlind: 5,
      bigBlind: 10,
      buyInMin: 100,
      buyInMax: 10000,
      status: TableStatus.Waiting,
      variant: GameVariant.TexasHoldem,
      format: GameFormat.Cash,
      playerCount: 0,
    })

    // Add AI opponents only (human joins after)
    const aiNames = generateAINames(3)
    for (const name of aiNames) {
      const aiId = `ai-${name.toLowerCase()}`
      engine.addPlayer(aiId, name, AI_STACK)
    }

    return { tableId, engine }
  }

  isPracticeTable(tableId: string): boolean {
    return tableId.startsWith('practice-')
  }
}

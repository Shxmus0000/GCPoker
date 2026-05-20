import { GameEngine } from './game'
import { calculatePayouts } from './payouts'
import {
  TournamentConfig, TournamentState, TournamentStatus,
  TournamentFormat, TournamentPlayer,
  GameState, GamePhase, Player,
} from '@gcpoker/shared'


export class TournamentEngine {
  private config: TournamentConfig
  private state: TournamentState
  private tables: Map<string, GameEngine> = new Map()
  private levelTimer: ReturnType<typeof setInterval> | null = null
  private onEndCallback?: (state: TournamentState) => void

  constructor(config: TournamentConfig) {
    this.config = config
    this.state = this.initState()
  }

  getState(): TournamentState {
    return this.state
  }

  getConfig(): TournamentConfig {
    return this.config
  }

  getTable(tableId: string): GameEngine | undefined {
    return this.tables.get(tableId)
  }

  setOnEndCallback(cb: (state: TournamentState) => void): void {
    this.onEndCallback = cb
  }

  // ─── Registration ──────────────────────────────────────

  registerPlayer(userId: string, name: string): boolean {
    if (this.state.status !== TournamentStatus.Registering) return false
    if (this.state.players.length >= this.config.maxPlayers) return false
    if (this.state.players.some(p => p.userId === userId)) return false

    this.state.players.push({
      userId,
      name,
      stack: this.config.startingStack,
      tableId: '',
      seatIndex: -1,
    })

    this.state.registrations++

    // Auto-start when max players reached (for player-created) or min players (for system SNGs)
    if (this.state.players.length >= this.config.maxPlayers) {
      this.startTournament()
    } else if (
      !this.config.creatorId &&
      this.config.format === TournamentFormat.SitNGo &&
      this.state.players.length >= this.config.minPlayers
    ) {
      this.startTournament()
    }

    return true
  }

  // ─── Tournament Lifecycle ──────────────────────────────

  startTournament(): void {
    if (this.state.status !== TournamentStatus.Registering) return

    this.state.status = TournamentStatus.Running
    this.createTables()
    this.assignPlayersToTables()
    this.startAllTables()
    this.startLevelTimer()
  }

  private createTables(): void {
    const playersPerTable = this.config.maxPerTable || 6
    const numTables = Math.ceil(this.state.players.length / playersPerTable)

    for (let i = 0; i < numTables; i++) {
      const tableId = `${this.config.id}-table-${i}`
      const engine = new GameEngine({
        smallBlind: this.config.blindLevels[0].smallBlind,
        bigBlind: this.config.blindLevels[0].bigBlind,
      })
      this.tables.set(tableId, engine)

      // Need to get past the Waiting phase to allow in-progress joining
      // We'll add 2 placeholder players, then remove them
      engine.addPlayer(`sys-${tableId}-1`, 'Placeholder', 0)
      engine.addPlayer(`sys-${tableId}-2`, 'Placeholder', 0)
    }

    this.state.tables = [...this.tables.keys()]
  }

  private assignPlayersToTables(): void {
    const tableIds = [...this.tables.keys()]
    const playersPerTable = Math.ceil(this.state.players.length / tableIds.length) || 1

    this.state.players.forEach((player, index) => {
      const tableIndex = Math.floor(index / playersPerTable)
      const tableId = tableIds[tableIndex]
      const engine = this.tables.get(tableId)!

      // Remove a placeholder
      const placeholders = engine['state'].players.filter(
        (p: Player) => p.id.startsWith('sys-')
      )
      if (placeholders.length > 0) {
        engine.removePlayer(placeholders[0].id)
      }

      engine.addPlayer(player.userId, player.name, player.stack)
      player.tableId = tableId
      player.seatIndex = engine.getState().players.findIndex(
        (p: Player) => p.id === player.userId
      )
    })
  }

  private startAllTables(): void {
    for (const [, engine] of this.tables) {
      engine.startHand()
    }
  }

  // ─── Level Timer ───────────────────────────────────────

  private startLevelTimer(): void {
    const currentLevel = this.config.blindLevels[this.state.currentLevel]
    this.state.levelTimeRemaining = currentLevel.duration * 60

    this.levelTimer = setInterval(() => {
      this.state.levelTimeRemaining--

      if (this.state.levelTimeRemaining <= 0) {
        this.advanceLevel()
      }
    }, 1000)
  }

  private advanceLevel(): void {
    this.state.currentLevel++
    const level = this.config.blindLevels[this.state.currentLevel]
    if (!level) return // no more levels defined

    this.state.levelTimeRemaining = level.duration * 60

    // Update blind levels on all tables
    for (const [, engine] of this.tables) {
      const state = engine.getState() as any
      state.blinds.small = level.smallBlind
      state.blinds.big = level.bigBlind
    }
  }

  // ─── Hand Completion & Elimination ─────────────────────

  onHandComplete(): void {
    if (this.state.status !== TournamentStatus.Running) return

    this.checkEliminations()
    this.rebalanceTables()

    // Check if tournament is over
    const activePlayers = this.state.players.filter(p => !p.eliminatedAt)
    if (activePlayers.length <= 1) {
      this.endTournament()
      return
    }

    // Start next hand on all active tables
    for (const [, engine] of this.tables) {
      const state = engine.getState()
      if (state.phase === GamePhase.Complete) {
        engine.startHand()
      }
    }
  }

  private checkEliminations(): void {
    for (const player of this.state.players) {
      if (player.eliminatedAt) continue

      const engine = this.tables.get(player.tableId)
      if (!engine) continue

      const state = engine.getState()
      const p = state.players.find((p: Player) => p.id === player.userId)
      if (p && p.stack <= 0) {
        player.eliminatedAt = Date.now()
        player.finishPosition = this.state.players.filter(
          p2 => p2.eliminatedAt && p2.eliminatedAt <= Date.now()
        ).length + 1

        engine.removePlayer(player.userId)
      }
    }
  }

  private rebalanceTables(): void {
    // Simple rebalancing: if a table has 0 active players, consolidate
    const activePlayers = this.state.players.filter(p => !p.eliminatedAt)
    const activeTables = [...this.tables.keys()].filter(tid => {
      const engine = this.tables.get(tid)!
      return engine.getState().players.length > 0
    })

    if (activeTables.length <= 1) return

    // If total players can fit on fewer tables, consolidate
    const maxPerTable = this.config.maxPerTable || 6
    const targetCount = Math.ceil(activePlayers.length / maxPerTable)
    if (activeTables.length <= targetCount) return

    // Move players from the smallest table to others
    const sortedTables = activeTables.sort((a, b) =>
      this.tables.get(a)!.getState().players.length -
      this.tables.get(b)!.getState().players.length
    )

    const tableToRemove = sortedTables[0]
    const engine = this.tables.get(tableToRemove)!
    const playersToMove = engine.getState().players.filter(
      (p: Player) => !p.id.startsWith('sys-')
    )

    for (const p of playersToMove) {
      engine.removePlayer(p.id)

      // Find a table with space
      for (let i = 1; i < sortedTables.length; i++) {
        const targetEngine = this.tables.get(sortedTables[i])!
        if (targetEngine.getState().players.length < maxPerTable) {
          targetEngine.addPlayer(p.id, p.name, p.stack)
          const tp = this.state.players.find(tp => tp.userId === p.id)
          if (tp) {
            tp.tableId = sortedTables[i]
          }
          break
        }
      }
    }

    this.tables.delete(tableToRemove)
    this.state.tables = [...this.tables.keys()]
  }

  // ─── Prize Distribution ────────────────────────────────

  private endTournament(): void {
    if (this.levelTimer) clearInterval(this.levelTimer)
    this.state.status = TournamentStatus.Completed

    // Assign finish positions for remaining players
    const ranked = this.state.players
      .filter(p => !p.eliminatedAt)
      .sort((a, b) => (b.finishPosition ?? 0) - (a.finishPosition ?? 0))

    ranked.forEach((p, i) => {
      p.finishPosition = i + 1
    })

    // Update stacks from table engines
    for (const [, engine] of this.tables) {
      const state = engine.getState()
      for (const p of state.players) {
        if (!p.id.startsWith('sys-')) {
          const tp = this.state.players.find(tp => tp.userId === p.id)
          if (tp) tp.stack = p.stack
        }
      }
    }

    // Compute prize pool
    this.state.prizePool = this.computePrizePool()

    // Distribute prizes using dynamic payout calculation
    const { prizes } = calculatePayouts(this.state.players.length, this.config.buyIn)
    this.state.prizes = prizes

    if (this.onEndCallback) {
      this.onEndCallback(this.state)
    }
  }

  getPrizes(): number[] {
    return this.state.prizes || []
  }

  private computePrizePool(): number {
    const totalBuyIns = this.state.players.length * (this.config.buyIn)
    const totalRake = totalBuyIns * this.config.rake
    return totalBuyIns - totalRake
  }

  getPrizeForPosition(position: number): number {
    if (this.state.prizes && this.state.prizes.length > 0) {
      if (position > this.state.prizes.length) return 0
      return this.state.prizes[position - 1]
    }
    const pool = this.computePrizePool()
    const payout = this.config.prizeStructure
    if (position > payout.length) return 0
    return Math.floor(pool * payout[position - 1])
  }

  // ─── Init ──────────────────────────────────────────────

  private initState(): TournamentState {
    return {
      id: this.config.id,
      name: this.config.name,
      format: this.config.format,
      status: TournamentStatus.Registering,
      players: [],
      tables: [],
      currentLevel: 0,
      levelTimeRemaining: this.config.blindLevels[0]?.duration ?? 10 * 60,
      prizePool: 0,
      prizes: [],
      registrations: 0,
      entries: 0,
      reentries: 0,
      blindLevels: this.config.blindLevels,
    }
  }
}

import { EventEmitter } from 'events'
import type { PlayerGameSummary, PlayerGame, TournamentSummary, TournamentState, GCTransaction, ChatMessage } from '@gcpoker/shared'
import type { HandRecord } from '@gcpoker/engine'

export interface ServerEvents {
  'game:created': (game: PlayerGameSummary) => void
  'game:started': (gameId: string, gameName: string) => void
  'game:ended': (game: PlayerGame) => void
  'game:cancelled': (gameId: string) => void
  'hand:complete': (hand: HandRecord) => void
  'tournament:created': (tournament: TournamentSummary) => void
  'tournament:started': (tournamentId: string, tournamentName: string) => void
  'tournament:ended': (state: TournamentState) => void
  'tournament:cancelled': (tournamentId: string) => void
  'tournament:register': (tournamentId: string, userId: string, name: string, registrations: number, maxPlayers: number) => void
  'cashier:deposit': (userId: string, txId: string) => void
  'cashier:withdraw': (userId: string, amount: number, txId: string) => void
  'cashier:deposit:complete': (userId: string, amount: number, txId: string) => void
  'cashier:withdraw:complete': (userId: string, amount: number, gcCode: string | undefined, txId: string) => void
  'chat:message': (roomId: string, msg: ChatMessage) => void
  'discord:chat': (roomId: string, userId: string, userName: string, text: string) => void
}

const serverEvents = new EventEmitter()
serverEvents.setMaxListeners(50)

export function emitServerEvent<K extends keyof ServerEvents>(event: K, ...args: Parameters<ServerEvents[K]>): void {
  serverEvents.emit(event, ...args)
}

export function onServerEvent<K extends keyof ServerEvents>(event: K, listener: ServerEvents[K]): void {
  serverEvents.on(event, listener as (...args: any[]) => void)
}

export default serverEvents

import {
  Card, PlayerAction, Player, GamePhase, EvaluatedHand, Pot,
} from '@gcpoker/shared'

// ─── Hand Record ────────────────────────────────────────
// Full record of a poker hand for replay and dispute resolution.

export interface HandRecord {
  handId: number
  tableId: string
  timestamp: number
  serverSeed: string
  clientSeed: string
  nonce: number
  players: Array<{
    id: string
    name: string
    holeCards: [Card, Card] | null
    stackAtStart: number
    stackAtEnd: number
  }>
  communityCards: Card[]
  actions: PlayerAction[]
  pots: Pot[]
  hands: Array<{
    playerId: string
    hand: EvaluatedHand | null
  }>
  winners: Array<{
    playerId: string
    amount: number
  }>
  blinds: { small: number; big: number }
}

const handHistory = new Map<number, HandRecord>()
let onHandRecorded: ((hand: HandRecord) => void) | null = null

export function setOnHandRecorded(cb: (hand: HandRecord) => void): void {
  onHandRecorded = cb
}

export function storeHand(record: HandRecord): void {
  handHistory.set(record.handId, record)
  onHandRecorded?.(record)
}

export function getHand(handId: number): HandRecord | undefined {
  return handHistory.get(handId)
}

export function getRecentHands(tableId: string, limit = 50): HandRecord[] {
  const all = [...handHistory.values()]
    .filter(h => h.tableId === tableId)
    .sort((a, b) => b.handId - a.handId)
  return all.slice(0, limit)
}

export function getAllHands(): HandRecord[] {
  return [...handHistory.values()]
    .sort((a, b) => b.handId - a.handId)
}

// ─── Card Types ───────────────────────────────────────────
export enum Suit {
  Hearts = 'h',
  Diamonds = 'd',
  Clubs = 'c',
  Spades = 's',
}

export enum Rank {
  Two = 2, Three, Four, Five, Six, Seven,
  Eight, Nine, Ten, Jack = 11, Queen = 12,
  King = 13, Ace = 14,
}

export interface Card {
  rank: Rank
  suit: Suit
}

// ─── Hand / Deck Types ────────────────────────────────────
export type Hand = [Card, Card]      // hole cards
export type CommunityCards = Card[]  // board

export enum HandRank {
  HighCard,
  OnePair,
  TwoPair,
  ThreeOfAKind,
  Straight,
  Flush,
  FullHouse,
  FourOfAKind,
  StraightFlush,
  RoyalFlush,
}

export interface EvaluatedHand {
  rank: HandRank
  kickers: number[]  // for comparison
  bestCards: Card[]  // the 5 cards used
}

// ─── Player / Action Types ────────────────────────────────
export enum ActionType {
  Fold = 'fold',
  Check = 'check',
  Call = 'call',
  Bet = 'bet',
  Raise = 'raise',
  AllIn = 'allIn',
}

export interface PlayerAction {
  type: ActionType
  amount: number
  playerId: string
  timestamp: number
}

export interface Player {
  id: string
  name: string
  stack: number
  holeCards?: Hand
  seatIndex: number
  isDealer: boolean
  currentBet: number
  isFolded: boolean
  isAllIn: boolean
  actedThisRound: boolean
  totalBet: number
  cardsRevealed?: boolean
  bestHand?: EvaluatedHand | null
}

// ─── Game State ───────────────────────────────────────────
export enum GamePhase {
  Waiting,     // not enough players
  PreFlop,
  Flop,
  Turn,
  River,
  Showdown,
  Complete,
}

export enum GameVariant {
  TexasHoldem = 'texas-holdem',
}

export enum GameFormat {
  Cash = 'cash',
  SitNGo = 'sitngo',
  Tournament = 'tournament',
}

export interface SidePot {
  amount: number
  eligiblePlayerIds: string[]
}

export interface Pot {
  main: number
  sidePots: SidePot[]
}

export interface GameState {
  id: string
  variant: GameVariant
  format: GameFormat
  phase: GamePhase
  players: Player[]
  communityCards: CommunityCards
  deck: Card[]
  pot: Pot
  currentPlayerIndex: number
  dealerIndex: number
  minBet: number
  maxBet: number
  currentBet: number
  lastRaise: number
  actionHistory: PlayerAction[]
  handCount: number
  buttonIndex: number
  // tournament-specific
  blinds: { small: number; big: number }
  level?: number
  // provably fair
  serverSeed?: string
  clientSeed?: string
  nonce?: number
  tableId?: string
}

// ─── Room / Lobby Types ──────────────────────────────────
export enum TableStatus {
  Waiting,
  Playing,
  Finished,
}

export interface TableConfig {
  id: string
  name: string
  maxPlayers: number
  minPlayers: number
  smallBlind: number
  bigBlind: number
  buyInMin: number
  buyInMax: number
  status: TableStatus
  variant: GameVariant
  format: GameFormat
  playerCount: number
}

export const HAND_RANK_NAMES: Record<HandRank, string> = {
  [HandRank.HighCard]: 'High Card',
  [HandRank.OnePair]: 'One Pair',
  [HandRank.TwoPair]: 'Two Pair',
  [HandRank.ThreeOfAKind]: 'Three of a Kind',
  [HandRank.Straight]: 'Straight',
  [HandRank.Flush]: 'Flush',
  [HandRank.FullHouse]: 'Full House',
  [HandRank.FourOfAKind]: 'Four of a Kind',
  [HandRank.StraightFlush]: 'Straight Flush',
  [HandRank.RoyalFlush]: 'Royal Flush',
}

// ─── Socket Events ───────────────────────────────────────
export interface JoinTableRequest {
  tableId: string
  name: string
  buyIn: number
  token?: string
}

export enum ClientEvent {
  JoinTable = 'table:join',
  LeaveTable = 'table:leave',
  SitDown = 'table:sit',
  StandUp = 'table:stand',
  PlayerAction = 'game:action',
  BuyIn = 'game:buyIn',
  Chat = 'table:chat',
  ShowCards = 'game:showCards',
}

export enum ServerEvent {
  TableState = 'table:state',
  GameState = 'game:state',
  PlayerJoined = 'table:playerJoined',
  PlayerLeft = 'table:playerLeft',
  ActionRequired = 'game:yourTurn',
  ActionProcessed = 'game:actionProcessed',
  HandResult = 'game:handResult',
  Error = 'game:error',
  Chat = 'table:chat',
}

// ─── Cashier / Wallet Types ──────────────────────────────
export enum TransactionStatus {
  Pending = 'pending',
  Processing = 'processing',
  Completed = 'completed',
  Failed = 'failed',
}

export enum TransactionType {
  Deposit = 'deposit',
  Withdrawal = 'withdrawal',
  BuyIn = 'buyIn',
  CashOut = 'cashOut',
  TournamentFee = 'tournamentFee',
  Prize = 'prize',
}

export interface GCTransaction {
  id: string
  userId: string
  type: TransactionType
  amount: number
  gcCode?: string
  status: TransactionStatus
  createdAt: number
  completedAt?: number
  botMessage?: string
}

// ─── Tournament Types ───────────────────────────────────
export enum TournamentStatus {
  Registering,
  Running,
  Paused,
  Completed,
}

export enum TournamentFormat {
  SitNGo = 'sng',
  MultiTable = 'mtt',
}

export interface BlindLevel {
  level: number
  smallBlind: number
  bigBlind: number
  ante?: number
  duration: number
}

export interface TournamentConfig {
  id: string
  name: string
  format: TournamentFormat
  buyIn: number
  rake: number
  startingStack: number
  maxPlayers: number
  maxPerTable: number
  minPlayers: number
  lateRegistrationMinutes: number
  blindLevels: BlindLevel[]
  prizeStructure: number[]
  creatorId?: string
  creatorName?: string
}

export interface TournamentPlayer {
  userId: string
  name: string
  stack: number
  tableId: string
  seatIndex: number
  eliminatedAt?: number
  finishPosition?: number
}

export interface TournamentState {
  id: string
  name: string
  format: TournamentFormat
  status: TournamentStatus
  players: TournamentPlayer[]
  tables: string[]
  currentLevel: number
  levelTimeRemaining: number
  prizePool: number
  prizes: number[]
  registrations: number
  entries: number
  reentries: number
  blindLevels: BlindLevel[]
}

export interface TournamentSummary {
  id: string
  name: string
  format: TournamentFormat
  status: TournamentStatus
  buyIn: number
  prizePool: number
  maxPlayers: number
  maxPerTable: number
  registrations: number
  currentLevel: number
  creatorId?: string
  creatorName?: string
}

// ─── Auth Types ───────────────────────────────────────────
export interface SignupRequest {
  username: string
  password: string
}

export interface SigninRequest {
  username: string
  password: string
}

export interface AuthResponse {
  token: string
  user: {
    id: string
    name: string
    balance: number
  }
}

export interface SessionUser {
  id: string
  name: string
  balance: number
}

// ─── Hand History Types ────────────────────────────────────
export interface HandSummary {
  handId: number
  tableId: string
  timestamp: number
  playerNames: string[]
  winnerName: string
  winAmount: number
  potSize: number
  actionCount: number
}

export interface HandReplayState {
  step: number
  totalSteps: number
  currentStreet: GamePhase
  potSize: number
  communityCards: Card[]
  foldedPlayers: string[]
  allInPlayers: string[]
  playerStacks: Record<string, number>
  currentAction?: PlayerAction
  showHoleCards: boolean
}

// ─── Player Stats Types ───────────────────────────────────
export interface PlayerStatsInfo {
  totalHands: number
  vpip: number
  pfr: number
  af: number
  threeBetPct: number
  totalWon: number
  biggestPot: number
  handsWon: number
}

// ─── Chat Types ───────────────────────────────────────────
export interface ChatMessage {
  id: string
  playerId: string
  playerName: string
  text: string
  timestamp: number
}

// ─── Bot / Cashier Queue Types ──────────────────────────
export enum BotJobStatus {
  Queued = 'queued',
  Claimed = 'claimed',
  Completed = 'completed',
  Failed = 'failed',
}

export interface CashierJob {
  id: string
  type: TransactionType.Deposit | TransactionType.Withdrawal
  gcCode?: string
  amount?: number
  userId: string
  status: BotJobStatus
  createdAt: number
  claimedAt?: number
  completedAt?: number
  resultMessage?: string
}

export interface BotInfo {
  connected: boolean
  username?: string
  server?: string
  uptime: number
  queueLength: number
  lastActivity: number
}

// ─── Player-Created Game Types ──────────────────────────
export enum GameStatus {
  Waiting = 'waiting',
  Playing = 'playing',
  Complete = 'complete',
}

export interface PlayerGame {
  id: string
  name: string
  creatorId: string
  creatorName: string
  maxPlayers: number
  buyIn: number
  startingChips: number
  smallBlind: number
  bigBlind: number
  status: GameStatus
  players: PlayerGamePlayer[]
  createdAt: number
}

export interface PlayerGamePlayer {
  userId: string
  name: string
  stack: number
  finishPosition?: number
}

export interface PlayerGameSummary {
  id: string
  name: string
  creatorId: string
  creatorName: string
  maxPlayers: number
  buyIn: number
  startingChips: number
  smallBlind: number
  bigBlind: number
  status: GameStatus
  playerCount: number
  prizePool: number
}

export interface CreateGameRequest {
  name: string
  maxPlayers: number
  buyIn: number
  startingChips: number
  token: string
}

export interface CreateTournamentRequest {
  name: string
  maxPlayers: number
  maxPerTable: number
  buyIn: number
  startingChips: number
  token: string
}

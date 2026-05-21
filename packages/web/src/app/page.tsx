'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { io, Socket } from 'socket.io-client'
import {
  GameState, Player, Card, TableConfig, TableStatus, GamePhase,
  TournamentSummary, PlayerGameSummary, GameStatus,
  HAND_RANK_NAMES, HandSummary, PlayerStatsInfo,
  ChatMessage, HandRank, EvaluatedHand,
  ServerEvent, ClientEvent, ActionType, JoinTableRequest,
  TournamentFormat,
} from '@gcpoker/shared'
import { evaluateHand, calculateWinProbability } from '@gcpoker/engine'

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'http://localhost:3001'
const STORAGE_KEY = 'gcpoker_token'

const SUIT_SYMBOLS: Record<string, string> = { h: '\u2665', d: '\u2666', c: '\u2663', s: '\u2660' }
const SUIT_COLORS: Record<string, string> = { h: '#e74c3c', d: '#e74c3c', c: '#2c3e50', s: '#2c3e50' }
const RANK_LABELS: Record<number, string> = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }
const SUIT_NAMES: Record<string, string> = { h: 'Hearts', d: 'Diamonds', c: 'Clubs', s: 'Spades' }

function straightRangeText(cards: Card[]): string {
  const ranks = cards.map(c => c.rank).sort((a, b) => a - b)
  return `${RANK_LABELS[ranks[0]]} to ${RANK_LABELS[ranks[4]]}`
}

function getHandDescription(hand: EvaluatedHand): string {
  const { rank, kickers, bestCards } = hand
  switch (rank) {
    case HandRank.RoyalFlush:
      return `Royal Flush (${SUIT_NAMES[bestCards[0].suit]})`
    case HandRank.StraightFlush:
      return `Straight Flush, ${straightRangeText(bestCards)} (${SUIT_NAMES[bestCards[0].suit]})`
    case HandRank.FourOfAKind:
      return `Four of a Kind, ${RANK_LABELS[kickers[0]]}s`
    case HandRank.FullHouse:
      return `Full House, ${RANK_LABELS[kickers[0]]}s full of ${RANK_LABELS[kickers[1]]}s`
    case HandRank.Flush:
      return `Flush (${SUIT_NAMES[bestCards[0].suit]})`
    case HandRank.Straight:
      return `Straight, ${straightRangeText(bestCards)}`
    case HandRank.ThreeOfAKind:
      return `Three of a Kind, ${RANK_LABELS[kickers[0]]}s`
    case HandRank.TwoPair:
      return `Two Pair, ${RANK_LABELS[kickers[0]]}s and ${RANK_LABELS[kickers[1]]}s`
    case HandRank.OnePair:
      return `Pair of ${RANK_LABELS[kickers[0]]}s`
    case HandRank.HighCard:
      return `${RANK_LABELS[kickers[0]]} High`
    default:
      return HAND_RANK_NAMES[rank]
  }
}

// ─── Card Component ──────────────────────────────────────

function CardView({ card, hidden, small }: { card?: Card; hidden?: boolean; small?: boolean }) {
  const w = small ? 54 : 74
  const h = small ? 74 : 102
  const br = small ? 7 : 9
  if (hidden || !card) {
    return (
      <div style={{ width: w, height: h, borderRadius: br, background: 'linear-gradient(135deg, #1a3a5c, #2a5a8c)', border: '1px solid #3a6a9c', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: small ? 20 : 30, color: '#557', fontWeight: 700 }}>
        ?
      </div>
    )
  }
  return (
    <div style={{ width: w, height: h, borderRadius: br, background: '#fff', border: '1px solid #ccc', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: SUIT_COLORS[card.suit], boxShadow: '0 3px 8px rgba(0,0,0,0.25)', position: 'relative' }}>
      <span style={{ position: 'absolute', top: 3, left: 5, fontSize: small ? 16 : 22 }}>{RANK_LABELS[card.rank]}{SUIT_SYMBOLS[card.suit]}</span>
      <span style={{ fontSize: small ? 32 : 48 }}>{SUIT_SYMBOLS[card.suit]}</span>
    </div>
  )
}

// ─── Seat Position Calibration ──────────────────────────
interface CalibrationData {
  seats: Array<{ top: string; left: string }>
  communityCards?: { top: string; left: string }
  pot?: { top: string; left: string }
}

const DEFAULT_SEAT_POSITIONS: Record<number, React.CSSProperties> = {
  0: { bottom: '4%', left: '50%', transform: 'translateX(-50%)' },
  1: { bottom: '4%', left: '8%' },
  2: { bottom: '4%', right: '8%' },
  3: { top: '50%', left: '4%', transform: 'translateY(-50%)' },
  4: { top: '50%', right: '4%', transform: 'translateY(-50%)' },
  5: { top: '6%', left: '10%' },
  6: { top: '6%', left: '50%', transform: 'translateX(-50%)' },
  7: { top: '6%', right: '10%' },
}

const SEAT_LABELS = ['Dealer', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'HJ', 'CO']

function getCalibrationData(): CalibrationData | null {
  try {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('gcpoker_seats')
      return stored ? JSON.parse(stored) : null
    }
  } catch {}
  return null
}

function getSeatStyle(index: number): React.CSSProperties {
  const data = getCalibrationData()
  if (data?.seats?.[index]) {
    return { top: data.seats[index].top, left: data.seats[index].left, transform: 'translate(-50%, -50%)' }
  }
  return DEFAULT_SEAT_POSITIONS[index] ?? {}
}

function getCommunityCardsStyle(): React.CSSProperties {
  const data = getCalibrationData()
  if (data?.communityCards) {
    return { top: data.communityCards.top, left: data.communityCards.left, transform: 'translate(-50%, -50%)' }
  }
  return { top: '35%', left: '50%', transform: 'translate(-50%, -50%)' }
}

function getPotStyle(): React.CSSProperties {
  const data = getCalibrationData()
  if (data?.pot) {
    return { top: data.pot.top, left: data.pot.left, transform: 'translate(-50%, -50%)' }
  }
  return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
}

// ─── Player Seat ─────────────────────────────────────────

function PlayerSeat({ player, isCurrent, isMe, index, positionLabel, communityCards, phase }: {
  player: Player; isCurrent: boolean; isMe: boolean; index: number; positionLabel: string;
  communityCards: Card[]; phase: GamePhase
}) {
  const showCards = (isMe || player.cardsRevealed) && player.holeCards && !player.isFolded
  const isWinner = player.bestHand && !player.isFolded

  const handInfo = useMemo(() => {
    if (!isMe || !player.holeCards || player.isFolded || phase >= GamePhase.Showdown) return null
    const winProb = calculateWinProbability(player.holeCards, communityCards, 400)
    if (communityCards.length >= 3) {
      const evaluated = evaluateHand(player.holeCards, communityCards)
      return { handType: getHandDescription(evaluated), winProb }
    }
    if (player.holeCards[0].rank === player.holeCards[1].rank) {
      return { handType: `Pocket ${RANK_LABELS[player.holeCards[0].rank]}s`, winProb }
    }
    const highRank = Math.max(player.holeCards[0].rank, player.holeCards[1].rank)
    return { handType: `${RANK_LABELS[highRank]} High`, winProb }
  }, [isMe, player.holeCards, player.isFolded, communityCards, phase])

  return (
    <div style={{
      position: 'absolute', ...getSeatStyle(index),
      padding: '8px 14px', borderRadius: 12,
      background: isCurrent ? 'rgba(46, 204, 113, 0.25)' : isWinner ? 'rgba(241, 196, 15, 0.12)' : isMe ? 'rgba(52, 152, 219, 0.15)' : 'rgba(255,255,255,0.04)',
      border: isCurrent ? '2px solid #2ecc71' : isWinner ? '1px solid #f1c40f' : isMe ? '1px solid #3498db' : '1px solid rgba(255,255,255,0.08)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, minWidth: 120, transition: 'all 0.2s',
      opacity: 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: player.isFolded ? '#888' : '#eee' }}>{player.name}</span>
        {player.isFolded && <span style={{ fontSize: 10, background: '#e74c3c', color: '#fff', borderRadius: 3, padding: '2px 6px', fontWeight: 700 }}>FOLD</span>}
        {player.isDealer && !player.isFolded && <span style={{ fontSize: 10, background: '#f1c40f', color: '#222', borderRadius: 3, padding: '2px 6px', fontWeight: 700 }}>D</span>}
        {player.isAllIn && <span style={{ fontSize: 10, background: '#e67e22', color: '#fff', borderRadius: 3, padding: '2px 6px' }}>AI</span>}
      </div>
      <div style={{ fontSize: 14, color: player.isFolded ? '#666' : '#f1c40f', fontWeight: 700 }}>${player.stack}</div>
      {player.currentBet > 0 && !player.isFolded && (
        <div style={{ fontSize: 12, color: '#e67e22', background: 'rgba(230,126,34,0.15)', padding: '2px 10px', borderRadius: 4 }}>Bet ${player.currentBet}</div>
      )}
      <div style={{ fontSize: 10, color: player.isFolded ? '#555' : '#666' }}>{positionLabel}</div>
      {showCards && (
        <div style={{ display: 'flex', gap: 3, marginTop: 2 }}>
          <CardView card={player.holeCards![0]} small />
          <CardView card={player.holeCards![1]} small />
        </div>
      )}
      {!showCards && !player.isFolded && (
        <div style={{ display: 'flex', gap: 3, marginTop: 2 }}>
          <CardView hidden small />
          <CardView hidden small />
        </div>
      )}
      {handInfo && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 }}>
          {handInfo.handType && (
            <span style={{ fontSize: 11, fontWeight: 700, color: '#2ecc71', background: 'rgba(46,204,113,0.12)', padding: '2px 8px', borderRadius: 4 }}>
              {handInfo.handType}
            </span>
          )}
          <span style={{ fontSize: 11, fontWeight: 700, color: '#3498db', background: 'rgba(52,152,219,0.12)', padding: '2px 8px', borderRadius: 4 }}>
            {Math.round(handInfo.winProb * 100)}%
          </span>
        </div>
      )}
      {player.bestHand && player.cardsRevealed && (
        <div style={{
          fontSize: 12, fontWeight: 700, color: '#2ecc71',
          background: 'rgba(46,204,113,0.12)', padding: '2px 10px', borderRadius: 4, marginTop: 3,
        }}>
          {getHandDescription(player.bestHand)}
        </div>
      )}
    </div>
  )
}

// ─── Action Button ───────────────────────────────────────

function ActBtn({ label, color, disabled, onClick }: {
  label: string; color: string; disabled?: boolean; onClick: () => void
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: '12px 28px', borderRadius: 8, border: 'none',
      background: disabled ? '#2a2a3e' : color, color: '#fff',
      fontWeight: 700, fontSize: 16, cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1, transition: 'all 0.15s',
      boxShadow: disabled ? 'none' : '0 3px 8px rgba(0,0,0,0.35)',
    }}>
      {label}
    </button>
  )
}

// ─── Table View ──────────────────────────────────────────

// ─── Table Hand History Modal ────────────────────────────

function TableHandHistoryModal({ tableId, onClose, onSelectHand }: {
  tableId: string; onClose: () => void; onSelectHand: (hand: HandSummary) => void
}) {
  const [hands, setHands] = useState<HandSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`${WS_URL}/api/hands/table/${tableId}`)
      .then(r => r.json())
      .then(data => setHands(data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [tableId])

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 150, backdropFilter: 'blur(4px)',
    }}>
      <div style={{
        background: 'linear-gradient(135deg, #1a1a2e, #16213e)',
        borderRadius: 20, padding: '24px 28px',
        border: '1px solid rgba(255,255,255,0.12)',
        width: '90%', maxWidth: 600, maxHeight: '80vh',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: '#eee' }}>Table History</div>
          <button onClick={onClose} style={{
            padding: '6px 14px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)',
            background: 'transparent', color: '#888', cursor: 'pointer', fontSize: 13,
          }}>Close</button>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', color: '#888', padding: 40 }}>Loading hands...</div>
        ) : hands.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#888', padding: 40, background: 'rgba(255,255,255,0.03)', borderRadius: 12 }}>
            No hands played at this table yet.
          </div>
        ) : (
          <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {hands.map(h => (
              <div key={h.handId} onClick={() => onSelectHand(h)} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '10px 14px', borderRadius: 8,
                background: 'rgba(255,255,255,0.03)', cursor: 'pointer',
                transition: 'all 0.15s',
              }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)' }}>
                <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: '#666', minWidth: 40 }}>#{h.handId}</span>
                  <div>
                    <div style={{ fontSize: 13, color: '#ccc' }}>{h.winnerName} wins ${h.winAmount}</div>
                    <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                      {new Date(h.timestamp).toLocaleString()} &middot; Pot: ${h.potSize} &middot; {h.actionCount} actions
                    </div>
                  </div>
                </div>
                <span style={{ fontSize: 11, color: '#888' }}>{h.playerNames.length}p</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function TableView({
  gameState, socket, myId, onLeave, onViewHand,
}: {
  gameState: GameState; socket: Socket; myId: string; onLeave: () => void; onViewHand?: (hand: HandSummary) => void
}) {
  const [legalActions, setLegalActions] = useState<ActionType[]>([])
  const [betAmount, setBetAmount] = useState(0)
  const [handResult, setHandResult] = useState<string | null>(null)
  const [showdown, setShowdown] = useState(false)
  const [showdownDismissable, setShowdownDismissable] = useState(false)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [showTableHistory, setShowTableHistory] = useState(false)
  const [tableHistoryHand, setTableHistoryHand] = useState<HandSummary | null>(null)

  useEffect(() => {
    const handler = (data: { playerId: string; legalActions: ActionType[] }) => {
      if (data.playerId === socket.id) setLegalActions(data.legalActions)
      else setLegalActions([])
    }
    socket.on(ServerEvent.ActionRequired, handler)
    return () => { socket.off(ServerEvent.ActionRequired, handler) }
  }, [socket])

  useEffect(() => {
    if (gameState.phase === GamePhase.Complete) {
      const nonFolded = gameState.players.filter(p => !p.isFolded)
      const winners = nonFolded.filter(p => p.bestHand)
      const winner = winners.length > 0 ? winners[0] : nonFolded[0]
      const myPlayer = gameState.players.find(p => p.id === myId)
      const iWon = myPlayer && winner?.id === myId
      if (myPlayer) {
        setShowdown(true)
        setShowdownDismissable(false)
        setHandResult(iWon ? 'You won!' : `${winner?.name ?? 'Player'} wins`)
        // Allow dismissing after 4 seconds (only for practice/AI tables)
        if (gameState.players.some(p => p.id.startsWith('ai-'))) {
          setTimeout(() => setShowdownDismissable(true), 4000)
        }
      }
    }
  }, [gameState.phase, gameState.handCount, myId])

  // When the server starts the next hand (after Continue), dismiss overlay
  const prevPhaseRef = useRef(gameState.phase)
  useEffect(() => {
    const prev = prevPhaseRef.current
    prevPhaseRef.current = gameState.phase
    if (prev === GamePhase.Complete && gameState.phase !== GamePhase.Complete && showdown) {
      setShowdown(false)
      setHandResult(null)
    }
  }, [gameState.phase, showdown])

  useEffect(() => {
    const handler = (msg: ChatMessage) => {
      setChatMessages(prev => [...prev.slice(-49), msg])
    }
    socket.on(ServerEvent.Chat, handler)
    return () => { socket.off(ServerEvent.Chat, handler) }
  }, [socket])

  const act = useCallback((type: ActionType, amount?: number) => {
    socket.emit(ClientEvent.PlayerAction, { type, amount })
    setLegalActions([])
  }, [socket])

  const myPlayer = gameState.players.find(p => p.id === myId)
  const currentPlayer = gameState.players[gameState.currentPlayerIndex]
  const isMyTurn = currentPlayer?.id === myId
  const toCall = myPlayer ? Math.max(0, gameState.currentBet - myPlayer.currentBet) : 0
  const phaseLabels = ['', 'Pre-Flop', 'Flop', 'Turn', 'River', 'Showdown', 'Complete']
  const positionLabels = gameState.players.map((_, i) => SEAT_LABELS[i] ?? `Seat ${i + 1}`)

  const isBetOrRaise = legalActions.includes(ActionType.Raise) || legalActions.includes(ActionType.Bet)
  const isRaise = legalActions.includes(ActionType.Raise)
  const betMin = isRaise
    ? gameState.currentBet + gameState.blinds.big
    : gameState.blinds.big
  const betMax = myPlayer
    ? myPlayer.stack + myPlayer.currentBet
    : 100
  const clamped = Math.max(betMin, Math.min(betAmount, betMax))

  useEffect(() => {
    if (myPlayer && isMyTurn) {
      const initial = Math.min(gameState.blinds.big * 3, myPlayer.stack)
      setBetAmount(Math.max(betMin, initial))
    }
  }, [gameState.handCount, isMyTurn])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100%' }}>
      {/* Top Bar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '12px 24px', background: 'rgba(0,0,0,0.35)', borderBottom: '1px solid rgba(255,255,255,0.08)',
      }}>
        <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
          <span style={{ color: '#f1c40f', fontWeight: 700, fontSize: 18 }}>Pot: ${gameState.pot.main}</span>
          <span style={{ color: '#3498db', fontSize: 16, fontWeight: 600 }}>{phaseLabels[gameState.phase] ?? ''}</span>
          <span style={{ fontSize: 14, color: '#888' }}>Hand #{gameState.handCount}</span>
          <button onClick={() => setShowTableHistory(true)} style={{
            padding: '6px 14px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.2)',
            background: 'rgba(255,255,255,0.08)', color: '#ccc', cursor: 'pointer', fontSize: 12, fontWeight: 600,
          }}>History</button>
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          {myPlayer && <span style={{ color: '#3498db', fontSize: 16, fontWeight: 700 }}>Stack: ${myPlayer.stack}</span>}
          <button onClick={onLeave} style={{
            padding: '8px 20px', borderRadius: 6, border: '1px solid #e74c3c',
            background: 'transparent', color: '#e74c3c', cursor: 'pointer', fontSize: 14, fontWeight: 600,
          }}>Leave</button>
        </div>
      </div>

      {/* Table Area */}
      <div style={{
        flex: 1, position: 'relative', overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: 'url(/poker-table.png)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
        }}>
          {/* Community cards */}
          <div style={{
            position: 'absolute', ...getCommunityCardsStyle(),
            display: 'flex', gap: 8,
          }}>
            {Array.from({ length: 5 }).map((_, i) => (
              <CardView key={i} card={gameState.communityCards[i]} />
            ))}
          </div>

          {/* Pot */}
          <div style={{
            position: 'absolute', ...getPotStyle(),
            color: '#f1c40f', fontSize: 18, fontWeight: 700,
            background: 'rgba(0,0,0,0.4)', padding: '4px 20px', borderRadius: 10,
          }}>
            Pot: ${gameState.pot.main}
          </div>

          {/* Players */}
          {gameState.players.map((p, i) => (
            <PlayerSeat key={p.id} player={p} index={i} isCurrent={currentPlayer?.id === p.id && isMyTurn}
              isMe={p.id === myId} positionLabel={positionLabels[i]}
              communityCards={gameState.communityCards} phase={gameState.phase} />
          ))}

          {/* Chat Overlay */}
          {chatMessages.length > 0 && <ChatOverlay messages={chatMessages} myId={myId} />}
        </div>
      </div>

      {/* Action Bar */}
      <div style={{
        padding: '10px 20px', background: 'rgba(0,0,0,0.35)', borderTop: '1px solid rgba(255,255,255,0.08)',
        display: 'flex', flexDirection: 'column', gap: 6, minHeight: 72,
      }}>
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {isMyTurn && legalActions.length > 0 ? (
            <>
              {legalActions.includes(ActionType.Fold) && <ActBtn label="Fold" color="#e74c3c" onClick={() => act(ActionType.Fold)} />}
              {legalActions.includes(ActionType.Check) && <ActBtn label="Check" color="#3498db" onClick={() => act(ActionType.Check)} />}
              {legalActions.includes(ActionType.Call) && <ActBtn label={`Call $${toCall}`} color="#2ecc71" onClick={() => act(ActionType.Call)} />}
              {isBetOrRaise && (
                <>
                  {/* Pot Preset Buttons */}
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <PotPresetBtn label="½ Pot" onClick={() => {
                      const halfPot = isRaise
                        ? Math.max(betMin, Math.min(betMax, Math.floor(gameState.currentBet + gameState.pot.main / 2 + toCall)))
                        : Math.max(betMin, Math.min(betMax, Math.floor(gameState.pot.main / 2)))
                      setBetAmount(halfPot)
                    }} />
                    <PotPresetBtn label="¾ Pot" onClick={() => {
                      const val = isRaise
                        ? Math.max(betMin, Math.min(betMax, Math.floor(gameState.currentBet + gameState.pot.main * 3 / 4 + toCall)))
                        : Math.max(betMin, Math.min(betMax, Math.floor(gameState.pot.main * 3 / 4)))
                      setBetAmount(val)
                    }} />
                    <PotPresetBtn label="Pot" onClick={() => {
                      const potBet = isRaise
                        ? Math.max(betMin, Math.min(betMax, Math.floor(gameState.currentBet + gameState.pot.main + toCall)))
                        : Math.max(betMin, Math.min(betMax, gameState.pot.main))
                      setBetAmount(potBet)
                    }} />
                    <PotPresetBtn label="All In" onClick={() => setBetAmount(betMax)} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.07)', padding: '6px 14px', borderRadius: 8 }}>
                    <span style={{ fontSize: 11, color: '#888', minWidth: 50 }}>
                      {gameState.pot.main > 0 ? `${Math.round(clamped / (gameState.pot.main + toCall) * 100)}%` : '—'}
                    </span>
                    <input type="range" min={betMin} max={betMax} value={clamped} onChange={e => setBetAmount(Number(e.target.value))} style={{ width: 120 }} />
                    <input type="number" min={betMin} max={betMax} value={clamped} onChange={e => setBetAmount(Math.max(betMin, Math.min(Number(e.target.value), betMax)))} style={{ width: 70, padding: '5px 8px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.15)', background: '#16162a', color: '#eee', fontSize: 13, textAlign: 'center' }} />
                  </div>
                  <ActBtn label={isRaise ? `Raise $${clamped}` : `Bet $${clamped}`} color="#e67e22" onClick={() => act(isRaise ? ActionType.Raise : ActionType.Bet, clamped)} />
                </>
              )}
              {legalActions.includes(ActionType.AllIn) && <ActBtn label={`All In $${myPlayer?.stack ?? 0}`} color="#9b59b6" onClick={() => act(ActionType.AllIn)} />}
            </>
          ) : gameState.phase === GamePhase.Complete && myPlayer && myPlayer.holeCards && !myPlayer.isFolded ? (
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <span style={{ color: '#888', fontSize: 16 }}>Hand complete</span>
              <button onClick={() => socket.emit(ClientEvent.ShowCards)} style={{
                padding: '8px 20px', borderRadius: 6, border: '1px solid #3498db',
                background: 'transparent', color: '#3498db', cursor: 'pointer', fontSize: 14, fontWeight: 600,
              }}>
                {myPlayer.cardsRevealed ? 'Hide Cards' : 'Show Cards'}
              </button>
            </div>
          ) : (
            <span style={{ color: '#888', fontSize: 16 }}>
              {currentPlayer ? `${currentPlayer.name}'s turn...` : 'Waiting...'}
            </span>
          )}
        </div>
        {/* Chat Input */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 6 }}>
          <input
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && chatInput.trim()) {
                socket.emit(ClientEvent.Chat, { text: chatInput.trim() })
                setChatInput('')
              }
            }}
            placeholder="Chat..."
            maxLength={200}
            style={{
              width: 300, padding: '6px 12px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)',
              background: 'rgba(0,0,0,0.3)', color: '#ccc', fontSize: 12, outline: 'none',
            }}
          />
        </div>
      </div>

      {/* Showdown Overlay */}
      {showdown && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 100, backdropFilter: 'blur(4px)',
        }}>
          <div style={{
            background: 'linear-gradient(135deg, #1a1a2e, #16213e)', borderRadius: 20, padding: '32px 40px',
            border: '1px solid rgba(255,255,255,0.12)', boxShadow: '0 24px 64px rgba(0,0,0,0.7)',
            maxWidth: 550, width: '90%', textAlign: 'center',
          }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: '#f1c40f', marginBottom: 20 }}>
              {handResult}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
              {gameState.players.filter(p => !p.isFolded).map(p => (
                <div key={p.id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '10px 16px', background: 'rgba(255,255,255,0.05)', borderRadius: 10,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontWeight: 700, fontSize: 16 }}>{p.name}</span>
                    {p.holeCards && p.cardsRevealed && (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <CardView card={p.holeCards[0]} small />
                        <CardView card={p.holeCards[1]} small />
                      </div>
                    )}
                  </div>
                  {p.bestHand && (
                    <span style={{ color: '#2ecc71', fontWeight: 700, fontSize: 15 }}>
                      {getHandDescription(p.bestHand)}
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div style={{ fontSize: 15, color: '#888', marginBottom: 16 }}>
              Pot: ${gameState.pot.main}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16 }}>
              {myPlayer && myPlayer.holeCards && !myPlayer.isFolded && (
                <button onClick={() => socket.emit(ClientEvent.ShowCards)} style={{
                  padding: '10px 24px', borderRadius: 8, border: '1px solid #3498db',
                  background: 'transparent', color: '#3498db', cursor: 'pointer',
                  fontSize: 15, fontWeight: 600,
                }}>
                  {myPlayer.cardsRevealed ? 'Hide My Cards' : 'Show My Cards'}
                </button>
              )}
              {showdownDismissable && gameState.players.some(p => p.id.startsWith('ai-')) && (
                <button onClick={() => {
                  setShowdown(false)
                  setHandResult(null)
                  socket.emit(ClientEvent.Continue)
                }} style={{
                  padding: '10px 24px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.2)',
                  background: 'transparent', color: '#888', cursor: 'pointer',
                  fontSize: 15, fontWeight: 600,
                }}>
                  Continue
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Table Hand History Modal */}
      {showTableHistory && !tableHistoryHand && gameState.tableId && (
        <TableHandHistoryModal
          tableId={gameState.tableId}
          onClose={() => setShowTableHistory(false)}
          onSelectHand={(hand) => setTableHistoryHand(hand)}
        />
      )}
      {tableHistoryHand && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 150, backdropFilter: 'blur(4px)',
        }}>
          <div style={{
            background: 'linear-gradient(135deg, #1a1a2e, #16213e)',
            borderRadius: 20, padding: '24px 28px',
            border: '1px solid rgba(255,255,255,0.12)',
            width: '90%', maxWidth: 700, maxHeight: '85vh',
            overflow: 'auto',
          }}>
            <HandReplayer hand={tableHistoryHand} onBack={() => setTableHistoryHand(null)} />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Auth Screen ─────────────────────────────────────────

function AuthScreen({ onAuth, onSignup }: { onAuth: (token: string) => void; onSignup?: (token: string) => void }) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    setError('')
    if (!username || !password) { setError('Fill in all fields'); return }
    setLoading(true)
    try {
      const res = await fetch(`${WS_URL}/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Authentication failed')
      localStorage.setItem(STORAGE_KEY, data.token)
      if (mode === 'signup' && onSignup) {
        onSignup(data.token)
      } else {
        onAuth(data.token)
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div style={{
        background: '#1a1a2e', borderRadius: 20, padding: '40px 36px',
        border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
        width: '100%', maxWidth: 400,
      }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 36, fontWeight: 800, color: '#f1c40f', letterSpacing: -1, marginBottom: 8 }}>♠ GCPoker</div>
          <div style={{ fontSize: 14, color: '#888' }}>{mode === 'signin' ? 'Welcome back' : 'Create your account'}</div>
        </div>

        {error && (
          <div style={{
            textAlign: 'center', color: '#e74c3c', marginBottom: 16,
            padding: '8px 16px', background: 'rgba(231,76,60,0.1)', borderRadius: 8,
            fontSize: 13,
          }}>{error}</div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <input
            value={username} onChange={e => setUsername(e.target.value)}
            placeholder="Username" autoFocus
            style={{ padding: '12px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: '#16162a', color: '#eee', fontSize: 15, outline: 'none' }}
          />
          <input
            value={password} onChange={e => setPassword(e.target.value)}
            placeholder="Password" type="password"
            onKeyDown={e => e.key === 'Enter' && submit()}
            style={{ padding: '12px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: '#16162a', color: '#eee', fontSize: 15, outline: 'none' }}
          />
          <button onClick={submit} disabled={loading} style={{
            padding: '12px', borderRadius: 8, border: 'none',
            background: loading ? '#2a2a3e' : '#2ecc71', color: '#fff',
            fontWeight: 700, fontSize: 15, cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.6 : 1, marginTop: 4,
          }}>
            {loading ? 'Please wait...' : mode === 'signin' ? 'Sign In' : 'Create Account'}
          </button>
        </div>

        <div style={{ textAlign: 'center', marginTop: 20, fontSize: 13, color: '#888' }}>
          {mode === 'signin' ? (
            <>No account? <button onClick={() => { setMode('signup'); setError('') }} style={{ background: 'none', border: 'none', color: '#3498db', cursor: 'pointer', fontWeight: 600, fontSize: 13, padding: 0 }}>Sign up</button></>
          ) : (
            <>Already have an account? <button onClick={() => { setMode('signin'); setError('') }} style={{ background: 'none', border: 'none', color: '#3498db', cursor: 'pointer', fontWeight: 600, fontSize: 13, padding: 0 }}>Sign in</button></>
          )}
        </div>
      </div>
    </div>
  )
}

function DiscordLinkScreen({ token, onLinked, onSkip }: { token: string; onLinked: () => void; onSkip: () => void }) {
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const submit = async () => {
    setError('')
    if (!code.trim()) { setError('Enter your code'); return }
    setLoading(true)
    try {
      const res = await fetch(`${WS_URL}/api/auth/discord/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, code: code.trim().toUpperCase() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Link failed')
      setSuccess(true)
      setTimeout(onLinked, 1500)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div style={{
        background: '#1a1a2e', borderRadius: 20, padding: '40px 36px',
        border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
        width: '100%', maxWidth: 440, textAlign: 'center',
      }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🔗</div>
        <div style={{ fontSize: 24, fontWeight: 700, color: '#fff', marginBottom: 8 }}>Link your Discord</div>
        <div style={{ fontSize: 14, color: '#888', lineHeight: 1.6, marginBottom: 24 }}>
          Go to the GCPoker Discord server and run <code style={{ background: '#16162a', padding: '2px 8px', borderRadius: 4, color: '#f1c40f' }}>/link</code>
          {' '}in any channel, then enter the 6-character code below.
        </div>

        {success ? (
          <div style={{
            padding: 16, background: 'rgba(46,204,113,0.1)', borderRadius: 8,
            border: '1px solid rgba(46,204,113,0.2)',
            color: '#2ecc71', fontSize: 15, fontWeight: 600,
          }}>
            ✓ Discord linked successfully!
          </div>
        ) : (
          <>
            {error && (
              <div style={{
                color: '#e74c3c', marginBottom: 16, padding: '8px 16px',
                background: 'rgba(231,76,60,0.1)', borderRadius: 8, fontSize: 13,
              }}>{error}</div>
            )}
            <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
              <input
                value={code} onChange={e => setCode(e.target.value.toUpperCase().slice(0, 6))}
                placeholder="XXXXXX" maxLength={6}
                onKeyDown={e => e.key === 'Enter' && submit()}
                style={{
                  flex: 1, padding: '12px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)',
                  background: '#16162a', color: '#eee', fontSize: 20, outline: 'none',
                  textAlign: 'center', letterSpacing: 8, fontWeight: 700, textTransform: 'uppercase',
                }}
              />
            </div>
            <button onClick={submit} disabled={loading || code.length < 6} style={{
              width: '100%', padding: '12px', borderRadius: 8, border: 'none',
              background: loading ? '#2a2a3e' : '#5865F2', color: '#fff',
              fontWeight: 700, fontSize: 15, cursor: code.length < 6 ? 'not-allowed' : 'pointer',
              opacity: code.length < 6 ? 0.4 : 1, marginBottom: 12,
            }}>
              {loading ? 'Verifying...' : 'Link Discord'}
            </button>
            <button onClick={onSkip} style={{
              background: 'none', border: 'none', color: '#888', cursor: 'pointer',
              fontSize: 13, padding: 0, textDecoration: 'underline',
            }}>
              Skip for now — I'll link later
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function DeleteAccountScreen({ token, onDeleted, onCancel, discordTag }: { token: string; onDeleted: () => void; onCancel: () => void; discordTag?: string | null }) {
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const submit = async () => {
    setError('')
    if (!code.trim()) { setError('Enter your code'); return }
    setLoading(true)
    try {
      const res = await fetch(`${WS_URL}/api/auth/delete-account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, code: code.trim().toUpperCase() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Deletion failed')
      setSuccess(true)
      localStorage.removeItem(STORAGE_KEY)
      setTimeout(onDeleted, 2000)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  if (!discordTag) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}>
        <div style={{
          background: '#1a1a2e', borderRadius: 20, padding: '40px 36px',
          border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
          width: '100%', maxWidth: 440, textAlign: 'center',
        }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🔗</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#e74c3c', marginBottom: 8 }}>Discord Required</div>
          <div style={{ fontSize: 14, color: '#888', lineHeight: 1.6, marginBottom: 24 }}>
            You must link a Discord account before you can delete your account. This ensures only you can authorize account deletion.
          </div>
          <button onClick={onCancel} style={{
            padding: '12px 24px', borderRadius: 8, border: 'none',
            background: '#5865F2', color: '#fff',
            fontWeight: 700, fontSize: 14, cursor: 'pointer',
          }}>
            Go Back
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div style={{
        background: '#1a1a2e', borderRadius: 20, padding: '40px 36px',
        border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
        width: '100%', maxWidth: 440, textAlign: 'center',
      }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
        <div style={{ fontSize: 24, fontWeight: 700, color: '#e74c3c', marginBottom: 8 }}>Delete Account</div>
        <div style={{ fontSize: 14, color: '#888', lineHeight: 1.6, marginBottom: 24 }}>
          This will permanently delete your GCPoker account and <strong style={{ color: '#e74c3c' }}>you will lose any remaining balance</strong>.
          To confirm, run <code style={{ background: '#16162a', padding: '2px 8px', borderRadius: 4, color: '#f1c40f' }}>/confirmdeletion</code>
          {' '}in the GCPoker Discord server and enter the code below.
        </div>

        {success ? (
          <div style={{
            padding: 16, background: 'rgba(231,76,60,0.1)', borderRadius: 8,
            border: '1px solid rgba(231,76,60,0.2)',
            color: '#e74c3c', fontSize: 15, fontWeight: 600,
          }}>
            ✕ Account deleted. Redirecting...
          </div>
        ) : (
          <>
            {error && (
              <div style={{
                color: '#e74c3c', marginBottom: 16, padding: '8px 16px',
                background: 'rgba(231,76,60,0.1)', borderRadius: 8, fontSize: 13,
              }}>{error}</div>
            )}
            <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
              <input
                value={code} onChange={e => setCode(e.target.value.toUpperCase().slice(0, 6))}
                placeholder="XXXXXX" maxLength={6}
                onKeyDown={e => e.key === 'Enter' && submit()}
                style={{
                  flex: 1, padding: '12px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)',
                  background: '#16162a', color: '#eee', fontSize: 20, outline: 'none',
                  textAlign: 'center', letterSpacing: 8, fontWeight: 700, textTransform: 'uppercase',
                }}
              />
            </div>
            <button onClick={submit} disabled={loading || code.length < 6} style={{
              width: '100%', padding: '12px', borderRadius: 8, border: 'none',
              background: loading ? '#2a2a3e' : '#e74c3c', color: '#fff',
              fontWeight: 700, fontSize: 15, cursor: code.length < 6 ? 'not-allowed' : 'pointer',
              opacity: code.length < 6 ? 0.4 : 1, marginBottom: 12,
            }}>
              {loading ? 'Deleting...' : 'Delete My Account'}
            </button>
            <button onClick={onCancel} style={{
              background: 'none', border: 'none', color: '#888', cursor: 'pointer',
              fontSize: 13, padding: 0, textDecoration: 'underline',
            }}>
              Cancel — keep my account
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Seat Calibration View ───────────────────────────────

type CalibrationPhase = 'seats' | 'community' | 'pot' | 'done'

const PHASE_LABELS: Record<CalibrationPhase, string> = {
  seats: 'Click each seat position (8 total)',
  community: 'Click the center of the community card area',
  pot: 'Click where the pot amount should display',
  done: 'All positions saved!',
}

const PHASE_TARGETS: Record<CalibrationPhase, number> = {
  seats: 8,
  community: 1,
  pot: 1,
  done: 0,
}

interface CalibrationItem {
  phase: CalibrationPhase
  index?: number
  top: string
  left: string
  color: string
  label: string
}

function CalibrateSeatsView({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<CalibrationPhase>('seats')
  const [items, setItems] = useState<CalibrationItem[]>([])
  const tableRef = useRef<HTMLDivElement>(null)

  const phaseProgress = (): string => {
    if (phase === 'seats') return `${items.length}/8`
    if (phase === 'community') return `Seats done (8/8)`
    if (phase === 'pot') return `Community cards done`
    return ''
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!e.shiftKey || phase === 'done') return
    e.preventDefault()
    const rect = tableRef.current!.getBoundingClientRect()
    const top = ((e.clientY - rect.top) / rect.height * 100).toFixed(2)
    const left = ((e.clientX - rect.left) / rect.width * 100).toFixed(2)
    const pos = { top: `${top}%`, left: `${left}%` }

    if (phase === 'seats' && items.length < 8) {
      const newItems = [...items, { phase, index: items.length, ...pos, color: '#2ecc71', label: `${items.length + 1}` }]
      setItems(newItems)
      if (newItems.length === 8) setPhase('community')
    } else if (phase === 'community') {
      const newItems = [...items, { phase, ...pos, color: '#3498db', label: 'CC' }]
      setItems(newItems)
      setPhase('pot')
    } else if (phase === 'pot') {
      const newItems = [...items, { phase, ...pos, color: '#f1c40f', label: 'Pot' }]
      setItems(newItems)
      setPhase('done')
    }
  }

  // Separate effect to save when phase reaches done
  const saveRef = useRef(false)
  useEffect(() => {
    if (phase === 'done' && !saveRef.current) {
      saveRef.current = true
      const seats = items.filter(i => i.phase === 'seats').map(i => ({ top: i.top, left: i.left }))
      const community = items.find(i => i.phase === 'community')
      const pot = items.find(i => i.phase === 'pot')
      const data: CalibrationData = { seats }
      if (community) data.communityCards = { top: community.top, left: community.left }
      if (pot) data.pot = { top: pot.top, left: pot.left }
      localStorage.setItem('gcpoker_seats', JSON.stringify(data))
    }
  }, [phase, items])

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#0f0f1a', display: 'flex', flexDirection: 'column' }}>
      {/* Top Bar — matches game style */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '12px 24px', background: 'rgba(0,0,0,0.35)', borderBottom: '1px solid rgba(255,255,255,0.08)',
      }}>
        <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
          <span style={{ color: '#f1c40f', fontWeight: 700, fontSize: 18 }}>Calibration</span>
          <span style={{ color: '#3498db', fontSize: 16, fontWeight: 600 }}>{PHASE_LABELS[phase]}</span>
          <span style={{ fontSize: 14, color: '#888' }}>{phaseProgress()}</span>
        </div>
      </div>

      {/* Table Area — full-width image, no border */}
      <div ref={tableRef} style={{
        flex: 1, position: 'relative', overflow: 'hidden', cursor: 'crosshair',
        backgroundImage: 'url(/poker-table.png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
      }}
        onContextMenu={handleContextMenu}
      >
        {/* Marker items */}
        {items.filter(i => i.phase === 'seats').map((pos, i) => (
          <div key={`seat-${i}`} style={{
            position: 'absolute', top: pos.top, left: pos.left,
            transform: 'translate(-50%, -50%)',
            width: 44, height: 44, borderRadius: '50%',
            background: 'rgba(46,204,113,0.55)',
            border: '2px solid #2ecc71',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontWeight: 800, fontSize: 18,
            boxShadow: '0 0 12px rgba(46,204,113,0.4)',
            zIndex: 10,
          }}>
            {i + 1}
          </div>
        ))}
        {items.filter(i => i.phase === 'community').map(pos => (
          <div key="community" style={{
            position: 'absolute', top: pos.top, left: pos.left,
            transform: 'translate(-50%, -50%)',
            width: 180, height: 44, borderRadius: 8,
            background: 'rgba(52,152,219,0.45)',
            border: '2px solid #3498db',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontWeight: 700, fontSize: 14,
            boxShadow: '0 0 12px rgba(52,152,219,0.4)',
            zIndex: 10,
          }}>
            Community Cards
          </div>
        ))}
        {items.filter(i => i.phase === 'pot').map(pos => (
          <div key="pot" style={{
            position: 'absolute', top: pos.top, left: pos.left,
            transform: 'translate(-50%, -50%)',
            padding: '8px 24px', borderRadius: 8,
            background: 'rgba(241,196,15,0.45)',
            border: '2px solid #f1c40f',
            color: '#fff', fontWeight: 700, fontSize: 16,
            boxShadow: '0 0 12px rgba(241,196,15,0.4)',
            zIndex: 10,
          }}>
            Pot: $0
          </div>
        ))}
      </div>

      {/* Bottom Bar — matches game action bar style */}
      <div style={{
        padding: '10px 20px', background: 'rgba(0,0,0,0.35)', borderTop: '1px solid rgba(255,255,255,0.08)',
        display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, minHeight: 72,
      }}>
        {phase === 'done' && (
          <div style={{ color: '#2ecc71', fontWeight: 700, fontSize: 15 }}>
            All positions saved
          </div>
        )}
        <button onClick={() => {
          localStorage.removeItem('gcpoker_seats')
          setItems([])
          setPhase('seats')
          saveRef.current = false
        }} style={{
          padding: '10px 24px', borderRadius: 8, border: '1px solid #e74c3c',
          background: 'transparent', color: '#e74c3c', cursor: 'pointer', fontWeight: 600, fontSize: 14,
        }}>Reset</button>
        <button onClick={() => {
          if (phase === 'done' || items.length > 0) onDone()
          else {
            // Save whatever we have
            const seats = items.filter(i => i.phase === 'seats').map(i => ({ top: i.top, left: i.left }))
            const community = items.find(i => i.phase === 'community')
            const pot = items.find(i => i.phase === 'pot')
            const data: CalibrationData = { seats }
            if (community) data.communityCards = { top: community.top, left: community.left }
            if (pot) data.pot = { top: pot.top, left: pot.left }
            localStorage.setItem('gcpoker_seats', JSON.stringify(data))
            onDone()
          }
        }} style={{
          padding: '10px 24px', borderRadius: 8, border: 'none',
          background: '#2ecc71', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 14,
        }}>Done</button>
      </div>
    </div>
  )
}

// ─── Header / Profile ────────────────────────────────────

function Header({ name, balance, connected, onSignOut, onDeposit, onWithdraw, discordTag, onLinkDiscord, onUnlinkDiscord, onDeleteAccount }: {
  name: string; balance: number; connected: boolean; onSignOut: () => void; onDeposit?: () => void; onWithdraw?: () => void; discordTag?: string | null; onLinkDiscord?: () => void; onUnlinkDiscord?: () => void; onDeleteAccount?: () => void
}) {
  const [showProfile, setShowProfile] = useState(false)
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '16px 28px', marginBottom: 24,
      background: 'rgba(255,255,255,0.03)', borderRadius: 16,
      border: '1px solid rgba(255,255,255,0.06)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span style={{ fontSize: 22, fontWeight: 800, color: '#f1c40f', letterSpacing: -0.5 }}>♠ GCPoker</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: connected ? '#2ecc71' : '#e74c3c' }} />
        <div style={{ position: 'relative' }}>
          <button onClick={() => setShowProfile(!showProfile)} style={{
            padding: '8px 18px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.1)',
            background: 'rgba(255,255,255,0.05)', color: '#eee', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 10, fontSize: 14,
          }}>
            <span style={{ fontSize: 16 }}>👤</span>
            <span style={{ fontWeight: 600 }}>{name}</span>
            <span style={{ color: '#f1c40f', fontWeight: 700 }}>${balance.toLocaleString()}</span>
          </button>
          {showProfile && (
            <div style={{
              position: 'absolute', top: '100%', right: 0, marginTop: 8,
              background: '#1a1a2e', borderRadius: 12, padding: 16, minWidth: 200,
              border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
              zIndex: 50, display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <div style={{ fontSize: 13, color: '#888' }}>{name}</div>
              {discordTag && (
                <div style={{ fontSize: 13, color: '#5865F2' }}>@{discordTag}</div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                <span style={{ color: '#888' }}>Balance</span>
                <span style={{ color: '#f1c40f', fontWeight: 700 }}>${balance.toLocaleString()}</span>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={onDeposit} style={{
                  flex: 1, padding: '8px', borderRadius: 6, border: '1px solid rgba(46,204,113,0.3)',
                  background: 'transparent', color: '#2ecc71', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                }}>
                  Deposit
                </button>
                <button onClick={onWithdraw} style={{
                  flex: 1, padding: '8px', borderRadius: 6, border: '1px solid rgba(230,126,34,0.3)',
                  background: 'transparent', color: '#e67e22', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                }}>
                  Withdraw
                </button>
              </div>
              <hr style={{ border: 'none', borderTop: '1px solid rgba(255,255,255,0.06)', margin: 0 }} />
              {discordTag ? (
                <button onClick={onUnlinkDiscord} style={{
                  padding: '8px', borderRadius: 6, border: '1px solid rgba(88,101,242,0.3)',
                  background: 'transparent', color: '#5865F2', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                }}>
                  Unlink Discord
                </button>
              ) : (
                <button onClick={onLinkDiscord} style={{
                  padding: '8px', borderRadius: 6, border: '1px solid rgba(88,101,242,0.3)',
                  background: 'transparent', color: '#5865F2', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                }}>
                  Link Discord
                </button>
              )}
              <button onClick={onDeleteAccount} style={{
                padding: '8px', borderRadius: 6, border: '1px solid rgba(231,76,60,0.3)',
                background: 'transparent', color: '#e74c3c', cursor: 'pointer', fontSize: 13, fontWeight: 600,
              }}>
                Delete Account
              </button>
              <hr style={{ border: 'none', borderTop: '1px solid rgba(255,255,255,0.06)', margin: 0 }} />
              <button onClick={onSignOut} style={{
                padding: '8px', borderRadius: 6, border: '1px solid rgba(231,76,60,0.3)',
                background: 'transparent', color: '#e74c3c', cursor: 'pointer', fontSize: 13, fontWeight: 600,
              }}>
                Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Lobby View ──────────────────────────────────────────

function LobbyView({ tables, onJoin, onPractice, balance }: {
  tables: TableConfig[]; onJoin: (tableId: string) => void; onPractice: () => void; balance: number
}) {
  const hasBalance = balance > 0
  return (
    <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Section Header */}
      <div style={{ textAlign: 'center', marginBottom: 4 }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: '#eee', letterSpacing: -0.5 }}>Game Lobby</div>
        <div style={{ fontSize: 14, color: '#666', marginTop: 6 }}>Choose a table or practice against AI</div>
      </div>

      {/* Practice Mode */}
      <div style={{
        padding: '28px 32px', borderRadius: 16,
        background: 'linear-gradient(135deg, rgba(155,89,182,0.15), rgba(155,89,182,0.05))',
        border: '1px solid rgba(155,89,182,0.2)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        transition: 'all 0.2s',
        cursor: 'default',
      }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(155,89,182,0.4)'; e.currentTarget.style.background = 'linear-gradient(135deg, rgba(155,89,182,0.2), rgba(155,89,182,0.08))' }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(155,89,182,0.2)'; e.currentTarget.style.background = 'linear-gradient(135deg, rgba(155,89,182,0.15), rgba(155,89,182,0.05))' }}
      >
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#bb86fc', marginBottom: 4 }}>🎮 Practice Mode</div>
          <div style={{ fontSize: 14, color: '#888', lineHeight: 1.6 }}>
            Play against 3 AI opponents &middot; Completely free &middot; Blinds 5/10
          </div>
        </div>
        <button onClick={onPractice} style={{
          padding: '12px 28px', borderRadius: 10, border: 'none',
          background: '#9b59b6', color: '#fff', fontWeight: 700, fontSize: 15,
          cursor: 'pointer', boxShadow: '0 4px 16px rgba(155,89,182,0.35)',
          transition: 'all 0.15s',
        }}
          onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 6px 20px rgba(155,89,182,0.45)' }}
          onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 4px 16px rgba(155,89,182,0.35)' }}
        >
          Play vs AI
        </button>
      </div>

      {/* Cash Tables */}
      <div>
        <div style={{
          fontSize: 16, fontWeight: 700, color: '#ccc', marginBottom: 14,
          textAlign: 'center', letterSpacing: 1, textTransform: 'uppercase',
        }}>
          💰 Cash Games
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {tables.map(t => {
            const canJoin = hasBalance && t.playerCount < t.maxPlayers && t.status === TableStatus.Waiting
            return (
              <div key={t.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '18px 22px',
                background: 'rgba(255,255,255,0.03)', borderRadius: 12,
                border: '1px solid rgba(255,255,255,0.06)',
                transition: 'all 0.2s',
              }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)' }}
              >
                <div>
                  <div style={{ fontWeight: 700, fontSize: 16, color: '#eee' }}>{t.name}</div>
                  <div style={{ fontSize: 13, color: '#888', marginTop: 4, display: 'flex', gap: 16 }}>
                    <span>Blinds ${t.smallBlind}/${t.bigBlind}</span>
                    <span>{t.playerCount}/{t.maxPlayers} seats</span>
                    <span>Buy-in ${t.buyInMin}–${t.buyInMax}</span>
                  </div>
                </div>
                <button onClick={() => onJoin(t.id)} disabled={!canJoin} style={{
                  padding: '10px 22px', borderRadius: 8, border: 'none',
                  background: canJoin ? '#2ecc71' : '#2a2a3e',
                  color: canJoin ? '#fff' : '#666', fontWeight: 600, fontSize: 14,
                  cursor: canJoin ? 'pointer' : 'not-allowed',
                  boxShadow: canJoin ? '0 3px 10px rgba(46,204,113,0.3)' : 'none',
                  transition: 'all 0.15s',
                }}
                  onMouseEnter={e => { if (canJoin) { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 5px 14px rgba(46,204,113,0.4)' } }}
                  onMouseLeave={e => { if (canJoin) { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 3px 10px rgba(46,204,113,0.3)' } }}
                >
                  {t.status === TableStatus.Playing ? 'In Progress' : `Join $${t.buyInMin}`}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─── Payout Calculation (frontend) ──────────────────────

function computePayouts(playerCount: number, buyIn: number, rebuyCount: number = 0): { prizePool: number; positions: number; prizes: number[] } {
  const totalEntries = playerCount + rebuyCount
  const totalPool = totalEntries * buyIn
  const prizePool = Math.floor(totalPool * 0.9)
  let positions = 0
  if (totalEntries <= 1) positions = 0
  else if (totalEntries <= 4) positions = 1
  else if (totalEntries <= 7) positions = 2
  else if (totalEntries <= 10) positions = 3
  else if (totalEntries <= 15) positions = 4
  else if (totalEntries <= 20) positions = 5
  else if (totalEntries <= 30) positions = 6
  else if (totalEntries <= 50) positions = 7
  else positions = 9
  const weights = Array.from({ length: positions }, (_, i) => positions - i)
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  const prizes = []
  let remaining = prizePool
  for (let i = 0; i < positions; i++) {
    if (i === positions - 1) { prizes.push(remaining) }
    else { const s = Math.floor(prizePool * (weights[i] / totalWeight)); prizes.push(s); remaining -= s }
  }
  return { prizePool, positions, prizes }
}

const positionLabels = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th']

// ─── Game Info Modal ────────────────────────────────────

function GameInfoModal({ game, onClose }: { game: PlayerGameSummary; onClose: () => void }) {
  const [detail, setDetail] = useState<any>(null)
  useEffect(() => {
    fetch(`${WS_URL}/api/games/${game.id}`).then(r => r.json()).then(setDetail).catch(() => {})
  }, [game.id])
  const currentPlayers = detail?.players?.length ?? game.playerCount
  const payouts = computePayouts(currentPlayers, game.buyIn)
  const players = detail?.players
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 200, backdropFilter: 'blur(4px)',
    }}>
      <div style={{
        background: 'linear-gradient(135deg, #1a1a2e, #16213e)', borderRadius: 20, padding: '28px 32px',
        border: '1px solid rgba(255,255,255,0.12)', width: '90%', maxWidth: 480,
      }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: '#eee', marginBottom: 4 }}>{game.name}</div>
        <div style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>
          ${game.buyIn} buy-in &middot; ${game.startingChips} chips &middot; Blinds ${game.smallBlind}/${game.bigBlind}
        </div>

        <div style={{ fontSize: 14, fontWeight: 700, color: '#ccc', marginBottom: 8 }}>Players ({currentPlayers}/{game.maxPlayers})</div>
        <div style={{ maxHeight: 150, overflowY: 'auto', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {players ? (
            players.length > 0 ? players.map((p: any) => (
              <div key={p.userId} style={{ fontSize: 13, color: '#aaa', padding: '4px 8px', background: 'rgba(255,255,255,0.03)', borderRadius: 6 }}>
                {p.name} <span style={{ color: '#f1c40f', fontSize: 12 }}>${p.stack}</span>
              </div>
            )) : <div style={{ fontSize: 12, color: '#666' }}>No players yet</div>
          ) : game.playerCount > 0 ? (
            <div style={{ fontSize: 12, color: '#666' }}>Loading player details...</div>
          ) : (
            <div style={{ fontSize: 12, color: '#666' }}>No players yet</div>
          )}
        </div>

        <div style={{ fontSize: 14, fontWeight: 700, color: '#ccc', marginBottom: 8 }}>Payouts (Prize Pool: ${payouts.prizePool})</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16 }}>
          {payouts.prizes.map((p, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 8px', background: 'rgba(255,255,255,0.03)', borderRadius: 6 }}>
              <span style={{ color: '#eee', fontWeight: 600 }}>{positionLabels[i] || `#${i + 1}`}</span>
              <span style={{ color: '#2ecc71' }}>${p}</span>
            </div>
          ))}
        </div>

        <button onClick={onClose} style={{
          width: '100%', padding: '10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)',
          background: 'transparent', color: '#888', cursor: 'pointer', fontSize: 14,
        }}>Close</button>
      </div>
    </div>
  )
}

// ─── Tournament Info Modal ──────────────────────────────

function TournamentInfoModal({ tournament, onClose }: { tournament: TournamentSummary; onClose: () => void }) {
  const [detail, setDetail] = useState<any>(null)
  useEffect(() => {
    fetch(`${WS_URL}/api/tournaments/${tournament.id}`).then(r => r.json()).then(setDetail).catch(() => {})
  }, [tournament.id])
  const players = detail?.state?.players
  const currentPlayers = players?.length ?? tournament.registrations
  const payouts = computePayouts(currentPlayers || tournament.maxPlayers, tournament.buyIn)
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 200, backdropFilter: 'blur(4px)',
    }}>
      <div style={{
        background: 'linear-gradient(135deg, #1a1a2e, #16213e)', borderRadius: 20, padding: '28px 32px',
        border: '1px solid rgba(255,255,255,0.12)', width: '90%', maxWidth: 480,
      }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: '#eee', marginBottom: 4 }}>{tournament.name}</div>
        <div style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>
          ${tournament.buyIn} buy-in &middot; {tournament.maxPerTable}/table
          {tournament.creatorName && ` &middot; by ${tournament.creatorName}`}
        </div>

        <div style={{ fontSize: 14, fontWeight: 700, color: '#ccc', marginBottom: 8 }}>Players ({currentPlayers}/{tournament.maxPlayers})</div>
        <div style={{ maxHeight: 150, overflowY: 'auto', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {players ? (
            players.length > 0 ? players.map((p: any) => (
              <div key={p.userId} style={{ fontSize: 13, color: '#aaa', padding: '4px 8px', background: 'rgba(255,255,255,0.03)', borderRadius: 6 }}>
                {p.name} <span style={{ color: '#f1c40f', fontSize: 12 }}>${p.stack}</span>
              </div>
            )) : <div style={{ fontSize: 12, color: '#666' }}>No players yet</div>
          ) : tournament.registrations > 0 ? (
            <div style={{ fontSize: 12, color: '#666' }}>Loading player details...</div>
          ) : (
            <div style={{ fontSize: 12, color: '#666' }}>No players yet</div>
          )}
        </div>

        <div style={{ fontSize: 14, fontWeight: 700, color: '#ccc', marginBottom: 8 }}>Payouts (Prize Pool: ${payouts.prizePool})</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16 }}>
          {payouts.prizes.map((p, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 8px', background: 'rgba(255,255,255,0.03)', borderRadius: 6 }}>
              <span style={{ color: '#eee', fontWeight: 600 }}>{positionLabels[i] || `#${i + 1}`}</span>
              <span style={{ color: '#2ecc71' }}>${p}</span>
            </div>
          ))}
        </div>

        <button onClick={onClose} style={{
          width: '100%', padding: '10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)',
          background: 'transparent', color: '#888', cursor: 'pointer', fontSize: 14,
        }}>Close</button>
      </div>
    </div>
  )
}

// ─── Player-Created Games View ──────────────────────────

function PlayerGamesView({ games, onJoin, balance, onCreateGame, userId, onCancel }: {
  games: PlayerGameSummary[]; onJoin: (id: string) => void; balance: number; onCreateGame: () => void; userId: string; onCancel: (id: string) => void
}) {
  const [infoGame, setInfoGame] = useState<PlayerGameSummary | null>(null)
  const openGames = games.filter(g => g.status === 'waiting')
  const inProgressGames = games.filter(g => g.status === 'playing')
  return (
    <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16, marginTop: 24 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#ccc', letterSpacing: 1, textTransform: 'uppercase' }}>
          Sit & Go Games
        </div>
        <button onClick={onCreateGame} style={{
          padding: '10px 22px', borderRadius: 8, border: 'none',
          background: '#2ecc71', color: '#fff', fontWeight: 600, fontSize: 14,
          cursor: 'pointer', boxShadow: '0 3px 10px rgba(46,204,113,0.3)',
        }}>+ Create Game</button>
      </div>

      {/* Open Games */}
      {openGames.length > 0 && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#888', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
            Open Games
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {openGames.map(g => {
              const canJoin = balance >= g.buyIn && g.playerCount < g.maxPlayers
              const isCreator = g.creatorId === userId
              return (
                <div key={g.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '16px 20px',
                  background: 'rgba(255,255,255,0.03)', borderRadius: 12,
                  border: '1px solid rgba(255,255,255,0.06)',
                }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15, color: '#eee' }}>{g.name}</div>
                    <div style={{ fontSize: 13, color: '#888', marginTop: 3, display: 'flex', gap: 16 }}>
                      <span>{g.buyIn} GC buy-in</span>
                      <span>{g.startingChips} chips</span>
                      <span>Blinds {g.smallBlind}/{g.bigBlind}</span>
                      <span>{g.playerCount}/{g.maxPlayers} players</span>
                      <span>Prize: {g.prizePool} GC</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>by {g.creatorName}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => setInfoGame(g)} title="Details" style={{
                      padding: '8px 10px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)',
                      background: 'transparent', color: '#888', cursor: 'pointer', fontSize: 12, fontWeight: 700,
                    }}>i</button>
                    <button onClick={() => onJoin(g.id)} disabled={!canJoin} style={{
                      padding: '8px 18px', borderRadius: 8, border: 'none',
                      background: canJoin ? '#2ecc71' : '#2a2a3e',
                      color: canJoin ? '#fff' : '#666', fontWeight: 600, fontSize: 13,
                      cursor: canJoin ? 'pointer' : 'not-allowed',
                    }}>
                      Join
                    </button>
                    {isCreator && (
                      <button onClick={() => onCancel(g.id)} title="Cancel game" style={{
                        padding: '8px 14px', borderRadius: 6, border: '1px solid #e74c3c',
                        background: 'transparent', color: '#e74c3c', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                      }}>Cancel</button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* In-Progress Games */}
      {inProgressGames.length > 0 && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#f39c12', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
            In Progress
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {inProgressGames.map(g => (
              <div key={g.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '16px 20px',
                background: 'rgba(243,156,18,0.04)', borderRadius: 12,
                border: '1px solid rgba(243,156,18,0.12)',
              }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: '#eee' }}>{g.name}</div>
                  <div style={{ fontSize: 13, color: '#888', marginTop: 3, display: 'flex', gap: 16 }}>
                    <span>{g.buyIn} GC buy-in</span>
                    <span>{g.startingChips} chips</span>
                    <span>Blinds {g.smallBlind}/{g.bigBlind}</span>
                    <span>{g.playerCount}/{g.maxPlayers} players</span>
                    <span>Prize: {g.prizePool} GC</span>
                    <span style={{ color: '#f39c12', fontWeight: 600 }}>playing</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>by {g.creatorName}</div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => setInfoGame(g)} title="View progress" style={{
                    padding: '8px 18px', borderRadius: 8, border: '1px solid #f39c12',
                    background: 'transparent', color: '#f39c12', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                  }}>View</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {openGames.length === 0 && inProgressGames.length === 0 && (
        <div style={{
          padding: 24, textAlign: 'center', color: '#666', fontSize: 14,
          background: 'rgba(255,255,255,0.02)', borderRadius: 12,
          border: '1px solid rgba(255,255,255,0.06)',
        }}>
          No games yet. Create one to start playing!
        </div>
      )}

      {infoGame && <GameInfoModal game={infoGame} onClose={() => setInfoGame(null)} />}
    </div>
  )
}

// ─── Create Game Modal ───────────────────────────────────

function CreateGameModal({ onClose, onCreate, balance }: {
  onClose: () => void; onCreate: (name: string, maxPlayers: number, buyIn: number, startingChips: number) => void; balance: number
}) {
  const [name, setName] = useState('My Game')
  const [maxPlayers, setMaxPlayers] = useState(6)
  const [buyIn, setBuyIn] = useState(1)
  const [startingChips, setStartingChips] = useState(1000)

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 200, backdropFilter: 'blur(4px)',
    }}>
      <div style={{
        background: 'linear-gradient(135deg, #1a1a2e, #16213e)', borderRadius: 20, padding: '28px 32px',
        border: '1px solid rgba(255,255,255,0.12)', width: '90%', maxWidth: 440,
      }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: '#eee', marginBottom: 20 }}>Create Sit & Go Game</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Game Name" style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: '#16162a', color: '#eee', fontSize: 14, outline: 'none' }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Max Players</div>
              <select value={maxPlayers} onChange={e => setMaxPlayers(Number(e.target.value))} style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: '#16162a', color: '#eee', fontSize: 14, outline: 'none' }}>
                {[2,3,4,5,6,7,8].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Buy-In ($)</div>
              <input type="number" min={1} value={buyIn} onChange={e => setBuyIn(Math.max(1, Number(e.target.value)))} style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: '#16162a', color: '#eee', fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Starting Chips</div>
            <input type="number" min={100} step={100} value={startingChips} onChange={e => setStartingChips(Math.max(100, Number(e.target.value)))} style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: '#16162a', color: '#eee', fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
          </div>
          <div style={{ fontSize: 12, color: '#888' }}>Your balance: ${balance.toLocaleString()}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={onClose} style={{
              flex: 1, padding: '10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)',
              background: 'transparent', color: '#888', cursor: 'pointer', fontSize: 14,
            }}>Cancel</button>
            <button onClick={() => onCreate(name, maxPlayers, buyIn, startingChips)} disabled={balance < buyIn || !name.trim()} style={{
              flex: 1, padding: '10px', borderRadius: 8, border: 'none',
              background: balance >= buyIn && name.trim() ? '#2ecc71' : '#2a2a3e',
              color: balance >= buyIn && name.trim() ? '#fff' : '#666',
              fontWeight: 700, cursor: balance >= buyIn && name.trim() ? 'pointer' : 'not-allowed',
              fontSize: 14,
            }}>Create & Join</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Create Tournament Modal ─────────────────────────────

function CreateTournamentModal({ onClose, onCreate, balance }: {
  onClose: () => void; onCreate: (name: string, maxPlayers: number, buyIn: number, startingChips: number, rebuyDuration: number) => void; balance: number
}) {
  const [name, setName] = useState('My Tournament')
  const [maxPlayers, setMaxPlayers] = useState(18)
  const [buyIn, setBuyIn] = useState(1)
  const [startingChips, setStartingChips] = useState(1500)
  const [rebuyDuration, setRebuyDuration] = useState(60)
  const maxPerTable = Math.min(8, maxPlayers)
  const numTables = Math.ceil(maxPlayers / maxPerTable)

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 200, backdropFilter: 'blur(4px)',
    }}>
      <div style={{
        background: 'linear-gradient(135deg, #1a1a2e, #16213e)', borderRadius: 20, padding: '28px 32px',
        border: '1px solid rgba(255,255,255,0.12)', width: '90%', maxWidth: 440,
      }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: '#eee', marginBottom: 20 }}>Create Tournament</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Tournament Name" style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: '#16162a', color: '#eee', fontSize: 14, outline: 'none' }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Max Players</div>
              <input type="number" min={2} max={1000} value={maxPlayers} onChange={e => setMaxPlayers(Math.max(2, Math.min(1000, Number(e.target.value))))} style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: '#16162a', color: '#eee', fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Buy-In (GC)</div>
              <input type="number" min={1} value={buyIn} onChange={e => setBuyIn(Math.max(1, Number(e.target.value)))} style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: '#16162a', color: '#eee', fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Starting Chips</div>
              <input type="number" min={100} step={100} value={startingChips} onChange={e => setStartingChips(Math.max(100, Number(e.target.value)))} style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: '#16162a', color: '#eee', fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Rebuy Window (min)</div>
              <input type="number" min={0} value={rebuyDuration} onChange={e => setRebuyDuration(Math.max(0, Number(e.target.value)))} style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: '#16162a', color: '#eee', fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
            </div>
          </div>
          <div style={{ fontSize: 12, color: '#888' }}>
            {numTables > 1 ? `${numTables} tables of ${maxPerTable}` : '1 table'} &middot; Your balance: ${balance.toLocaleString()} &middot; {rebuyDuration > 0 ? `${rebuyDuration}min rebuy window` : 'No rebuys'}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={onClose} style={{
              flex: 1, padding: '10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)',
              background: 'transparent', color: '#888', cursor: 'pointer', fontSize: 14,
            }}>Cancel</button>
            <button onClick={() => onCreate(name, maxPlayers, buyIn, startingChips, rebuyDuration)} disabled={balance < buyIn || !name.trim()} style={{
              flex: 1, padding: '10px', borderRadius: 8, border: 'none',
              background: balance >= buyIn && name.trim() ? '#e67e22' : '#2a2a3e',
              color: balance >= buyIn && name.trim() ? '#fff' : '#666',
              fontWeight: 700, cursor: balance >= buyIn && name.trim() ? 'pointer' : 'not-allowed',
              fontSize: 14,
            }}>Create &amp; Join</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Tournament Lobby ────────────────────────────────────

function TournamentLobbyView({ tournaments, onRegister, onRebuy, balance, onCreateTournament, onCancel, userId }: {
  tournaments: TournamentSummary[]; onRegister: (id: string) => void; onRebuy?: (id: string) => void; balance: number; onCreateTournament?: () => void; onCancel?: (id: string) => void; userId?: string
}) {
  const statusLabel = ['Registering', 'Running', 'Completed']
  const userTourneys = tournaments.filter(t => t.creatorName)
  const systemTourneys = tournaments.filter(t => !t.creatorName)
  const [infoTourney, setInfoTourney] = useState<TournamentSummary | null>(null)
  return (
    <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 800, color: '#eee', letterSpacing: -0.5 }}>Tournaments</div>
          <div style={{ fontSize: 14, color: '#666', marginTop: 6 }}>Compete for prizes in scheduled events</div>
        </div>
        {onCreateTournament && (
          <button onClick={onCreateTournament} style={{
            padding: '10px 22px', borderRadius: 8, border: 'none',
            background: '#e67e22', color: '#fff', fontWeight: 600, fontSize: 14,
            cursor: 'pointer', boxShadow: '0 3px 10px rgba(230,126,34,0.3)',
          }}>+ Create Tournament</button>
        )}
      </div>

      {/* System/Default Tournaments */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#888', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>Scheduled</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {systemTourneys.map(t => {
            const canRegister = balance >= t.buyIn && t.status === 0 && t.registrations < t.maxPlayers
            return (
              <div key={t.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '18px 22px',
                background: 'rgba(255,255,255,0.03)', borderRadius: 12,
                border: '1px solid rgba(255,255,255,0.06)',
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 16, color: '#eee' }}>{t.name}</div>
                  <div style={{ fontSize: 13, color: '#888', marginTop: 4, display: 'flex', gap: 16 }}>
                    <span>{t.buyIn} GC buy-in</span>
                    <span>{t.registrations}/{t.maxPlayers} players</span>
                    <span style={{ color: t.status === 0 ? '#2ecc71' : t.status === 1 ? '#f39c12' : '#888' }}>{statusLabel[t.status]}</span>
                    <span>Prize: {t.prizePool.toLocaleString()} GC</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => setInfoTourney(t)} title="Details" style={{
                    padding: '8px 10px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)',
                    background: 'transparent', color: '#888', cursor: 'pointer', fontSize: 12, fontWeight: 700,
                  }}>i</button>
                  <button onClick={() => onRegister(t.id)} disabled={!canRegister} style={{
                      padding: '10px 22px', borderRadius: 8, border: 'none',
                      background: canRegister ? '#e67e22' : '#2a2a3e',
                      color: canRegister ? '#fff' : '#666', fontWeight: 600, fontSize: 14,
                      cursor: canRegister ? 'pointer' : 'not-allowed',
                      boxShadow: canRegister ? '0 3px 10px rgba(230,126,34,0.3)' : 'none',
                    }}>
                      {t.status === 0 ? 'Register' : t.status === 1 ? 'Running' : 'Completed'}
                    </button>
                    {t.status === 1 && onRebuy && (
                      <button onClick={() => onRebuy(t.id)} title="Rebuy for buy-in cost" style={{
                        padding: '10px 22px', borderRadius: 8, border: '1px solid #2ecc71',
                        background: 'transparent', color: '#2ecc71', fontWeight: 600, fontSize: 14,
                        cursor: 'pointer', boxShadow: '0 3px 10px rgba(46,204,113,0.2)',
                      }}>
                        Rebuy (${t.buyIn})
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Player-Created Tournaments */}
      {userTourneys.length > 0 && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#888', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>Player Tournaments</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {userTourneys.map(t => {
              const canRegister = balance >= t.buyIn && t.status === 0 && t.registrations < t.maxPlayers
              const isCreator = t.creatorId === userId
              return (
                <div key={t.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '16px 20px',
                  background: 'rgba(255,255,255,0.03)', borderRadius: 12,
                  border: '1px solid rgba(255,255,255,0.06)',
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: '#eee' }}>{t.name}</div>
                    <div style={{ fontSize: 12, color: '#888', marginTop: 3, display: 'flex', gap: 12 }}>
                      <span>{t.buyIn} GC buy-in</span>
                      <span>{t.registrations}/{t.maxPlayers} players</span>
                      <span>{t.maxPerTable}/table</span>
                      <span style={{ color: t.status === 0 ? '#2ecc71' : t.status === 1 ? '#f39c12' : '#888' }}>{statusLabel[t.status]}</span>
                      <span>Prize: {t.prizePool.toLocaleString()} GC</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>by {t.creatorName}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => setInfoTourney(t)} title="Details" style={{
                      padding: '8px 10px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)',
                      background: 'transparent', color: '#888', cursor: 'pointer', fontSize: 12, fontWeight: 700,
                    }}>i</button>
                    <button onClick={() => onRegister(t.id)} disabled={!canRegister} style={{
                      padding: '8px 18px', borderRadius: 8, border: 'none',
                      background: canRegister ? '#e67e22' : '#2a2a3e',
                      color: canRegister ? '#fff' : '#666', fontWeight: 600, fontSize: 13,
                      cursor: canRegister ? 'pointer' : 'not-allowed',
                    }}>
                      {t.status === 0 ? 'Register' : t.status === 1 ? 'Running' : 'Completed'}
                    </button>
                    {t.status === 1 && onRebuy && (
                      <button onClick={() => onRebuy(t.id)} title="Rebuy for buy-in cost" style={{
                        padding: '8px 18px', borderRadius: 8, border: '1px solid #2ecc71',
                        background: 'transparent', color: '#2ecc71', fontWeight: 600, fontSize: 13,
                        cursor: 'pointer',
                      }}>
                        Rebuy (${t.buyIn})
                      </button>
                    )}
                    {isCreator && t.status === 0 && onCancel && (
                      <button onClick={() => onCancel(t.id)} title="Cancel tournament" style={{
                        padding: '8px 14px', borderRadius: 6, border: '1px solid #e74c3c',
                        background: 'transparent', color: '#e74c3c', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                      }}>Cancel</button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {infoTourney && <TournamentInfoModal tournament={infoTourney} onClose={() => setInfoTourney(null)} />}
    </div>
  )
}

// ─── Pot Preset Buttons ───────────────────────────────────

function PotPresetBtn({ label, active, onClick }: {
  label: string; active?: boolean; onClick: () => void
}) {
  return (
    <button onClick={onClick} style={{
      padding: '6px 12px', borderRadius: 6, border: active ? '2px solid #e67e22' : '1px solid rgba(255,255,255,0.15)',
      background: active ? 'rgba(230,126,34,0.2)' : 'rgba(255,255,255,0.06)',
      color: active ? '#e67e22' : '#aaa', cursor: 'pointer', fontSize: 12, fontWeight: 600,
      transition: 'all 0.12s',
    }}>
      {label}
    </button>
  )
}

// ─── Chat Components ─────────────────────────────────────

function ChatMsg({ msg, isMe }: { msg: ChatMessage; isMe: boolean }) {
  return (
    <div style={{
      display: 'flex', gap: 6, alignItems: 'baseline',
      padding: '3px 8px', borderRadius: 6,
      background: isMe ? 'rgba(52,152,219,0.1)' : 'transparent',
    }}>
      <span style={{ fontWeight: 700, fontSize: 12, color: isMe ? '#3498db' : '#bb86fc' }}>{msg.playerName}:</span>
      <span style={{ fontSize: 12, color: '#ccc', wordBreak: 'break-word' }}>{msg.text}</span>
    </div>
  )
}

function ChatOverlay({ messages, myId }: { messages: ChatMessage[]; myId: string }) {
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])
  return (
    <div style={{
      position: 'absolute', top: '2%', right: '1%', width: 220,
      maxHeight: '30%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2,
      background: 'rgba(0,0,0,0.55)', borderRadius: 8, padding: 6,
      border: '1px solid rgba(255,255,255,0.06)',
    }}>
      {messages.map(m => <ChatMsg key={m.id} msg={m} isMe={m.playerId === myId} />)}
      <div ref={bottomRef} />
    </div>
  )
}

// ─── Stats HUD (at table) ────────────────────────────────

function StatsHUD({ stats, compact }: { stats: PlayerStatsInfo | null; compact?: boolean }) {
  if (!stats || stats.totalHands === 0) return null
  if (compact) {
    return (
      <div style={{ display: 'flex', gap: 4, fontSize: 9, color: '#888', marginTop: 1 }}>
        <span title="Hands">{stats.totalHands}h</span>
        <span title="VPIP">V:{stats.vpip}%</span>
        <span title="PFR">P:{stats.pfr}%</span>
        <span title="Aggression Factor">AF:{stats.af.toFixed(1)}</span>
      </div>
    )
  }
  return (
    <div style={{
      background: 'rgba(0,0,0,0.6)', borderRadius: 10, padding: '10px 14px',
      border: '1px solid rgba(255,255,255,0.08)', minWidth: 180,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#eee', marginBottom: 8 }}>My Stats</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', fontSize: 12 }}>
        <span style={{ color: '#888' }}>Hands</span><span style={{ color: '#eee' }}>{stats.totalHands}</span>
        <span style={{ color: '#888' }}>VPIP</span><span style={{ color: stats.vpip > 30 ? '#e74c3c' : '#2ecc71' }}>{stats.vpip}%</span>
        <span style={{ color: '#888' }}>PFR</span><span style={{ color: stats.pfr > 25 ? '#e74c3c' : '#2ecc71' }}>{stats.pfr}%</span>
        <span style={{ color: '#888' }}>AF</span><span style={{ color: stats.af > 3 ? '#e74c3c' : '#2ecc71' }}>{stats.af.toFixed(1)}</span>
        <span style={{ color: '#888' }}>3-Bet</span><span style={{ color: '#eee' }}>{stats.threeBetPct}%</span>
        <span style={{ color: '#888' }}>Won</span><span style={{ color: stats.totalWon >= 0 ? '#2ecc71' : '#e74c3c' }}>${stats.totalWon}</span>
        <span style={{ color: '#888' }}>Won/Hand</span><span style={{ color: '#eee' }}>${stats.totalHands > 0 ? Math.round(stats.totalWon / stats.totalHands) : 0}</span>
        <span style={{ color: '#888' }}>WSD%</span><span style={{ color: '#eee' }}>{stats.totalHands > 0 ? Math.round(stats.handsWon / stats.totalHands * 100) : 0}%</span>
      </div>
    </div>
  )
}

// ─── Cashier Modal (Deposit / Withdraw) ─────────────────

const STATUS_COLORS: Record<string, string> = {
  pending: '#f39c12',
  processing: '#3498db',
  completed: '#2ecc71',
  failed: '#e74c3c',
}

function CashierModal({ mode, userId, token, balance, onDone }: {
  mode: 'deposit' | 'withdraw'; userId: string; token: string; balance: number; onDone: () => void
}) {
  const [amount, setAmount] = useState(0)
  const [gcCode, setGcCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string; gcCode?: string; amount?: number } | null>(null)
  const [txList, setTxList] = useState<any[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [clearing, setClearing] = useState(false)

  const loadTransactions = useCallback(async () => {
    try {
      const r = await fetch(`${WS_URL}/api/cashier/transactions/${userId}`)
      const txs = await r.json()
      setTxList(txs ?? [])
    } catch {}
  }, [userId])

  // Load transactions on mount and poll while modal is open
  useEffect(() => {
    loadTransactions()
    const interval = setInterval(loadTransactions, 3000)
    return () => clearInterval(interval)
  }, [userId, loadTransactions])

  const submit = async () => {
    setLoading(true)
    setResult(null)
    try {
      const body = mode === 'deposit'
        ? { userId, gcCode }
        : { userId, amount }
      const res = await fetch(`${WS_URL}/api/cashier/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Request failed')

      // Poll for this transaction to complete
      const txId = data.transactionId
      const pollStart = Date.now()
      let finalTx: any = null
      while (Date.now() - pollStart < 30000) {
        await new Promise(r => setTimeout(r, 1500))
        try {
          const txRes = await fetch(`${WS_URL}/api/cashier/transaction/${txId}`)
          const txData = await txRes.json()
          if (txData.status === 'completed' || txData.status === 'failed') {
            finalTx = txData
            break
          }
        } catch {}
      }

      setAmount(0)
      setGcCode('')
      await loadTransactions()

      if (finalTx) {
        if (finalTx.status === 'completed') {
          setResult({ ok: true, message: '', gcCode: finalTx.gcCode, amount: finalTx.amount })
        } else {
          setResult({ ok: false, message: finalTx.botMessage || 'Transaction failed' })
        }
      } else {
        setResult({ ok: false, message: 'Transaction timed out. Check history for status.' })
      }
    } catch (err: any) {
      setResult({ ok: false, message: err.message })
    } finally {
      setLoading(false)
    }
  }

  const clearHistory = async () => {
    if (!confirm('Clear all transaction history?')) return
    setClearing(true)
    try {
      await fetch(`${WS_URL}/api/cashier/transactions/${userId}`, { method: 'DELETE' })
      setTxList([])
      await loadTransactions()
    } catch {}
    setClearing(false)
  }

  const recentTxs = txList.slice(0, 50)

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 200, backdropFilter: 'blur(4px)',
    }}>
      <div style={{
        background: 'linear-gradient(135deg, #1a1a2e, #16213e)', borderRadius: 20, padding: '28px 32px',
        border: '1px solid rgba(255,255,255,0.12)', boxShadow: '0 24px 64px rgba(0,0,0,0.7)',
        width: '90%', maxWidth: showHistory ? 560 : 440, transition: 'max-width 0.2s',
      }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: '#eee', marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{mode === 'deposit' ? 'Deposit GC' : 'Withdraw GC'}</span>
          <span style={{ fontSize: 14, color: '#f1c40f' }}>Balance: ${balance.toLocaleString()}</span>
        </div>

        {/* Result display — replaces inputs on success/error */}
        {result && result.ok && mode === 'withdraw' && result.gcCode ? (
          /* ── Withdrawal success ── */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
            <div style={{
              padding: '20px', borderRadius: 12,
              background: 'rgba(46,204,113,0.08)', border: '1px solid rgba(46,204,113,0.25)',
              textAlign: 'center', width: '100%',
            }}>
              <div style={{ fontSize: 13, color: '#2ecc71', fontWeight: 700, marginBottom: 12 }}>✔ Withdrawal Successful</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#fff', letterSpacing: 3, fontFamily: 'monospace', userSelect: 'all', padding: '10px 0', wordBreak: 'break-all' }}>{result.gcCode}</div>
              <div style={{ fontSize: 11, color: '#888', marginTop: 8 }}>Click the code above to select, then copy</div>
            </div>
            <button onClick={onDone} style={{
              width: '100%', padding: '12px', borderRadius: 8, border: 'none',
              background: '#2ecc71', color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer',
            }}>Close</button>
          </div>
        ) : result && result.ok && mode === 'deposit' ? (
          /* ── Deposit success ── */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
            <div style={{
              padding: '20px', borderRadius: 12,
              background: 'rgba(46,204,113,0.08)', border: '1px solid rgba(46,204,113,0.25)',
              textAlign: 'center', width: '100%',
            }}>
              <div style={{ fontSize: 13, color: '#2ecc71', fontWeight: 700, marginBottom: 12 }}>✔ Deposit Successful</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: '#f1c40f', padding: '10px 0' }}>
                ${(result.amount ?? 0).toLocaleString()}
              </div>
              <div style={{ fontSize: 12, color: '#2ecc71' }}>credited to your balance</div>
            </div>
            <button onClick={onDone} style={{
              width: '100%', padding: '12px', borderRadius: 8, border: 'none',
              background: '#2ecc71', color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer',
            }}>Close</button>
          </div>
        ) : result && !result.ok ? (
          /* ── Error ── */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{
              padding: '14px', borderRadius: 12, fontSize: 13,
              background: 'rgba(231,76,60,0.1)', border: '1px solid rgba(231,76,60,0.3)',
              color: '#e74c3c', textAlign: 'center',
            }}>
              {result.message}
            </div>
            <button onClick={onDone} style={{
              width: '100%', padding: '12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)',
              background: 'transparent', color: '#ccc', fontWeight: 600, fontSize: 14, cursor: 'pointer',
            }}>Close</button>
          </div>
        ) : null}

        {/* Input area — hidden when any result is showing */}
        {!result && (
          mode === 'deposit' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <input
                value={gcCode} onChange={e => setGcCode(e.target.value)}
                placeholder="Enter GC code"
                style={{ padding: '12px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: '#16162a', color: '#eee', fontSize: 15, outline: 'none' }}
              />
              <button onClick={submit} disabled={loading || !gcCode.trim()} style={{
                padding: '12px', borderRadius: 8, border: 'none',
                background: loading || !gcCode.trim() ? '#2a2a3e' : '#2ecc71', color: '#fff',
                fontWeight: 700, fontSize: 15, cursor: loading || !gcCode.trim() ? 'not-allowed' : 'pointer',
              }}>
                {loading ? 'Submitting...' : 'Redeem Code'}
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <input
                type="number" min={1} value={amount || ''}
                onChange={e => setAmount(Math.max(1, Math.min(Number(e.target.value), balance)))}
                placeholder="Amount"
                style={{ padding: '12px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: '#16162a', color: '#eee', fontSize: 15, outline: 'none' }}
              />
              <button onClick={submit} disabled={loading || amount <= 0 || amount > balance} style={{
                padding: '12px', borderRadius: 8, border: 'none',
                background: loading || amount <= 0 || amount > balance ? '#2a2a3e' : '#e67e22', color: '#fff',
                fontWeight: 700, fontSize: 15, cursor: loading || amount <= 0 || amount > balance ? 'not-allowed' : 'pointer',
              }}>
                {loading ? 'Processing...' : `Withdraw $${amount}`}
              </button>
            </div>
          )
        )}

        {/* Transaction History */}
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <button onClick={() => setShowHistory(!showHistory)} style={{
              background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 12, fontWeight: 700, padding: 0,
            }}>
              {showHistory ? '\u25bc Hide History' : '\u25b6 Show History'} ({txList.length})
            </button>
            {txList.length > 0 && (
              <button onClick={clearHistory} disabled={clearing} style={{
                background: 'none', border: 'none', color: clearing ? '#555' : '#e74c3c', cursor: clearing ? 'not-allowed' : 'pointer',
                fontSize: 11, padding: 0, fontWeight: 600,
              }}>
                {clearing ? 'Clearing...' : 'Clear All'}
              </button>
            )}
          </div>
          {showHistory && txList.length > 0 && (
            <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, padding: 4 }}>
              {recentTxs.map(tx => (
                <div key={tx.id} style={{
                  display: 'flex', flexDirection: 'column', padding: '8px 10px',
                  borderRadius: 6, background: 'rgba(255,255,255,0.03)', fontSize: 12, gap: 2,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600, color: '#ccc' }}>
                      {tx.type === 'deposit' ? 'Deposit' : 'Withdraw'}
                      {tx.amount > 0 ? ` $${tx.amount}` : ''}
                    </span>
                    <span style={{
                      color: STATUS_COLORS[tx.status] ?? '#888',
                      fontWeight: 600, fontSize: 11,
                    }}>{tx.status}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#666' }}>
                    <span>{new Date(tx.createdAt).toLocaleString()}</span>
                    <span style={{ fontSize: 10 }}>{tx.id.slice(0, 8)}</span>
                  </div>
                  {(tx.gcCode) && (
                    <div style={{ fontSize: 11, color: tx.status === 'completed' ? '#2ecc71' : '#888' }}>
                      {tx.type === 'deposit' ? 'Code: ' : 'GC: '}
                      <span style={{ fontFamily: 'monospace', fontWeight: 600, userSelect: 'all' }}>{tx.gcCode}</span>
                    </div>
                  )}
                  {tx.botMessage && tx.status !== 'completed' && (
                    <div style={{ fontSize: 10, color: '#e74c3c' }}>{tx.botMessage}</div>
                  )}
                </div>
              ))}
            </div>
          )}
          {showHistory && txList.length === 0 && (
            <div style={{ fontSize: 12, color: '#666', textAlign: 'center', padding: 12 }}>
              No transactions yet.
            </div>
          )}
        </div>

        {!result && (
          <button onClick={onDone} style={{
            width: '100%', padding: '10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.1)',
            background: 'transparent', color: '#888', cursor: 'pointer', fontSize: 14, marginTop: 16,
          }}>Close</button>
        )}
      </div>
    </div>
  )
}

// ─── Compute Player Stats from Hand History ──────────────

function computeStats(hands: HandSummary[], playerName: string): PlayerStatsInfo {
  let totalHands = 0
  let vpipCount = 0
  let pfrCount = 0
  let afCalls = 0
  let afAggro = 0
  let threeBets = 0
  let totalWon = 0
  let biggestPot = 0
  let handsWon = 0

  for (const h of hands) {
    if (!h.playerNames.includes(playerName)) continue
    totalHands++
    if (h.winnerName === playerName) {
      handsWon++
      totalWon += h.winAmount
    }
    if (h.potSize > biggestPot) biggestPot = h.potSize
  }

  // Approximate stats from available hand summary data
  // For real stats we need detailed per-action data from HandRecord
  const vpip = totalHands > 0 ? Math.round(vpipCount / totalHands * 100) : 0
  const pfr = totalHands > 0 ? Math.round(pfrCount / totalHands * 100) : 0
  const af = afCalls > 0 ? Math.round(afAggro / afCalls * 10) / 10 : 0
  const threeBetPct = totalHands > 0 ? Math.round(threeBets / totalHands * 100) : 0

  return {
    totalHands,
    vpip,
    pfr,
    af: Math.max(af, 0.5),
    threeBetPct,
    totalWon,
    biggestPot,
    handsWon,
  }
}

// ─── Hand History Panel ───────────────────────────────────

function HandHistoryPanel({ hands, onSelectHand, playerName, loading }: {
  hands: HandSummary[]; onSelectHand: (hand: HandSummary) => void; playerName: string; loading: boolean
}) {
  const filtered = hands.filter(h => h.playerNames.includes(playerName))

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: '#eee', letterSpacing: -0.5 }}>My Hands</div>
        <div style={{ fontSize: 14, color: '#666', marginTop: 6 }}>Review your recent hand history</div>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', color: '#888', padding: 40 }}>Loading hands...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#888', padding: 40, background: 'rgba(255,255,255,0.03)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.06)' }}>
          No hands played yet. Join a table to start!
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {filtered.slice(0, 50).map(h => {
            const won = h.winnerName === playerName
            return (
              <div key={h.handId} onClick={() => onSelectHand(h)} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '14px 18px', background: 'rgba(255,255,255,0.03)', borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.06)', cursor: 'pointer',
                transition: 'all 0.15s',
              }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)' }}>
                <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: '#666', minWidth: 50 }}>#{h.handId}</span>
                  <div>
                    <div style={{ fontSize: 13, color: '#999' }}>
                      {h.playerNames.join(', ')}
                    </div>
                    <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>
                      {new Date(h.timestamp).toLocaleString()} &middot; {h.actionCount} actions
                    </div>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: won ? '#2ecc71' : '#e74c3c' }}>
                    {won ? `+$${h.winAmount}` : `-$${h.potSize > 0 ? Math.abs(h.winAmount - h.potSize) : 0}`}
                  </div>
                  <div style={{ fontSize: 12, color: '#888' }}>Pot: ${h.potSize}</div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div style={{ fontSize: 12, color: '#555', textAlign: 'center' }}>
        Showing last {Math.min(filtered.length, 50)} hands
      </div>
    </div>
  )
}

// ─── Hand Replayer ────────────────────────────────────────

function HandReplayer({ hand, onBack }: {
  hand: HandSummary | null; onBack: () => void
}) {
  const [handDetail, setHandDetail] = useState<any>(null)
  const [step, setStep] = useState(0)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!hand) return
    setLoading(true)
    fetch(`${WS_URL}/api/hands/${hand.handId}`)
      .then(r => r.json())
      .then(data => {
        setHandDetail(data)
        setStep(0)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [hand?.handId])

  if (!hand) return null

  if (loading) {
    return (
      <div style={{ textAlign: 'center', color: '#888', padding: 60 }}>Loading hand details...</div>
    )
  }

  if (!handDetail) {
    return (
      <div style={{ textAlign: 'center', color: '#e74c3c', padding: 60 }}>
        Could not load hand details
        <button onClick={onBack} style={{ display: 'block', margin: '20px auto', padding: '8px 20px', borderRadius: 6, border: '1px solid #3498db', background: 'transparent', color: '#3498db', cursor: 'pointer', fontSize: 14 }}>Back</button>
      </div>
    )
  }

  const totalSteps = handDetail.actions.length + 1
  const currentStep = Math.min(step, totalSteps - 1)

  // Determine which street we're on based on actions up to current step
  const actionsUpToStep = handDetail.actions.slice(0, Math.max(0, currentStep))
  let street = 'Pre-Flop'
  let communityCards: any[] = []
  if (currentStep >= totalSteps - 1) {
    // At the end — show complete state
    communityCards = handDetail.communityCards || []
    if (communityCards.length >= 5) street = 'Showdown'
    else if (communityCards.length >= 4) street = 'River'
    else if (communityCards.length >= 3) street = 'Turn'
    else if (communityCards.length >= 1) street = 'Flop'
  } else {
    // Simulate action processing to determine street
    let actionIdx = 0
    let flopDealt = false, turnDealt = false, riverDealt = false
    let lastAggressorIdx = -1
    for (const a of handDetail.actions) {
      if (actionIdx >= currentStep) break
      if (a.type === ActionType.Bet || a.type === ActionType.Raise || a.type === ActionType.AllIn) {
        lastAggressorIdx = handDetail.actions.indexOf(a)
      }
      actionIdx++
    }
    // Estimate betting rounds (simplified)
    const actionsPerStreet = handDetail.actions.length / (handDetail.communityCards?.length >= 5 ? 4 : handDetail.communityCards?.length >= 3 ? 3 : 2)
    const streetIdx = Math.min(Math.floor(currentStep / Math.max(1, actionsPerStreet)), handDetail.communityCards?.length >= 5 ? 3 : handDetail.communityCards?.length >= 3 ? 2 : 1)
    const streets = ['Pre-Flop', 'Flop', 'Turn', 'River']
    street = streets[streetIdx] || 'Pre-Flop'
    const cardsToShow = handDetail.communityCards || []
    if (streetIdx >= 1) communityCards = cardsToShow.slice(0, 3)
    if (streetIdx >= 2) communityCards = cardsToShow.slice(0, 4)
    if (streetIdx >= 3) communityCards = cardsToShow
  }

  const currentAction = handDetail.actions[currentStep > 0 ? currentStep - 1 : 0]

  return (
    <div style={{ maxWidth: 700, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button onClick={onBack} style={{
          padding: '8px 16px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)',
          background: 'transparent', color: '#888', cursor: 'pointer', fontSize: 13,
        }}>&larr; Back</button>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#eee' }}>Hand #{hand.handId}</div>
          <div style={{ fontSize: 12, color: '#888' }}>Pot: ${hand.potSize} &middot; {street}</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setStep(Math.max(0, step - 1))} disabled={step <= 0} style={{
            padding: '8px 14px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)',
            background: step <= 0 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.08)',
            color: step <= 0 ? '#555' : '#ccc', cursor: step <= 0 ? 'not-allowed' : 'pointer', fontSize: 13,
          }}>&larr; Prev</button>
          <button onClick={() => setStep(Math.min(totalSteps - 1, step + 1))} disabled={step >= totalSteps - 1} style={{
            padding: '8px 14px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)',
            background: step >= totalSteps - 1 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.08)',
            color: step >= totalSteps - 1 ? '#555' : '#ccc', cursor: step >= totalSteps - 1 ? 'not-allowed' : 'pointer', fontSize: 13,
          }}>Next &rarr;</button>
        </div>
      </div>

      {/* Players */}
      <div style={{
        background: 'rgba(255,255,255,0.03)', borderRadius: 12,
        border: '1px solid rgba(255,255,255,0.06)', padding: 16,
      }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
          {handDetail.players.map((p: any, i: number) => {
            const isActive = currentAction && currentAction.playerId === p.id
            return (
              <div key={p.id} style={{
                padding: '10px 14px', borderRadius: 10,
                background: isActive ? 'rgba(46,204,113,0.2)' : 'rgba(255,255,255,0.04)',
                border: isActive ? '2px solid #2ecc71' : '1px solid rgba(255,255,255,0.08)',
                textAlign: 'center', minWidth: 110,
              }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: isActive ? '#2ecc71' : '#eee' }}>{p.name}</div>
                <div style={{ fontSize: 12, color: '#f1c40f' }}>${p.stackAtEnd}</div>
                {p.holeCards && currentStep >= totalSteps - 1 && (
                  <div style={{ display: 'flex', gap: 2, justifyContent: 'center', marginTop: 4 }}>
                    {p.holeCards.map((c: any, ci: number) => (
                      <div key={ci} style={{
                        width: 28, height: 40, borderRadius: 4, background: '#fff',
                        border: '1px solid #ccc', display: 'flex', alignItems: 'center',
                        justifyContent: 'center', fontSize: 10, fontWeight: 700,
                        color: c.suit === 'h' || c.suit === 'd' ? '#e74c3c' : '#2c3e50',
                      }}>
                        {RANK_LABELS[c.rank]}{SUIT_SYMBOLS[c.suit]}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Community Cards */}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'center', padding: 8 }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <CardView key={i} card={communityCards[i]} />
        ))}
      </div>

      {/* Action Log */}
      <div style={{
        background: 'rgba(0,0,0,0.3)', borderRadius: 10, padding: 12,
        maxHeight: 200, overflowY: 'auto', border: '1px solid rgba(255,255,255,0.06)',
      }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#888', marginBottom: 8 }}>Action Log</div>
        {handDetail.actions.map((a: any, i: number) => {
          const player = handDetail.players.find((p: any) => p.id === a.playerId)
          const isCurrentAction = i === currentStep - 1
          const label = a.type === 'bet' ? `Bets $${a.amount}`
            : a.type === 'raise' ? `Raises to $${a.amount}`
            : a.type === 'call' ? `Calls $${a.amount}`
            : a.type === 'fold' ? 'Folds'
            : a.type === 'check' ? 'Checks'
            : a.type === 'allIn' ? `All-In $${a.amount}`
            : a.type
          return (
            <div key={i} style={{
              padding: '4px 10px', borderRadius: 4,
              background: isCurrentAction ? 'rgba(46,204,113,0.15)' : 'transparent',
              borderLeft: isCurrentAction ? '3px solid #2ecc71' : '3px solid transparent',
              fontSize: 13, color: isCurrentAction ? '#2ecc71' : '#bbb', marginBottom: 2,
            }}>
              <span style={{ fontWeight: 600 }}>{player?.name ?? 'Unknown'}:</span> {label}
            </div>
          )
        })}
        {currentStep >= totalSteps - 1 && (
          <div style={{
            padding: '6px 10px', borderRadius: 4,
            background: 'rgba(241,196,15,0.1)', borderLeft: '3px solid #f1c40f',
            fontSize: 13, color: '#f1c40f', fontWeight: 700, marginTop: 4,
          }}>
            Result: {hand.winnerName} wins ${hand.winAmount}
          </div>
        )}
      </div>

      {/* Progress bar */}
      <div style={{ width: '100%', height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{
          width: `${(currentStep / (totalSteps - 1)) * 100}%`, height: '100%',
          background: 'linear-gradient(90deg, #2ecc71, #27ae60)', borderRadius: 2,
          transition: 'width 0.2s',
        }} />
      </div>
    </div>
  )
}

// ─── Stats Panel (full lobby view) ────────────────────────

function StatsPanel({ stats, hands, playerName }: { stats: PlayerStatsInfo | null; hands: HandSummary[]; playerName: string }) {
  if (!stats || stats.totalHands === 0) {
    return (
      <div style={{ maxWidth: 500, margin: '0 auto', textAlign: 'center', padding: 60, color: '#888' }}>
        No stats yet. Play some hands first!
      </div>
    )
  }
  return (
    <div style={{ maxWidth: 700, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: '#eee', letterSpacing: -0.5 }}>Player Stats</div>
        <div style={{ fontSize: 14, color: '#666', marginTop: 6 }}>Your performance summary</div>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12,
        background: 'rgba(255,255,255,0.03)', borderRadius: 16,
        border: '1px solid rgba(255,255,255,0.06)', padding: 24,
      }}>
        <div style={{ textAlign: 'center', padding: 12 }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#f1c40f' }}>{stats.totalHands}</div>
          <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>Hands Played</div>
        </div>
        <div style={{ textAlign: 'center', padding: 12 }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: stats.totalWon >= 0 ? '#2ecc71' : '#e74c3c' }}>${stats.totalWon}</div>
          <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>Total Won</div>
        </div>
        <div style={{ textAlign: 'center', padding: 12 }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#3498db' }}>{Math.round(stats.totalHands > 0 ? stats.handsWon / stats.totalHands * 100 : 0)}%</div>
          <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>Win Rate</div>
        </div>
      </div>

      <div style={{
        background: 'rgba(255,255,255,0.03)', borderRadius: 16,
        border: '1px solid rgba(255,255,255,0.06)', padding: 20,
      }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 24px', fontSize: 14 }}>
          {[
            ['VPIP', `${stats.vpip}%`, stats.vpip > 30 ? '#e74c3c' : '#2ecc71', 'Voluntarily Put $ In Pot'],
            ['PFR', `${stats.pfr}%`, stats.pfr > 25 ? '#e74c3c' : '#2ecc71', 'Pre-Flop Raise %'],
            ['AF', stats.af.toFixed(1), stats.af > 3 ? '#e74c3c' : '#2ecc71', 'Aggression Factor'],
            ['3-Bet', `${stats.threeBetPct}%`, '#eee', 'Three-Bet Pre-Flop'],
            ['Biggest Pot', `$${stats.biggestPot}`, '#f1c40f', 'Largest pot you were in'],
            ['Hands Won', `${stats.handsWon}`, '#2ecc71', 'Total hands won'],
          ].map(([label, value, color, title]) => (
            <div key={label} title={title} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <span style={{ color: '#888' }}>{label}</span>
              <span style={{ color, fontWeight: 700 }}>{value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Recent results */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#888', marginBottom: 8 }}>Recent Results</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {hands.filter(h => h.playerNames.includes(playerName)).slice(0, 20).map(h => {
            const won = h.winnerName === playerName
            return (
              <div key={h.handId} style={{
                display: 'flex', justifyContent: 'space-between', padding: '6px 12px',
                borderRadius: 6, background: 'rgba(255,255,255,0.02)', fontSize: 12,
              }}>
                <span style={{ color: '#666' }}>#{h.handId}</span>
                <span style={{ color: won ? '#2ecc71' : '#e74c3c' }}>
                  {won ? `+$${h.winAmount}` : `-$${h.potSize > h.winAmount ? h.potSize - h.winAmount : h.potSize}`}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─── Main App ────────────────────────────────────────────

export default function Home() {
  const [socket, setSocket] = useState<Socket | null>(null)
  const [connected, setConnected] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [sessionLoaded, setSessionLoaded] = useState(false)
  const [userId, setUserId] = useState('')
  const [userName, setUserName] = useState('')
  const [discordTag, setDiscordTag] = useState<string | null>(null)
  const [tables, setTables] = useState<TableConfig[]>([])
  const [tournaments, setTournaments] = useState<TournamentSummary[]>([])
  const [playerGames, setPlayerGames] = useState<PlayerGameSummary[]>([])
  const [gameState, setGameState] = useState<GameState | null>(null)
  const [pendingGameId, setPendingGameId] = useState<string | null>(null)
  const [tab, setTab] = useState<'cash' | 'tournaments' | 'hands' | 'stats'>('cash')
  const [error, setError] = useState('')
  const [balance, setBalance] = useState(0)
  const [hands, setHands] = useState<HandSummary[]>([])
  const [selectedHand, setSelectedHand] = useState<HandSummary | null>(null)
  const [handsLoading, setHandsLoading] = useState(false)
  const [cashierMode, setCashierMode] = useState<'deposit' | 'withdraw' | null>(null)
  const [showCreateGame, setShowCreateGame] = useState(false)
  const [showCreateTournament, setShowCreateTournament] = useState(false)
  const [showDiscordLink, setShowDiscordLink] = useState(false)
  const [showDeleteAccount, setShowDeleteAccount] = useState(false)
  const [pendingToken, setPendingToken] = useState<string | null>(null)
  const [showCalibration, setShowCalibration] = useState(false)

  // Restore session on mount
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      fetch(`${WS_URL}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: saved }),
      }).then(r => r.json()).then(data => {
        if (data.user) {
          setToken(saved)
          setUserId(data.user.id)
          setUserName(data.user.name)
          setBalance(data.user.balance)
          setDiscordTag(data.user.discordTag ?? null)
        } else {
          localStorage.removeItem(STORAGE_KEY)
        }
      }).catch(() => {
        localStorage.removeItem(STORAGE_KEY)
      }).finally(() => setSessionLoaded(true))
    } else {
      setSessionLoaded(true)
    }
  }, [])

  // Socket connection
  useEffect(() => {
    const s = io(WS_URL, { reconnectionDelay: 1000, reconnectionDelayMax: 5000 })

    s.on('connect', async () => {
      setConnected(true)
      if (token) {
        setHandsLoading(true)
        try {
          const [lobby, tourneys, session, handsData, pGames] = await Promise.all([
            fetch(`${WS_URL}/api/lobby`).then(r => r.json()),
            fetch(`${WS_URL}/api/tournaments`).then(r => r.json()),
            fetch(`${WS_URL}/api/auth/session`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token }),
            }).then(r => r.json()),
            fetch(`${WS_URL}/api/hands`).then(r => r.json()),
            fetch(`${WS_URL}/api/games`).then(r => r.json()),
          ])
          setTables(lobby.cashTables || lobby)
          setPlayerGames(pGames)
          setTournaments(tourneys)
          if (session.user) {
            setUserId(session.user.id)
            setBalance(session.user.balance)
            setUserName(session.user.name)
            setDiscordTag(session.user.discordTag ?? null)
          }
          setHands(handsData)
        } catch { /* silent */ }
        setHandsLoading(false)
      } else {
        try {
          const [lobby, tourneys] = await Promise.all([
            fetch(`${WS_URL}/api/lobby`).then(r => r.json()),
            fetch(`${WS_URL}/api/tournaments`).then(r => r.json()),
          ])
          setTables(lobby.cashTables || lobby)
          setTournaments(tourneys)
        } catch { /* silent */ }
      }
    })

    s.on('disconnect', () => setConnected(false))
    s.on(ServerEvent.Error, (e: { message: string }) => setError(e.message))
    s.on(ServerEvent.GameState, (state: GameState) => {
      setGameState(state)
      setPendingGameId(null)
    })
    s.on('lobby:update', (data: any) => {
      if (Array.isArray(data)) {
        setTables(data)
      } else {
        setTables(data.cashTables || [])
        setPlayerGames(data.playerGames || [])
      }
    })
    s.on('game:ended', () => {
      setGameState(null)
      setPendingGameId(null)
      refreshBalance()
    })
    s.on('tournament:ended', () => {
      setGameState(null)
      refreshBalance()
    })

    setSocket(s)
    return () => { s.close() }
  }, [token])

  const handleAuth = useCallback((newToken: string) => {
    setToken(newToken)
    const s = socket
    if (s?.connected && newToken) {
      fetch(`${WS_URL}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: newToken }),
      }).then(r => r.json()).then(data => {
        if (data.user) {
          setUserId(data.user.id)
          setUserName(data.user.name)
          setBalance(data.user.balance)
          setDiscordTag(data.user.discordTag ?? null)
        }
      }).catch(() => {})
    }
  }, [socket])

  const handleSignup = useCallback((newToken: string) => {
    setPendingToken(newToken)
    setShowDiscordLink(true)
  }, [])

  const refreshBalance = useCallback(async () => {
    if (!token) return
    try {
      const res = await fetch(`${WS_URL}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const data = await res.json()
      if (data.user) setBalance(data.user.balance)
    } catch { /* silent */ }
  }, [token])

  const signOut = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY)
    setToken(null)
    setUserId('')
    setUserName('')
    setBalance(0)
    setDiscordTag(null)
  }, [])

  const handleLinkDiscord = useCallback(() => {
    setShowDiscordLink(true)
    setPendingToken(token)
  }, [token])

  const handleUnlinkDiscord = useCallback(async () => {
    if (!token) return
    try {
      const res = await fetch(`${WS_URL}/api/auth/discord/unlink`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const data = await res.json()
      if (!data.success) throw new Error('Failed to unlink')
      setDiscordTag(null)
      refreshBalance()
    } catch (err: any) {
      setError(err.message)
    }
  }, [token, refreshBalance])

  const handleDiscordLinked = useCallback(() => {
    if (pendingToken) {
      localStorage.setItem(STORAGE_KEY, pendingToken)
      handleAuth(pendingToken)
    }
    setShowDiscordLink(false)
    setPendingToken(null)
  }, [pendingToken, handleAuth])

  const handleDiscordSkip = useCallback(() => {
    if (pendingToken) {
      localStorage.setItem(STORAGE_KEY, pendingToken)
      handleAuth(pendingToken)
    }
    setShowDiscordLink(false)
    setPendingToken(null)
  }, [pendingToken, handleAuth])

  const handleDeleteAccount = useCallback(() => {
    setShowDeleteAccount(true)
  }, [])

  const handleAccountDeleted = useCallback(() => {
    setShowDeleteAccount(false)
    signOut()
  }, [signOut])

  const handleDeleteCancel = useCallback(() => {
    setShowDeleteAccount(false)
  }, [])

  const joinTable = useCallback((tableId: string) => {
    if (!socket || !token) { setError('Not authenticated'); return }
    setError('')
    const msg: JoinTableRequest = {
      tableId, name: userName, buyIn: tableId === 'practice' ? 1000 : 500, token,
    }
    socket.emit(ClientEvent.JoinTable, msg)
  }, [socket, token, userName])

  const startPractice = useCallback(() => {
    if (!socket) { setError('Not connected'); return }
    setError('')
    socket.emit(ClientEvent.JoinTable, {
      tableId: 'practice', name: userName || 'Player', buyIn: 1000,
    })
  }, [socket, userName])

  const refreshHands = useCallback(async () => {
    setHandsLoading(true)
    try {
      const data = await fetch(`${WS_URL}/api/hands`).then(r => r.json())
      setHands(data)
    } catch {}
    setHandsLoading(false)
  }, [])

  const leaveTable = useCallback(() => {
    socket?.emit(ClientEvent.LeaveTable)
    setGameState(null)
    setPendingGameId(null)
    refreshBalance()
    refreshHands()
    // Refresh games/tournaments
    fetch(`${WS_URL}/api/games`).then(r => r.json()).then(setPlayerGames).catch(() => {})
    fetch(`${WS_URL}/api/tournaments`).then(r => r.json()).then(setTournaments).catch(() => {})
  }, [socket, refreshHands])

  const registerTournament = useCallback(async (id: string) => {
    if (!token) { setError('Not authenticated'); return }
    setError('')
    try {
      const res = await fetch(`${WS_URL}/api/tournaments/${id}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error ?? 'Registration failed')
      const [list, session] = await Promise.all([
        fetch(`${WS_URL}/api/tournaments`).then(r => r.json()),
        fetch(`${WS_URL}/api/auth/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        }).then(r => r.json()),
      ])
      setTournaments(list)
      if (session.user) setBalance(session.user.balance)
    } catch (err: any) {
      setError(err.message)
    }
  }, [token])

  const rebuyTournament = useCallback(async (id: string) => {
    if (!token) { setError('Not authenticated'); return }
    setError('')
    try {
      const res = await fetch(`${WS_URL}/api/tournaments/${id}/rebuy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error ?? 'Rebuy failed')
      const [list, session] = await Promise.all([
        fetch(`${WS_URL}/api/tournaments`).then(r => r.json()),
        fetch(`${WS_URL}/api/auth/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        }).then(r => r.json()),
      ])
      setTournaments(list)
      if (session.user) setBalance(session.user.balance)
    } catch (err: any) {
      setError(err.message)
    }
  }, [token])

  // ─── Create Game ──────────────────────────────────────────

  const createGame = useCallback(async (name: string, maxPlayers: number, buyIn: number, startingChips: number) => {
    if (!token) { setError('Not authenticated'); return }
    setError('')
    try {
      const res = await fetch(`${WS_URL}/api/games/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, maxPlayers, buyIn, startingChips, token }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to create game')
      setShowCreateGame(false)
      // Refresh games list
      const games = await fetch(`${WS_URL}/api/games`).then(r => r.json())
      setPlayerGames(games)
      // Join the created game
      joinPlayerGame(data.id)
    } catch (err: any) {
      setError(err.message)
    }
  }, [token])

  // ─── Create Tournament ─────────────────────────────────────

  const createTournamentFn = useCallback(async (name: string, maxPlayers: number, buyIn: number, startingChips: number, rebuyDuration: number = 60) => {
    if (!token) { setError('Not authenticated'); return }
    setError('')
    try {
      const res = await fetch(`${WS_URL}/api/tournaments/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, maxPlayers, buyIn, startingChips, token, rebuyDuration }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to create tournament')
      setShowCreateTournament(false)
      const list = await fetch(`${WS_URL}/api/tournaments`).then(r => r.json())
      setTournaments(list)
      refreshBalance()
    } catch (err: any) {
      setError(err.message)
    }
  }, [token])

  // ─── Join Player Game ──────────────────────────────────────

  const joinPlayerGame = useCallback(async (gameId: string) => {
    if (!token) { setError('Not authenticated'); return }
    setError('')
    try {
      const res = await fetch(`${WS_URL}/api/games/${gameId}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to join game')
      // Connect via socket to the game
      if (socket) {
        socket.emit('game:join', { gameId, token })
      }
      if (data.isReady) {
        setPendingGameId(null)
      } else {
        setPendingGameId(gameId)
      }
      refreshBalance()
      const games = await fetch(`${WS_URL}/api/games`).then(r => r.json())
      setPlayerGames(games)
    } catch (err: any) {
      setError(err.message)
    }
  }, [socket, token])

  // ─── Cancel Game ──────────────────────────────────────────

  const cancelGame = useCallback(async (gameId: string) => {
    if (!token) return
    try {
      const res = await fetch(`${WS_URL}/api/games/${gameId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (!res.ok) throw new Error('Failed to cancel')
      const games = await fetch(`${WS_URL}/api/games`).then(r => r.json())
      setPlayerGames(games)
      refreshBalance()
    } catch (err: any) {
      setError(err.message)
    }
  }, [token])

  // ─── Cancel Tournament ────────────────────────────────────

  const cancelTournament = useCallback(async (tournamentId: string) => {
    if (!token) return
    try {
      const res = await fetch(`${WS_URL}/api/tournaments/${tournamentId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (!res.ok) throw new Error('Failed to cancel')
      const list = await fetch(`${WS_URL}/api/tournaments`).then(r => r.json())
      setTournaments(list)
      refreshBalance()
    } catch (err: any) {
      setError(err.message)
    }
  }, [token])

  if (!sessionLoaded) {
    return (
      <div style={{ width: '100vw', height: '100vh', background: '#0f0f1a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: '#888', fontSize: 15 }}>Loading...</div>
      </div>
    )
  }

  if (showDiscordLink && pendingToken) {
    return (
      <div style={{ width: '100vw', height: '100vh', background: '#0f0f1a', display: 'flex', flexDirection: 'column' }}>
        <DiscordLinkScreen token={pendingToken} onLinked={handleDiscordLinked} onSkip={handleDiscordSkip} />
      </div>
    )
  }

  if (showDeleteAccount && token) {
    return (
      <div style={{ width: '100vw', height: '100vh', background: '#0f0f1a', display: 'flex', flexDirection: 'column' }}>
        <DeleteAccountScreen token={token} onDeleted={handleAccountDeleted} onCancel={handleDeleteCancel} discordTag={discordTag} />
      </div>
    )
  }

  if (showCalibration) {
    return (
      <CalibrateSeatsView onDone={() => setShowCalibration(false)} />
    )
  }

  if (!token) {
    return (
      <div style={{ width: '100vw', height: '100vh', background: '#0f0f1a', display: 'flex', flexDirection: 'column' }}>
        <AuthScreen onAuth={handleAuth} onSignup={handleSignup} />
      </div>
    )
  }

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#0f0f1a', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {!gameState ? (
        <div style={{ flex: 1, overflow: 'auto' }}>
          <div style={{ padding: '24px 32px' }}>
            <Header name={userName} balance={balance} connected={connected} onSignOut={signOut} onDeposit={() => setCashierMode('deposit')} onWithdraw={() => setCashierMode('withdraw')} discordTag={discordTag} onLinkDiscord={handleLinkDiscord} onUnlinkDiscord={handleUnlinkDiscord} onDeleteAccount={handleDeleteAccount} />

            {error && (
              <div style={{
                textAlign: 'center', color: '#e74c3c', marginBottom: 16,
                padding: '8px 16px', background: 'rgba(231,76,60,0.1)', borderRadius: 8,
                fontSize: 13, border: '1px solid rgba(231,76,60,0.2)',
              }}>
                {error}
              </div>
            )}

            {!connected && (
              <div style={{
                textAlign: 'center', padding: 48,
                background: 'rgba(255,255,255,0.03)', borderRadius: 12,
                border: '1px solid rgba(255,255,255,0.06)',
              }}>
                <div style={{ fontSize: 24, marginBottom: 8 }}>♠</div>
                <div style={{ color: '#888', fontSize: 14 }}>Connecting to server at {WS_URL}...</div>
              </div>
            )}

            {connected && (
              <>
                <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
                  <button onClick={() => setTab('cash')} style={{
                    padding: '10px 24px', borderRadius: 9999, border: 'none',
                    background: tab === 'cash' ? 'rgba(46,204,113,0.15)' : 'rgba(255,255,255,0.04)',
                    color: tab === 'cash' ? '#2ecc71' : '#888', fontWeight: 700, cursor: 'pointer', fontSize: 14,
                    borderBottom: tab === 'cash' ? '2px solid #2ecc71' : '2px solid transparent',
                    transition: 'all 0.15s',
                  }}
                    onMouseEnter={e => { if (tab !== 'cash') e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
                    onMouseLeave={e => { if (tab !== 'cash') e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                  >Cash Games</button>
                  <button onClick={() => setTab('tournaments')} style={{
                    padding: '10px 24px', borderRadius: 9999, border: 'none',
                    background: tab === 'tournaments' ? 'rgba(230,126,34,0.15)' : 'rgba(255,255,255,0.04)',
                    color: tab === 'tournaments' ? '#e67e22' : '#888', fontWeight: 700, cursor: 'pointer', fontSize: 14,
                    borderBottom: tab === 'tournaments' ? '2px solid #e67e22' : '2px solid transparent',
                    transition: 'all 0.15s',
                  }}
                    onMouseEnter={e => { if (tab !== 'tournaments') e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
                    onMouseLeave={e => { if (tab !== 'tournaments') e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                  >Tournaments</button>
                  <button onClick={() => setTab('hands')} style={{
                    padding: '10px 24px', borderRadius: 9999, border: 'none',
                    background: tab === 'hands' ? 'rgba(52,152,219,0.15)' : 'rgba(255,255,255,0.04)',
                    color: tab === 'hands' ? '#3498db' : '#888', fontWeight: 700, cursor: 'pointer', fontSize: 14,
                    borderBottom: tab === 'hands' ? '2px solid #3498db' : '2px solid transparent',
                    transition: 'all 0.15s',
                  }}
                    onMouseEnter={e => { if (tab !== 'hands') e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
                    onMouseLeave={e => { if (tab !== 'hands') e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                  >Hands</button>
                  <button onClick={() => setTab('stats')} style={{
                    padding: '10px 24px', borderRadius: 9999, border: 'none',
                    background: tab === 'stats' ? 'rgba(155,89,182,0.15)' : 'rgba(255,255,255,0.04)',
                    color: tab === 'stats' ? '#bb86fc' : '#888', fontWeight: 700, cursor: 'pointer', fontSize: 14,
                    borderBottom: tab === 'stats' ? '2px solid #bb86fc' : '2px solid transparent',
                    transition: 'all 0.15s',
                  }}
                    onMouseEnter={e => { if (tab !== 'stats') e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
                    onMouseLeave={e => { if (tab !== 'stats') e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                  >Stats</button>
                </div>
                {tab === 'cash' ? (
                  <>
                    <LobbyView tables={tables} onJoin={joinTable} onPractice={startPractice} balance={balance} />
                    <PlayerGamesView games={playerGames} onJoin={joinPlayerGame} balance={balance} onCreateGame={() => setShowCreateGame(true)} userId={userId} onCancel={cancelGame} />
                  </>
                ) : tab === 'tournaments' ? (
                  <>
                    <TournamentLobbyView tournaments={tournaments} onRegister={registerTournament} onRebuy={rebuyTournament} balance={balance} onCreateTournament={() => setShowCreateTournament(true)} onCancel={cancelTournament} userId={userId} />
                  </>
                ) : tab === 'hands' ? (
                  selectedHand ? (
                    <HandReplayer hand={selectedHand} onBack={() => setSelectedHand(null)} />
                  ) : (
                    <HandHistoryPanel hands={hands} onSelectHand={setSelectedHand} playerName={userName} loading={handsLoading} />
                  )
                ) : (
                  <StatsPanel stats={computeStats(hands, userName)} hands={hands} playerName={userName} />
                )}
                {process.env.NODE_ENV === 'development' && (
                  <div style={{ textAlign: 'center', marginTop: 32, paddingBottom: 16 }}>
                    <button onClick={() => setShowCalibration(true)} style={{
                      background: 'none', border: 'none', color: '#555', cursor: 'pointer',
                      fontSize: 12, padding: 0, textDecoration: 'underline',
                    }}>Calibrate Seats</button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      ) : (
        <TableView gameState={gameState} socket={socket!} myId={socket!.id!} onLeave={leaveTable} />
      )}

      {/* Pending Game Waiting Screen */}
      {pendingGameId && !gameState && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 150, backdropFilter: 'blur(4px)',
        }}>
          <div style={{
            background: 'linear-gradient(135deg, #1a1a2e, #16213e)', borderRadius: 20, padding: '32px 40px',
            border: '1px solid rgba(255,255,255,0.12)', textAlign: 'center',
          }}>
            <div style={{ fontSize: 24, marginBottom: 12 }}>⏳</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#eee', marginBottom: 8 }}>Waiting for players...</div>
            <div style={{ fontSize: 14, color: '#888' }}>The game will start once all players have joined</div>
            <button onClick={() => { setPendingGameId(null) }} style={{
              marginTop: 20, padding: '8px 20px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)',
              background: 'transparent', color: '#888', cursor: 'pointer', fontSize: 13,
            }}>Back to Lobby</button>
          </div>
        </div>
      )}

      {/* Create Game Modal */}
      {showCreateGame && (
        <CreateGameModal
          onClose={() => setShowCreateGame(false)}
          onCreate={createGame}
          balance={balance}
        />
      )}

      {/* Create Tournament Modal */}
      {showCreateTournament && (
        <CreateTournamentModal
          onClose={() => setShowCreateTournament(false)}
          onCreate={(name, maxPlayers, buyIn, startingChips) => createTournamentFn(name, maxPlayers, buyIn, startingChips)}
          balance={balance}
        />
      )}

      {/* Cashier Modal */}
      {cashierMode && token && (
        <CashierModal
          mode={cashierMode}
          userId={userId}
          token={token}
          balance={balance}
          onDone={() => { setCashierMode(null); refreshBalance() }}
        />
      )}
    </div>
  )
}

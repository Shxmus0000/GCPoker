// ─── Payout Calculation ─────────────────────────────────
// Up to 90% of total buy-ins paid out, weighted to top finishers

export interface PayoutResult {
  positions: number
  prizePool: number
  prizes: number[] // prizes[0] = 1st place, prizes[1] = 2nd, etc.
}

export function calculatePayouts(playerCount: number, buyIn: number, rebuyCount: number = 0): PayoutResult {
  const totalEntries = playerCount + rebuyCount
  const totalPool = totalEntries * buyIn
  const prizePool = Math.floor(totalPool * 0.9)

  const positions = determinePaidPositions(totalEntries)

  if (positions === 0) return { positions: 0, prizePool: 0, prizes: [] }

  // Weighted distribution: weights decrease by position
  const weights = generateWeights(positions)
  const totalWeight = weights.reduce((a, b) => a + b, 0)

  const prizes: number[] = []
  let remaining = prizePool
  for (let i = 0; i < positions; i++) {
    if (i === positions - 1) {
      prizes.push(remaining)
    } else {
      const share = Math.floor(prizePool * (weights[i] / totalWeight))
      prizes.push(share)
      remaining -= share
    }
  }

  return { positions, prizePool, prizes }
}

function determinePaidPositions(playerCount: number): number {
  if (playerCount <= 1) return 0
  if (playerCount <= 4) return 1
  if (playerCount <= 7) return 2
  if (playerCount <= 10) return 3
  if (playerCount <= 15) return 4
  if (playerCount <= 20) return 5
  if (playerCount <= 30) return 6
  if (playerCount <= 50) return 7
  return 9
}

function generateWeights(count: number): number[] {
  const weights: number[] = []
  for (let i = 0; i < count; i++) {
    // 1st gets highest weight, decreasing
    weights.push(count - i)
  }
  return weights
}

// ─── Blind Calculation ──────────────────────────────────
// Derive starting blinds from starting chips.
// Target: starting stack ≈ 50-100 big blinds

export interface BlindLevelProgression {
  level: number
  smallBlind: number
  bigBlind: number
  duration: number
}

export function calculateStartingBlinds(startingChips: number): { smallBlind: number; bigBlind: number } {
  // Target: ~75 big blinds deep
  const bb = Math.max(2, Math.round(startingChips / 75 / 5) * 5)
  const sb = Math.max(1, Math.round(bb / 2))
  return { smallBlind: sb, bigBlind: bb }
}

export function generateBlindLevels(startingChips: number, isMultiTable: boolean): BlindLevelProgression[] {
  const { smallBlind, bigBlind } = calculateStartingBlinds(startingChips)
  const duration = isMultiTable ? 15 : 10
  const levels: BlindLevelProgression[] = []

  for (let i = 0; i < 15; i++) {
    const multiplier = Math.pow(1.5, i)
    const bb = Math.max(bigBlind, Math.round(bigBlind * multiplier / 5) * 5)
    const sb = Math.max(smallBlind, Math.round(bb / 2))
    levels.push({
      level: i + 1,
      smallBlind: sb,
      bigBlind: bb,
      duration,
    })
    // Cap at reasonable max
    if (bb >= startingChips) break
  }

  return levels
}

import { createHmac, randomBytes } from 'crypto'
import { Card } from '@gcpoker/shared'
import { createDeck } from './deck'

// ─── Provably Fair Seeded Shuffle ───────────────────────
// Uses HMAC-SHA256 to derive a deterministic seed from
// server_seed, client_seed, and nonce. The server seed is
// kept secret until the hand ends, then revealed so anyone
// can verify the shuffle was fair.

export interface SeedPair {
  serverSeed: string
  clientSeed: string
  nonce: number
}

export function generateServerSeed(): string {
  return randomBytes(32).toString('hex')
}

export function generateClientSeed(): string {
  return randomBytes(8).toString('hex')
}

export function computeCombinedSeed(serverSeed: string, clientSeed: string, nonce: number): string {
  const hmac = createHmac('sha256', serverSeed)
  hmac.update(`${clientSeed}:${nonce}`)
  return hmac.digest('hex')
}

// Fisher-Yates shuffle using a deterministic seed
export function provablyFairShuffle(seed: string): Card[] {
  const deck = createDeck()
  const d = [...deck]

  // Use the seed bytes to drive the RNG
  const bytes = Buffer.from(seed, 'hex')

  for (let i = d.length - 1; i > 0; i--) {
    // Use bytes from the seed to determine the swap index
    const byteIndex = i * 4
    const b1 = bytes[byteIndex % bytes.length] ?? 0
    const b2 = bytes[(byteIndex + 1) % bytes.length] ?? 0
    const b3 = bytes[(byteIndex + 2) % bytes.length] ?? 0
    const b4 = bytes[(byteIndex + 3) % bytes.length] ?? 0
    const rand = (b1 << 24 | b2 << 16 | b3 << 8 | b4) >>> 0
    const j = rand % (i + 1)
    ;[d[i], d[j]] = [d[j], d[i]]
  }

  return d
}

// Verify a hand's deck after both seeds are revealed
export function verifyShuffle(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  expectedDeck: Card[],
): boolean {
  const combined = computeCombinedSeed(serverSeed, clientSeed, nonce)
  const computedDeck = provablyFairShuffle(combined)

  if (computedDeck.length !== expectedDeck.length) return false

  for (let i = 0; i < computedDeck.length; i++) {
    if (computedDeck[i].rank !== expectedDeck[i].rank ||
        computedDeck[i].suit !== expectedDeck[i].suit) {
      return false
    }
  }

  return true
}

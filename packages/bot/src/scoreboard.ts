// Scoreboard parsing & world detection (adapted from Joybait's worldMonitor + scoreboard)

export interface ScoreboardState {
  world: string | null
  lines: string[]
}

const NON_GAME_WORLDS = new Set(['Hub', 'Lobby', 'Spawn'])

function normalizeForMatch(s: string): string {
  if (!s) return ''
  const noDiacritics = String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
  return noDiacritics.toLowerCase()
}

function textOf(x: any): string {
  try {
    if (!x) return ''
    if (typeof x === 'string') return x
    if (typeof x.toString === 'function') return String(x.toString())
    if (x.text) return String(x.text)
    return JSON.stringify(x)
  } catch {
    return String(x || '')
  }
}

function linesFromScoreboard(sb: any): string[] {
  if (!sb) return []

  let items: any[] = []
  if (Array.isArray(sb.items)) items = sb.items
  else if (sb.items?.values) items = Array.from(sb.items.values())
  else if (sb.scores?.values) items = Array.from(sb.scores.values())
  else if (Array.isArray(sb.scores)) items = sb.scores
  else if (sb.items && typeof sb.items === 'object')
    items = Object.values(sb.items)

  items.sort((a: any, b: any) => {
    const as = a.score ?? a.value ?? 0
    const bs = b.score ?? b.value ?? 0
    if (bs !== as) return bs - as
    return textOf(a.displayName ?? a.name ?? '')
      .localeCompare(textOf(b.displayName ?? b.name ?? ''))
  })

  return items
    .map((it: any) => textOf(it.displayName ?? it.name ?? '').trim())
    .map((l: string) => l.replace(/\u00a7[0-9A-FK-OR]/gi, '').trim())
    .filter((l: string) => l && l !== '-')
}

export function guessWorldFromLines(lines: string[]): string | null {
  if (!lines?.length) return null

  const pairs = lines.map((l) => ({
    raw: l,
    norm: normalizeForMatch(l),
  }))

  // Hub detection
  for (const p of pairs) {
    if (p.norm === 'hub' || /\bhub\s*\d+/.test(p.norm)) return 'Hub'
  }

  // Spawn detection
  for (const p of pairs) {
    if (p.norm.includes('spawn')) return 'Spawn'
  }

  // Generic shard/server detection - skip common info lines
  const bannedNorm =
    /(season|server|balance|experience|xp\b|k\/d|fly\s*time|power|online\b|shield|faction|member|claim|claimed|money|coins|vote|store|discord|website|mc-?complex|\.com)/i

  const isCandidate = (raw: string, norm: string) => {
    if (!raw || !raw.trim()) return false
    if (bannedNorm.test(norm)) return false
    if (/^\s*[•▪\-\[]/.test(raw)) return false
    if (/:/.test(raw)) return false
    return true
  }

  const candidate = pairs.find((p) => isCandidate(p.raw, p.norm))
  if (candidate) return candidate.raw.trim()

  return null
}

export function extractWorldFromSidebar(bot: any): ScoreboardState {
  let sb: any = null
  const scoreboards = bot.scoreboards || {}
  sb = Object.values(scoreboards).find(
    (x: any) => String(x.position ?? x.displayPosition ?? '').toLowerCase() === 'sidebar'
  )

  if (!sb) return { world: null, lines: [] }

  const lines = linesFromScoreboard(sb)
  const world = guessWorldFromLines(lines)
  return { world, lines }
}

export function isHubOrLobby(world: string | null): boolean {
  return !!world && NON_GAME_WORLDS.has(world)
}

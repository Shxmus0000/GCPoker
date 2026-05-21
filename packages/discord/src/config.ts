import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'

export interface ReactionRole {
  emoji: string
  roleId: string
  label: string
}

export interface DiscordConfig {
  // Channel IDs
  lobby: string
  createTable: string
  tournaments: string
  highStakes: string
  badBeats: string
  withdrawals: string
  depositSupport: string
  depositSupportMessageId: string
  general: string
  reactRoles: string

  // Role IDs
  guestRoleId: string
  verifiedRoleId: string

  // Reaction roles
  reactionRoleMessageId: string
  reactionRoles: ReactionRole[]

  // Category
  pokerCategoryId: string

  // Persistent config embed
  configChannelId: string
  configMessageId: string

  // Lobby hub message
  lobbyMessageId: string

  // Ticket system
  supportCategoryId: string
  ticketLogChannelId: string
  ticketPanelChannelId: string
  ticketPanelMessageId: string
  staffRoleIds: string[]

  // Transaction history
  transactionHistoryChannelId: string
  transactionHistoryMessageId: string

  // Staff transaction log
  transactionLogChannelId: string

  // Verify / confirm deletion channels
  verifyChannelId: string
  verifyMessageId: string
  confirmDeletionChannelId: string
  confirmDeletionMessageId: string

  // FAQ
  faqChannelId: string
  faqMessageId: string

  // How to play
  howToPlayChannelId: string
  howToPlayMessageId: string

  // Suggestions
  suggestionsChannelId: string
  suggestionsPanelMessageId: string
  suggestionsTrackerChannelId: string

  // Command log
  commandLogChannelId: string

  // Rules
  rulesChannelId: string
  rulesMessageId: string
}

const DEFAULT_CONFIG: DiscordConfig = {
  lobby: '',
  createTable: '',
  tournaments: '',
  highStakes: '',
  badBeats: '',
  withdrawals: '',
  depositSupport: '',
  depositSupportMessageId: '',
  general: '',
  reactRoles: '',
  guestRoleId: '',
  verifiedRoleId: '',
  reactionRoleMessageId: '',
  reactionRoles: [
    { emoji: '📢', roleId: '', label: 'Poker Updates' },
    { emoji: '🏆', roleId: '', label: 'Tournament Ping' },
    { emoji: '🔥', roleId: '', label: 'High Stakes' },
    { emoji: '🎁', roleId: '', label: 'Giveaways' },
  ],
  pokerCategoryId: '',
  configChannelId: '',
  configMessageId: '',
  lobbyMessageId: '',
  supportCategoryId: '',
  ticketLogChannelId: '',
  ticketPanelChannelId: '',
  ticketPanelMessageId: '',
  staffRoleIds: [],
  transactionHistoryChannelId: '',
  transactionHistoryMessageId: '',
  transactionLogChannelId: '',
  verifyChannelId: '',
  verifyMessageId: '',
  confirmDeletionChannelId: '',
  confirmDeletionMessageId: '',
  faqChannelId: '',
  faqMessageId: '',
  howToPlayChannelId: '',
  howToPlayMessageId: '',
  suggestionsChannelId: '',
  suggestionsPanelMessageId: '',
  suggestionsTrackerChannelId: '',
  commandLogChannelId: '',
  rulesChannelId: '',
  rulesMessageId: '',
}

const CONFIG_PATH = process.env.DISCORD_CONFIG_PATH
  ? resolve(process.env.DISCORD_CONFIG_PATH)
  : resolve(__dirname, '..', '..', '..', 'server', 'data', 'discord-config.json')

let cachedConfig: DiscordConfig | null = null

export function loadDiscordConfig(): DiscordConfig {
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = readFileSync(CONFIG_PATH, 'utf-8')
      const parsed = JSON.parse(raw)
      cachedConfig = { ...DEFAULT_CONFIG, ...parsed }
      return cachedConfig!
    } catch {
      console.warn('[Discord] Failed to parse config file, using defaults')
    }
  }
  cachedConfig = { ...DEFAULT_CONFIG }
  return cachedConfig!
}

export function saveDiscordConfig(config: DiscordConfig): void {
  const dir = dirname(CONFIG_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
  cachedConfig = config
}

export function getDiscordConfig(): DiscordConfig {
  if (cachedConfig) return cachedConfig
  return loadDiscordConfig()
}

export function getPingRoleMention(label: string): string {
  const cfg = getDiscordConfig()
  const role = cfg.reactionRoles.find(r => r.label === label)
  return role?.roleId ? `<@&${role.roleId}>` : ''
}

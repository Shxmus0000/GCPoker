import { getDiscordConfig } from './config'

export interface DiscordChannels {
  lobby: string
  createTable: string
  tournaments: string
  highStakes: string
  badBeats: string
  withdrawals: string
  depositSupport: string
  general: string
}

export function loadChannels(): DiscordChannels {
  const cfg = getDiscordConfig()
  return {
    lobby: cfg.lobby,
    createTable: cfg.createTable,
    tournaments: cfg.tournaments,
    highStakes: cfg.highStakes,
    badBeats: cfg.badBeats,
    withdrawals: cfg.withdrawals,
    depositSupport: cfg.depositSupport,
    general: cfg.general,
  }
}

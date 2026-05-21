import {
  Client, TextChannel, ChannelType, EmbedBuilder, PermissionsBitField,
} from 'discord.js'
import { getDiscordConfig } from './config'
import { resolve, dirname } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'

interface BridgeChannel {
  channelId: string
  roomId: string
  name: string
  type: 'game' | 'tournament'
}

let clientRef: Client | null = null
const bridges = new Map<string, BridgeChannel>() // roomId → BridgeChannel
const channelToRoom = new Map<string, string>() // channelId → roomId

const DATA_PATH = resolve(__dirname, '..', '..', '..', 'server', 'data', 'chat-bridges.json')

function loadBridges(): void {
  if (existsSync(DATA_PATH)) {
    try {
      const raw = readFileSync(DATA_PATH, 'utf-8')
      const arr = JSON.parse(raw) as BridgeChannel[]
      bridges.clear()
      channelToRoom.clear()
      for (const b of arr) {
        bridges.set(b.roomId, b)
        channelToRoom.set(b.channelId, b.roomId)
      }
    } catch { /* ignore */ }
  }
}

function saveBridges(): void {
  const dir = dirname(DATA_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(DATA_PATH, JSON.stringify([...bridges.values()], null, 2), 'utf-8')
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_\s]/g, '').replace(/\s+/g, '-').toLowerCase().slice(0, 32)
}

export async function createBridgeChannel(roomId: string, displayName: string, type: 'game' | 'tournament'): Promise<void> {
  if (!clientRef) return
  const cfg = getDiscordConfig()
  if (!cfg.pokerCategoryId) return

  const guild = clientRef.guilds.cache.first()
  if (!guild) return

  const channelName = `${type === 'game' ? '🃏' : '🏟️'}${sanitizeName(displayName)}`
  const existing = bridges.get(roomId)
  if (existing) {
    const ch = clientRef.channels.cache.get(existing.channelId)
    if (ch && ch instanceof TextChannel) return
    bridges.delete(roomId)
    channelToRoom.delete(existing.channelId)
  }

  try {
    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: cfg.pokerCategoryId,
      topic: `${type === 'game' ? 'Game' : 'Tournament'} chat for ${displayName} — messages relay between in-game and Discord.`,
      permissionOverwrites: [
        { id: guild.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
      ],
    })

    const bridge: BridgeChannel = { channelId: channel.id, roomId, name: displayName, type }
    bridges.set(roomId, bridge)
    channelToRoom.set(channel.id, roomId)
    saveBridges()

    const embed = new EmbedBuilder()
      .setTitle(`${type === 'game' ? '🃏' : '🏟️'} ${displayName}`)
      .setColor(type === 'game' ? '#2ecc71' : '#9b59b6')
      .setDescription(`Chat for **${displayName}**. Messages sent here will appear in the in-game chat and vice versa.`)
      .setFooter({ text: 'GCPoker Chat Bridge' })
      .setTimestamp()

    await channel.send({ embeds: [embed] })
    console.log(`[Discord] Created bridge channel #${channelName} for ${roomId}`)
  } catch (err) {
    console.error(`[Discord] Failed to create bridge channel for ${roomId}:`, err)
  }
}

export async function deleteBridgeChannel(roomId: string): Promise<void> {
  if (!clientRef) return
  const bridge = bridges.get(roomId)
  if (!bridge) return

  const channel = clientRef.channels.cache.get(bridge.channelId)
  if (channel && channel instanceof TextChannel) {
    try {
      await channel.delete()
    } catch { /* ignore */ }
  }
  bridges.delete(roomId)
  channelToRoom.delete(bridge.channelId)
  saveBridges()
  console.log(`[Discord] Deleted bridge channel for ${roomId}`)
}

export function getRoomByChannel(channelId: string): string | undefined {
  return channelToRoom.get(channelId)
}

export async function relayChatToDiscord(roomId: string, playerName: string, text: string): Promise<void> {
  if (!clientRef) return
  const bridge = bridges.get(roomId)
  if (!bridge) return

  const channel = clientRef.channels.cache.get(bridge.channelId)
  if (!channel || !(channel instanceof TextChannel)) return

  const embed = new EmbedBuilder()
    .setColor('#3498db')
    .setDescription(`**${playerName}**: ${text}`)
    .setTimestamp()

  await channel.send({ embeds: [embed] }).catch(() => {})
}

export function isBridgeChannel(channelId: string): boolean {
  return channelToRoom.has(channelId)
}

export function initChatBridge(client: Client): void {
  clientRef = client
  loadBridges()
}

export function getBridgeNames(): string[] {
  return [...bridges.values()].map(b => `${b.type}:${b.roomId} → #${b.channelId}`)
}

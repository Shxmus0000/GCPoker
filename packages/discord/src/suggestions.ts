import {
  TextChannel, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle,
} from 'discord.js'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { getDiscordConfig, saveDiscordConfig } from './config'

const SUGGESTIONS_PATH = process.env.SUGGESTIONS_DATA_PATH
  ? resolve(process.env.SUGGESTIONS_DATA_PATH)
  : resolve(__dirname, '..', '..', '..', 'server', 'data', 'suggestions.json')

interface SuggestionData {
  id: string
  messageId: string
  channelId: string
  authorId: string
  authorName: string
  content: string
  upvotes: string[]
  downvotes: string[]
  createdAt: number
  tracked: boolean
  trackerMessageId?: string
}

let suggestions = new Map<string, SuggestionData>()
let clientRef: any = null
let suggestionCounter = 0

function dataPath(): string { return SUGGESTIONS_PATH }

function load(): void {
  const dir = dirname(dataPath())
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (existsSync(dataPath())) {
    try {
      const raw = readFileSync(dataPath(), 'utf-8')
      const parsed = JSON.parse(raw) as { suggestions: SuggestionData[]; counter: number }
      suggestions = new Map(parsed.suggestions.map(s => [s.id, s]))
      suggestionCounter = parsed.counter
    } catch { /* ignore */ }
  }
}

function save(): void {
  const dir = dirname(dataPath())
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(dataPath(), JSON.stringify({ suggestions: [...suggestions.values()], counter: suggestionCounter }, null, 2), 'utf-8')
}

function buildSuggestionEmbed(s: SuggestionData): EmbedBuilder {
  const net = s.upvotes.length - s.downvotes.length
  const status = net > 0 ? '✅ Positive' : net < 0 ? '❌ Negative' : '➖ Neutral'
  return new EmbedBuilder()
    .setTitle(`Suggestion #${s.id}`)
    .setColor(net > 0 ? '#2ecc71' : net < 0 ? '#e74c3c' : '#3498db')
    .setDescription(s.content)
    .addFields(
      { name: 'Author', value: `<@${s.authorId}>`, inline: true },
      { name: 'Status', value: status, inline: true },
      { name: '\u200B', value: '\u200B', inline: true },
      { name: '👍 Upvotes', value: `${s.upvotes.length}`, inline: true },
      { name: '👎 Downvotes', value: `${s.downvotes.length}`, inline: true },
      { name: '\u200B', value: '\u200B', inline: true },
    )
    .setFooter({ text: `Suggested ${new Date(s.createdAt).toLocaleDateString()}` })
    .setTimestamp()
}

function buildVoteButtons(s: SuggestionData, userId: string): ActionRowBuilder<ButtonBuilder> {
  const hasUpvoted = s.upvotes.includes(userId)
  const hasDownvoted = s.downvotes.includes(userId)
  return new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`sug:upvote:${s.id}`)
        .setLabel(`👍 ${s.upvotes.length}`)
        .setStyle(hasUpvoted ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`sug:downvote:${s.id}`)
        .setLabel(`👎 ${s.downvotes.length}`)
        .setStyle(hasDownvoted ? ButtonStyle.Danger : ButtonStyle.Secondary),
    )
}

async function refreshSuggestionMessage(s: SuggestionData): Promise<void> {
  if (!clientRef) return
  const channel = clientRef.channels.cache.get(s.channelId)
  if (!channel || !(channel instanceof TextChannel)) return
  try {
    const msg = await channel.messages.fetch(s.messageId)
    const embed = buildSuggestionEmbed(s)
    const row = buildVoteButtons(s, '') // placeholder userId passed during interaction
    await msg.edit({ embeds: [embed], components: [row] })
  } catch { /* message deleted */ }
}

async function checkTracker(s: SuggestionData): Promise<void> {
  if (s.tracked) return
  const cfg = getDiscordConfig()
  if (!cfg.suggestionsTrackerChannelId || !clientRef) return
  const channel = clientRef.channels.cache.get(cfg.suggestionsTrackerChannelId)
  if (!channel || !(channel instanceof TextChannel)) return

  const net = s.upvotes.length - s.downvotes.length
  if (net <= 0) return

  const embed = new EmbedBuilder()
    .setTitle(`📋 Suggestion #${s.id} — Positive Feedback`)
    .setColor('#2ecc71')
    .setDescription(s.content)
    .addFields(
      { name: 'Author', value: `<@${s.authorId}>`, inline: true },
      { name: 'Net Votes', value: `+${net}`, inline: true },
      { name: 'Link', value: `[Jump to suggestion](https://discord.com/channels/${channel.guildId}/${s.channelId}/${s.messageId})`, inline: false },
    )
    .setTimestamp()

  s.tracked = true
  try {
    const msg = await channel.send({ embeds: [embed] })
    s.trackerMessageId = msg.id
  } catch {
    s.tracked = false
  }
  save()
}

// ─── Exported functions ──────────────────────────────────

export function initSuggestions(client: any): void {
  load()
  clientRef = client
}

export async function postSuggestionsPanel(channel: TextChannel): Promise<any> {
  const embed = new EmbedBuilder()
    .setTitle('💡 Have a Suggestion?')
    .setColor('#9b59b6')
    .setDescription('We\'re always looking for ways to improve! Click the button below to submit your suggestion. The community can then vote on it.')
    .setFooter({ text: 'GCPoker Suggestions' })

  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder().setCustomId('suggestion:create').setLabel('Create Suggestion').setEmoji('💡').setStyle(ButtonStyle.Primary),
    )

  return await channel.send({ embeds: [embed], components: [row] })
}

export async function handleSuggestionCreateButton(interaction: any): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId('suggestion:modal')
    .setTitle('💡 New Suggestion')

  const contentInput = new TextInputBuilder()
    .setCustomId('suggestion_content')
    .setLabel('Your suggestion')
    .setPlaceholder('Describe your suggestion in detail...')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(2000)

  const row = new ActionRowBuilder<TextInputBuilder>().addComponents(contentInput)
  modal.addComponents(row)
  await interaction.showModal(modal)
}

export async function handleSuggestionCreateModal(interaction: any): Promise<void> {
  const content = interaction.fields.getTextInputValue('suggestion_content')
  if (!content.trim()) {
    await interaction.reply({ content: '❌ Suggestion cannot be empty.', ephemeral: true })
    return
  }

  const cfg = getDiscordConfig()
  if (!cfg.suggestionsChannelId || !clientRef) {
    await interaction.reply({ content: '❌ Suggestions channel not configured.', ephemeral: true })
    return
  }

  const channel = clientRef.channels.cache.get(cfg.suggestionsChannelId)
  if (!channel || !(channel instanceof TextChannel)) {
    await interaction.reply({ content: '❌ Suggestions channel not found.', ephemeral: true })
    return
  }

  suggestionCounter++
  const id = String(suggestionCounter)

  const s: SuggestionData = {
    id,
    messageId: '',
    channelId: channel.id,
    authorId: interaction.user.id,
    authorName: interaction.user.tag,
    content: content.trim(),
    upvotes: [],
    downvotes: [],
    createdAt: Date.now(),
    tracked: false,
  }

  // Post suggestion message
  const embed = buildSuggestionEmbed(s)
  const row = buildVoteButtons(s, interaction.user.id)
  const suggestionMsg = await channel.send({ embeds: [embed], components: [row] })
  s.messageId = suggestionMsg.id

  suggestions.set(s.id, s)
  save()

  await interaction.reply({ content: `✅ Your suggestion has been posted!`, ephemeral: true })

  // Update the suggestions panel at the bottom
  if (cfg.suggestionsPanelMessageId) {
    try {
      const oldPanel = await channel.messages.fetch(cfg.suggestionsPanelMessageId)
      const embed = new EmbedBuilder()
        .setTitle('💡 Have a Suggestion?')
        .setColor('#9b59b6')
        .setDescription('We\'re always looking for ways to improve! Click the button below to submit your suggestion. The community can then vote on it.')
        .setFooter({ text: 'GCPoker Suggestions' })
      const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          new ButtonBuilder().setCustomId('suggestion:create').setLabel('Create Suggestion').setEmoji('💡').setStyle(ButtonStyle.Primary),
        )
      await oldPanel.edit({ embeds: [embed], components: [row] })
      return
    } catch { /* message deleted — send new below */ }
  }
  const panelMsg = await postSuggestionsPanel(channel)
  const c = getDiscordConfig()
  c.suggestionsPanelMessageId = panelMsg.id
  saveDiscordConfig(c)
}

export async function handleSuggestionVote(interaction: any, voteType: 'upvote' | 'downvote'): Promise<void> {
  await interaction.deferUpdate()

  const customId = interaction.customId
  const parts = customId.split(':')
  const suggestionId = parts[2]
  const userId = interaction.user.id

  const s = suggestions.get(suggestionId)
  if (!s) {
    await interaction.followUp({ content: '❌ Suggestion not found.', ephemeral: true })
    return
  }

  const hasUpvoted = s.upvotes.includes(userId)
  const hasDownvoted = s.downvotes.includes(userId)

  if (voteType === 'upvote') {
    if (hasUpvoted) {
      s.upvotes = s.upvotes.filter((id: string) => id !== userId)
    } else {
      s.upvotes.push(userId)
      if (hasDownvoted) {
        s.downvotes = s.downvotes.filter((id: string) => id !== userId)
      }
    }
  } else {
    if (hasDownvoted) {
      s.downvotes = s.downvotes.filter((id: string) => id !== userId)
    } else {
      s.downvotes.push(userId)
      if (hasUpvoted) {
        s.upvotes = s.upvotes.filter((id: string) => id !== userId)
      }
    }
  }

  save()

  // Update the suggestion message
  const channel = clientRef?.channels.cache.get(s.channelId)
  if (channel && channel instanceof TextChannel) {
    try {
      const msg = await channel.messages.fetch(s.messageId)
      const embed = buildSuggestionEmbed(s)
      const row = buildVoteButtons(s, userId)
      await msg.edit({ embeds: [embed], components: [row] })
    } catch { /* ignore */ }
  }

  // Check tracker
  await checkTracker(s)
}

export async function syncSuggestionsPanelOnStartup(): Promise<void> {
  const cfg = getDiscordConfig()
  if (!cfg.suggestionsChannelId || !clientRef) return

  const channel = clientRef.channels.cache.get(cfg.suggestionsChannelId)
  if (!channel || !(channel instanceof TextChannel)) return

  // Delete old panel if message ID is recorded
  if (cfg.suggestionsPanelMessageId) {
    try {
      const existing = await channel.messages.fetch(cfg.suggestionsPanelMessageId)
      if (existing) return // still exists
    } catch {
      // Message was deleted — will repost below
    }
  }

  const panelMsg = await postSuggestionsPanel(channel)
  const c = getDiscordConfig()
  c.suggestionsPanelMessageId = panelMsg.id
  saveDiscordConfig(c)
}

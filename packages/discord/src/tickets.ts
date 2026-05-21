import {
  Client, TextChannel, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, ChannelType, PermissionsBitField,
  AttachmentBuilder,
} from 'discord.js'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { getDiscordConfig, saveDiscordConfig } from './config'
import PDFDocument from 'pdfkit'

const TICKETS_PATH = process.env.TICKETS_DATA_PATH
  ? resolve(process.env.TICKETS_DATA_PATH)
  : resolve(__dirname, '..', '..', '..', 'server', 'data', 'tickets.json')

const TICKET_LOG_MSG_PATH = process.env.TICKET_LOG_MSG_PATH
  ? resolve(process.env.TICKET_LOG_MSG_PATH)
  : resolve(__dirname, '..', '..', '..', 'server', 'data', 'ticket-log-msg.json')

interface TicketData {
  id: string
  number: number
  channelId: string
  creatorId: string
  creatorTag: string
  reason: string
  description: string
  status: 'open' | 'closed'
  addedUsers: string[]
  createdAt: number
  closedAt?: number
  lastActivity: number
}

let tickets = new Map<string, TicketData>()
let ticketCounter = 0
let clientRef: Client | null = null
let staleInterval: ReturnType<typeof setInterval> | null = null
const STALE_TIMEOUT = 30 * 60 * 1000
const CHECK_INTERVAL = 60 * 1000

function dataPath(): string { return TICKETS_PATH }
function logMsgPath(): string { return TICKET_LOG_MSG_PATH }

function load(): void {
  const dir = dirname(dataPath())
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (existsSync(dataPath())) {
    try {
      const raw = readFileSync(dataPath(), 'utf-8')
      const parsed = JSON.parse(raw) as { tickets: TicketData[]; counter: number }
      tickets = new Map(parsed.tickets.map(t => [t.id, t]))
      ticketCounter = parsed.counter
    } catch { /* ignore */ }
  }
}

function save(): void {
  const dir = dirname(dataPath())
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(dataPath(), JSON.stringify({ tickets: [...tickets.values()], counter: ticketCounter }, null, 2), 'utf-8')
}

function isStaff(member: any): boolean {
  if (member.permissions?.has(PermissionsBitField.Flags.Administrator)) return true
  const cfg = getDiscordConfig()
  if (!cfg.staffRoleIds || cfg.staffRoleIds.length === 0) return false
  return cfg.staffRoleIds.some((rid: string) => member.roles?.cache?.has(rid))
}

function getTicketByChannel(channelId: string): TicketData | undefined {
  for (const t of tickets.values()) {
    if (t.channelId === channelId) return t
  }
  return undefined
}

async function updateTicketLog(): Promise<void> {
  const cfg = getDiscordConfig()
  if (!cfg.ticketLogChannelId || !clientRef) return
  const channel = clientRef.channels.cache.get(cfg.ticketLogChannelId)
  if (!channel || !(channel instanceof TextChannel)) return

  const open = [...tickets.values()].filter(t => t.status === 'open').sort((a, b) => b.createdAt - a.createdAt)
  const closed = [...tickets.values()].filter(t => t.status === 'closed').sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))

  const embed = new EmbedBuilder()
    .setTitle('📋 Ticket Log')
    .setColor('#3498db')
    .setDescription(`**${open.length}** open · **${closed.length}** closed total`)

  if (open.length > 0) {
    const lines = open.slice(0, 20).map(t => {
      const age = Date.now() - t.lastActivity
      const ageStr = age < 60000 ? '<1m' : age < 3600000 ? `${Math.floor(age / 60000)}m` : `${Math.floor(age / 3600000)}h`
      const needsAttention = age > STALE_TIMEOUT ? ' ⏰' : ''
      return `🟢 **#${String(t.number).padStart(3, '0')}** — ${t.reason} — <@${t.creatorId}> (${ageStr}${needsAttention})`
    })
    embed.addFields({ name: 'Open Tickets', value: lines.join('\n'), inline: false })
  } else {
    embed.addFields({ name: 'Open Tickets', value: '*None*', inline: false })
  }

  if (closed.length > 0) {
    const lines = closed.slice(0, 5).map(t => {
      return `🔴 **#${String(t.number).padStart(3, '0')}** — ${t.reason} — <@${t.creatorId}>`
    })
    embed.addFields({ name: 'Recently Closed', value: lines.join('\n'), inline: false })
  }

  embed.setTimestamp()

  // Read cached log message ID
  let logMsgId = ''
  if (existsSync(logMsgPath())) {
    try {
      logMsgId = JSON.parse(readFileSync(logMsgPath(), 'utf-8')).messageId
    } catch { /* ignore */ }
  }

  if (logMsgId) {
    const existing = await channel.messages.fetch(logMsgId).catch(() => null)
    if (existing) {
      await existing.edit({ embeds: [embed] }).catch(() => {})
      return
    }
  }

  // No existing message, send new one
  const msg = await channel.send({ embeds: [embed] }).catch(() => null)
  if (msg) {
    const dir = dirname(logMsgPath())
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(logMsgPath(), JSON.stringify({ messageId: msg.id }), 'utf-8')
  }
}

async function generatePdf(ticket: TicketData, messages: { tag: string; time: string; content: string }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 })
    const buffers: Buffer[] = []
    doc.on('data', (chunk: Buffer) => buffers.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(buffers)))
    doc.on('error', reject)

    const ticketId = `#${String(ticket.number).padStart(3, '0')}`

    doc.fontSize(22).font('Helvetica-Bold').text('GCPoker Support Ticket Transcript', { align: 'center' })
    doc.moveDown(0.5)
    doc.fontSize(11).font('Helvetica')
      .text(`Ticket ${ticketId}`, { align: 'center' })
      .text(`Created: ${new Date(ticket.createdAt).toUTCString()}`, { align: 'center' })
      .text(`Status: ${ticket.status.toUpperCase()}`, { align: 'center' })
    if (ticket.closedAt) {
      doc.text(`Closed: ${new Date(ticket.closedAt).toUTCString()}`, { align: 'center' })
    }
    doc.moveDown()

    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#999').stroke()
    doc.moveDown()

    doc.fontSize(14).font('Helvetica-Bold').text('Details')
    doc.fontSize(11).font('Helvetica')
      .text(`Created by: ${ticket.creatorTag}`)
      .text(`Reason: ${ticket.reason}`)
      .text(`Description: ${ticket.description}`)
    doc.moveDown(0.5)

    if (ticket.addedUsers.length > 0) {
      doc.text(`Added users: ${ticket.addedUsers.length}`)
    }
    doc.moveDown()

    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#999').stroke()
    doc.moveDown()

    doc.fontSize(14).font('Helvetica-Bold').text(`Messages (${messages.length})`)
    doc.moveDown(0.5)

    for (const m of messages) {
      doc.fontSize(10).font('Helvetica-Bold').text(`${m.tag}`)
      doc.fontSize(9).font('Helvetica').fillColor('#888').text(m.time, { continued: false })
      doc.fontSize(10).fillColor('#000').font('Helvetica').text(m.content)
      doc.moveDown(0.3)
    }

    doc.end()
  })
}

async function sendTranscript(ticket: TicketData): Promise<void> {
  if (!clientRef) return
  const channel = clientRef.channels.cache.get(ticket.channelId)
  if (!channel || !(channel instanceof TextChannel)) return

  const messages: { tag: string; time: string; content: string }[] = []
  try {
    const fetched = await channel.messages.fetch({ limit: 100 })
    const sorted = [...fetched.values()].reverse()
    for (const msg of sorted) {
      if (msg.author.bot && msg.embeds.length > 0) continue
      messages.push({
        tag: msg.author.tag,
        time: new Date(msg.createdTimestamp).toUTCString(),
        content: msg.cleanContent || '[embed or attachment]',
      })
    }
  } catch { /* skip */ }

  const pdfBuffer = await generatePdf(ticket, messages)
  const ticketLabel = String(ticket.number).padStart(3, '0')
  const attachment = new AttachmentBuilder(pdfBuffer, { name: `ticket-${ticketLabel}.pdf` })

  const recipients = new Set<string>([ticket.creatorId, ...ticket.addedUsers])
  for (const uid of recipients) {
    try {
      const user = await clientRef.users.fetch(uid)
      await user.send({ content: `📋 Your support ticket **#${ticketLabel}** has been closed.`, files: [attachment] }).catch(() => {})
    } catch { /* skip users who can't be DMed */ }
  }
}

function checkStaleTickets(): void {
  const cfg = getDiscordConfig()
  if (!cfg.ticketLogChannelId || !clientRef) return

  const now = Date.now()
  const stale = [...tickets.values()].filter(t => t.status === 'open' && (now - t.lastActivity) > STALE_TIMEOUT)
  if (stale.length === 0) return

  const channel = clientRef.channels.cache.get(cfg.ticketLogChannelId)
  if (!channel || !(channel instanceof TextChannel)) return

  const lines = stale.map(t => `<#${t.channelId}> (${t.reason} — <@${t.creatorId}>)`).join('\n')
  const staffPing = cfg.staffRoleIds.map((rid: string) => `<@&${rid}>`).join(' ')

  channel.send({
    content: `${staffPing}\n⏰ The following tickets need attention:\n${lines}`,
  }).catch(() => {})
}

async function createTicketChannel(reason: string, description: string, creatorId: string, creatorTag: string): Promise<void> {
  const cfg = getDiscordConfig()
  if (!cfg.supportCategoryId || !clientRef) return

  const guild = clientRef.guilds.cache.first()
  if (!guild) return

  ticketCounter++
  const ticketId = String(ticketCounter).padStart(3, '0')
  const channel = await guild.channels.create({
    name: `ticket-${ticketId}`,
    type: ChannelType.GuildText,
    parent: cfg.supportCategoryId,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: creatorId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
      ...cfg.staffRoleIds.map((rid: string) => ({
        id: rid,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
      })),
    ],
  })

  const ticket: TicketData = {
    id: `ticket-${ticketId}`,
    number: ticketCounter,
    channelId: channel.id,
    creatorId,
    creatorTag,
    reason,
    description,
    status: 'open',
    addedUsers: [],
    createdAt: Date.now(),
    lastActivity: Date.now(),
  }

  tickets.set(ticket.id, ticket)
  save()

  const embed = new EmbedBuilder()
    .setTitle(`🎫 Ticket #${ticketId} — ${reason}`)
    .setColor('#2ecc71')
    .setDescription(description)
    .addFields(
      { name: 'Created by', value: `<@${creatorId}>`, inline: true },
      { name: 'Status', value: '🟢 Open', inline: true },
    )
    .setFooter({ text: 'Staff will be with you shortly.' })
    .setTimestamp()

  await channel.send({ content: `<@${creatorId}>`, embeds: [embed] }).catch(() => {})
  await updateTicketLog()
}

// ─── Exported functions ──────────────────────────────────

export function initTicketSystem(client: Client): void {
  load()
  clientRef = client
  if (staleInterval) clearInterval(staleInterval)
  staleInterval = setInterval(checkStaleTickets, CHECK_INTERVAL)
  // Initial log update
  setTimeout(updateTicketLog, 3000)
}

export async function postTicketPanel(channel: TextChannel): Promise<any> {
  const embed = new EmbedBuilder()
    .setTitle('🎫 Create a Support Ticket')
    .setColor('#9b59b6')
    .setDescription('Click the button below to create a support ticket. A private channel will be created where you can discuss with our staff team.')
    .setFooter({ text: 'GCPoker Support' })

  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder().setCustomId('ticket:create').setLabel('Create Ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary),
    )

  return await channel.send({ embeds: [embed], components: [row] })
}

export async function handleTicketCreateButton(interaction: any): Promise<void> {
  const select = new StringSelectMenuBuilder()
    .setCustomId('ticket:reason')
    .setPlaceholder('Select a reason for your ticket...')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('General Support').setValue('General Support').setEmoji('💬'),
      new StringSelectMenuOptionBuilder().setLabel('Account Issue').setValue('Account Issue').setEmoji('🔐'),
      new StringSelectMenuOptionBuilder().setLabel('Payment Issue').setValue('Payment Issue').setEmoji('💰'),
      new StringSelectMenuOptionBuilder().setLabel('Report a Player').setValue('Report a Player').setEmoji('🚩'),
      new StringSelectMenuOptionBuilder().setLabel('Other').setValue('Other').setEmoji('❓'),
    )

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
  await interaction.reply({ content: 'Please select a reason for your ticket:', components: [row], ephemeral: true })
}

export async function handleTicketReasonSelect(interaction: any): Promise<void> {
  const reason = interaction.values[0]
  const safeReason = reason.replace(/[^a-zA-Z0-9 -]/g, '').replace(/ /g, '_')

  const modal = new ModalBuilder()
    .setCustomId(`ticket:modal:${safeReason}`)
    .setTitle(`New Ticket — ${reason}`)

  const descInput = new TextInputBuilder()
    .setCustomId('ticket_desc')
    .setLabel('Describe your issue')
    .setPlaceholder('Please provide as much detail as possible...')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000)

  const row = new ActionRowBuilder<TextInputBuilder>().addComponents(descInput)
  modal.addComponents(row)

  await interaction.showModal(modal)
}

export async function handleTicketCreateModal(interaction: any): Promise<void> {
  const parts = interaction.customId.split(':')
  const reason = parts.length >= 3 ? parts[2].replace(/_/g, ' ') : 'Support'
  const description = interaction.fields.getTextInputValue('ticket_desc')

  await createTicketChannel(reason, description, interaction.user.id, interaction.user.tag)
  await interaction.reply({ content: '✅ Your ticket has been created! Check the support category for your private channel.', ephemeral: true })
}

export async function handleTicketAddUser(interaction: any): Promise<void> {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: '❌ Only staff can add users to tickets.', ephemeral: true })
    return
  }

  const ticket = getTicketByChannel(interaction.channelId)
  if (!ticket) {
    await interaction.reply({ content: '❌ This command can only be used in a ticket channel.', ephemeral: true })
    return
  }

  const target = interaction.options.getUser('user', true)
  if (ticket.addedUsers.includes(target.id)) {
    await interaction.reply({ content: '❌ That user is already added to this ticket.', ephemeral: true })
    return
  }

  ticket.addedUsers.push(target.id)
  save()

  const channel = interaction.channel
  if (channel) {
    await channel.permissionOverwrites.create(target.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    }).catch(() => {})
  }

  await interaction.reply({ content: `✅ Added <@${target.id}> to this ticket.`, ephemeral: false })
}

export async function handleTicketRemoveUser(interaction: any): Promise<void> {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: '❌ Only staff can remove users from tickets.', ephemeral: true })
    return
  }

  const ticket = getTicketByChannel(interaction.channelId)
  if (!ticket) {
    await interaction.reply({ content: '❌ This command can only be used in a ticket channel.', ephemeral: true })
    return
  }

  const target = interaction.options.getUser('user', true)
  if (target.id === ticket.creatorId) {
    await interaction.reply({ content: '❌ Cannot remove the ticket creator.', ephemeral: true })
    return
  }

  ticket.addedUsers = ticket.addedUsers.filter(id => id !== target.id)
  save()

  const channel = interaction.channel
  if (channel) {
    await channel.permissionOverwrites.delete(target.id).catch(() => {})
  }

  await interaction.reply({ content: `✅ Removed <@${target.id}> from this ticket.`, ephemeral: false })
}

export async function handleTicketClose(interaction: any): Promise<void> {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: '❌ Only staff can close tickets.', ephemeral: true })
    return
  }

  const ticket = getTicketByChannel(interaction.channelId)
  if (!ticket) {
    await interaction.reply({ content: '❌ This command can only be used in a ticket channel.', ephemeral: true })
    return
  }

  if (ticket.status === 'closed') {
    await interaction.reply({ content: '❌ This ticket is already closed.', ephemeral: true })
    return
  }

  await interaction.reply({ content: '🔒 Closing ticket and sending transcript...', ephemeral: true })

  ticket.status = 'closed'
  ticket.closedAt = Date.now()
  save()

  const channel = interaction.channel as TextChannel

  await sendTranscript(ticket)

  await updateTicketLog()

  setTimeout(async () => {
    try { await channel.delete() } catch { /* ignore */ }
  }, 3000)
}

export async function handleMessageActivity(message: any): Promise<void> {
  if (message.author.bot) return
  const ticket = getTicketByChannel(message.channelId)
  if (!ticket || ticket.status !== 'open') return
  ticket.lastActivity = Date.now()
}

export async function setupTicketLog(): Promise<void> {
  await updateTicketLog()
}

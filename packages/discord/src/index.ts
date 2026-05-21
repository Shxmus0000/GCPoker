import {
  Client, GatewayIntentBits, TextChannel, SlashCommandBuilder,
  ChannelType, EmbedBuilder, PermissionsBitField,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js'
import type { EventEmitter } from 'events'
import { resolve } from 'path'
import { existsSync, readFileSync } from 'fs'
import { analyzeHand } from './handDetection'
import {
  lobbyUpdateEmbed, gameCreatedEmbed, gameStartedEmbed, gameEndedEmbed,
  tournamentCreatedEmbed, tournamentStartedEmbed, tournamentEndedEmbed,
  tournamentRegisterEmbed, bigHandEmbed, badBeatEmbed,
  depositCompleteEmbed, withdrawalCompleteEmbed,
} from './embeds'
import {
  loadDiscordConfig, saveDiscordConfig, getDiscordConfig, getPingRoleMention,
  DiscordConfig,
} from './config'
import {
  initTicketSystem, postTicketPanel as ticketsPostPanel,
  handleTicketCreateButton, handleTicketReasonSelect, handleTicketCreateModal,
  handleTicketAddUser, handleTicketRemoveUser, handleTicketClose,
  handleMessageActivity, setupTicketLog,
} from './tickets'
import {
  initChatBridge, createBridgeChannel, deleteBridgeChannel,
  relayChatToDiscord, getRoomByChannel, isBridgeChannel,
} from './chatBridge'
import {
  initSuggestions, postSuggestionsPanel, handleSuggestionCreateButton,
  handleSuggestionCreateModal, handleSuggestionVote, syncSuggestionsPanelOnStartup,
} from './suggestions'

let client: Client | null = null
let discConfig: DiscordConfig = loadDiscordConfig()
let ready = false
let eventsRef: EventEmitter | null = null

const linkCodes = new Map<string, { discordId: string; discordTag: string; createdAt: number }>()
const deletionCodes = new Map<string, { discordId: string; createdAt: number }>()
const LINK_CODE_EXPIRY = 5 * 60 * 1000
const tempRRRole = new Map<string, string>() // userId → roleId (pending during add RR flow)

// Track posted messages so we can update/delete them later
const gameMessages = new Map<string, { channelId: string; messageId: string }>()
const tournamentMessages = new Map<string, { channelId: string; messageId: string }>()
const highStakesMessages = new Map<string, { channelId: string; messageId: string }>()
let lobbyGameCount = 0
let lobbyTournamentCount = 0
let lobbyActivePlayers = 0
let lobbyPrizeToday = 0

function getChannel(id: string): TextChannel | null {
  if (!client || !id) return null
  const ch = client.channels.cache.get(id)
  return ch instanceof TextChannel ? ch : null
}

function logCommandUsage(interaction: any, subcommand?: string): void {
  const cfg = getDiscordConfig()
  const ch = getChannel(cfg.commandLogChannelId)
  if (!ch) return

  const user = interaction.user
  const cmd = `/${interaction.commandName}${subcommand ? ` ${subcommand}` : ''}`
  const channel = interaction.channel

  const embed = new EmbedBuilder()
    .setTitle('📝 Command Used')
    .setColor('#3498db')
    .addFields(
      { name: 'User', value: `${user} (${user.tag})`, inline: true },
      { name: 'Command', value: cmd, inline: true },
      { name: 'Channel', value: channel ? `${channel}` : 'DM', inline: true },
    )
    .setTimestamp()

  ch.send({ embeds: [embed] }).catch(() => {})
}

export async function createDiscordBot(token: string, events: EventEmitter, linkedDiscordIds?: string[]): Promise<void> {
  if (!token) {
    console.log('[Discord] No token provided — bot disabled')
    return
  }

  // Try with full intents first; fall back to minimal if disallowed
  const fullIntents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
  ]
  const minimalIntents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ]

  try {
    client = new Client({ intents: fullIntents })
    await client.login(token)
  } catch (err: any) {
    if (err.message?.includes('disallowed intents')) {
      console.warn('[Discord] Full intents not allowed — falling back to minimal intents (role features disabled)')
      client = new Client({ intents: minimalIntents })
      await client.login(token)
    } else {
      throw err
    }
  }

  client.once('ready', async () => {
    ready = true
    discConfig = loadDiscordConfig()
    console.log(`[Discord] Bot online as ${client!.user!.tag}`)

    try {
      await client!.application!.commands.set([])
      const guild = client!.guilds.cache.first()
      if (!guild) {
        console.warn('[Discord] No guild found — commands not registered')
        return
      }
      console.log(`[Discord] Registering commands in guild: ${guild.name} (${guild.id})`)

      // Sync config embed if configured
      syncConfigEmbed()

      // Ensure reaction role message exists in configured channel
      syncReactionRolesOnStartup()

      // Ensure ticket panel exists in configured channel
      syncTicketPanelOnStartup()

      // Ensure deposit info and transaction history exist
      syncDepositInfoOnStartup()
      syncTransactionHistoryOnStartup()
      syncVerifyInfoOnStartup()
      syncConfirmDeletionInfoOnStartup()
      syncFAQOnStartup()
      syncHowToPlayOnStartup()
      syncRulesOnStartup()

      // Sync roles for already-linked users first
      if (linkedDiscordIds && linkedDiscordIds.length > 0) {
        await syncVerifiedRoles(linkedDiscordIds)
      }

      // Remove Guest role from any linked users who shouldn't have it
      await removeGuestRoleFromLinked(guild, linkedDiscordIds)

      // Post/refresh lobby hub
      updateLobbyHub()

      const commands = [
        new SlashCommandBuilder()
          .setName('link')
          .setDescription('Get a one-time code to link your Discord to your GCPoker account'),
        new SlashCommandBuilder()
          .setName('confirmdeletion')
          .setDescription('Get a code to confirm deletion of your GCPoker account '),
        new SlashCommandBuilder()
          .setName('config')
          .setDescription('Post the configuration embed to this channel'),
        new SlashCommandBuilder()
          .setName('setup-reaction-roles')
          .setDescription('Post the reaction role embed in this channel'),
        new SlashCommandBuilder()
          .setName('setup-permissions')
          .setDescription('Scan and log all channel permissions (Admin only)')
          .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
        new SlashCommandBuilder()
          .setName('ticket')
          .setDescription('Manage support tickets')
          .addSubcommand(sub => sub
            .setName('adduser')
            .setDescription('Add a user to the ticket')
            .addUserOption(opt => opt.setName('user').setDescription('The user to add').setRequired(true)))
          .addSubcommand(sub => sub
            .setName('removeuser')
            .setDescription('Remove a user from the ticket')
            .addUserOption(opt => opt.setName('user').setDescription('The user to remove').setRequired(true)))
          .addSubcommand(sub => sub
            .setName('close')
            .setDescription('Close the current ticket')),
      ]

      await guild.commands.set(commands.map(c => c.toJSON()))
      console.log('[Discord] Registered /link, /confirmdeletion, /config, /setup-reaction-roles, /setup-permissions & /ticket')

      // Initialize ticket system
      initTicketSystem(client!)
      // Initialize chat bridge
      initChatBridge(client!)
      // Initialize suggestions
      initSuggestions(client!)
      await syncSuggestionsPanelOnStartup()
    } catch (err) {
      console.error('[Discord] Failed to register commands:', err)
    }
  })

  client.on('error', (err) => {
    console.error('[Discord] Client error:', err.message)
  })

  // ─── Track message activity for ticket channels ──────
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return
    await handleMessageActivity(message)

    // Chat bridge: relay Discord messages to game/tournament rooms
    if (isBridgeChannel(message.channelId)) {
      const roomId = getRoomByChannel(message.channelId)
      if (roomId && eventsRef) {
        const msg = message.cleanContent || ''
        if (!msg) return
        // Look up linked user
        const dataDir = resolve(__dirname, '..', '..', '..', 'packages', 'server', 'data')
        const usersPath = resolve(dataDir, 'users.json')
        let userName = message.author.username
        try {
          if (existsSync(usersPath)) {
            const users = JSON.parse(readFileSync(usersPath, 'utf-8'))
            const user = users.find((u: any) => u.discordId === message.author.id)
            if (user) userName = user.name ?? user.username
          }
        } catch { /* use discord name */ }
        eventsRef.emit('discord:chat', roomId, message.author.id, userName, msg)
      }
    }
  })

  // ─── Auto-role on join ────────────────────────────────
  client.on('guildMemberAdd', async (member) => {
    if (!discConfig.guestRoleId) return
    const cfg = getDiscordConfig()
    try {
      if (cfg.verifiedRoleId && member.roles.cache.has(cfg.verifiedRoleId)) return
      const hasStaffRole = cfg.staffRoleIds.some(rid => rid && member.roles.cache.has(rid))
      if (hasStaffRole) return
      await member.roles.add(discConfig.guestRoleId)
      console.log(`[Discord] Assigned Guest role to ${member.user.tag}`)
    } catch (err) {
      console.error(`[Discord] Failed to assign Guest role to ${member.user.tag}:`, err)
    }
  })

  // ─── Reaction roles ───────────────────────────────────
  client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return
    if (reaction.message.id !== discConfig.reactionRoleMessageId) return

    const guild = client?.guilds.cache.first()
    if (!guild) return

    const rr = discConfig.reactionRoles.find(r => r.emoji === reaction.emoji.name)
    if (!rr || !rr.roleId) return

    const member = guild.members.cache.get(user.id)
    if (!member) return

    try {
      await member.roles.add(rr.roleId)
    } catch (err) {
      console.error(`[Discord] Failed to add reaction role to ${user.tag}:`, err)
    }
  })

  client.on('messageReactionRemove', async (reaction, user) => {
    if (user.bot) return
    if (reaction.message.id !== discConfig.reactionRoleMessageId) return

    const guild = client?.guilds.cache.first()
    if (!guild) return

    const rr = discConfig.reactionRoles.find(r => r.emoji === reaction.emoji.name)
    if (!rr || !rr.roleId) return

    const member = guild.members.cache.get(user.id)
    if (!member) return

    try {
      await member.roles.remove(rr.roleId)
    } catch (err) {
      console.error(`[Discord] Failed to remove reaction role from ${user.tag}:`, err)
    }
  })

  // ─── Interaction handlers ─────────────────────────────
  client.on('interactionCreate', async (interaction) => {
    // Clean up expired codes on every interaction
    const now = Date.now()
    for (const [c, data] of linkCodes) {
      if (now - data.createdAt > LINK_CODE_EXPIRY) linkCodes.delete(c)
    }
    for (const [c, data] of deletionCodes) {
      if (now - data.createdAt > LINK_CODE_EXPIRY) deletionCodes.delete(c)
    }

    // ── Chat input commands ───────────────────────────
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'link') {
        const discordId = interaction.user.id
        const discordTag = interaction.user.tag
        const code = generateLinkCode()
        linkCodes.set(code, { discordId, discordTag, createdAt: Date.now() })
        await interaction.reply({
          content: `🔗 Your link code: **${code}**\nEnter this code on the GCPoker website to link your Discord account.\nThis code expires in 5 minutes.`,
          ephemeral: true,
        })
        logCommandUsage(interaction)
        return
      }

      if (interaction.commandName === 'confirmdeletion') {
        const discordId = interaction.user.id
        const code = generateLinkCode()
        deletionCodes.set(code, { discordId, createdAt: Date.now() })
        await interaction.reply({
          content: `⚠️ **ACCOUNT DELETION CONFIRMATION**\nYour code: **${code}**\n\nEnter this code on the GCPoker website to permanently delete your account.\n**This will forfeit any balance on your account and cannot be undone.**\nThis code expires in 5 minutes.`,
          ephemeral: true,
        })
        logCommandUsage(interaction)
        return
      }

      if (interaction.commandName === 'config') {
        const channel = interaction.channel
        if (!channel || !channel.isTextBased() || channel.isDMBased()) {
          await interaction.reply({ content: '❌ Run this in a server text channel.', ephemeral: true })
          return
        }

        discConfig = getDiscordConfig()
        const embed = buildConfigEmbed()
        const buttons = buildConfigButtons()
        const msg = await channel.send({ embeds: [embed], components: buttons })

        discConfig.configChannelId = channel.id
        discConfig.configMessageId = msg.id
        saveDiscordConfig(discConfig)

        await interaction.reply({ content: `✅ Configuration embed posted in <#${channel.id}>`, ephemeral: true })
        logCommandUsage(interaction)
        return
      }

      if (interaction.commandName === 'ticket') {
        const sub = interaction.options.getSubcommand()
        if (sub === 'adduser') await handleTicketAddUser(interaction)
        else if (sub === 'removeuser') await handleTicketRemoveUser(interaction)
        else if (sub === 'close') await handleTicketClose(interaction)
        logCommandUsage(interaction, sub)
        return
      }

      if (interaction.commandName === 'setup-reaction-roles') {
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
          await interaction.reply({ content: '❌ You need Administrator permission.', ephemeral: true })
          return
        }

        discConfig = getDiscordConfig()
        const channel = interaction.channel
        if (!channel || !channel.isTextBased() || channel.isDMBased()) {
          await interaction.reply({ content: '❌ Run this in a server text channel.', ephemeral: true })
          return
        }

        if (discConfig.reactionRoles.length === 0 || discConfig.reactionRoles.every(r => !r.roleId)) {
          await interaction.reply({ content: '❌ No reaction roles configured. Use the config embed to add reaction roles first.', ephemeral: true })
          return
        }

        const descLines = discConfig.reactionRoles
          .filter(r => r.roleId)
          .map(r => `${r.emoji} — <@&${r.roleId}> — ${r.label}`)
        const embed = new EmbedBuilder()
          .setTitle('🎯 React for Roles')
          .setColor('#9b59b6')
          .setDescription(`React to this message to get notified about specific events!\n\n${descLines.join('\n')}\n\n*Remove your reaction to opt out.*`)
          .setFooter({ text: 'GCPoker' })

        const msg = await channel.send({ embeds: [embed] })

        for (const rr of discConfig.reactionRoles) {
          if (!rr.roleId) continue
          try { await msg.react(rr.emoji) } catch { /* skip */ }
        }

        discConfig.reactRoles = channel.id
        discConfig.reactionRoleMessageId = msg.id
        saveDiscordConfig(discConfig)
        syncConfigEmbed()

        await interaction.reply({ content: `✅ Reaction role message posted in <#${channel.id}>`, ephemeral: true })
        logCommandUsage(interaction)
        return
      }

      if (interaction.commandName === 'setup-permissions') {
        await interaction.deferReply({ ephemeral: true })
        const guild = interaction.guild
        if (!guild) {
          await interaction.editReply({ content: '❌ This command can only be used in a server.' })
          return
        }

        const channels = await guild.channels.fetch()
        const roles = await guild.roles.fetch()
        const cfg = getDiscordConfig()

        const EVERYONE = guild.roles.everyone.id
        const GUEST = cfg.guestRoleId || ''
        const VERIFIED = cfg.verifiedRoleId || ''
        const STAFF = cfg.staffRoleIds.filter(Boolean)

        const textView = [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AddReactions]
        const textWrite = [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks, PermissionsBitField.Flags.AttachFiles, PermissionsBitField.Flags.UseExternalEmojis]
        const textFull = [...textView, ...textWrite, PermissionsBitField.Flags.SendMessagesInThreads, PermissionsBitField.Flags.CreatePublicThreads, PermissionsBitField.Flags.CreatePrivateThreads, PermissionsBitField.Flags.UseApplicationCommands]

        const voiceView = [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect]
        const voiceFull = [...voiceView, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.UseVAD, PermissionsBitField.Flags.MuteMembers, PermissionsBitField.Flags.DeafenMembers]

        const denyAll = [PermissionsBitField.Flags.ViewChannel]

        type Override = { id: string; allow: bigint[]; deny: bigint[] }

        const categoryConfig = new Map<string, Override[]>()

        // ─── INFORMATION category: read-only for non-staff ───
        categoryConfig.set('1506465367453601892', [
          { id: EVERYONE, allow: textView, deny: textWrite },
          ...STAFF.map(id => ({ id, allow: textFull, deny: [] })),
        ])

        // ─── POKER category: read-only for non-staff, hidden from guest ───
        categoryConfig.set('1506485046150692874', [
          { id: EVERYONE, allow: textView, deny: textWrite },
          { id: GUEST, allow: [], deny: denyAll },
          ...STAFF.map(id => ({ id, allow: textFull, deny: [] })),
        ])

        // ─── BANKING category: verified+staff only (read-only for verified) ───
        categoryConfig.set('1506485094989172796', [
          { id: EVERYONE, allow: [], deny: denyAll },
          { id: GUEST, allow: [], deny: denyAll },
          { id: VERIFIED, allow: textView, deny: textWrite },
          ...STAFF.map(id => ({ id, allow: textFull, deny: [] })),
        ])

        // ─── SUPPORT category: read-only for non-staff ───
        categoryConfig.set('1506485122860318913', [
          { id: EVERYONE, allow: textView, deny: textWrite },
          { id: GUEST, allow: [], deny: denyAll },
          ...STAFF.map(id => ({ id, allow: textFull, deny: [] })),
        ])

        // ─── COMMUNITY category: everyone except guest ───
        categoryConfig.set('1506485143416864950', [
          { id: GUEST, allow: [], deny: denyAll },
        ])

        // ─── VOICE category: everyone except guest ───
        categoryConfig.set('1506485168037171301', [
          { id: GUEST, allow: [], deny: denyAll },
        ])

        // ─── STAFF category: staff only ───
        categoryConfig.set('1506489077359185981', [
          { id: EVERYONE, allow: [], deny: denyAll },
          { id: GUEST, allow: [], deny: denyAll },
          { id: VERIFIED, allow: [], deny: denyAll },
          ...STAFF.map(id => ({ id, allow: textFull, deny: [] })),
        ])

        // ─── Bot Control category: staff only ───
        categoryConfig.set('1506725746763108502', [
          { id: EVERYONE, allow: [], deny: denyAll },
          { id: GUEST, allow: [], deny: denyAll },
          { id: VERIFIED, allow: [], deny: denyAll },
          ...STAFF.map(id => ({ id, allow: textFull, deny: [] })),
        ])

        // Apply permissions
        let updatedCategories = 0
        let updatedChannels = 0
        let errors = 0

        const catOverrides = new Map<string, any[]>()

        for (const [catId, overrides] of categoryConfig) {
          const catChannel = channels.get(catId) as any
          if (!catChannel || catChannel.type !== 4) {
            console.log('[Discord]  ⚠ Category channel not found: ' + catId)
            errors++
            continue
          }

          const ov = overrides
            .filter(o => o.id)
            .map(o => ({
              id: o.id,
              allow: o.allow.length > 0 ? o.allow : undefined,
              deny: o.deny.length > 0 ? o.deny : undefined,
            }))

          try {
            await catChannel.permissionOverwrites.set(ov)
            updatedCategories++
            catOverrides.set(catId, ov)
            console.log('[Discord]  ✅ Category #' + catChannel.name + ' — permissions set')
          } catch (err: any) {
            console.log('[Discord]  ❌ Category #' + catChannel.name + ' — ' + err.message)
            errors++
          }
        }

        // Apply same overrides to all child channels to ensure they take effect
        for (const [, ch] of channels) {
          if (!ch || ch.type === 4) continue
          const parentId = ch.parentId
          if (!parentId || !categoryConfig.has(parentId)) continue

          const ov = categoryConfig.get(parentId)!
            .filter(o => o.id)
            .map(o => ({
              id: o.id,
              allow: o.allow.length > 0 ? o.allow : undefined,
              deny: o.deny.length > 0 ? o.deny : undefined,
            }))

          try {
            await ch.permissionOverwrites.set(ov)
            updatedChannels++
          } catch { /* skip */ }
        }

        // ─── Channel-specific overrides (deviations from category defaults) ───
        const channelOverrides = new Map<string, Override[]>()

        // #💡┃suggestions — read-only for non-staff (can view & click buttons, not type)
        channelOverrides.set('1506485638294143026', [
          { id: EVERYONE, allow: textView, deny: textWrite },
          { id: GUEST, allow: [], deny: denyAll },
          ...STAFF.map(id => ({ id, allow: textFull, deny: [] })),
        ])

        for (const [chId, overrides] of channelOverrides) {
          const ch = channels.get(chId) as any
          if (!ch) {
            console.log('[Discord]  ⚠ Channel not found for override: ' + chId)
            errors++
            continue
          }
          const ov = overrides
            .filter(o => o.id)
            .map(o => ({
              id: o.id,
              allow: o.allow.length > 0 ? o.allow : undefined,
              deny: o.deny.length > 0 ? o.deny : undefined,
            }))
          try {
            await ch.permissionOverwrites.set(ov)
            updatedChannels++
            console.log('[Discord]  ✅ Override #' + ch.name + ' — permissions set')
          } catch { /* skip */ }
        }

        // ─── Role permissions ───
        const baseMemberPerms = [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.AddReactions,
          PermissionsBitField.Flags.UseExternalEmojis,
          PermissionsBitField.Flags.UseExternalStickers,
          PermissionsBitField.Flags.Connect,
          PermissionsBitField.Flags.Speak,
          PermissionsBitField.Flags.UseVAD,
          PermissionsBitField.Flags.CreateInstantInvite,
          PermissionsBitField.Flags.ChangeNickname,
        ]
        const staffModPerms = [
          PermissionsBitField.Flags.KickMembers,
          PermissionsBitField.Flags.ManageMessages,
          PermissionsBitField.Flags.MuteMembers,
          PermissionsBitField.Flags.DeafenMembers,
          PermissionsBitField.Flags.MoveMembers,
          PermissionsBitField.Flags.ModerateMembers,
          PermissionsBitField.Flags.ViewAuditLog,
        ]
        const staffFullPerms = [
          ...staffModPerms,
          PermissionsBitField.Flags.BanMembers,
          PermissionsBitField.Flags.ManageChannels,
          PermissionsBitField.Flags.ManageRoles,
          PermissionsBitField.Flags.ManageNicknames,
          PermissionsBitField.Flags.ManageWebhooks,
        ]

        // Map role name → permission set for role-specific levels
        const rolePermOverrides: Record<string, bigint[]> = {
          'Owner': [PermissionsBitField.Flags.Administrator],
          'Admin': [...staffFullPerms, ...baseMemberPerms],
          'Moderator': [...staffModPerms, ...baseMemberPerms],
          'Developer': [...staffModPerms, PermissionsBitField.Flags.ManageWebhooks, ...baseMemberPerms],
        }

        let updatedRoles = 0
        for (const [, role] of roles) {
          if (!role || role.name === '@everyone' || role.managed) continue

          let perms: bigint[] | null = null

          if (cfg.staffRoleIds.includes(role.id)) {
            // Staff role — check for name-based overrides, otherwise use staffFullPerms + baseMemberPerms
            perms = rolePermOverrides[role.name] ?? [...staffFullPerms, ...baseMemberPerms]
          } else if (role.id === cfg.guestRoleId || role.id === cfg.verifiedRoleId) {
            perms = baseMemberPerms
          }

          if (perms) {
            try {
              const permBigInt = perms.reduce((a, b) => a | b, 0n)
              await role.setPermissions(permBigInt)
              updatedRoles++
              console.log('[Discord]  ✅ Role @' + role.name + ' — permissions set')
            } catch (err: any) {
              console.log('[Discord]  ❌ Role @' + role.name + ' — ' + err.message)
              errors++
            }
          }
        }

        console.log('\n[Discord] Permission setup complete: ' + updatedCategories + ' categories, ' + updatedChannels + ' channels, ' + updatedRoles + ' roles updated, ' + errors + ' errors\n')
        await interaction.editReply({ content: '✅ Permissions applied: ' + updatedCategories + ' categories + ' + updatedChannels + ' channels + ' + updatedRoles + ' roles updated' + (errors > 0 ? ' (' + errors + ' errors — check console)' : '') + '.' })
        logCommandUsage(interaction)
        return
      }
    }

    // ── Ticket button ──────────────────────────────────
    if (interaction.isButton() && interaction.customId === 'ticket:create') {
      await handleTicketCreateButton(interaction)
      return
    }

    // ── Transaction history button ─────────────────────
    if (interaction.isButton() && interaction.customId === 'tx:view') {
      await handleTxHistoryButton(interaction)
      return
    }

    // ── Suggestion button ──────────────────────────────
    if (interaction.isButton() && interaction.customId === 'suggestion:create') {
      await handleSuggestionCreateButton(interaction)
      return
    }

    // ── Suggestion vote buttons ────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('sug:upvote:')) {
      await handleSuggestionVote(interaction, 'upvote')
      return
    }
    if (interaction.isButton() && interaction.customId.startsWith('sug:downvote:')) {
      await handleSuggestionVote(interaction, 'downvote')
      return
    }

    // ── Component interactions (buttons, selects, modals on config embed) ──
    if (interaction.isButton()) {
      try {
        await handleConfigButton(interaction)
      } catch (err) {
        console.error('[Discord] Button handler error:', err)
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '❌ An error occurred.', ephemeral: true }).catch(() => {})
        }
      }
      return
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'ticket:reason') {
        await handleTicketReasonSelect(interaction)
        return
      }
      try {
        await handleConfigStringSelect(interaction)
      } catch (err) {
        console.error('[Discord] StringSelect handler error:', err)
      }
      return
    }

    if (interaction.isChannelSelectMenu()) {
      try {
        await handleConfigChannelSelect(interaction)
      } catch (err) {
        console.error('[Discord] ChannelSelect handler error:', err)
      }
      return
    }

    if (interaction.isRoleSelectMenu()) {
      try {
        await handleConfigRoleSelect(interaction)
      } catch (err) {
        console.error('[Discord] RoleSelect handler error:', err)
      }
      return
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('ticket:modal')) {
        await handleTicketCreateModal(interaction)
        return
      }
      if (interaction.customId === 'suggestion:modal') {
        await handleSuggestionCreateModal(interaction)
        return
      }
      try {
        await handleConfigModal(interaction)
      } catch (err) {
        console.error('[Discord] Modal handler error:', err)
      }
      return
    }
  })

  await client.login(token)
  eventsRef = events
  setupEventListeners(events)
}

// ─── Helper: send a message with optional ping role mention ──
function sendWithPing(ch: TextChannel | null, pingLabel: string | undefined, options: { content?: string; embeds?: EmbedBuilder[] }): void {
  if (!ch) return
  const ping = pingLabel ? getPingRoleMention(pingLabel) : ''
  const parts: string[] = []
  if (ping) parts.push(ping)
  if (options.content) parts.push(options.content)
  const content = parts.length > 0 ? parts.join('\n') : undefined
  ch.send({ content, embeds: options.embeds as any }).catch(() => {})
}

// ─── Build config embed ──────────────────────────────────
function buildConfigEmbed(): EmbedBuilder {
  const cfg = getDiscordConfig()
  const guild = client?.guilds.cache.first()

  const embed = new EmbedBuilder()
    .setTitle('⚙️ Discord Bot Configuration')
    .setColor('#3498db')
    .addFields(
      { name: '📁 Channels', value:
        `Lobby 🎰 — hub overview\n━━━━━━━━━━━━━━━━\nLive Tables 🆕 — game lifecycle\nTournaments 🏟️ — tournament lifecycle\nHigh Stakes 🔥 — big buy-in events\nBad Beats 💀 — bad beat hands\n━━━━━━━━━━━━━━━━\nDeposit Support 💰 — deposit instructions\nGeneral 💬 — general chat\nReact Roles 🔁 — reaction role message`, inline: false },
      { name: 'Channel IDs', value:
        `Lobby: <#${cfg.lobby || '—'}>\nLive Tables: <#${cfg.createTable || '—'}>\nTournaments: <#${cfg.tournaments || '—'}>\nHigh Stakes: <#${cfg.highStakes || '—'}>\nBad Beats: <#${cfg.badBeats || '—'}>\nDeposit Support: <#${cfg.depositSupport || '—'}>\nGeneral: <#${cfg.general || '—'}>\nReact Roles: <#${cfg.reactRoles || '—'}>\nTx History: <#${cfg.transactionHistoryChannelId || '—'}>\nTx Log: <#${cfg.transactionLogChannelId || '—'}>\nVerify: <#${cfg.verifyChannelId || '—'}>\nConfirm Deletion: <#${cfg.confirmDeletionChannelId || '—'}>\nFAQ: <#${cfg.faqChannelId || '—'}>\nHow to Play: <#${cfg.howToPlayChannelId || '—'}>\nSuggestions: <#${cfg.suggestionsChannelId || '—'}>\nSuggestion Tracker: <#${cfg.suggestionsTrackerChannelId || '—'}>\nCommand Log: <#${cfg.commandLogChannelId || '—'}>\nRules: <#${cfg.rulesChannelId || '—'}>`, inline: false },
      { name: '🎫 Tickets', value:
        `Support Category: ${cfg.supportCategoryId ? `<#${cfg.supportCategoryId}>` : '—'}\nTicket Panel: ${cfg.ticketPanelChannelId ? `<#${cfg.ticketPanelChannelId}>` : '—'}\nTicket Log: ${cfg.ticketLogChannelId ? `<#${cfg.ticketLogChannelId}>` : '—'}\nStaff Roles: ${cfg.staffRoleIds?.length ? cfg.staffRoleIds.map((r: string) => `<@&${r}>`).join(', ') : '—'}`, inline: false },
      { name: '🎭 Roles', value:
        `Guest: <@&${cfg.guestRoleId || '—'}>\nVerified: <@&${cfg.verifiedRoleId || '—'}>`, inline: false },
      { name: '📌 Category', value: cfg.pokerCategoryId ? `<#${cfg.pokerCategoryId}>` : '(not set)', inline: false },
    )
    .setTimestamp()

  if (cfg.reactionRoles.length > 0) {
    const rrLines = cfg.reactionRoles.map(r =>
      `${r.emoji} **${r.label}** → ${r.roleId ? `<@&${r.roleId}>` : '*not set*'}`
    ).join('\n')
    embed.addFields({ name: '🔁 Reaction Roles', value: rrLines, inline: false })
    if (cfg.reactionRoleMessageId && guild) {
      embed.addFields({ name: 'Reaction Message', value: `[Jump to message](https://discord.com/channels/${guild.id}/${cfg.reactRoles}/${cfg.reactionRoleMessageId})`, inline: false })
    }
  }

  return embed
}

// ─── Sync config embed to configured channel ────────────
function syncConfigEmbed(): void {
  const cfg = getDiscordConfig()
  if (!cfg.configChannelId || !cfg.configMessageId) return
  if (!client) return

  const channel = client.channels.cache.get(cfg.configChannelId)
  if (!channel || !(channel instanceof TextChannel)) return

  const embed = buildConfigEmbed()
  const buttons = buildConfigButtons()
  channel.messages.fetch(cfg.configMessageId).then(msg => {
    msg.edit({ embeds: [embed], components: buttons }).catch(() => {})
  }).catch(() => {
    const c = getDiscordConfig()
    c.configChannelId = ''
    c.configMessageId = ''
    saveDiscordConfig(c)
  })
}

// ─── Sync reaction roles on startup ─────────────────────
async function syncReactionRolesOnStartup(): Promise<void> {
  const cfg = getDiscordConfig()
  if (!cfg.reactRoles || cfg.reactionRoles.length === 0 || cfg.reactionRoles.every(r => !r.roleId)) return
  if (!client) return

  const channel = client.channels.cache.get(cfg.reactRoles)
  if (!channel || !(channel instanceof TextChannel)) return

  // If we already have a recorded message ID, verify it still exists
  if (cfg.reactionRoleMessageId) {
    try {
      const existing = await channel.messages.fetch(cfg.reactionRoleMessageId)
      if (existing) return // still exists, nothing to do
    } catch {
      // Message was deleted — will repost below
    }
  }

  // Post new reaction role message
  const descLines = cfg.reactionRoles
    .filter(r => r.roleId)
    .map(r => `${r.emoji} — <@&${r.roleId}> — ${r.label}`)
  const embed = new EmbedBuilder()
    .setTitle('🎯 React for Roles')
    .setColor('#9b59b6')
    .setDescription(`React to this message to get notified about specific events!\n\n${descLines.join('\n')}\n\n*Remove your reaction to opt out.*`)
    .setFooter({ text: 'GCPoker' })

  try {
    const msg = await channel.send({ embeds: [embed] })
    for (const rr of cfg.reactionRoles) {
      if (!rr.roleId) continue
      try { await msg.react(rr.emoji) } catch { /* skip */ }
    }
    const c = getDiscordConfig()
    c.reactionRoleMessageId = msg.id
    saveDiscordConfig(c)
    console.log(`[Discord] Reaction role message posted in #${channel.name}`)
  } catch (err) {
    console.error('[Discord] Failed to sync reaction roles on startup:', err)
  }
}

// ─── Sync ticket panel on startup ───────────────────────
async function syncTicketPanelOnStartup(): Promise<void> {
  const cfg = getDiscordConfig()
  if (!cfg.ticketPanelChannelId || !cfg.supportCategoryId) return
  if (!client) return

  const channel = client.channels.cache.get(cfg.ticketPanelChannelId)
  if (!channel || !(channel instanceof TextChannel)) return

  // If we already have a recorded message ID, verify it still exists
  if (cfg.ticketPanelMessageId) {
    try {
      const existing = await channel.messages.fetch(cfg.ticketPanelMessageId)
      if (existing) return
    } catch {
      // Message was deleted — will repost below
    }
  }

  try {
    const msg = await ticketsPostPanel(channel)
    const c = getDiscordConfig()
    c.ticketPanelMessageId = msg.id
    saveDiscordConfig(c)
    discConfig = c
    console.log(`[Discord] Ticket panel posted in #${channel.name}`)
  } catch (err) {
    console.error('[Discord] Failed to sync ticket panel on startup:', err)
  }
}

// ─── Sync deposit info on startup ───────────────────────
async function syncDepositInfoOnStartup(): Promise<void> {
  const cfg = getDiscordConfig()
  if (!cfg.depositSupport) return
  if (!client) return

  const channel = client.channels.cache.get(cfg.depositSupport)
  if (!channel || !(channel instanceof TextChannel)) return

  // Edit existing deposit info if tracked
  if (cfg.depositSupportMessageId) {
    try {
      const existing = await channel.messages.fetch(cfg.depositSupportMessageId)
      const embed = new EmbedBuilder()
        .setTitle('💰 Depositing GC')
        .setColor('#2ecc71')
        .setDescription(
          'Withdraw your GC from in-game on Complex MC or buy a GC code from Complex\'s website, then use the code on our website.\n\n' +
          '**Steps:**\n' +
          '1. Withdraw GC from in-game on Complex MC or purchase a GC code from Complex\'s website\n' +
          '2. Visit the GCPoker website\n' +
          '3. Go to the cashier section\n' +
          '4. Enter your gift card code\n\n' +
          'Need further help? Click the button below to create a support ticket.'
        )
        .setFooter({ text: 'GCPoker' })
      const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          new ButtonBuilder().setCustomId('ticket:create').setLabel('Create Ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary),
        )
      await existing.edit({ embeds: [embed], components: [row] })
      return
    } catch { /* message deleted — clean up old and repost */ }
  }

  // Clean up old untracked deposit messages from the bot
  try {
    const old = await channel.messages.fetch({ limit: 10 })
    for (const [, msg] of old) {
      if (msg.author.id === client!.user!.id && msg.embeds.length > 0 && msg.embeds[0].title?.includes('Depositing')) {
        await msg.delete().catch(() => {})
      }
    }
  } catch { /* ignore */ }

  await postDepositInfoToChannel(cfg.depositSupport)
}

// ─── Sync transaction history on startup ────────────────
async function syncTransactionHistoryOnStartup(): Promise<void> {
  const cfg = getDiscordConfig()
  if (!cfg.transactionHistoryChannelId) return
  if (!client) return

  const channel = client.channels.cache.get(cfg.transactionHistoryChannelId)
  if (!channel || !(channel instanceof TextChannel)) return

  // If we already have a recorded message ID, verify it still exists
  if (cfg.transactionHistoryMessageId) {
    try {
      const existing = await channel.messages.fetch(cfg.transactionHistoryMessageId)
      if (existing) return
    } catch {
      // Message was deleted — will repost below
    }
  }

  await postTransactionHistoryToChannel(cfg.transactionHistoryChannelId)
}

// ─── Post verify info embed to a channel ────────────────
async function postVerifyInfoToChannel(channelId: string): Promise<void> {
  if (!channelId || !client) return
  const channel = client.channels.cache.get(channelId)
  if (!channel || !(channel instanceof TextChannel)) return

  const embed = new EmbedBuilder()
    .setTitle('✅ Verify Your Account')
    .setColor('#2ecc71')
    .setDescription(
      'Use the `/link` command in any channel to get a one-time code, then enter it on the GCPoker website to link your Discord account.\n\n' +
      '**Why link?**\n' +
      '• Get the **Verified** role\n' +
      '• Your in-game chat messages are relayed to Discord game channels\n' +
      '• Staff can identify you across platforms\n\n' +
      '**Steps:**\n' +
      '1. Run `/link` in any text channel\n' +
      '2. Copy the 6-character code\n' +
      '3. Visit the GCPoker website and enter the code\n' +
      '4. You\'ll automatically receive the Verified role!'
    )
    .setFooter({ text: 'GCPoker' })

  const cfg = getDiscordConfig()
  if (cfg.verifyMessageId) {
    try {
      const existing = await channel.messages.fetch(cfg.verifyMessageId)
      await existing.edit({ embeds: [embed] })
      return
    } catch { /* message deleted — send new below */ }
  }

  try {
    const msg = await channel.send({ embeds: [embed] })
    const c = getDiscordConfig()
    c.verifyMessageId = msg.id
    saveDiscordConfig(c)
    discConfig = c
    console.log(`[Discord] Verify info posted in #${channel.name}`)
  } catch (err) {
    console.error('[Discord] Failed to post verify info:', err)
  }
}

// ─── Post confirm deletion info embed to a channel ────
async function postConfirmDeletionInfoToChannel(channelId: string): Promise<void> {
  if (!channelId || !client) return
  const channel = client.channels.cache.get(channelId)
  if (!channel || !(channel instanceof TextChannel)) return

  const embed = new EmbedBuilder()
    .setTitle('⚠️ Account Deletion')
    .setColor('#e74c3c')
    .setDescription(
      'To permanently delete your GCPoker account, use the `/confirmdeletion` command to get a one-time code.\n\n' +
      '**⚠️ This action is irreversible!**\n' +
      '• Any remaining balance will be forfeited\n' +
      '• Your account and all data will be permanently deleted\n' +
      '• This cannot be undone\n\n' +
      '**Steps:**\n' +
      '1. Run `/confirmdeletion` in any text channel\n' +
      '2. Copy the 6-character code\n' +
      '3. Enter it on the GCPoker website to confirm\n' +
      '4. Your account will be permanently deleted'
    )
    .setFooter({ text: 'GCPoker' })

  const cfg = getDiscordConfig()
  if (cfg.confirmDeletionMessageId) {
    try {
      const existing = await channel.messages.fetch(cfg.confirmDeletionMessageId)
      await existing.edit({ embeds: [embed] })
      return
    } catch { /* message deleted — send new below */ }
  }

  try {
    const msg = await channel.send({ embeds: [embed] })
    const c = getDiscordConfig()
    c.confirmDeletionMessageId = msg.id
    saveDiscordConfig(c)
    discConfig = c
    console.log(`[Discord] Confirm deletion info posted in #${channel.name}`)
  } catch (err) {
    console.error('[Discord] Failed to post confirm deletion info:', err)
  }
}

// ─── Sync verify info on startup ───────────────────────
async function syncVerifyInfoOnStartup(): Promise<void> {
  const cfg = getDiscordConfig()
  if (!cfg.verifyChannelId) return
  if (!client) return

  const channel = client.channels.cache.get(cfg.verifyChannelId)
  if (!channel || !(channel instanceof TextChannel)) return

  if (cfg.verifyMessageId) {
    try {
      const existing = await channel.messages.fetch(cfg.verifyMessageId)
      if (existing) return
    } catch {
      // Message was deleted — will repost below
    }
  }

  await postVerifyInfoToChannel(cfg.verifyChannelId)
}

// ─── Sync confirm deletion info on startup ─────────────
async function syncConfirmDeletionInfoOnStartup(): Promise<void> {
  const cfg = getDiscordConfig()
  if (!cfg.confirmDeletionChannelId) return
  if (!client) return

  const channel = client.channels.cache.get(cfg.confirmDeletionChannelId)
  if (!channel || !(channel instanceof TextChannel)) return

  if (cfg.confirmDeletionMessageId) {
    try {
      const existing = await channel.messages.fetch(cfg.confirmDeletionMessageId)
      if (existing) return
    } catch {
      // Message was deleted — will repost below
    }
  }

  await postConfirmDeletionInfoToChannel(cfg.confirmDeletionChannelId)
}

// ─── Post FAQ embed to a channel ────────────────────────
async function postFAQToChannel(channelId: string): Promise<void> {
  if (!channelId || !client) return
  const channel = client.channels.cache.get(channelId)
  if (!channel || !(channel instanceof TextChannel)) return

  const cfg = getDiscordConfig()
  const embed = new EmbedBuilder()
    .setTitle('❓ Frequently Asked Questions')
    .setColor('#3498db')
    .setDescription(
      '**Q: How do I play poker?**\n' +
      'Create or join a table in the lobby. Each player is dealt two cards, and you bet, fold, or raise to win the pot.\n\n' +
      '**Q: How do I deposit GC?**\n' +
      'Visit the cashier section on the website to deposit using a GC code purchased from Complex MC.\n\n' +
      '**Q: How do I withdraw GC?**\n' +
      'Use the cashier section on the website to request a withdrawal. If approved, you\'ll receive a GC code that can be redeemed in-game on Complex MC.\n\n' +
      '**Q: How do tournaments work?**\n' +
      'Tournaments have a set buy-in and start at a scheduled time. All players start with the same chip count and play until one player wins.\n\n' +
      '**Q: How do I link my Discord account?**\n' +
      'You can link your Discord during account creation, or anytime afterwards in your **Profile** section on the website. You can also run `/link` in any text channel to get a one-time code.\n\n' +
      '**Q: I lost my password / can\'t log in**\n' +
      `Create a support ticket in ${cfg.ticketPanelChannelId ? `<#${cfg.ticketPanelChannelId}>` : 'the support channel'} to get help from staff.\n\n` +
      '**Q: How do I delete my account?**\n' +
      'First, click the **Delete Account** button in your **Profile** section on the website, then run `/confirmdeletion` in any text channel and enter the code that appears to confirm. **This is permanent and cannot be undone.**'
    )
    .setFooter({ text: 'GCPoker' })

  if (cfg.faqMessageId) {
    try {
      const existing = await channel.messages.fetch(cfg.faqMessageId)
      await existing.edit({ embeds: [embed] })
      return
    } catch { /* message deleted — send new below */ }
  }

  try {
    const msg = await channel.send({ embeds: [embed] })
    const c = getDiscordConfig()
    c.faqMessageId = msg.id
    saveDiscordConfig(c)
    discConfig = c
    console.log(`[Discord] FAQ posted in #${channel.name}`)
  } catch (err) {
    console.error('[Discord] Failed to post FAQ:', err)
  }
}

// ─── Sync FAQ on startup ────────────────────────────────
async function syncFAQOnStartup(): Promise<void> {
  const cfg = getDiscordConfig()
  if (!cfg.faqChannelId) return
  if (!client) return

  const channel = client.channels.cache.get(cfg.faqChannelId)
  if (!channel || !(channel instanceof TextChannel)) return

  if (cfg.faqMessageId) {
    try {
      const existing = await channel.messages.fetch(cfg.faqMessageId)
      if (existing) return
    } catch {
      // Message was deleted — will repost below
    }
  }

  await postFAQToChannel(cfg.faqChannelId)
}

// ─── Post how-to-play embed to a channel ─────────────────
async function postHowToPlayToChannel(channelId: string): Promise<void> {
  if (!channelId || !client) return
  const channel = client.channels.cache.get(channelId)
  if (!channel || !(channel instanceof TextChannel)) return

  const embed = new EmbedBuilder()
    .setTitle('🃏 How to Play Poker')
    .setColor('#2ecc71')
    .setDescription(
      'Welcome to GCPoker! Here\'s everything you need to know to get started.\n\n' +
      '**━━━━━━━━━━━━━━━━━━━━━━━━**\n' +
      '**🌐 Getting Started on GCPoker**\n' +
      '• **Visit the website** — Open your browser and go to the GCPoker website (ask staff for the link).\n' +
      '• **Create an account** — Sign up with a username and password. You can link your Discord during registration or later in your Profile.\n' +
      '• **Deposit GC** — Go to the **Cashier** section and use a GC code purchased from Complex MC to add chips to your account.\n' +
      '• **Join a game** — Browse the **Lobby** for open tables or tournaments and start playing!\n\n' +
      '**━━━━━━━━━━━━━━━━━━━━━━━━**\n' +
      '**📋 The Basics**\n' +
      'Poker is a card game where players bet on who has the best hand. The game we use is **Texas Hold\'em** — each player gets 2 private cards and shares 5 community cards.\n\n' +
      '**━━━━━━━━━━━━━━━━━━━━━━━━**\n' +
      '**🎯 Gameplay Flow**\n' +
      '1. **Create or Join** — Browse the lobby for open tables or create your own with your preferred buy-in and player count.\n' +
      '2. **Blinds** — Two players post the small blind and big blind to start the action.\n' +
      '3. **Hole Cards** — Each player receives 2 private cards (hole cards).\n' +
      '4. **Betting Rounds** — There are 4 rounds of betting (see below).\n' +
      '5. **Showdown** — Remaining players reveal their hands; the best hand wins the pot.\n\n' +
      '**━━━━━━━━━━━━━━━━━━━━━━━━**\n' +
      '**🔄 Betting Rounds**\n' +
      '• **Pre-Flop** — After everyone receives their 2 hole cards, betting starts left of the big blind.\n' +
      '• **Flop** — 3 community cards are dealt face-up. Another betting round.\n' +
      '• **Turn** — A 4th community card is dealt. Another betting round.\n' +
      '• **River** — The 5th and final community card is dealt. Final betting round.\n\n' +
      '**━━━━━━━━━━━━━━━━━━━━━━━━**\n' +
      '**🎮 Actions You Can Take**\n' +
      '• **Check** — Pass the action to the next player (only if no bet has been made).\n' +
      '• **Bet** — Place the first wager in the round.\n' +
      '• **Call** — Match the current bet to stay in the hand.\n' +
      '• **Raise** — Increase the current bet.\n' +
      '• **Fold** — Give up your hand and lose any chips already bet.\n' +
      '• **All-In** — Bet all your remaining chips.\n\n' +
      '**━━━━━━━━━━━━━━━━━━━━━━━━**\n' +
      '**🃏 Hand Rankings (highest to lowest)**\n' +
      '1. 🏆 **Royal Flush** — A, K, Q, J, 10 all same suit\n' +
      '2. ♠️ **Straight Flush** — 5 consecutive cards same suit\n' +
      '3. 🔢 **Four of a Kind** — 4 cards of same rank\n' +
      '4. 🏠 **Full House** — 3 of a kind + a pair\n' +
      '5. 🌊 **Flush** — 5 cards same suit (not consecutive)\n' +
      '6. 📏 **Straight** — 5 consecutive cards (mixed suits)\n' +
      '7. 👌 **Three of a Kind** — 3 cards of same rank\n' +
      '8. 🥈 **Two Pair** — 2 different pairs\n' +
      '9. 👆 **One Pair** — 2 cards of same rank\n' +
      '10. 📄 **High Card** — Highest card wins if no one has a pair\n\n' +
      '**━━━━━━━━━━━━━━━━━━━━━━━━**\n' +
      '**💰 Chip Management**\n' +
      '• Your chip stack is displayed at all times. You can only bet what you have.\n' +
      '• When you run out of chips, you\'re eliminated from the game.\n' +
      '• In tournaments, blinds increase over time to force action.\n\n' +
      '**━━━━━━━━━━━━━━━━━━━━━━━━**\n' +
      '**🏟️ Games vs Tournaments**\n' +
      '• **Cash Games** — Buy in for a set amount, play as long as you want, leave anytime.\n' +
      '• **Tournaments** — Fixed buy-in, scheduled start, everyone plays until one winner remains. Prizes are awarded to top finishers.\n\n' +
      '**━━━━━━━━━━━━━━━━━━━━━━━━**\n' +
      '**💡 Tips for Beginners**\n' +
      '• Play tight early — only play strong hands like high pairs or high cards.\n' +
      '• Pay attention to position — acting later gives you more information.\n' +
      '• Don\'t bluff too much — beginners tend to bluff too often.\n' +
      '• Watch the community cards — the best hand can change on every card.\n' +
      '• Manage your bankroll — don\'t play above your limit.\n\n' +
      'Good luck and have fun! 🍀'
    )
    .setFooter({ text: 'GCPoker' })

  const cfg = getDiscordConfig()
  if (cfg.howToPlayMessageId) {
    try {
      const existing = await channel.messages.fetch(cfg.howToPlayMessageId)
      await existing.edit({ embeds: [embed] })
      return
    } catch { /* message deleted — send new below */ }
  }

  try {
    const msg = await channel.send({ embeds: [embed] })
    const c = getDiscordConfig()
    c.howToPlayMessageId = msg.id
    saveDiscordConfig(c)
    discConfig = c
    console.log(`[Discord] How-to-play guide posted in #${channel.name}`)
  } catch (err) {
    console.error('[Discord] Failed to post how-to-play guide:', err)
  }
}

// ─── Sync how-to-play on startup ─────────────────────────
async function syncHowToPlayOnStartup(): Promise<void> {
  const cfg = getDiscordConfig()
  if (!cfg.howToPlayChannelId) return
  if (!client) return

  const channel = client.channels.cache.get(cfg.howToPlayChannelId)
  if (!channel || !(channel instanceof TextChannel)) return

  if (cfg.howToPlayMessageId) {
    try {
      const existing = await channel.messages.fetch(cfg.howToPlayMessageId)
      if (existing) return
    } catch {
      // Message was deleted — will repost below
    }
  }

  await postHowToPlayToChannel(cfg.howToPlayChannelId)
}

// ─── Post rules embed to a channel ───────────────────────
async function postRulesToChannel(channelId: string): Promise<void> {
  if (!channelId || !client) return
  const channel = client.channels.cache.get(channelId)
  if (!channel || !(channel instanceof TextChannel)) return

  const embed = new EmbedBuilder()
    .setTitle('📜 GCPoker Rules')
    .setColor('#e74c3c')
    .setDescription(
      'Please read and follow these rules at all times. Violations may result in warnings, mutes, or bans.\n\n' +
      '**━━━━━━━━━━━━━━━━━━━━━━━━**\n' +
      '**🤝 Discord Server Rules**\n' +
      '1. **Be respectful** — Treat all members with respect. Harassment, hate speech, discrimination, or toxicity will not be tolerated.\n' +
      '2. **No spam** — Do not spam messages, emojis, or mentions. Keep conversations on-topic in each channel.\n' +
      '3. **No advertising** — Do not promote other Discord servers, websites, or services without staff permission.\n' +
      '4. **No NSFW content** — Keep all messages, images, and media appropriate for all ages.\n' +
      '5. **No threatening or encouraging violence** — This includes self-harm, harm to others, or doxxing.\n' +
      '6. **Follow staff instructions** — Server moderators and administrators have the final say. Arguing with staff publicly may result in additional action.\n' +
      '7. **Use channels appropriately** — Post content in the correct channels. Check channel descriptions before posting.\n' +
      '8. **No ban evasion** — Creating alternate accounts to bypass a ban will result in an immediate permanent ban.\n' +
      '9. **No account sharing** — Sharing your Discord or GCPoker account with others is prohibited.\n' +
      '10. **Use common sense** — If you\'re unsure whether something is allowed, ask a staff member.\n\n' +
      '**━━━━━━━━━━━━━━━━━━━━━━━━**\n' +
      '**🃏 Game Rules**\n' +
      '1. **No collusion** — Do not team up with other players to gain an unfair advantage. This includes sharing hole card information.\n' +
      '2. **No chip dumping** — Intentionally losing chips to another player is strictly forbidden.\n' +
      '3. **One account per player** — Multiple accounts are not permitted. All accounts found to be operated by the same person will be banned.\n' +
      '4. **No abusing bugs** — If you discover a bug, report it to staff immediately. Exploiting bugs will result in a permanent ban and forfeiture of all chips.\n' +
      '5. **No third-party tools** — Using bots, scripts, or any automated tools that interact with the game is prohibited.\n' +
      '6. **Fair play** — Play your own hands. Any form of assistance from other players or external sources during a hand is not allowed.\n' +
      '7. **Timeout policy** — Players who repeatedly go afk or stall games may be timed out or removed from tables.\n' +
      '8. **Decisions are final** — Staff decisions regarding disputes are final. Further disputes should be handled via support tickets.\n\n' +
      '**━━━━━━━━━━━━━━━━━━━━━━━━**\n' +
      '**⚠️ Consequences**\n' +
      '• **First offense** — Verbal warning\n' +
      '• **Second offense** — 24-hour mute / suspension\n' +
      '• **Third offense** — 7-day suspension\n' +
      '• **Severe offenses** — Permanent ban (at staff discretion)\n\n' +
      '**📋 Reporting Violations**\n' +
      'To report a rule violation, create a support ticket and a staff member will review the situation.'
    )
    .setFooter({ text: 'GCPoker — Rules last updated' })
    .setTimestamp()

  const cfg = getDiscordConfig()
  if (cfg.rulesMessageId) {
    try {
      const existing = await channel.messages.fetch(cfg.rulesMessageId)
      await existing.edit({ embeds: [embed] })
      return
    } catch { /* message deleted — send new below */ }
  }

  try {
    const msg = await channel.send({ embeds: [embed] })
    const c = getDiscordConfig()
    c.rulesMessageId = msg.id
    saveDiscordConfig(c)
    discConfig = c
    console.log(`[Discord] Rules posted in #${channel.name}`)
  } catch (err) {
    console.error('[Discord] Failed to post rules:', err)
  }
}

// ─── Sync rules on startup ───────────────────────────────
async function syncRulesOnStartup(): Promise<void> {
  const cfg = getDiscordConfig()
  if (!cfg.rulesChannelId) return
  if (!client) return

  const channel = client.channels.cache.get(cfg.rulesChannelId)
  if (!channel || !(channel instanceof TextChannel)) return

  if (cfg.rulesMessageId) {
    try {
      const existing = await channel.messages.fetch(cfg.rulesMessageId)
      if (existing) return
    } catch {
      // Message was deleted — will repost below
    }
  }

  await postRulesToChannel(cfg.rulesChannelId)
}

// ─── Remove guest role from any linked members on startup ──
async function removeGuestRoleFromLinked(guild: any, linkedDiscordIds?: string[]): Promise<void> {
  if (!linkedDiscordIds || linkedDiscordIds.length === 0) return
  const cfg = getDiscordConfig()
  if (!cfg.guestRoleId) return

  let removed = 0
  for (const discordId of linkedDiscordIds) {
    try {
      const member = await guild.members.fetch(discordId)
      const memberRoleIds: string[] = member._roles ?? []
      if (memberRoleIds.includes(cfg.guestRoleId)) {
        await member.roles.remove(cfg.guestRoleId)
        removed++
      }
    } catch { /* member not in guild or fetch failed */ }
  }
  if (removed > 0) {
    console.log(`[Discord] Removed Guest role from ${removed} linked member(s)`)
  }
}

// ─── Build config embed buttons ──────────────────────────
function buildConfigButtons(): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder().setCustomId('cfg:channels').setLabel('Channels').setEmoji('📁').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:roles').setLabel('Roles').setEmoji('🎭').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:category').setLabel('Categories').setEmoji('📌').setStyle(ButtonStyle.Secondary),
    )

  const row2 = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder().setCustomId('cfg:addrr').setLabel('Add RR').setEmoji('➕').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('cfg:removerr').setLabel('Remove RR').setEmoji('❌').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('cfg:postrr').setLabel('Post RR').setEmoji('📨').setStyle(ButtonStyle.Primary),
    )

  const row3 = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder().setCustomId('cfg:staffadd').setLabel('Add Staff').setEmoji('🎫').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('cfg:staffremove').setLabel('Remove Staff').setEmoji('🚫').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('cfg:ticketpanel').setLabel('Post Panel').setEmoji('📋').setStyle(ButtonStyle.Primary),
    )

  const row4 = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder().setCustomId('cfg:refresh').setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    )

  return [row1, row2, row3, row4]
}

// ─── Admin check for component interactions ────────────
async function isConfigAdmin(interaction: any): Promise<boolean> {
  if (interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) return true
  try {
    const member = await interaction.guild?.members.fetch(interaction.user.id)
    return member?.permissions.has(PermissionsBitField.Flags.Administrator) ?? false
  } catch {
    return false
  }
}

// ─── Post reaction roles to a channel ───────────────────
async function postReactionRolesToChannel(channelId: string): Promise<void> {
  const cfg = getDiscordConfig()
  if (!channelId || cfg.reactionRoles.length === 0 || cfg.reactionRoles.every(r => !r.roleId)) return
  if (!client) return

  const channel = client.channels.cache.get(channelId)
  if (!channel || !(channel instanceof TextChannel)) return

  const descLines = cfg.reactionRoles
    .filter(r => r.roleId)
    .map(r => `${r.emoji} — <@&${r.roleId}> — ${r.label}`)
  const embed = new EmbedBuilder()
    .setTitle('🎯 React for Roles')
    .setColor('#9b59b6')
    .setDescription(`React to this message to get notified about specific events!\n\n${descLines.join('\n')}\n\n*Remove your reaction to opt out.*`)
    .setFooter({ text: 'GCPoker' })

  try {
    const msg = await channel.send({ embeds: [embed] })
    for (const rr of cfg.reactionRoles) {
      if (!rr.roleId) continue
      try { await msg.react(rr.emoji) } catch { /* skip */ }
    }
    const c = getDiscordConfig()
    c.reactionRoleMessageId = msg.id
    saveDiscordConfig(c)
    discConfig = c
    console.log(`[Discord] Reaction role message posted in #${channel.name}`)
  } catch (err) {
    console.error('[Discord] Failed to post reaction roles:', err)
  }
}

// ─── Post ticket panel to a channel ─────────────────────
async function postTicketPanelToChannel(channelId: string): Promise<void> {
  const cfg = getDiscordConfig()
  if (!channelId || !cfg.supportCategoryId) return
  if (!client) return

  const channel = client.channels.cache.get(channelId)
  if (!channel || !(channel instanceof TextChannel)) return

  try {
    // Edit existing panel if tracked
    if (cfg.ticketPanelMessageId) {
      try {
        const existing = await channel.messages.fetch(cfg.ticketPanelMessageId)
        const panelEmbed = new EmbedBuilder()
          .setTitle('🎫 Create a Support Ticket')
          .setColor('#9b59b6')
          .setDescription('Click the button below to create a support ticket. A private channel will be created where you can discuss with our staff team.')
          .setFooter({ text: 'GCPoker Support' })
        const panelRow = new ActionRowBuilder<ButtonBuilder>()
          .addComponents(
            new ButtonBuilder().setCustomId('ticket:create').setLabel('Create Ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary),
          )
        await existing.edit({ embeds: [panelEmbed], components: [panelRow] })
        return
      } catch { /* message deleted — send new below */ }
    }
    const msg = await ticketsPostPanel(channel)
    const c = getDiscordConfig()
    c.ticketPanelMessageId = msg.id
    saveDiscordConfig(c)
    discConfig = c
    console.log(`[Discord] Ticket panel posted in #${channel.name}`)
  } catch (err) {
    console.error('[Discord] Failed to post ticket panel:', err)
  }
}

// ─── Post deposit info embed to a channel ───────────────
async function postDepositInfoToChannel(channelId: string): Promise<void> {
  if (!channelId || !client) return
  const channel = client.channels.cache.get(channelId)
  if (!channel || !(channel instanceof TextChannel)) return

  const embed = new EmbedBuilder()
    .setTitle('💰 Depositing GC')
    .setColor('#2ecc71')
    .setDescription(
      'Withdraw your GC from in-game on Complex MC or buy a GC code from Complex\'s website, then use the code on our website.\n\n' +
      '**Steps:**\n' +
      '1. Withdraw GC from in-game on Complex MC or purchase a GC code from Complex\'s website\n' +
      '2. Visit the GCPoker website\n' +
      '3. Go to the cashier section\n' +
      '4. Enter your gift card code\n\n' +
      'Need further help? Click the button below to create a support ticket.'
    )
    .setFooter({ text: 'GCPoker' })

  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder().setCustomId('ticket:create').setLabel('Create Ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary),
    )

  try {
    const msg = await channel.send({ embeds: [embed], components: [row] })
    const c = getDiscordConfig()
    c.depositSupportMessageId = msg.id
    saveDiscordConfig(c)
    discConfig = c
    console.log(`[Discord] Deposit info posted in #${channel.name}`)
  } catch (err) {
    console.error('[Discord] Failed to post deposit info:', err)
  }
}

// ─── Post transaction history panel to a channel ────────
async function postTransactionHistoryToChannel(channelId: string): Promise<void> {
  if (!channelId || !client) return
  const channel = client.channels.cache.get(channelId)
  if (!channel || !(channel instanceof TextChannel)) return

  const embed = new EmbedBuilder()
    .setTitle('📊 Transaction History')
    .setColor('#3498db')
    .setDescription('Click the button below to view your last 10 transactions.\n\nYour Discord account must be linked to your GCPoker account.')
    .setFooter({ text: 'GCPoker' })

  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder().setCustomId('tx:view').setLabel('View My Transactions').setEmoji('📊').setStyle(ButtonStyle.Primary),
    )

  const cfg = getDiscordConfig()
  if (cfg.transactionHistoryMessageId) {
    try {
      const existing = await channel.messages.fetch(cfg.transactionHistoryMessageId)
      await existing.edit({ embeds: [embed], components: [row] })
      return
    } catch { /* message deleted — send new below */ }
  }

  try {
    const msg = await channel.send({ embeds: [embed], components: [row] })
    const c = getDiscordConfig()
    c.transactionHistoryMessageId = msg.id
    saveDiscordConfig(c)
    discConfig = c
    console.log(`[Discord] Transaction history panel posted in #${channel.name}`)
  } catch (err) {
    console.error('[Discord] Failed to post transaction history panel:', err)
  }
}

// ─── Handle transaction history button ──────────────────
async function handleTxHistoryButton(interaction: any): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  try {
    const dataDir = resolve(__dirname, '..', '..', '..', 'packages', 'server', 'data')
    const usersPath = resolve(dataDir, 'users.json')
    const txPath = resolve(dataDir, 'transactions.json')

    let users: any[] = []
    let transactions: any[] = []
    if (existsSync(usersPath)) users = JSON.parse(readFileSync(usersPath, 'utf-8'))
    if (existsSync(txPath)) transactions = JSON.parse(readFileSync(txPath, 'utf-8'))

    const discordId = interaction.user.id
    const user = users.find((u: any) => u.discordId === discordId)
    if (!user) {
      await interaction.editReply({ content: '❌ Your Discord account is not linked to a GCPoker account. Use `/link` to link it.' })
      return
    }

    const userTxs = transactions
      .filter((tx: any) => tx.userId === user.id)
      .sort((a: any, b: any) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, 10)

    if (userTxs.length === 0) {
      await interaction.editReply({ content: '📊 No transactions found for your account.' })
      return
    }

    const lines = userTxs.map((tx: any) => {
      const type = tx.type === 'deposit' ? '💰 Deposit' : tx.type === 'withdrawal' ? '🏦 Withdrawal' : tx.type
      const status = tx.status === 'completed' ? '✅' : tx.status === 'failed' ? '❌' : '⏳'
      const date = tx.createdAt ? new Date(tx.createdAt).toLocaleDateString() : '?'
      return `${status} **${type}** — ${tx.amount ?? 0} GC — ${date}`
    }).join('\n')

    const embed = new EmbedBuilder()
      .setTitle(`📊 Last ${userTxs.length} Transactions — ${user.name ?? user.username}`)
      .setColor('#3498db')
      .setDescription(lines)
      .setTimestamp()

    await interaction.editReply({ embeds: [embed] })
  } catch (err) {
    console.error('[Discord] Tx history error:', err)
    await interaction.editReply({ content: '❌ Failed to load transaction history. Contact staff.' }).catch(() => {})
  }
}

// ─── Handle config embed button clicks ─────────────────
async function handleConfigButton(interaction: any): Promise<void> {
  if (!await isConfigAdmin(interaction)) {
    await interaction.reply({ content: '❌ You need Administrator permission.', ephemeral: true })
    return
  }

  const customId = interaction.customId

  if (customId === 'cfg:channels') {
    const select = new StringSelectMenuBuilder()
      .setCustomId('cfg:sel_chan_type')
      .setPlaceholder('Select a channel type to set...')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Lobby — hub overview').setValue('lobby').setEmoji('🎰'),
        new StringSelectMenuOptionBuilder().setLabel('Live Tables — game lifecycle').setValue('createTable').setEmoji('🆕'),
        new StringSelectMenuOptionBuilder().setLabel('Tournaments — tournament lifecycle').setValue('tournaments').setEmoji('🏟️'),
        new StringSelectMenuOptionBuilder().setLabel('High Stakes — big buy-in events').setValue('highStakes').setEmoji('🔥'),
        new StringSelectMenuOptionBuilder().setLabel('Bad Beats — bad beat hands').setValue('badBeats').setEmoji('💀'),
        new StringSelectMenuOptionBuilder().setLabel('Deposit Support — deposit instructions').setValue('depositSupport').setEmoji('💰'),
        new StringSelectMenuOptionBuilder().setLabel('General — general chat').setValue('general').setEmoji('💬'),
        new StringSelectMenuOptionBuilder().setLabel('Tx History — view transactions').setValue('transactionHistory').setEmoji('📊'),
        new StringSelectMenuOptionBuilder().setLabel('Tx Log — staff transaction log').setValue('transactionLog').setEmoji('📋'),
        new StringSelectMenuOptionBuilder().setLabel('Verify — link / verify instructions').setValue('verify').setEmoji('✅'),
        new StringSelectMenuOptionBuilder().setLabel('Confirm Deletion — account deletion').setValue('confirmDeletion').setEmoji('⚠️'),
        new StringSelectMenuOptionBuilder().setLabel('FAQ — frequently asked questions').setValue('faq').setEmoji('❓'),
        new StringSelectMenuOptionBuilder().setLabel('How to Play — poker guide').setValue('howToPlay').setEmoji('🃏'),
        new StringSelectMenuOptionBuilder().setLabel('Suggestions — suggestion panel').setValue('suggestions').setEmoji('💡'),
        new StringSelectMenuOptionBuilder().setLabel('Suggestion Tracker — staff log').setValue('suggestionsTracker').setEmoji('📋'),
        new StringSelectMenuOptionBuilder().setLabel('Command Log — command usage').setValue('commandLog').setEmoji('📝'),
        new StringSelectMenuOptionBuilder().setLabel('Rules — server and game rules').setValue('rules').setEmoji('📜'),
        new StringSelectMenuOptionBuilder().setLabel('React Roles — reaction role message').setValue('reactRoles').setEmoji('🔁'),
        new StringSelectMenuOptionBuilder().setLabel('Ticket Panel — create ticket button').setValue('ticketPanel').setEmoji('📋'),
        new StringSelectMenuOptionBuilder().setLabel('Ticket Log — ticket status log').setValue('ticketLogChannel').setEmoji('📋'),
      )
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
    await interaction.update({ components: [row] })
    return
  }

  if (customId === 'cfg:roles') {
    const select = new StringSelectMenuBuilder()
      .setCustomId('cfg:sel_role_type')
      .setPlaceholder('Select a role type to set...')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Guest Role').setValue('guest').setEmoji('👋'),
        new StringSelectMenuOptionBuilder().setLabel('Verified Role').setValue('verified').setEmoji('✅'),
        new StringSelectMenuOptionBuilder().setLabel('Staff Role (add)').setValue('staff').setEmoji('🎫'),
      )
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
    await interaction.update({ components: [row] })
    return
  }

  if (customId === 'cfg:category') {
    const select = new StringSelectMenuBuilder()
      .setCustomId('cfg:sel_cat_type')
      .setPlaceholder('Select a category type to set...')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Poker Category').setValue('pokerCat').setEmoji('🃏'),
        new StringSelectMenuOptionBuilder().setLabel('Support Category').setValue('supportCat').setEmoji('🎫'),
      )
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
    await interaction.update({ components: [row] })
    return
  }

  if (customId === 'cfg:addrr') {
    const select = new RoleSelectMenuBuilder()
      .setCustomId('cfg:sel_rr_role')
      .setPlaceholder('Select a role for the reaction...')
    const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select)
    await interaction.update({ components: [row] })
    return
  }

  if (customId === 'cfg:removerr') {
    const cfg = getDiscordConfig()
    if (cfg.reactionRoles.length === 0) {
      await interaction.reply({ content: '❌ No reaction roles configured.', ephemeral: true })
      return
    }
    const options = cfg.reactionRoles.map((rr, i) =>
      new StringSelectMenuOptionBuilder().setLabel(rr.label).setValue(String(i)).setEmoji(rr.emoji)
    )
    const select = new StringSelectMenuBuilder()
      .setCustomId('cfg:sel_rr_remove')
      .setPlaceholder('Select a reaction role to remove...')
      .addOptions(...options)
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
    await interaction.update({ components: [row] })
    return
  }

  if (customId === 'cfg:postrr') {
    const cfg = getDiscordConfig()
    if (!cfg.reactRoles) {
      await interaction.reply({ content: '❌ No reactRoles channel set. Set it via the Channels button first.', ephemeral: true })
      return
    }
    if (cfg.reactionRoles.length === 0 || cfg.reactionRoles.every(r => !r.roleId)) {
      await interaction.reply({ content: '❌ No reaction roles configured. Add some via the "Add RR" button first.', ephemeral: true })
      return
    }
    await interaction.deferUpdate()
    await postReactionRolesToChannel(cfg.reactRoles)
    syncConfigEmbed()
    await interaction.followUp({ content: `✅ Reaction roles posted in <#${cfg.reactRoles}>`, ephemeral: true })
    return
  }

  if (customId === 'cfg:staffadd') {
    const select = new RoleSelectMenuBuilder()
      .setCustomId('cfg:sel_staff_add')
      .setPlaceholder('Select a role to add as staff...')
    const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select)
    await interaction.update({ components: [row] })
    return
  }

  if (customId === 'cfg:staffremove') {
    const cfg = getDiscordConfig()
    if (!cfg.staffRoleIds || cfg.staffRoleIds.length === 0) {
      await interaction.reply({ content: '❌ No staff roles configured.', ephemeral: true })
      return
    }
    const options = cfg.staffRoleIds.map((rid: string, i: number) => {
      const role = interaction.guild?.roles.cache.get(rid)
      return new StringSelectMenuOptionBuilder().setLabel(role?.name ?? rid).setValue(String(i))
    })
    const select = new StringSelectMenuBuilder()
      .setCustomId('cfg:sel_staff_remove')
      .setPlaceholder('Select a staff role to remove...')
      .addOptions(...options)
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
    await interaction.update({ components: [row] })
    return
  }

  if (customId === 'cfg:ticketpanel') {
    const cfg = getDiscordConfig()
    if (!cfg.ticketPanelChannelId) {
      await interaction.reply({ content: '❌ No ticket panel channel configured. Set one via the Channels button first.', ephemeral: true })
      return
    }
    await interaction.deferUpdate()
    await postTicketPanelToChannel(cfg.ticketPanelChannelId)
    syncConfigEmbed()
    await interaction.followUp({ content: `✅ Ticket panel posted in <#${cfg.ticketPanelChannelId}>`, ephemeral: true })
    return
  }

  if (customId === 'cfg:refresh') {
    await interaction.deferUpdate()
    syncConfigEmbed()
    await interaction.followUp({ content: '🔄 Configuration embed refreshed.', ephemeral: true })
    return
  }
}

// ─── Handle config embed string select menus ───────────
async function handleConfigStringSelect(interaction: any): Promise<void> {
  if (!await isConfigAdmin(interaction)) {
    await interaction.reply({ content: '❌ You need Administrator permission.', ephemeral: true })
    return
  }

  const customId = interaction.customId
  const value = interaction.values[0]

  if (customId === 'cfg:sel_chan_type') {
    const select = new ChannelSelectMenuBuilder()
      .setCustomId(`cfg:sel_chan_set:${value}`)
      .setPlaceholder('Select a channel...')
    const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select)
    await interaction.update({ components: [row] })
    return
  }

  if (customId === 'cfg:sel_cat_type') {
    const select = new ChannelSelectMenuBuilder()
      .setCustomId(`cfg:sel_cat_set:${value}`)
      .setPlaceholder('Select a category...')
      .setChannelTypes(ChannelType.GuildCategory)
    const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select)
    await interaction.update({ components: [row] })
    return
  }

  if (customId === 'cfg:sel_role_type') {
    const select = new RoleSelectMenuBuilder()
      .setCustomId(`cfg:sel_role_set:${value}`)
      .setPlaceholder('Select a role...')
    const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select)
    await interaction.update({ components: [row] })
    return
  }

  if (customId === 'cfg:sel_rr_remove') {
    const idx = parseInt(value)
    const cfg = getDiscordConfig()
    const embed = buildConfigEmbed()
    const buttons = buildConfigButtons()

    if (idx >= 0 && idx < cfg.reactionRoles.length) {
      const removed = cfg.reactionRoles.splice(idx, 1)[0]
      saveDiscordConfig(cfg)
      discConfig = cfg
      await interaction.update({ embeds: [embed], components: buttons })
      await interaction.followUp({ content: `✅ Removed ${removed.emoji} ${removed.label}`, ephemeral: true })
    } else {
      await interaction.update({ embeds: [embed], components: buttons })
    }
    return
  }

  if (customId === 'cfg:sel_staff_remove') {
    const idx = parseInt(value)
    const cfg = getDiscordConfig()
    const embed = buildConfigEmbed()
    const buttons = buildConfigButtons()

    if (idx >= 0 && idx < cfg.staffRoleIds.length) {
      const removed = cfg.staffRoleIds.splice(idx, 1)[0]
      saveDiscordConfig(cfg)
      discConfig = cfg
      await interaction.update({ embeds: [embed], components: buttons })
      const role = interaction.guild?.roles.cache.get(removed)
      await interaction.followUp({ content: `✅ Removed ${role ? `<@&${removed}>` : `role ${removed}`} from staff.`, ephemeral: true })
    } else {
      await interaction.update({ embeds: [embed], components: buttons })
    }
    return
  }
}

// ─── Handle config embed channel select menus ──────────
async function handleConfigChannelSelect(interaction: any): Promise<void> {
  if (!await isConfigAdmin(interaction)) {
    await interaction.reply({ content: '❌ You need Administrator permission.', ephemeral: true })
    return
  }

  const customId = interaction.customId
  const channel = interaction.channels.first()
  if (!channel) {
    const embed = buildConfigEmbed()
    const buttons = buildConfigButtons()
    await interaction.update({ embeds: [embed], components: buttons })
    return
  }

  if (customId.startsWith('cfg:sel_chan_set:')) {
    const key = customId.split(':')[2]
    const cfg = getDiscordConfig()
    const channelKeyMap: Record<string, keyof DiscordConfig> = {
      lobby: 'lobby', createTable: 'createTable',
      tournaments: 'tournaments', highStakes: 'highStakes', badBeats: 'badBeats',
      depositSupport: 'depositSupport',
      general: 'general', reactRoles: 'reactRoles',
      ticketPanel: 'ticketPanelChannelId', ticketLogChannel: 'ticketLogChannelId',
      transactionHistory: 'transactionHistoryChannelId',
      transactionLog: 'transactionLogChannelId',
      verify: 'verifyChannelId',
      confirmDeletion: 'confirmDeletionChannelId',
      faq: 'faqChannelId',
      howToPlay: 'howToPlayChannelId',
      suggestions: 'suggestionsChannelId',
      suggestionsTracker: 'suggestionsTrackerChannelId',
      commandLog: 'commandLogChannelId',
      rules: 'rulesChannelId',
    }
    const cfgKey = channelKeyMap[key]
    if (cfgKey) {
      (cfg as any)[cfgKey] = channel.id
      saveDiscordConfig(cfg)
      discConfig = cfg
    }
    // Auto-post reaction roles when reactRoles channel is set
    if (key === 'reactRoles' && cfg.reactionRoles.some(r => r.roleId)) {
      await postReactionRolesToChannel(channel.id)
    }
    // Auto-post ticket panel when ticket panel channel is set
    if (key === 'ticketPanel' && cfg.supportCategoryId) {
      await postTicketPanelToChannel(channel.id)
    }
    // Auto-post deposit info embed when deposit support channel is set
    if (key === 'depositSupport') {
      await postDepositInfoToChannel(channel.id)
    }
    // Auto-post transaction history when tx history channel is set
    if (key === 'transactionHistory') {
      await postTransactionHistoryToChannel(channel.id)
    }
    // Auto-post verify info when verify channel is set
    if (key === 'verify') {
      await postVerifyInfoToChannel(channel.id)
    }
    // Auto-post confirm deletion info when confirm deletion channel is set
    if (key === 'confirmDeletion') {
      await postConfirmDeletionInfoToChannel(channel.id)
    }
    // Auto-post FAQ when FAQ channel is set
    if (key === 'faq') {
      await postFAQToChannel(channel.id)
    }
    // Auto-post how to play when how to play channel is set
    if (key === 'howToPlay') {
      await postHowToPlayToChannel(channel.id)
    }
    // Auto-post suggestions panel when suggestions channel is set
    if (key === 'suggestions') {
      const ch = client?.channels.cache.get(channel.id)
      if (ch && ch instanceof TextChannel) {
        const panelMsg = await postSuggestionsPanel(ch)
        const c = getDiscordConfig()
        c.suggestionsPanelMessageId = panelMsg.id
        saveDiscordConfig(c)
        discConfig = c
      }
    }
    // Auto-post rules when rules channel is set
    if (key === 'rules') {
      await postRulesToChannel(channel.id)
    }
    const embed = buildConfigEmbed()
    const buttons = buildConfigButtons()
    await interaction.update({ embeds: [embed], components: buttons })
    return
  }

  if (customId === 'cfg:sel_cat_set') {
    const cfg = getDiscordConfig()
    cfg.pokerCategoryId = channel.id
    saveDiscordConfig(cfg)
    discConfig = cfg
    const embed = buildConfigEmbed()
    const buttons = buildConfigButtons()
    await interaction.update({ embeds: [embed], components: buttons })
    return
  }

  if (customId.startsWith('cfg:sel_cat_set:')) {
    const catType = customId.split(':')[2]
    const cfg = getDiscordConfig()
    if (catType === 'pokerCat') {
      cfg.pokerCategoryId = channel.id
    } else if (catType === 'supportCat') {
      cfg.supportCategoryId = channel.id
    }
    saveDiscordConfig(cfg)
    discConfig = cfg
    const embed = buildConfigEmbed()
    const buttons = buildConfigButtons()
    await interaction.update({ embeds: [embed], components: buttons })
    return
  }
}

// ─── Handle config embed role select menus ─────────────
async function handleConfigRoleSelect(interaction: any): Promise<void> {
  if (!await isConfigAdmin(interaction)) {
    await interaction.reply({ content: '❌ You need Administrator permission.', ephemeral: true })
    return
  }

  const customId = interaction.customId
  const role = interaction.roles.first()
  if (!role) {
    const embed = buildConfigEmbed()
    const buttons = buildConfigButtons()
    await interaction.update({ embeds: [embed], components: buttons })
    return
  }

  if (customId.startsWith('cfg:sel_role_set:')) {
    const key = customId.split(':')[2]
    const cfg = getDiscordConfig()
    if (key === 'guest') {
      cfg.guestRoleId = role.id
    } else if (key === 'verified') {
      cfg.verifiedRoleId = role.id
    } else if (key === 'staff') {
      if (!cfg.staffRoleIds.includes(role.id)) {
        cfg.staffRoleIds.push(role.id)
      }
    }
    saveDiscordConfig(cfg)
    discConfig = cfg
    const embed = buildConfigEmbed()
    const buttons = buildConfigButtons()
    await interaction.update({ embeds: [embed], components: buttons })
    return
  }

  if (customId === 'cfg:sel_staff_add') {
    const cfg = getDiscordConfig()
    if (!cfg.staffRoleIds.includes(role.id)) {
      cfg.staffRoleIds.push(role.id)
      saveDiscordConfig(cfg)
      discConfig = cfg
    }
    const embed = buildConfigEmbed()
    const buttons = buildConfigButtons()
    await interaction.update({ embeds: [embed], components: buttons })
    await interaction.followUp({ content: `✅ Added <@&${role.id}> as staff role.`, ephemeral: true })
    return
  }

  if (customId === 'cfg:sel_rr_role') {
    tempRRRole.set(interaction.user.id, role.id)

    const modal = new ModalBuilder()
      .setCustomId('cfg:modal_rr')
      .setTitle('Add Reaction Role')

    const emojiInput = new TextInputBuilder()
      .setCustomId('rr_emoji')
      .setLabel('Emoji')
      .setPlaceholder('e.g. 📢, 🏆, 🔥')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(10)

    const labelInput = new TextInputBuilder()
      .setCustomId('rr_label')
      .setLabel('Label')
      .setPlaceholder('e.g. Poker Updates, Tournament Ping')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(80)

    const emojiRow = new ActionRowBuilder<TextInputBuilder>().addComponents(emojiInput)
    const labelRow = new ActionRowBuilder<TextInputBuilder>().addComponents(labelInput)
    modal.addComponents(emojiRow, labelRow)

    await interaction.showModal(modal)
    return
  }
}

// ─── Handle config embed modal submissions ─────────────
async function handleConfigModal(interaction: any): Promise<void> {
  if (interaction.customId !== 'cfg:modal_rr') return
  if (!await isConfigAdmin(interaction)) {
    await interaction.reply({ content: '❌ You need Administrator permission.', ephemeral: true })
    return
  }

  const emoji = interaction.fields.getTextInputValue('rr_emoji')
  const label = interaction.fields.getTextInputValue('rr_label')
  const roleId = tempRRRole.get(interaction.user.id)
  tempRRRole.delete(interaction.user.id)

  if (!roleId) {
    await interaction.reply({ content: '❌ No role selected. Please try again from the config embed.', ephemeral: true })
    return
  }

  const cfg = getDiscordConfig()
  const existing = cfg.reactionRoles.findIndex(r => r.emoji === emoji)
  if (existing >= 0) {
    cfg.reactionRoles[existing] = { emoji, roleId, label }
  } else {
    cfg.reactionRoles.push({ emoji, roleId, label })
  }
  saveDiscordConfig(cfg)
  discConfig = cfg

  // Update the config embed
  if (cfg.configChannelId && cfg.configMessageId) {
    const channel = client?.channels.cache.get(cfg.configChannelId)
    if (channel && channel instanceof TextChannel) {
      try {
        const msg = await channel.messages.fetch(cfg.configMessageId)
        const embed = buildConfigEmbed()
        const buttons = buildConfigButtons()
        await msg.edit({ embeds: [embed], components: buttons })
      } catch { /* stale ID - ignore */ }
    }
  }

  await interaction.reply({ content: `✅ Reaction role set: ${emoji} → <@&${roleId}> (${label})`, ephemeral: true })
}

// ─── Lobby hub embed ────────────────────────────────────
function buildLobbyEmbed(gameCount: number, tournamentCount: number, activePlayers: number, prizeToday: number): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('🎰 GCPoker Lobby')
    .setColor('#2ecc71')
    .setDescription('Welcome to GCPoker! Here\'s the current state of the game.')
    .addFields(
      { name: '👥 Active Players', value: `${activePlayers}`, inline: true },
      { name: '🃏 Active Games', value: `${gameCount}`, inline: true },
      { name: '🏟️ Tournaments', value: `${tournamentCount}`, inline: true },
      { name: '💰 Prize Money Today', value: `${prizeToday} GC`, inline: false },
    )
    .setFooter({ text: 'GCPoker' })
    .setTimestamp()
}

// ─── Update or post lobby hub ───────────────────────────
function updateLobbyHub(): void {
  const cfg = getDiscordConfig()
  if (!cfg.lobby) return
  if (!client) return

  const channel = client.channels.cache.get(cfg.lobby)
  if (!channel || !(channel instanceof TextChannel)) return

  const embed = buildLobbyEmbed(lobbyGameCount, lobbyTournamentCount, lobbyActivePlayers, lobbyPrizeToday)

  if (cfg.lobbyMessageId) {
    channel.messages.fetch(cfg.lobbyMessageId).then(msg => {
      msg.edit({ embeds: [embed] }).catch(() => {})
    }).catch(() => {
      // Message deleted — repost
      channel.send({ embeds: [embed] }).then(msg => {
        const c = getDiscordConfig()
        c.lobbyMessageId = msg.id
        saveDiscordConfig(c)
      }).catch(() => {})
    })
  } else {
    channel.send({ embeds: [embed] }).then(msg => {
      const c = getDiscordConfig()
      c.lobbyMessageId = msg.id
      saveDiscordConfig(c)
    }).catch(() => {})
  }
}

// ─── Game message helpers (live-tables channel) ─────────
function postGameMessage(game: any, pingLabel: string | undefined): void {
  const cfg = getDiscordConfig()
  const ch = getChannel(cfg.createTable)
  if (!ch) return

  const ping = pingLabel ? getPingRoleMention(pingLabel) : ''
  const players = game.players?.length ?? game.playerCount ?? 0
  const prizePool = game.prizePool ?? Math.floor(game.buyIn * game.maxPlayers * 0.9)

  const embed = new EmbedBuilder()
    .setTitle(`🆕 ${game.name}`)
    .setColor('#2ecc71')
    .addFields(
      { name: 'Creator', value: game.creatorName ?? 'Unknown', inline: true },
      { name: 'Buy-in', value: `${game.buyIn} GC`, inline: true },
      { name: 'Prize Pool', value: `${prizePool} GC`, inline: true },
      { name: 'Players', value: `${players}/${game.maxPlayers}`, inline: true },
      { name: 'Status', value: '⏳ Waiting', inline: true },
    )
    .setTimestamp()

  ch.send({ content: ping || undefined, embeds: [embed] }).then(msg => {
    gameMessages.set(game.id || game.name, { channelId: ch.id, messageId: msg.id })
  }).catch(() => {})
}

function updateGameMessage(gameId: string, updates: { status?: string; players?: any[]; winnerName?: string }): void {
  const entry = gameMessages.get(gameId)
  if (!entry) return
  const channel = client?.channels.cache.get(entry.channelId)
  if (!channel || !(channel instanceof TextChannel)) {
    gameMessages.delete(gameId)
    return
  }
  channel.messages.fetch(entry.messageId).then(msg => {
    const embed = EmbedBuilder.from(msg.embeds[0])
    if (updates.status) {
      const statusText = updates.status === 'playing' ? '▶️ Playing' : updates.status === 'complete' ? '🏁 Ended' : '⏳ Waiting'
      embed.spliceFields(4, 1, { name: 'Status', value: statusText, inline: true })
    }
    if (updates.players) {
      embed.spliceFields(3, 1, { name: 'Players', value: `${updates.players.length}`, inline: true })
    }
    if (updates.winnerName) {
      embed.setColor('#e74c3c')
      embed.addFields({ name: '🏆 Winner', value: updates.winnerName, inline: false })
    }
    msg.edit({ embeds: [embed] }).catch(() => {})
  }).catch(() => {
    gameMessages.delete(gameId)
  })
}

function deleteGameMessage(gameId: string): void {
  const entry = gameMessages.get(gameId)
  if (!entry) return
  const channel = client?.channels.cache.get(entry.channelId)
  if (channel && channel instanceof TextChannel) {
    channel.messages.fetch(entry.messageId).then(msg => {
      msg.delete().catch(() => {})
    }).catch(() => {})
  }
  gameMessages.delete(gameId)
}

// ─── Tournament message helpers ─────────────────────────
function postTournamentMessage(tournament: any): void {
  const cfg = getDiscordConfig()
  const ch = getChannel(cfg.tournaments)
  if (!ch) return

  const prizePool = tournament.prizePool ?? Math.floor(tournament.buyIn * tournament.maxPlayers * 0.9)
  const ping = getPingRoleMention('Tournament Ping')

  const embed = new EmbedBuilder()
    .setTitle(`🏟️ ${tournament.name}`)
    .setColor('#9b59b6')
    .addFields(
      { name: 'Creator', value: tournament.creatorName ?? 'System', inline: true },
      { name: 'Buy-in', value: `${tournament.buyIn} GC`, inline: true },
      { name: 'Prize Pool', value: `${prizePool} GC`, inline: true },
      { name: 'Players', value: `${tournament.playerCount ?? 0}/${tournament.maxPlayers}`, inline: true },
      { name: 'Status', value: '⏳ Registering', inline: true },
    )
    .setTimestamp()

  ch.send({ content: ping || undefined, embeds: [embed] }).then(msg => {
    tournamentMessages.set(tournament.id, { channelId: ch.id, messageId: msg.id })
  }).catch(() => {})
}

function updateTournamentMessage(tournamentId: string, updates: { status?: string; registrations?: number; maxPlayers?: number; winnerName?: string; prize?: number }): void {
  const entry = tournamentMessages.get(tournamentId)
  if (!entry) return
  const channel = client?.channels.cache.get(entry.channelId)
  if (!channel || !(channel instanceof TextChannel)) {
    tournamentMessages.delete(tournamentId)
    return
  }
  channel.messages.fetch(entry.messageId).then(msg => {
    const embed = EmbedBuilder.from(msg.embeds[0])
    if (updates.status) {
      const statusText = updates.status === 'started' ? '▶️ Playing' : updates.status === 'ended' ? '🏁 Ended' : '⏳ Registering'
      embed.spliceFields(4, 1, { name: 'Status', value: statusText, inline: true })
    }
    if (updates.registrations !== undefined) {
      const max = updates.maxPlayers ?? parseInt(embed.data.fields?.[3]?.value?.split('/')[1] ?? '0')
      embed.spliceFields(3, 1, { name: 'Players', value: `${updates.registrations}/${max}`, inline: true })
    }
    if (updates.winnerName && updates.prize !== undefined) {
      embed.setColor('#f1c40f')
      embed.addFields({ name: '🏆 Champion', value: `${updates.winnerName} — ${updates.prize} GC`, inline: false })
    }
    msg.edit({ embeds: [embed] }).catch(() => {})
  }).catch(() => {
    tournamentMessages.delete(tournamentId)
  })
}

function deleteTournamentMessage(tournamentId: string): void {
  const entry = tournamentMessages.get(tournamentId)
  if (!entry) return
  const channel = client?.channels.cache.get(entry.channelId)
  if (channel && channel instanceof TextChannel) {
    channel.messages.fetch(entry.messageId).then(msg => {
      msg.delete().catch(() => {})
    }).catch(() => {})
  }
  tournamentMessages.delete(tournamentId)
}

// ─── High-stakes helpers ─────────────────────────────────
function isHighStakes(buyIn: number): boolean {
  return buyIn >= 50
}

function postHighStakesMessage(id: string, title: string, description: string, buyIn: number, prizePool: number, playerCount: number, maxPlayers: number): void {
  const cfg = getDiscordConfig()
  const ch = getChannel(cfg.highStakes)
  if (!ch) return

  const ping = getPingRoleMention('High Stakes')

  const embed = new EmbedBuilder()
    .setTitle(`🔥 ${title}`)
    .setColor('#e74c3c')
    .setDescription(description)
    .addFields(
      { name: 'Buy-in', value: `${buyIn} GC`, inline: true },
      { name: 'Prize Pool', value: `${prizePool} GC`, inline: true },
      { name: 'Players', value: `${playerCount}/${maxPlayers}`, inline: true },
    )
    .setTimestamp()

  ch.send({ content: ping || undefined, embeds: [embed] }).then(msg => {
    highStakesMessages.set(id, { channelId: ch.id, messageId: msg.id })
  }).catch(() => {})
}

function deleteHighStakesMessage(id: string): void {
  const entry = highStakesMessages.get(id)
  if (!entry) return
  const channel = client?.channels.cache.get(entry.channelId)
  if (channel && channel instanceof TextChannel) {
    channel.messages.fetch(entry.messageId).then(msg => {
      msg.delete().catch(() => {})
    }).catch(() => {})
  }
  highStakesMessages.delete(id)
}

// ─── Bad beat stream ─────────────────────────────────────
function postBadBeat(hand: any): void {
  const cfg = getDiscordConfig()
  const ch = getChannel(cfg.badBeats)
  if (!ch) return

  const result = analyzeHand(hand)
  if (!result || !result.isBadBeat) return

  const embed = badBeatEmbed(result.description, result.winningHand, result.losingHand ?? '', result.potSize)
  ch.send({ embeds: [embed] }).catch(() => {})
}

// ─── Event listeners with ping roles ─────────────────────
function setupEventListeners(events: EventEmitter): void {
  // ── Games ───────────────────────────────────────────
  events.on('game:created', (game: any) => {
    lobbyGameCount++
    const players = game.players?.length ?? game.playerCount ?? 0
    lobbyActivePlayers += players

    const isHS = isHighStakes(game.buyIn)
    postGameMessage(game, 'Poker Updates')
    if (isHS) {
      const prizePool = game.prizePool ?? Math.floor(game.buyIn * game.maxPlayers * 0.9)
      postHighStakesMessage(
        `game-${game.id}`, game.name,
        `A new high-stakes game has been created by ${game.creatorName ?? 'Unknown'}!`,
        game.buyIn, prizePool, players, game.maxPlayers,
      )
    }
    updateLobbyHub()
  })

  events.on('game:started', (gameId: string, gameName: string) => {
    updateGameMessage(gameId, { status: 'playing' })
    updateLobbyHub()
    createBridgeChannel(gameId, gameName, 'game')
  })

  events.on('game:ended', (game: any) => {
    lobbyGameCount = Math.max(0, lobbyGameCount - 1)
    const players = game.players?.length ?? 0
    lobbyActivePlayers = Math.max(0, lobbyActivePlayers - players)
    const prize = Math.floor(game.buyIn * game.maxPlayers * 0.9)
    lobbyPrizeToday += prize

    const winner = game.players?.find((p: any) => p.finishPosition === 1)
    updateGameMessage(game.id, { status: 'complete', winnerName: winner?.name })
    deleteGameMessage(game.id)
    deleteHighStakesMessage(`game-${game.id}`)
    deleteBridgeChannel(game.id)
    updateLobbyHub()
  })

  events.on('game:cancelled', (gameId: string) => {
    lobbyGameCount = Math.max(0, lobbyGameCount - 1)
    deleteGameMessage(gameId)
    deleteHighStakesMessage(`game-${gameId}`)
    updateLobbyHub()
  })

  // ── Tournaments ──────────────────────────────────────
  events.on('tournament:created', (tournament: any) => {
    lobbyTournamentCount++
    const players = tournament.playerCount ?? 0
    lobbyActivePlayers += players

    postTournamentMessage(tournament)

    if (isHighStakes(tournament.buyIn)) {
      const prizePool = tournament.prizePool ?? Math.floor(tournament.buyIn * tournament.maxPlayers * 0.9)
      postHighStakesMessage(
        `tournament-${tournament.id}`, tournament.name,
        `A new high-stakes tournament has been created by ${tournament.creatorName ?? 'System'}!`,
        tournament.buyIn, prizePool, players, tournament.maxPlayers,
      )
    }
    updateLobbyHub()
  })

  events.on('tournament:started', (tournamentId: string, tournamentName: string) => {
    updateTournamentMessage(tournamentId, { status: 'started' })
    createBridgeChannel(tournamentId, tournamentName, 'tournament')
  })

  events.on('tournament:ended', (state: any) => {
    lobbyTournamentCount = Math.max(0, lobbyTournamentCount - 1)
    const players = state.players?.length ?? 0
    lobbyActivePlayers = Math.max(0, lobbyActivePlayers - players)
    const prize = state.prizes?.[0] ?? 0
    lobbyPrizeToday += prize

    const winner = state.players?.find((p: any) => p.finishPosition === 1)
    updateTournamentMessage(state.id, { status: 'ended', winnerName: winner?.name, prize })
    deleteTournamentMessage(state.id)
    deleteHighStakesMessage(`tournament-${state.id}`)
    deleteBridgeChannel(state.id)
    updateLobbyHub()
  })

  events.on('tournament:register', (_tournamentId: string, _userId: string, _name: string, registrations: number, maxPlayers: number) => {
    updateTournamentMessage(_tournamentId, { registrations, maxPlayers })
  })

  events.on('tournament:cancelled', (tournamentId: string) => {
    lobbyTournamentCount = Math.max(0, lobbyTournamentCount - 1)
    deleteTournamentMessage(tournamentId)
    deleteHighStakesMessage(`tournament-${tournamentId}`)
    updateLobbyHub()
  })

  // ── Hand analysis ────────────────────────────────────
  events.on('hand:complete', (hand: any) => {
    const result = analyzeHand(hand)
    if (!result) return
    if (result.isBadBeat) {
      postBadBeat(hand)
    }
  })

  // ── Chat bridge ────────────────────────────────────────
  events.on('chat:message', (roomId: string, msg: any) => {
    relayChatToDiscord(roomId, msg.playerName, msg.text)
  })

  // ── Cashier / transaction log ────────────────────────────
  events.on('cashier:deposit:complete', (userId: string, amount: number, txId: string) => {
    const cfg = getDiscordConfig()
    const ch = getChannel(cfg.transactionLogChannelId)
    if (!ch) return

    // Look up user name
    const dataDir = resolve(__dirname, '..', '..', '..', 'packages', 'server', 'data')
    const usersPath = resolve(dataDir, 'users.json')
    let userName = userId
    try {
      if (existsSync(usersPath)) {
        const users = JSON.parse(readFileSync(usersPath, 'utf-8'))
        const user = users.find((u: any) => u.id === userId)
        if (user) userName = user.name ?? user.username
      }
    } catch { /* use userId */ }

    const embed = depositCompleteEmbed(userName, amount)
    ch.send({ embeds: [embed] }).catch(() => {})
  })

  events.on('cashier:withdraw:complete', (userId: string, amount: number, gcCode: string | undefined, txId: string) => {
    const cfg = getDiscordConfig()
    const ch = getChannel(cfg.transactionLogChannelId)
    if (!ch) return

    const dataDir = resolve(__dirname, '..', '..', '..', 'packages', 'server', 'data')
    const usersPath = resolve(dataDir, 'users.json')
    let userName = userId
    try {
      if (existsSync(usersPath)) {
        const users = JSON.parse(readFileSync(usersPath, 'utf-8'))
        const user = users.find((u: any) => u.id === userId)
        if (user) userName = user.name ?? user.username
      }
    } catch { /* use userId */ }

    const embed = withdrawalCompleteEmbed(userName, amount, gcCode)
    ch.send({ embeds: [embed] }).catch(() => {})
  })
}

function generateLinkCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return code
}

export function verifyLinkCode(code: string): { discordId: string; discordTag: string } | null {
  const data = linkCodes.get(code)
  if (!data) return null
  if (Date.now() - data.createdAt > LINK_CODE_EXPIRY) {
    linkCodes.delete(code)
    return null
  }
  linkCodes.delete(code)
  return { discordId: data.discordId, discordTag: data.discordTag }
}

export function verifyDeletionCode(code: string): { discordId: string } | null {
  const data = deletionCodes.get(code)
  if (!data) return null
  if (Date.now() - data.createdAt > LINK_CODE_EXPIRY) {
    deletionCodes.delete(code)
    return null
  }
  deletionCodes.delete(code)
  return { discordId: data.discordId }
}

export function isBotReady(): boolean {
  return ready
}

export async function stopBot(): Promise<void> {
  if (client) {
    client.destroy()
    client = null
    ready = false
  }
}

export async function assignVerifiedRole(discordId: string): Promise<void> {
  if (!client || !ready) return
  const cfg = getDiscordConfig()
  if (!cfg.verifiedRoleId) {
    console.warn('[Discord] verifiedRoleId not configured — cannot assign Verified role')
    return
  }
  const guild = client.guilds.cache.first()
  if (!guild) return
  try {
    const member = await guild.members.fetch(discordId)
    await member.roles.add(cfg.verifiedRoleId)
    if (cfg.guestRoleId) {
      await member.roles.remove(cfg.guestRoleId).catch(() => {})
    }
    console.log(`[Discord] Assigned Verified role to ${member.user.tag}`)
  } catch (err) {
    console.error(`[Discord] Failed to assign Verified role to ${discordId}:`, err)
  }
}

export async function syncVerifiedRoles(discordIds: string[]): Promise<void> {
  if (!client || !ready || discordIds.length === 0) return
  const cfg = getDiscordConfig()
  if (!cfg.verifiedRoleId) return

  const guild = client.guilds.cache.first()
  if (!guild) return

  let updated = 0
  for (const discordId of discordIds) {
    try {
      const member = await guild.members.fetch(discordId)
      const hasVerified = member.roles.cache.has(cfg.verifiedRoleId)
      if (!hasVerified) {
        await member.roles.add(cfg.verifiedRoleId)
        if (cfg.guestRoleId) {
          await member.roles.remove(cfg.guestRoleId).catch(() => {})
        }
        updated++
      }
    } catch {
      // Member not in guild or fetch failed — skip
    }
  }
  if (updated > 0) {
    console.log(`[Discord] Synced Verified role for ${updated} existing linked user(s)`)
  }
}

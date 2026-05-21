import { EmbedBuilder, ColorResolvable } from 'discord.js'

export function lobbyUpdateEmbed(tables: number, games: number): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('🎰 Lobby Update')
    .setColor('#3498db' as ColorResolvable)
    .setDescription(`**${tables}** cash tables available\n**${games}** sit & go games active`)
    .setTimestamp()
}

export function gameCreatedEmbed(name: string, creator: string, buyIn: number, maxPlayers: number, prizePool: number): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('🆕 Game Created')
    .setColor('#2ecc71' as ColorResolvable)
    .addFields(
      { name: 'Name', value: name, inline: true },
      { name: 'Creator', value: creator, inline: true },
      { name: 'Buy-in', value: `${buyIn} GC`, inline: true },
      { name: 'Players', value: `0/${maxPlayers}`, inline: true },
      { name: 'Prize Pool', value: `${prizePool} GC`, inline: true },
    )
    .setTimestamp()
}

export function gameStartedEmbed(name: string, players: number, buyIn: number): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('▶️ Game Started')
    .setColor('#f39c12' as ColorResolvable)
    .setDescription(`**${name}** has started with **${players}** players!`)
    .addFields(
      { name: 'Buy-in', value: `${buyIn} GC`, inline: true },
      { name: 'Players', value: `${players}`, inline: true },
    )
    .setTimestamp()
}

export function gameEndedEmbed(name: string, winner: string | undefined, prize: number): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('🏆 Game Over')
    .setColor('#e74c3c' as ColorResolvable)
    .setDescription(`**${name}** has ended!`)
    .addFields(
      { name: 'Winner', value: winner ?? 'Unknown', inline: true },
      { name: 'Prize', value: `${prize} GC`, inline: true },
    )
    .setTimestamp()
}

export function tournamentCreatedEmbed(name: string, creator: string, buyIn: number, maxPlayers: number, prizePool: number): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('🏟️ Tournament Created')
    .setColor('#9b59b6' as ColorResolvable)
    .addFields(
      { name: 'Name', value: name, inline: true },
      { name: 'Creator', value: creator, inline: true },
      { name: 'Buy-in', value: `${buyIn} GC`, inline: true },
      { name: 'Players', value: `0/${maxPlayers}`, inline: true },
      { name: 'Prize Pool', value: `${prizePool} GC`, inline: true },
    )
    .setTimestamp()
}

export function tournamentStartedEmbed(name: string, players: number): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('▶️ Tournament Started')
    .setColor('#e67e22' as ColorResolvable)
    .setDescription(`**${name}** is underway with **${players}** players! GLHF!`)
    .setTimestamp()
}

export function tournamentEndedEmbed(name: string, winner: string, prize: number, totalPlayers: number): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('🏆 Tournament Champion!')
    .setColor('#f1c40f' as ColorResolvable)
    .setDescription(`**${winner}** wins **${name}**!`)
    .addFields(
      { name: 'Players', value: `${totalPlayers}`, inline: true },
      { name: 'Prize', value: `${prize} GC`, inline: true },
    )
    .setTimestamp()
}

export function tournamentRegisterEmbed(name: string, player: string, registrations: number, maxPlayers: number): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('📝 Player Registered')
    .setColor('#1abc9c' as ColorResolvable)
    .setDescription(`${player} registered for **${name}**`)
    .addFields(
      { name: 'Players', value: `${registrations}/${maxPlayers}`, inline: true },
    )
    .setTimestamp()
}

export function bigHandEmbed(description: string, winningHand: string, potSize: number, isHuge: boolean, losingHand?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(isHuge ? '🔥 HUGE HAND!' : '👀 Big Hand')
    .setColor(isHuge ? '#e74c3c' as ColorResolvable : '#f39c12' as ColorResolvable)
    .setDescription(description)
    .addFields(
      { name: 'Winner', value: winningHand, inline: true },
      { name: 'Pot Size', value: `${potSize} chips`, inline: true },
    )
    if (losingHand) {
      embed.addFields({ name: 'Runner Up', value: losingHand, inline: true })
    }
    embed.setTimestamp()
  return embed
}

export function badBeatEmbed(description: string, winningHand: string, losingHand: string, potSize: number): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('💀 Bad Beat!')
    .setColor('#8e44ad' as ColorResolvable)
    .setDescription(description)
    .addFields(
      { name: 'Winner', value: winningHand, inline: true },
      { name: 'Loser', value: losingHand, inline: true },
      { name: 'Pot Size', value: `${potSize} chips`, inline: true },
    )
    .setTimestamp()
}

export function depositCompleteEmbed(userName: string, amount: number): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('💰 Deposit Complete')
    .setColor('#2ecc71' as ColorResolvable)
    .setDescription(`${userName} deposited **${amount} GC**`)
    .setTimestamp()
}

export function withdrawalCompleteEmbed(userName: string, amount: number, gcCode?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle('🏦 Withdrawal Complete')
    .setColor('#e67e22' as ColorResolvable)
    .setDescription(`${userName} withdrew **${amount} GC**`)
    .setTimestamp()
  if (gcCode) {
    embed.addFields({ name: 'GC Code', value: `\`${gcCode}\``, inline: false })
  }
  return embed
}

import { EventEmitter } from 'events'
import path from 'path'
import fs from 'fs'
import { config } from './config'
import {
  openGCMenu, clickGCButton, anvilSubmit, anvilRename, clickAnvilOutput,
  readAnvilOutputSlot, waitForChatMessage, waitForWindowClose, waitForWindow,
  isAnvilWindow, isChestWindow, closeCurrentWindow, parseDepositMessages,
  parseWithdrawalMessages, GC_CHEST_SLOTS, GCResult,
} from './gcUI'
import { extractWorldFromSidebar, isHubOrLobby } from './scoreboard'

let mineflayer: any = null
function getMineflayer() {
  if (!mineflayer) {
    mineflayer = require('mineflayer')
  }
  return mineflayer
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function jitter(minMs: number, maxMs: number): number {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
}

export declare interface MCBot {
  on(event: 'ready', listener: () => void): this
  on(event: 'message', listener: (msg: string) => void): this
  on(event: 'error', listener: (err: Error) => void): this
  on(event: 'msaCode', listener: (data: { user_code: string; verification_uri: string }) => void): this
  on(event: 'disconnected', listener: () => void): this
}

export class MCBot extends EventEmitter {
  private bot: any = null
  private _connected = false
  private _settled = false
  private _sidebarWorld: string | null = null
  private cmdQueue: Array<{ text: string; resolve: () => void; reject: (err: any) => void }> = []
  private cmdPumpTimer: ReturnType<typeof setInterval> | null = null
  private sending = false

  get isConnected(): boolean {
    return this._connected
  }

  async connect(timeoutMs = 60000): Promise<void> {
    if (this._connected) return
    this.disconnect()
    this._settled = false

    const mineflayer = getMineflayer()

    return new Promise((resolve, reject) => {
      let done = false

      const finish = (err?: any) => {
        if (done) return
        done = true
        this._settled = true
        clearTimeout(timer)
        if (err) reject(err)
        else resolve()
      }

      const timer = setTimeout(() => {
        finish(new Error('Connection timed out'))
        this.cleanup()
      }, timeoutMs)

      const profilesFolder = this.resolveProfilesDir()
      fs.mkdirSync(profilesFolder, { recursive: true })

      console.log(`[Bot] Creating bot...`)

      const mf = mineflayer.createBot({
        host: config.minecraft.host,
        port: config.minecraft.port,
        username: config.minecraft.username,
        password: config.minecraft.password || undefined,
        auth: config.minecraft.auth,
        version: config.minecraft.version,
        profilesFolder,
        checkTimeoutInterval: 90_000,
        onMsaCode: (data: { user_code: string; verification_uri: string }) => {
          console.log('\n═══════════════════════════════════════════════════════')
          console.log('  MICROSOFT AUTH REQUIRED')
          console.log(`  Open: ${data.verification_uri}`)
          console.log(`  Code: ${data.user_code}`)
          console.log('═══════════════════════════════════════════════════════\n')
          this.emit('msaCode', data)
        },
      })

      this.bot = mf

      // ─── login ──────────────────────────────────────
      mf.on('login', () => {
        const pos = mf.entity?.position
        const posStr = pos ? `(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})` : 'no entity'
        console.log(`[Bot] Logged in as ${mf.username} — entity pos: ${posStr}`)
        this.applySocketOptions()
        this.installResourcePackAutoAccept(mf)
      })

      // ─── spawn (once per connection; Joybait pattern) ──
      mf.once('spawn', () => {
        this._connected = true
        console.log('[Bot] Spawned in world')
        this.installSidebarCapture()
        this.ensureCmdPump()
        this.emit('ready')
        finish()
      })

      // ─── message ────────────────────────────────────
      mf.on('message', (jsonMsg: any) => {
        try {
          const text = jsonMsg?.toString?.() ?? ''
          if (text) this.emit('message', text)
        } catch {}
      })

      // ─── error ──────────────────────────────────────
      mf.on('error', (err: Error) => {
        console.error(`[Bot] Connection error: ${extractMessage(err)}`)
        this.emit('error', err)
        finish(err)
      })

      // ─── kicked ─────────────────────────────────────
      mf.on('kicked', (reason: string) => {
        const msg = typeof reason === 'string' ? reason : JSON.stringify(reason)
        console.warn(`[Bot] Kicked: ${msg}`)
        this.rejectAllQueued(new Error(`Kicked: ${msg}`))
        finish(new Error(`Kicked: ${msg}`))
        this.cleanup()
      })

      // ─── end ────────────────────────────────────────
      mf.on('end', () => {
        if (!this._settled) {
          console.log('[Bot] Connection ended (server transfer or disconnect)')
          this.rejectAllQueued(new Error('Connection ended'))
          finish(new Error('Connection ended'))
        }
        this.cleanup()
      })
    })
  }

  disconnect(): void {
    this._settled = true
    this.cleanup()
  }

  private cleanup(): void {
    this._connected = false
    this.rejectAllQueued(new Error('Bot disconnected'))
    this.stopCmdPump()
    this.emit('disconnected')
    try {
      if (this.bot) {
        this.bot.removeAllListeners()
        this.bot.end('done')
      }
    } catch {}
    this.bot = null
  }

  // ─── Profiles folder (matches Joybait) ────────────────

  private resolveProfilesDir(): string {
    const root = path.join(process.cwd(), 'data', 'nmp-cache')
    fs.mkdirSync(root, { recursive: true })
    return root
  }

  // ─── Socket options (matches Joybait) ─────────────────

  private applySocketOptions(): void {
    try {
      const sock = this.bot?._client?.socket
      if (!sock) return
      if (typeof sock.setKeepAlive === 'function') sock.setKeepAlive(true, 30000)
      if (typeof sock.setNoDelay === 'function') sock.setNoDelay(true)
    } catch {}
  }

  // ─── Sidebar world detection ──────────────────────────

  private installSidebarCapture(): void {
    if (!this.bot) return
    const bot = this.bot

    const update = () => {
      const state = extractWorldFromSidebar(bot)
      if (state.world && state.world !== this._sidebarWorld) {
        this._sidebarWorld = state.world
        console.log(`[Bot] Sidebar world: "${this._sidebarWorld}"`)
      }
    }

    bot.on('scoreboardPosition', update)
    bot.on('scoreboardCreated', update)
    bot.on('scoreUpdated', update)

    const poll = setInterval(update, 2000)
    this.once('disconnected', () => clearInterval(poll))
  }

  async pollWorld(timeoutMs = 5000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this.bot) return null
      const state = extractWorldFromSidebar(this.bot)
      if (state.world) return state.world
      await sleep(300)
    }
    if (!this.bot) return null
    return extractWorldFromSidebar(this.bot).world
  }

  // ─── Command pump (matches Joybait's ensureCommandPump) ──

  private stopCmdPump(): void {
    if (this.cmdPumpTimer) {
      clearInterval(this.cmdPumpTimer)
      this.cmdPumpTimer = null
    }
  }

  private ensureCmdPump(): void {
    if (this.cmdPumpTimer) return

    this.cmdPumpTimer = setInterval(() => {
      const bot = this.bot
      if (!bot || typeof bot.chat !== 'function') return

      try {
        if (bot._client && bot._client.state && bot._client.state !== 'play') return
      } catch {}

      if (this.sending) return
      if (!this.cmdQueue.length) return

      const item = this.cmdQueue.shift()
      if (!item) return

      // Close open windows before sending (Joybait pattern)
      try {
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
      } catch {}

      this.sending = true
      console.log(`[Bot] CMD: "${item.text}"`)

      try {
        bot.chat(item.text)
        item.resolve()
      } catch (e: any) {
        console.warn(`[Bot] CMD FAIL: "${item.text}" -> ${e?.message || e}`)
        item.reject(e)
      } finally {
        setTimeout(() => { this.sending = false }, 850)
      }
    }, 250)
  }

  async runCmd(cmd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.cmdQueue.push({ text: cmd, resolve, reject })
    })
  }

  private rejectAllQueued(err: Error): void {
    for (const item of this.cmdQueue) {
      item.reject(err)
    }
    this.cmdQueue = []
  }

  // ─── Warmup (matches Joybait's warmup) ────────────────

  private async warmup(): Promise<void> {
    await sleep(jitter(800, 1800))
    try {
      this.bot?.look(Math.random() * Math.PI * 2, 0, true)
    } catch {}
    await sleep(jitter(400, 900))
  }

  // ─── Server Navigation (Joybait-style) ───────────────

  // Transfer error patterns from Joybait's chat message handler
  private isTransferError(text: string): boolean {
    const low = text.toLowerCase()
    return (
      low.includes('velocity.error.server-disconnected') ||
      low.includes('server-disconnected') ||
      low.includes('redirect timed out') ||
      low.includes('unable to connect to') ||
      low.includes('failed to go to server') ||
      low.includes('something went wrong') ||
      low.includes('kicked whilst connecting') ||
      low.includes('you were kicked from this server') ||
      low.includes('!lock;prelogin') ||
      low.includes('prelogin') ||
      low.includes('postdispatch')
    )
  }

  // Probe by opening /gc to check if we're on a game server
  // Returns true if a chest window opened (/gc works on game servers)
  private async probeGC(timeoutMs = 5000): Promise<boolean> {
    if (!this.bot) return false
    try {
      await closeCurrentWindow(this.bot)
      this.bot.chat('/gc')
      await waitForWindow(this.bot, isChestWindow, timeoutMs)
      console.log('[Bot] /gc window opened — confirmed on game server')
      await closeCurrentWindow(this.bot)
      return true
    } catch {
      return false
    }
  }

  async navigateToServer(server: string): Promise<void> {
    if (!this._connected || !this.bot) {
      throw new Error('Bot not connected')
    }

    // Joybait post-spawn pattern: delay → warmup
    console.log('[Bot] Waiting 10s after spawn (Joybait pattern)...')
    await sleep(10000)
    await this.warmup()

    const commandsToTry = config.minecraft.serverCommands?.length
      ? config.minecraft.serverCommands
      : ['/factions', '/server factions', '/skyblock', '/server skyblock']

    console.log(`[Bot] Navigating to ${server}...`)

    // Joybait-style transfer flow: send command, wait for gap, check for error messages
    // Uses chat error detection (not login events) — matching Joybait's pattern
    const startTime = Date.now()
    const chatLog: Array<{ sec: number; msg: string }> = []
    const onChat = (jsonMsg: any) => {
      try {
        const text = jsonMsg?.toString?.() ?? ''
        if (text) chatLog.push({ sec: (Date.now() - startTime) / 1000, msg: text })
      } catch {}
    }
    this.bot.on('message', onChat)

    try {
      for (const cmd of commandsToTry) {
        if (!this._connected || !this.bot) {
          throw new Error('Bot disconnected during navigation')
        }

        console.log(`[Bot] Sending: "${cmd}"`)
        await this.runCmd(cmd)

        // Joybait-style: wait for the command to process, check for errors in chat
        // Gap of 10 seconds (matching Joybait's alt.serverCommandGapSeconds)
        console.log(`[Bot] Waiting ${7}s for transfer to complete or error...`)
        await sleep(7000)

        // Check chat for transfer errors (Joybait pattern)
        const recent = chatLog.filter(c => c.sec > (Date.now() - startTime) / 1000 - 8)
        const errorMsg = recent.find(c => this.isTransferError(c.msg))

        if (errorMsg) {
          console.log(`[Bot] Transfer error detected: "${errorMsg.msg}"`)
          await sleep(2000)
          continue
        }

        // No error detected — assume transfer succeeded
        console.log(`[Bot] No transfer error detected — assuming arrival at ${server}`)

        // Log recent chat for diagnostics
        if (recent.length > 0) {
          console.log(`[Bot] Chat during navigation:`, recent.map(c => `\n  [${c.sec.toFixed(1)}s] ${c.msg}`).join(''))
        }

        console.log(`[Bot] Arrived at ${server}`)
        return
      }

      throw new Error(`Failed to reach ${server}: all commands produced transfer errors`)
    } finally {
      if (this.bot) {
        this.bot.removeListener('message', onChat)
      }
    }
  }

  // ─── GC UI Interaction ──────────────────────────────────

  async redeemCode(code: string): Promise<GCResult> {
    if (!this._connected || !this.bot) {
      return { success: false, message: 'Bot not connected' }
    }

    try {
      console.log(`[GC] Opening menu to redeem code: ${code}`)
      await openGCMenu(this.bot)
      console.log('[GC] GC menu opened, clicking redeem button')
      await clickGCButton(this.bot, GC_CHEST_SLOTS.REDEEM)

      const anvilW = await waitForWindow(this.bot, isAnvilWindow, 6000)
      console.log(`[GC] Anvil opened (type="${anvilW?.type}", title="${anvilW?.title}"), entering code`)

      // Start listening BEFORE anvilSubmit so we don't miss the response message.
      // Only match completion messages (succeeded===true/false), skip intermediate
      // "Attempting to redeem..." messages.
      const chatPromise = waitForChatMessage(this.bot, (text: string) => {
        const p = parseDepositMessages(text)
        return p?.succeeded === true || p?.succeeded === false
      }, 20000)

      await anvilSubmit(this.bot, code)
      console.log('[GC] Code submitted, waiting for confirmation')

      const msg = await chatPromise

      const parsed = parseDepositMessages(msg)
      if (parsed?.succeeded) {
        return { success: true, message: msg, amount: parsed.amount }
      } else if (parsed?.succeeded === false) {
        return { success: false, message: msg }
      }

      return { success: false, message: msg || 'Unknown result' }
    } catch (err: any) {
      const msg = extractMessage(err)
      console.error(`[GC] redeemCode error: ${msg}`)
      await closeCurrentWindow(this.bot).catch(() => {})
      return { success: false, message: msg }
    }
  }

  async withdrawGC(amount: number): Promise<GCResult> {
    if (!this._connected || !this.bot) {
      return { success: false, message: 'Bot not connected' }
    }

    try {
      console.log(`[GC] Opening menu to withdraw ${amount} GC`)
      await openGCMenu(this.bot)
      console.log('[GC] GC menu opened, clicking withdraw button (slot 14)')
      await clickGCButton(this.bot, GC_CHEST_SLOTS.WITHDRAW)

      const anvilW = await waitForWindow(this.bot, isAnvilWindow, 6000)
      console.log(`[GC] Anvil opened (type="${anvilW?.type}", title="${anvilW?.title}"), entering amount: ${amount}`)

      // Start chat listener BEFORE any click so we don't miss the response
      const chatPromise = waitForChatMessage(this.bot, (text: string) => {
        return parseWithdrawalMessages(text) !== null
      }, 20000)

      // Rename only (don't click yet) — sends the amount text to the anvil
      await anvilRename(this.bot, amount.toString())

      // Try to read GC code from anvil output slot before clicking.
      // The server may embed the GC code in the output item's name or lore.
      let gcCodeFromSlot = ''
      try {
        const slotInfo = readAnvilOutputSlot(this.bot)
        if (slotInfo) {
          console.log(`[GC] Anvil output slot: name="${slotInfo.displayName}" lore="${slotInfo.lore}"`)
          const allText = slotInfo.displayName + ' ' + slotInfo.lore
          const match = allText.match(/\b(\d{16})\b/)
          if (match) {
            gcCodeFromSlot = match[1]
            console.log(`[GC] Extracted GC code from output slot: ${gcCodeFromSlot}`)
          }
        } else {
          console.log('[GC] No item in anvil output slot')
        }
      } catch {}

      // Click the output slot to confirm withdrawal
      await clickAnvilOutput(this.bot)
      console.log('[GC] Amount submitted, waiting for GC code')

      // Wait for chat message (full 20s timeout) — server sends the GC code in chat.
      // Don't race with window close; chat is the authoritative signal.
      const msg = await chatPromise.catch(() => null)

      if (msg) {
        const parsed = parseWithdrawalMessages(msg)
        if (parsed?.succeeded && parsed.gcCode) {
          return { success: true, message: msg, gcCode: parsed.gcCode, amount: parsed.amount }
        } else if (parsed?.succeeded === false) {
          return { success: false, message: msg }
        }
        return { success: false, message: msg }
      }

      // Fallback: GC code from output slot (chat didn't arrive)
      if (gcCodeFromSlot) {
        console.log('[GC] No chat message, using GC code from output slot')
        return { success: true, message: `Created GC: ${gcCodeFromSlot}`, gcCode: gcCodeFromSlot, amount }
      }

      return { success: false, message: 'No confirmation received' }
    } catch (err: any) {
      const msg = extractMessage(err)
      console.error(`[GC] withdrawGC error: ${msg}`)
      await closeCurrentWindow(this.bot).catch(() => {})
      return { success: false, message: msg }
    }
  }

  // ─── Resource Pack Auto-Accept ──────────────────────────

  private installResourcePackAutoAccept(mf: any): void {
    try {
      const c = mf._client
      if (!c) return
      const accept = () => {
        try { c.write('resource_pack_receive', { result: 3 }) } catch {}
        try { c.write('resource_pack_receive', { status: 3 }) } catch {}
        try { c.write('resource_pack_receive', { response: 3 }) } catch {}
      }
      c.on('resource_pack_send', accept)
      c.on('resource_pack', accept)
    } catch {}
  }
}

function extractMessage(err: any): string {
  if (!err) return 'Unknown error'
  if (typeof err === 'string') return err
  if (err.errors && Array.isArray(err.errors)) {
    const inner = err.errors.map((e: any) => e?.message || String(e)).filter(Boolean)
    if (inner.length > 0) return inner.join('; ')
  }
  return err.message || String(err)
}

// Manages the /gc GUI interaction flow: chest menu → anvil → chat confirmation

export const GC_CHEST_SLOTS = {
  WITHDRAW: 14,  // Row 2, Slot 6 (1-indexed)
  REDEEM: 15,    // Row 2, Slot 7 (1-indexed)
  INFO: 2,
  HISTORY: 12,
}

export interface GCResult {
  success: boolean
  message: string
  amount?: number
  gcCode?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function sendItemName(bot: any, name: string): void {
  try { bot._client.write('name_item', { name }) } catch {}
}

export function isAnvilWindow(window: any): boolean {
  if (!window) return false
  const t = String(window.type || window.title || '').toLowerCase()
  return t.includes('anvil') || t.includes('repair') || t.includes('renaming') || t.includes('item')
}

export function isChestWindow(window: any): boolean {
  if (!window) return false
  const t = String(window.type || '').toLowerCase()
  const title = String(window.title || '').toLowerCase()
  return t.includes('chest') || t.includes('container') || t.includes('generic_9x') || title.includes('chest') || title.includes('gc') || title.includes('giftcard')
}

export async function waitForWindow(bot: any, predicate: (w: any) => boolean, timeoutMs = 8000): Promise<any> {
  const existing = bot.currentWindow
  if (existing && predicate(existing)) return existing

  return new Promise((resolve, reject) => {
    let done = false

    const timer = setTimeout(() => {
      if (done) return
      done = true
      bot.removeListener('windowOpen', handler)
      reject(new Error('Timeout waiting for window'))
    }, timeoutMs)

    const handler = (window: any) => {
      if (done) return
      if (predicate(window)) {
        done = true
        clearTimeout(timer)
        bot.removeListener('windowOpen', handler)
        resolve(window)
      } else {
        console.log(`[waitForWindow] Window opened but didn't match predicate: type="${window?.type}" title="${window?.title}"`)
      }
    }

    bot.on('windowOpen', handler)
  })
}

export async function waitForChatMessage(bot: any, acceptFn: (msg: string) => boolean, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false

    const cleanup = () => {
      bot.removeListener('message', handler)
      bot.removeListener('end', endHandler)
      bot.removeListener('kicked', endHandler)
    }

    const timer = setTimeout(() => {
      if (done) return
      done = true
      cleanup()
      reject(new Error('Timeout waiting for chat message'))
    }, timeoutMs)

    const endHandler = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      cleanup()
      reject(new Error('Bot disconnected while waiting for chat message'))
    }

    const handler = (jsonMsg: any) => {
      if (done) return
      const text = jsonMsg?.toString?.() ?? String(jsonMsg ?? '')
      if (text) {
        if (acceptFn(text)) {
          done = true
          clearTimeout(timer)
          cleanup()
          resolve(text)
        } else {
          console.log(`[GC:chat:unmatched] ${text}`)
        }
      }
    }

    bot.on('message', handler)
    bot.on('end', endHandler)
    bot.on('kicked', endHandler)
  })
}

export async function waitForWindowClose(bot: any, timeoutMs = 5000): Promise<boolean> {
  if (!bot.currentWindow) return true
  return new Promise((resolve) => {
    let done = false
    const cleanup = () => bot.removeListener('windowClose', handler)
    const timer = setTimeout(() => {
      if (done) return
      done = true
      cleanup()
      resolve(false)
    }, timeoutMs)
    const handler = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      cleanup()
      resolve(true)
    }
    bot.on('windowClose', handler)
  })
}

export async function closeCurrentWindow(bot: any): Promise<void> {
  try {
    bot.closeWindow(bot.currentWindow)
  } catch {}
  await sleep(300)
}

export async function openGCMenu(bot: any): Promise<void> {
  console.log('[GC] Closing any open windows...')
  await closeCurrentWindow(bot)
  console.log('[GC] Sending /gc command...')

  // Debug: log any chat messages for 10s
  const chatUnsub = (() => {
    const handler = (msg: any) => {
      const text = msg?.toString?.() ?? String(msg ?? '')
      console.log(`[GC:chat] ${text}`)
    }
    bot.on('message', handler)
    return () => bot.removeListener('message', handler)
  })()

  // Debug: log any window that opens
  const winUnsub = (() => {
    const handler = (w: any) => {
      console.log(`[GC:windowOpen] type="${w?.type}" title="${w?.title}" slots=${w?.containerItems?.length ?? w?.slots?.length ?? '?'}`)
    }
    bot.on('windowOpen', handler)
    return () => bot.removeListener('windowOpen', handler)
  })()

  bot.chat('/gc')
  console.log('[GC] Waiting for chest window...')
  try {
    const window = await waitForWindow(bot, isChestWindow, 10000)
    console.log('[GC] Chest window opened, awaiting interaction...')
    await sleep(500)
  } finally {
    chatUnsub()
    winUnsub()
  }
}

export async function clickGCButton(bot: any, slot: number): Promise<void> {
  const w = bot.currentWindow
  if (!w) throw new Error('No window open')

  await bot.clickWindow(slot, 0, 0)
  await sleep(400)
}

export async function anvilRename(bot: any, text: string): Promise<void> {
  const w = bot.currentWindow
  if (!w) throw new Error('No window open')
  if (!isAnvilWindow(w)) throw new Error('Not an anvil window')

  // Wait briefly for the item to appear in slot 0
  await sleep(300)

  // Send rename packets character-by-character, matching vanilla client behavior.
  // Reset the name field first (vanilla sends empty name before typing).
  sendItemName(bot, '')
  sendItemName(bot, '')
  await sleep(50)
  for (let i = 1; i <= text.length; i++) {
    sendItemName(bot, text.substring(0, i))
    await sleep(50)
  }

  // Wait for server to compute the result
  await sleep(600)
}

export async function clickAnvilOutput(bot: any): Promise<void> {
  try {
    await bot.clickWindow(2, 0, 0)
  } catch (err: any) {
    const msg = String(err?.message || err || '')
    if (msg.includes('updateSlot') || msg.includes('did not fire')) {
      console.log(`[GC] Slot click window update timed out (expected for custom anvil UI): ${msg}`)
    } else {
      throw err
    }
  }
  await sleep(400)
}

export async function anvilSubmit(bot: any, text: string): Promise<void> {
  await anvilRename(bot, text)
  await clickAnvilOutput(bot)
}

export function readAnvilOutputSlot(bot: any): { displayName: string; lore: string } | null {
  try {
    const w = bot.currentWindow
    if (!w || !w.slots || !w.slots[2]) return null
    const item = w.slots[2]
    const displayName = item.displayName || item.name || ''
    const lore = item.lore
      ? (Array.isArray(item.lore) ? item.lore.join(' ') : String(item.lore))
      : ''
    return { displayName, lore }
  } catch {
    return null
  }
}

export function parseDepositMessages(text: string): { succeeded?: boolean; amount?: number; code?: string } | null {
  // "✔ Successfully redeemed 1.00 GC from gift card 6275320557784961"
  const successMatch = text.match(/successfully\s+redeemed\s+([\d.]+)\s*GC/i)
  if (successMatch) {
    return { succeeded: true, amount: parseFloat(successMatch[1]) }
  }

  // "✔ Attempting to redeem gift card 6275320557784961..."
  const attemptMatch = text.match(/attempting to redeem gift card (\d+)/i)
  if (attemptMatch) {
    return { code: attemptMatch[1] }
  }

  // "✘ Invalid gift card" or "Failed to redeem" or "already redeemed"
  const failMatch = text.match(/(invalid|failed|already\s+redeemed|not\s+found|expired)/i)
  if (failMatch) {
    return { succeeded: false }
  }

  return null
}

export function parseWithdrawalMessages(text: string): { succeeded?: boolean; amount?: number; gcCode?: string } | null {
  // "$ Created 1 GC Gift Card: 6275320557784961 [COPY]"
  const createdMatch = text.match(/created\s+([\d.]+)\s*GC\s*Gift\s*Card:\s*(\d+)/i)
  if (createdMatch) {
    return { succeeded: true, amount: parseFloat(createdMatch[1]), gcCode: createdMatch[2] }
  }

  // "$ Created 1 GC Gift Card: 6275320557784961"
  const altCreate = text.match(/gift\s*card:\s*(\d+)/i)
  if (altCreate) {
    return { succeeded: true, gcCode: altCreate[1] }
  }

  // Error patterns
  const failMatch = text.match(/(insufficient|can't afford|not enough|failed|error)/i)
  if (failMatch) {
    return { succeeded: false }
  }

  return null
}

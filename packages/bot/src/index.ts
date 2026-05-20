import { MCBot } from './mcBot'
import { QueueProcessor } from './queue'
import { config } from './config'

process.on('unhandledRejection', (err) => {
  console.error(`[Bot] Unhandled rejection: ${extractMsg(err)}`)
})

function extractMsg(err: any): string {
  if (!err) return 'Unknown error'
  if (typeof err === 'string') return err
  if (err.errors && Array.isArray(err.errors)) {
    const inner = err.errors.map((e: any) => e?.message || String(e)).filter(Boolean)
    if (inner.length > 0) return inner.join('; ')
  }
  return err.message || String(err)
}

async function main() {
  console.log('[Bot] Starting GC Cashier Bot (on-demand mode)...')
  console.log(`[Bot] Target MC: ${config.minecraft.host}:${config.minecraft.port} (user: ${config.minecraft.username}, auth: ${config.minecraft.auth}, version: ${config.minecraft.version ?? 'auto'})`)
  if (config.minecraft.server) console.log(`[Bot] Game server: /${config.minecraft.server}`)

  const bot = new MCBot()
  const queue = new QueueProcessor(bot)

  bot.on('error', (err) => {
    console.error(`[Bot] Error: ${extractMsg(err)}`)
  })

  bot.on('msaCode', (data) => {
    console.log(`\n[Bot] Microsoft auth required — visit ${data.verification_uri} and enter code ${data.user_code}\n`)
  })

  process.on('SIGINT', () => {
    console.log('\n[Bot] Shutting down...')
    queue.stop()
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    queue.stop()
    process.exit(0)
  })

  queue.start()
  console.log('[Bot] Polling for jobs...')
}

main().catch((err) => {
  console.error(`[Bot] Fatal: ${extractMsg(err)}`)
  process.exit(1)
})

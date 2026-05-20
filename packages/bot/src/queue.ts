import { BotJobStatus, TransactionType } from '@gcpoker/shared'
import { MCBot } from './mcBot'
import { fetchNextJob, submitJobResult, reportBotStatus } from './api'
import { config } from './config'

function extractErrorMessage(err: any): string {
  if (!err) return 'Unknown error'
  if (typeof err === 'string') return err
  if (err.errors && Array.isArray(err.errors)) {
    const inner = err.errors.map((e: any) => e?.message || String(e)).filter(Boolean)
    if (inner.length > 0) return inner.join('; ')
  }
  return err.message || String(err)
}

export class QueueProcessor {
  private bot: MCBot
  private running = false
  private processing = false
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private startTime = 0
  private lastActivity = 0
  private processedCount = 0

  constructor(bot: MCBot) {
    this.bot = bot
  }

  start(): void {
    this.running = true
    this.startTime = Date.now()
    this.lastActivity = Date.now()
    this.poll()
  }

  stop(): void {
    this.running = false
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.bot.disconnect()
  }

  private async poll(): Promise<void> {
    if (!this.running) return

    try {
      await reportBotStatus({
        connected: this.bot.isConnected,
        uptime: Date.now() - this.startTime,
        queueLength: 0,
        lastActivity: this.lastActivity,
      })

      // If not already processing a batch, try to start one
      if (!this.processing) {
        await this.processJobBatch()
      }
    } catch (err: any) {
      const msg = extractErrorMessage(err)
      console.error(`[Queue] Poll error: ${msg}`)
    }

    if (this.running) {
      this.pollTimer = setTimeout(() => this.poll(), config.pollInterval)
    }
  }

  /**
   * Fetch and process all queued jobs in FIFO order, staying connected
   * across multiple jobs. Disconnects only when the queue is empty.
   */
  private async processJobBatch(): Promise<void> {
    // Check if there's work to do
    const firstJob = await fetchNextJob()
    if (!firstJob) {
      // No jobs — disconnect if idle
      if (this.bot.isConnected) {
        console.log('[Queue] Queue drained, disconnecting')
        this.bot.disconnect()
      }
      return
    }

    this.processing = true
    this.lastActivity = Date.now()

    try {
      // Connect once for the batch
      if (!this.bot.isConnected) {
        console.log('[Queue] Connecting to Minecraft...')
        await this.bot.connect()
        console.log('[Queue] Connected, processing...')

        if (config.minecraft.server) {
          console.log(`[Queue] Navigating to /${config.minecraft.server}...`)
          await this.bot.navigateToServer(config.minecraft.server)
          console.log(`[Queue] Arrived at /${config.minecraft.server}`)
        }
      }

      // Process jobs in FIFO order
      let job: any = firstJob
      while (job && this.running) {
        console.log(`[Queue] Processing job ${job.id}: ${job.type}`)
        this.lastActivity = Date.now()

        try {
          if (job.type === TransactionType.Deposit) {
            await this.processDeposit(job)
          } else if (job.type === TransactionType.Withdrawal) {
            await this.processWithdrawal(job)
          }
        } catch (err: any) {
          const msg = extractErrorMessage(err)
          console.error(`[Queue] Job ${job.id} failed: ${msg}`)
          await submitJobResult(job.id, BotJobStatus.Failed, msg).catch(() => {})
        }

        this.processedCount++
        job = await fetchNextJob()
      }
    } catch (err: any) {
      console.error(`[Queue] Batch error: ${extractErrorMessage(err)}`)
    } finally {
      this.processing = false
      this.bot.disconnect()
      console.log('[Queue] Disconnected from Minecraft')
    }
  }

  private async processDeposit(job: any): Promise<void> {
    const result = await this.bot.redeemCode(job.gcCode)

    const message = result.success
      ? result.amount
        ? `Redeemed ${result.amount} GC`
        : result.message
      : result.message

    await submitJobResult(
      job.id,
      result.success ? BotJobStatus.Completed : BotJobStatus.Failed,
      message,
    )
  }

  private async processWithdrawal(job: any): Promise<void> {
    const result = await this.bot.withdrawGC(job.amount)

    if (result.success && result.gcCode) {
      await submitJobResult(
        job.id,
        BotJobStatus.Completed,
        result.gcCode,
      )
    } else {
      await submitJobResult(
        job.id,
        BotJobStatus.Failed,
        result.message,
      )
    }
  }
}

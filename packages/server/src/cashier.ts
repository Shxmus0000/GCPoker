import { Router, Request, Response } from 'express'
import {
  GCTransaction, TransactionStatus, TransactionType,
  CashierJob, BotJobStatus, BotInfo,
} from '@gcpoker/shared'
import { v4 as uuid } from 'uuid'
import { readJSON, writeJSON } from './db'
import { creditBalance, getUser } from './users'

// ─── Data Files ─────────────────────────────────────────

const TX_FILE = 'transactions.json'
const JOBS_FILE = 'jobs.json'
const BOT_FILE = 'bot-status.json'

// ─── Persistent Stores ──────────────────────────────────

let transactions = new Map<string, GCTransaction>()
let jobQueue: CashierJob[] = []
let botStatuses = new Map<string, BotInfo>()

function load(): void {
  const stored = readJSON<GCTransaction[]>(TX_FILE, [])
  transactions = new Map(stored.map(t => [t.id, t]))

  const storedJobs = readJSON<CashierJob[]>(JOBS_FILE, [])
  // Reset abandoned claimed jobs (stuck from a previous server restart)
  for (const job of storedJobs) {
    if (job.status === BotJobStatus.Claimed && job.claimedAt) {
      if (Date.now() - job.claimedAt > 5 * 60 * 1000) {
        job.status = BotJobStatus.Queued
        job.claimedAt = undefined
      }
    }
  }
  jobQueue = storedJobs

  const storedBots = readJSON<Array<[string, BotInfo]>>(BOT_FILE, [])
  botStatuses = new Map(storedBots)
}

function saveTransactions(): void {
  writeJSON(TX_FILE, [...transactions.values()])
}

function saveJobs(): void {
  writeJSON(JOBS_FILE, [...jobQueue])
}

function saveBotStatuses(): void {
  writeJSON(BOT_FILE, [...botStatuses.entries()])
}

// Load on init
load()

// ─── Helpers ────────────────────────────────────────────

function addTransaction(tx: GCTransaction): void {
  transactions.set(tx.id, tx)
  saveTransactions()
}

function enqueueJob(job: CashierJob): void {
  jobQueue.push(job)
  saveJobs()
}

function findUserTransactions(userId: string): GCTransaction[] {
  return [...transactions.values()]
    .filter(t => t.userId === userId)
    .sort((a, b) => b.createdAt - a.createdAt)
}

// ─── Router ─────────────────────────────────────────────

export const cashierRouter = Router()

const API_KEY = process.env.API_KEY ?? 'dev-key'

function isBotAuthed(req: Request): boolean {
  return req.headers['x-api-key'] === API_KEY
}

function requireBotAuth(req: Request, res: Response): boolean {
  if (!isBotAuthed(req)) {
    res.status(401).json({ error: 'Unauthorized' })
    return false
  }
  return true
}

// ─── Create Deposit ──────────────────────────────────────
// Called by: Frontend (user submits a GC code)

cashierRouter.post('/deposit', (req, res) => {
  const { userId, gcCode } = req.body
  if (!userId || !gcCode) {
    return res.status(400).json({ error: 'userId and gcCode required' })
  }

  const tx: GCTransaction = {
    id: uuid(),
    userId,
    type: TransactionType.Deposit,
    amount: 0, // determined by bot after redemption
    gcCode,
    status: TransactionStatus.Pending,
    createdAt: Date.now(),
  }
  addTransaction(tx)

  const job: CashierJob = {
    id: tx.id,
    type: TransactionType.Deposit,
    gcCode,
    userId,
    status: BotJobStatus.Queued,
    createdAt: Date.now(),
  }
  enqueueJob(job)

  res.json({ transactionId: tx.id, status: tx.status })
})

// ─── Create Withdrawal ───────────────────────────────────
// Called by: Frontend (user requests withdrawal)

cashierRouter.post('/withdraw', (req, res) => {
  const { userId, amount } = req.body
  if (!userId || !amount || amount <= 0) {
    return res.status(400).json({ error: 'userId and positive amount required' })
  }

  const user = getUser(userId)
  if (!user || user.balance < amount) {
    return res.status(400).json({ error: 'Insufficient balance' })
  }

  // Reserve the balance
  creditBalance(userId, -amount)

  const tx: GCTransaction = {
    id: uuid(),
    userId,
    type: TransactionType.Withdrawal,
    amount,
    status: TransactionStatus.Pending,
    createdAt: Date.now(),
  }
  addTransaction(tx)

  const job: CashierJob = {
    id: tx.id,
    type: TransactionType.Withdrawal,
    amount,
    userId,
    status: BotJobStatus.Queued,
    createdAt: Date.now(),
  }
  enqueueJob(job)

  res.json({ transactionId: tx.id, status: tx.status })
})

// ─── Bot: Get Next Job ──────────────────────────────────
// Called by: Bot (polls for work)

cashierRouter.get('/queue/next', (req, res) => {
  if (!requireBotAuth(req, res)) return

  const nextJob = jobQueue.find(j => j.status === BotJobStatus.Queued)
  if (!nextJob) return res.status(204).send()

  nextJob.status = BotJobStatus.Claimed
  nextJob.claimedAt = Date.now()
  saveJobs()

  // Update transaction status
  const tx = transactions.get(nextJob.id)
  if (tx) {
    tx.status = TransactionStatus.Processing
    saveTransactions()
  }

  res.json(nextJob)
})

// ─── Bot: Submit Job Result ─────────────────────────────
// Called by: Bot (reports completion)

cashierRouter.post('/queue/result', (req, res) => {
  if (!requireBotAuth(req, res)) return

  const { jobId, status, message } = req.body
  if (!jobId || !status) {
    return res.status(400).json({ error: 'jobId and status required' })
  }

  const job = jobQueue.find(j => j.id === jobId)
  if (!job) return res.status(404).json({ error: 'Job not found' })

  job.status = status
  job.completedAt = Date.now()
  job.resultMessage = message
  saveJobs()

  const tx = transactions.get(jobId)
  if (tx) {
    tx.completedAt = Date.now()
    tx.botMessage = message

    if (status === BotJobStatus.Completed) {
      tx.status = TransactionStatus.Completed

      if (job.type === TransactionType.Deposit) {
        // Extract amount from bot message: "You redeemed 50GC"
        const amountMatch = message.match(/(\d+)/)
        if (amountMatch) {
          tx.amount = parseInt(amountMatch[1], 10)
          creditBalance(tx.userId, tx.amount)
        }
      } else if (job.type === TransactionType.Withdrawal) {
        // message contains the GC code
        tx.gcCode = message
      }
    } else {
      tx.status = TransactionStatus.Failed

      // Refund withdrawal balance that was reserved
      if (job.type === TransactionType.Withdrawal && tx.amount > 0) {
        creditBalance(tx.userId, tx.amount)
      }
    }
    saveTransactions()
  }

  res.json({ ok: true })
})

// ─── Bot: Report Status ─────────────────────────────────
// Called by: Bot (heartbeat)

cashierRouter.post('/bot/status', (req, res) => {
  if (!requireBotAuth(req, res)) return

  const info = req.body as BotInfo
  botStatuses.set('default', info)
  saveBotStatuses()
  res.json({ ok: true })
})

// ─── Get Bot Status ─────────────────────────────────────
// Called by: Frontend (admin panel)

cashierRouter.get('/bot/status', (_req, res) => {
  res.json(botStatuses.get('default') ?? { connected: false })
})

// ─── Transaction History ─────────────────────────────────
// Called by: Frontend

cashierRouter.get('/transactions/:userId', (req, res) => {
  const txs = findUserTransactions(req.params.userId)
  res.json(txs)
})

// ─── Get Single Transaction ──────────────────────────────

cashierRouter.get('/transaction/:id', (req, res) => {
  const tx = transactions.get(req.params.id)
  if (!tx) return res.status(404).json({ error: 'Transaction not found' })
  res.json(tx)
})

// ─── Clear Transaction History ────────────────────────────

cashierRouter.delete('/transactions/:userId', (req, res) => {
  const { userId } = req.params
  const count = findUserTransactions(userId).length
  // Remove all transactions for this user
  for (const tx of [...transactions.values()]) {
    if (tx.userId === userId) {
      transactions.delete(tx.id)
    }
  }
  saveTransactions()
  res.json({ ok: true, deleted: count })
})

// ─── Get Balance ─────────────────────────────────────────

cashierRouter.get('/balance/:userId', (req, res) => {
  const user = getUser(req.params.userId)
  if (!user) return res.status(404).json({ error: 'User not found' })
  res.json({ balance: user.balance })
})

import { Request, Response, NextFunction } from 'express'

// ─── Idempotency Key Store ──────────────────────────────
// Prevents duplicate processing of the same request
// (e.g., double-submit on deposit/withdraw).

interface IdempotencyRecord {
  key: string
  status: 'processing' | 'completed'
  response: any
  expiresAt: number
}

const store = new Map<string, IdempotencyRecord>()

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [key, record] of store) {
    if (record.expiresAt <= now) store.delete(key)
  }
}, 300000)

const IDEMPOTENCY_TTL = 24 * 60 * 60 * 1000 // 24 hours

export function idempotency(req: Request, res: Response, next: NextFunction): void {
  // Only apply to mutating requests
  if (req.method === 'GET' || req.method === 'HEAD') return next()

  const key = req.headers['idempotency-key'] as string
  if (!key || typeof key !== 'string' || key.length < 8) {
    return next() // idempotency key is optional but recommended
  }

  const existing = store.get(key)

  if (existing) {
    if (existing.status === 'processing') {
      res.status(409).json({ error: 'Request is already being processed' })
      return
    }
    // Return cached response
    res.status(200).json(existing.response)
    return
  }

  // Store as processing
  store.set(key, {
    key,
    status: 'processing',
    response: null,
    expiresAt: Date.now() + IDEMPOTENCY_TTL,
  })

  // Intercept res.json to capture the response
  const originalJson = res.json.bind(res)
  res.json = function (body: any) {
    const record = store.get(key)
    if (record) {
      record.status = 'completed'
      record.response = body
    }
    return originalJson(body)
  }

  next()
}

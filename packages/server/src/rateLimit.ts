import { Request, Response, NextFunction } from 'express'

// ─── Simple In-Memory Rate Limiter ──────────────────────

interface BucketEntry {
  count: number
  resetAt: number
}

const buckets = new Map<string, BucketEntry>()

// Clean up expired entries every 60s
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(key)
  }
}, 60000)

export interface RateLimitOptions {
  windowMs: number
  maxRequests: number
  keyFn?: (req: Request) => string
}

export function rateLimit(opts: RateLimitOptions) {
  const keyFn = opts.keyFn ?? ((req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown')

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFn(req)
    const now = Date.now()
    const entry = buckets.get(key)

    if (!entry || entry.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs })
      return next()
    }

    entry.count++

    if (entry.count > opts.maxRequests) {
      res.status(429).json({
        error: 'Too many requests',
        retryAfter: Math.ceil((entry.resetAt - now) / 1000),
      })
      return
    }

    next()
  }
}

// ─── Input Validation ───────────────────────────────────

export function validatePositiveInt(value: any, name: string): number | null {
  const num = parseInt(value, 10)
  if (isNaN(num) || num <= 0) return null
  return num
}

export function validateNonEmptyString(value: any, name: string): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  return value.trim()
}

export function sanitizeString(input: string): string {
  return input.replace(/[<>&"']/g, '').slice(0, 100)
}

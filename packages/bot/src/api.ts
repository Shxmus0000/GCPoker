import { CashierJob, BotJobStatus, BotInfo } from '@gcpoker/shared'
import { config } from './config'

const BASE = config.backend.url
const HEADERS = {
  'Content-Type': 'application/json',
  'x-api-key': config.backend.apiKey,
}

export async function fetchNextJob(): Promise<CashierJob | null> {
  const res = await fetch(`${BASE}/api/cashier/queue/next`, { headers: HEADERS })
  if (res.status === 204) return null
  if (!res.ok) throw new Error(`fetchNextJob failed: ${res.status}`)
  return res.json()
}

export async function submitJobResult(jobId: string, status: BotJobStatus, message: string): Promise<void> {
  const res = await fetch(`${BASE}/api/cashier/queue/result`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ jobId, status, message }),
  })
  if (!res.ok) throw new Error(`submitJobResult failed: ${res.status}`)
}

export async function reportBotStatus(info: BotInfo): Promise<void> {
  const res = await fetch(`${BASE}/api/cashier/bot/status`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(info),
  })
  if (!res.ok) throw new Error(`reportBotStatus failed: ${res.status}`)
}

// Load .env file — must run before config object is built
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { readFileSync, existsSync } from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const envPath = resolve(__dirname, '..', '.env')
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf-8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!process.env[key]) {
      process.env[key] = value
    }
  }
}

export const config = {
  minecraft: {
    host: process.env.MC_HOST ?? 'localhost',
    port: parseInt(process.env.MC_PORT ?? '25565', 10),
    username: process.env.MC_USERNAME ?? 'CashierBot',
    password: process.env.MC_PASSWORD ?? '',
    auth: (process.env.MC_AUTH ?? 'offline') as 'microsoft' | 'offline',
    version: process.env.MC_VERSION || undefined,
    server: process.env.MC_SERVER ?? '',
    serverCommands: process.env.MC_SERVER_COMMANDS
      ? process.env.MC_SERVER_COMMANDS.split(',').map(s => s.trim()).filter(Boolean)
      : [],
  },

  backend: {
    url: process.env.BACKEND_URL ?? 'http://localhost:3001',
    apiKey: process.env.API_KEY ?? 'dev-key',
  },

  pollInterval: parseInt(process.env.BOT_POLL_INTERVAL ?? '3000', 10),
}

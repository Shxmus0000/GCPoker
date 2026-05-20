import * as fs from 'fs'
import * as path from 'path'

const DATA_DIR = path.resolve(__dirname, '..', 'data')

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
}

export function readJSON<T>(filename: string, defaultValue: T): T {
  ensureDir()
  const filePath = path.join(DATA_DIR, filename)
  try {
    const data = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(data) as T
  } catch {
    return defaultValue
  }
}

export function writeJSON<T>(filename: string, data: T): void {
  ensureDir()
  const filePath = path.join(DATA_DIR, filename)
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmp, filePath)
}

export function getDataDir(): string {
  ensureDir()
  return DATA_DIR
}

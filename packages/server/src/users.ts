import { v4 as uuid } from 'uuid'
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { readJSON, writeJSON } from './db'

interface StoredUser {
  id: string
  username: string
  name: string
  balance: number
  passwordHash: string
  salt: string
  createdAt: number
}

interface StoredSession {
  token: string
  userId: string
  createdAt: number
}

const USERS_FILE = 'users.json'
const SESSIONS_FILE = 'sessions.json'

// In-memory caches loaded from disk
let users = new Map<string, StoredUser>()
let usernameIndex = new Map<string, StoredUser>()
let sessions = new Map<string, StoredSession>() // token → session

function load(): void {
  const storedUsers = readJSON<StoredUser[]>(USERS_FILE, [])
  users = new Map(storedUsers.map(u => [u.id, u]))
  usernameIndex = new Map(storedUsers.map(u => [u.username, u]))

  const storedSessions = readJSON<StoredSession[]>(SESSIONS_FILE, [])
  sessions = new Map(storedSessions.map(s => [s.token, s]))
}

function saveUsers(): void {
  writeJSON(USERS_FILE, [...users.values()])
}

function saveSessions(): void {
  writeJSON(SESSIONS_FILE, [...sessions.values()])
}

// Load on module init
load()

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex')
}

export function createUser(username: string, password: string): StoredUser {
  if (usernameIndex.has(username)) throw new Error('Username already taken')
  if (username.length < 2) throw new Error('Username must be at least 2 characters')
  if (password.length < 4) throw new Error('Password must be at least 4 characters')

  const id = uuid()
  const salt = randomBytes(16).toString('hex')
  const user: StoredUser = {
    id,
    username,
    name: username,
    balance: 10000,
    passwordHash: hashPassword(password, salt),
    salt,
    createdAt: Date.now(),
  }
  users.set(id, user)
  usernameIndex.set(username, user)
  saveUsers()
  return user
}

export function authenticateUser(username: string, password: string): StoredUser | null {
  const user = usernameIndex.get(username)
  if (!user) return null
  const hash = hashPassword(password, user.salt)
  try {
    if (timingSafeEqual(Buffer.from(hash), Buffer.from(user.passwordHash))) {
      return user
    }
  } catch {
    return null
  }
  return null
}

export function createSession(userId: string): string {
  const token = uuid()
  sessions.set(token, { token, userId, createdAt: Date.now() })
  saveSessions()
  return token
}

export function getSessionUser(token: string): StoredUser | undefined {
  const session = sessions.get(token)
  if (!session) return undefined
  return users.get(session.userId)
}

export function getUser(id: string): StoredUser | undefined {
  return users.get(id)
}

export function getUserByUsername(username: string): StoredUser | undefined {
  return usernameIndex.get(username)
}

export function debitBalance(userId: string, amount: number): boolean {
  const user = users.get(userId)
  if (!user || user.balance < amount) return false
  user.balance -= amount
  saveUsers()
  return true
}

export function creditBalance(userId: string, amount: number): void {
  const user = users.get(userId)
  if (user) {
    user.balance += amount
    saveUsers()
  }
}

export function getBalance(userId: string): number {
  return users.get(userId)?.balance ?? 0
}

import { Router } from 'express'
import { createUser, authenticateUser, createSession, getSessionUser } from './users'

export const authRouter = Router()

authRouter.post('/signup', (req, res) => {
  try {
    const { username, password } = req.body
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' })
    }
    const user = createUser(username, password)
    const token = createSession(user.id)
    res.json({ token, user: { id: user.id, name: user.name, balance: user.balance } })
  } catch (err: any) {
    res.status(400).json({ error: err.message })
  }
})

authRouter.post('/signin', (req, res) => {
  const { username, password } = req.body
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' })
  }
  const user = authenticateUser(username, password)
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' })
  }
  const token = createSession(user.id)
  res.json({ token, user: { id: user.id, name: user.name, balance: user.balance } })
})

authRouter.post('/session', (req, res) => {
  const { token } = req.body
  if (!token) return res.status(400).json({ error: 'Token required' })
  const user = getSessionUser(token)
  if (!user) return res.status(401).json({ error: 'Invalid session' })
  res.json({ user: { id: user.id, name: user.name, balance: user.balance } })
})

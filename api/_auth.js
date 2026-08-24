import jwt from 'jsonwebtoken'
import { ensureSchema, findUserByUsername, findUserById, createUser, validateUserPassword } from './_db.js'

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me'
const JWT_EXPIRES = '7d'

export async function handleSignup(req, res, body) {
  try {
    await ensureSchema()
    const { fullName, username, password, role } = JSON.parse(body || '{}')
    if (!fullName || !username || !password || !role) {
      res.statusCode = 400
      return res.end(JSON.stringify({ error: 'Missing fields' }))
    }
    if (!['doctor','patient'].includes(role)) {
      res.statusCode = 400
      return res.end(JSON.stringify({ error: 'Invalid role' }))
    }
    const existing = await findUserByUsername(username)
    if (existing) {
      res.statusCode = 409
      return res.end(JSON.stringify({ error: 'Username already taken' }))
    }
    const user = await createUser({ fullName, username, password, role })
    res.setHeader('Content-Type', 'application/json')
    return res.end(JSON.stringify({ id: user.id, role: user.role }))
  } catch (err) {
    res.statusCode = 500
    return res.end(JSON.stringify({ error: 'Server error' }))
  }
}

export async function handleLogin(req, res, body) {
  try {
    await ensureSchema()
    const { id, password, role } = JSON.parse(body || '{}')
    if (!id || !password || !role) {
      res.statusCode = 400
      return res.end(JSON.stringify({ error: 'Missing credentials' }))
    }
    const userId = parseInt(id, 10)
    if (Number.isNaN(userId)) {
      res.statusCode = 400
      return res.end(JSON.stringify({ error: 'Invalid ID' }))
    }
    const user = await findUserById(userId)
    if (!user) {
      res.statusCode = 401
      return res.end(JSON.stringify({ error: 'Invalid credentials' }))
    }
    const ok = await validateUserPassword(user, password)
    if (!ok) {
      res.statusCode = 401
      return res.end(JSON.stringify({ error: 'Invalid credentials' }))
    }
    if (user.role !== role) {
      res.statusCode = 403
      return res.end(JSON.stringify({ error: 'Incorrect role selected', actualRole: user.role }))
    }
    const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES })
    res.setHeader('Content-Type', 'application/json')
    return res.end(JSON.stringify({ token, role: user.role, id: user.id, username: user.username, fullName: user.full_name }))
  } catch (err) {
    res.statusCode = 500
    return res.end(JSON.stringify({ error: 'Server error' }))
  }
}

export function requireAuth(req) {
  const header = req.headers['authorization'] || req.headers['Authorization']
  if (!header) return null
  const [type, token] = String(header).split(' ')
  if (type !== 'Bearer' || !token) return null
  try {
    return jwt.verify(token, JWT_SECRET)
  } catch {
    return null
  }
}



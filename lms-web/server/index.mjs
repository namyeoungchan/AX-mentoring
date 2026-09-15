import express from 'express'
import { config } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { ZodError } from 'zod'
import { createStore } from './store.mjs'
import { createRenderSync } from './render-sync.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
config({ path: resolve(root, '.env'), quiet: true })
const production = process.env.NODE_ENV === 'production'
const password = process.env.ADMIN_PASSWORD || ''
if (production && password.length < 16) throw new Error('운영 모드에서는 16자 이상의 ADMIN_PASSWORD가 필요합니다.')
const port = Number(process.env.API_PORT || 3001)
const host = production ? '0.0.0.0' : '127.0.0.1'
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3001,http://127.0.0.1:3001').split(',').map(v => v.trim()))
const store = createStore(resolve(root, process.env.BOT_DB_PATH || '../data/mentoring.db'))
const renderSync = createRenderSync(store.db, { token: process.env.LEARNINGOPS_SYNC_TOKEN || '', sourceId: process.env.LEARNINGOPS_SOURCE_ID || 'asan-ax' })
const sessions = new Map()
const attempts = new Map()
const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '10mb' }))
app.use('/api', (req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' })
  if (!production && !['localhost', '127.0.0.1'].includes(req.hostname)) return res.status(403).json({ error: '로컬 개발 서버는 localhost로만 접근할 수 있습니다.' })
  const origin = req.get('origin')
  if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ error: '허용되지 않은 Origin입니다.' })
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin)
    res.vary('Origin')
    res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS')
    res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error: 'JSON 요청만 지원합니다.' })
  next()
})
app.get('/api/health', (_req, res) => res.json({ status: 'ok', database: 'connected', auth: password ? 'password' : 'local-development' }))
app.post('/api/integrations/render/snapshot', (req, res) => {
  if (!renderSync.authorized(req.get('authorization'))) return res.status(401).json({ error: '동기화 인증에 실패했습니다.' })
  res.json(renderSync.ingest(req.body))
})
app.post('/api/login', (req, res) => {
  const now = Date.now()
  const failures = attempts.get(req.ip) || { count: 0, until: now + 60000 }
  if (failures.until < now) { failures.count = 0; failures.until = now + 60000 }
  if (failures.count >= 10) return res.status(429).json({ error: '잠시 후 다시 시도하세요.' })
  const digest = v => createHash('sha256').update(v).digest()
  if (typeof req.body?.password !== 'string' || !password || !timingSafeEqual(digest(req.body.password), digest(password))) {
    failures.count++; attempts.set(req.ip, failures)
    return res.status(401).json({ error: '관리자 비밀번호가 일치하지 않습니다.' })
  }
  attempts.delete(req.ip)
  const token = randomBytes(32).toString('hex')
  sessions.set(token, now + 8 * 60 * 60 * 1000)
  res.cookie('learningops_session', token, { httpOnly: true, sameSite: 'strict', secure: production, maxAge: 8 * 60 * 60 * 1000, path: '/api' }).json({ ok: true, token })
})
const sessionToken = req => req.get('authorization')?.startsWith('Bearer ') ? req.get('authorization').slice(7) : req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('learningops_session='))?.slice('learningops_session='.length)
app.use('/api', (req, res, next) => {
  if (!password && !production) return next()
  const token = sessionToken(req)
  if (!token || (sessions.get(token) || 0) < Date.now()) return res.status(401).json({ error: '관리자 로그인이 필요합니다.' })
  next()
})
app.post('/api/logout', (req, res) => {
  const token = sessionToken(req)
  sessions.delete(token); res.clearCookie('learningops_session', { path: '/api' }).json({ ok: true })
})
app.get('/api/workspace', (_req, res) => res.json({ ...store.snapshot(), authEnabled: Boolean(password) }))
app.patch('/api/workspace', (req, res) => res.json({ ...store.mutate(req.body), authEnabled: Boolean(password) }))
app.get('/api/audit', (_req, res) => res.json(store.db.prepare('SELECT * FROM lms_audit ORDER BY id DESC LIMIT 500').all()))
app.get('/api/integrations/render', (_req, res) => res.json(renderSync.read()))
app.use('/api', (_req, res) => res.status(404).json({ error: '지원하지 않는 API입니다.' }))
app.use(express.static(resolve(root, 'dist')))
app.use((error, _req, res, _next) => {
  if (error instanceof ZodError) return res.status(422).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(' / ') })
  if (error.status) return res.status(error.status).json({ error: error.message })
  if (/UNIQUE constraint/.test(error.message)) return res.status(409).json({ error: '중복된 과정 코드·기수, 이메일, Discord ID 또는 데이터입니다.' })
  console.error('API operation failed:', error.code || error.name)
  res.status(500).json({ error: '저장하지 못했습니다. 서버 로그와 데이터베이스 연결을 확인하세요.' })
})
const cleanup = setInterval(() => { const now = Date.now(); for (const [key, expiry] of sessions) if (expiry < now) sessions.delete(key); for (const [key, value] of attempts) if (value.until < now) attempts.delete(key) }, 60000).unref()
const server = app.listen(port, host, () => console.log(`LearningOps API: http://${host}:${port} (${password ? 'password auth' : 'local development'})`))
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => { clearInterval(cleanup); store.db.close(); process.exit(0) }))

import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { z } from 'zod'
import { ApiError } from './store.mjs'

const derive = promisify(scrypt)
const hash = value => createHash('sha256').update(value).digest('hex')
const snowflake = z.string().regex(/^\d{17,20}$/, 'Discord ID는 17~20자리 숫자여야 합니다.')
const username = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.-]{3,31}$/, '아이디는 영문 소문자·숫자·._- 4~32자로 입력하세요.')
const password = z.string().min(12, '비밀번호는 12자 이상 입력하세요.').max(128)
const registration = z.object({ username, name: z.string().trim().min(1).max(50), password, discordId: snowflake }).strict()
const ticketSchema = z.string().regex(/^[a-f0-9]{64}$/)
const verification = z.object({ code: z.string().trim().toUpperCase().transform(v => v.replaceAll('-', '')).pipe(z.string().regex(/^[A-F0-9]{16}$/)), discordId: snowflake, guildId: snowflake }).strict()
const publicUser = row => ({ id: row.id, username: row.username, name: row.name, discordId: row.discord_id, role: 'student', verified: row.verified_at !== null })
const admin = { id: 'admin', username: 'admin', name: '관리자', discordId: '', role: 'admin' }
const safeEqual = (a, b) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)))
const hashOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }
const dummyHash = `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`
let hashing = 0

async function passwordKey(value, salt) {
  if (hashing >= 4) throw new ApiError(429, '로그인 요청이 많습니다. 잠시 후 다시 시도하세요.')
  hashing++
  try { return await derive(value, salt, 64, hashOptions) } finally { hashing-- }
}
async function hashPassword(value) {
  const salt = randomBytes(16).toString('hex')
  return `scrypt$${salt}$${(await passwordKey(value, salt)).toString('hex')}`
}
async function checkPassword(value, stored) {
  const [, salt, key] = stored.split('$')
  return timingSafeEqual(await passwordKey(value, salt), Buffer.from(key, 'hex'))
}

export function createAuth(db, { adminPassword = '', botToken = '', guildId = '', now = Date.now, guildAllowed = id => id === guildId } = {}) {
  const enabled = botToken.length >= 32 && /^\d{17,20}$/.test(guildId)
  db.exec(`
    CREATE TABLE IF NOT EXISTS lms_users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, discord_id TEXT NOT NULL UNIQUE, guild_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lms_registrations (
      ticket_hash TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, username TEXT NOT NULL,
      name TEXT NOT NULL, password_hash TEXT NOT NULL, discord_id TEXT NOT NULL, guild_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, renewed_at INTEGER NOT NULL, verified_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS lms_auth_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES lms_users(id), admin_version TEXT,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lms_auth_limits (
      key_hash TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lms_sessions_expiry ON lms_auth_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS lms_registration_expiry ON lms_registrations(created_at);
  `)
  if (!db.prepare('PRAGMA table_info(lms_users)').all().some(row => row.name === 'verified_at')) {
    db.exec('ALTER TABLE lms_users ADD COLUMN verified_at INTEGER; UPDATE lms_users SET verified_at=created_at')
  }
  if (!db.prepare('PRAGMA table_info(lms_registrations)').all().some(row => row.name === 'user_id')) db.exec('ALTER TABLE lms_registrations ADD COLUMN user_id TEXT')

  function limit(scope, identity, maximum, windowMs) {
    const key = hash(`${scope}:${identity}`)
    const entry = db.prepare(`INSERT INTO lms_auth_limits(key_hash,count,expires_at) VALUES(?,1,?)
      ON CONFLICT(key_hash) DO UPDATE SET
        count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,
        expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END
      RETURNING count`).get(key, now() + windowMs, now(), now())
    if (entry.count > maximum) throw new ApiError(429, '요청 횟수를 초과했습니다. 잠시 후 다시 시도하세요.')
  }
  function requireEnabled() { if (!enabled) throw new ApiError(503, 'Discord 가입 인증이 아직 준비되지 않았습니다.') }
  function available(login, discordId) {
    if (db.prepare('SELECT id FROM lms_users WHERE username=? OR discord_id=?').get(login, discordId)) throw new ApiError(409, '이미 가입된 아이디 또는 Discord 계정입니다.')
  }
  function challenge() {
    const raw = randomBytes(8).toString('hex').toUpperCase()
    return { raw, code: `${raw.slice(0, 8)}-${raw.slice(8)}`, expiresAt: now() + 10 * 60000 }
  }
  async function register(body) {
    requireEnabled()
    const input = registration.parse(body)
    available(input.username, input.discordId)
    const passwordHash = await hashPassword(input.password)
    available(input.username, input.discordId)
    cleanup()
    if (db.prepare('SELECT COUNT(*) AS count FROM lms_registrations').get().count >= 1000) throw new ApiError(503, '가입 요청이 많습니다. 잠시 후 다시 시도하세요.')
    const ticket = randomBytes(32).toString('hex')
    const value = challenge()
    db.prepare(`INSERT INTO lms_registrations(ticket_hash,code_hash,username,name,password_hash,discord_id,guild_id,created_at,expires_at,renewed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(hash(ticket), hash(value.raw), input.username, input.name, passwordHash, input.discordId, guildId, now(), value.expiresAt, now())
    return { ticket, code: value.code, expiresAt: value.expiresAt }
  }
  async function signup(body, onCreated) {
    const input = registration.parse(body)
    available(input.username, input.discordId)
    const passwordHash = await hashPassword(input.password)
    const id = randomUUID()
    db.exec('BEGIN IMMEDIATE')
    try {
      available(input.username, input.discordId)
      db.prepare('INSERT INTO lms_users(id,username,name,password_hash,discord_id,guild_id,created_at,verified_at) VALUES(?,?,?,?,?,?,?,NULL)').run(id, input.username, input.name, passwordHash, input.discordId, '', now())
      const user = publicUser(db.prepare('SELECT * FROM lms_users WHERE id=?').get(id))
      onCreated(user)
      const result = issueSession(user)
      db.exec('COMMIT')
      return result
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function issueVerification(user, targetGuild) {
    if (botToken.length < 32 || !guildAllowed(targetGuild)) throw new ApiError(503, '이 서버의 Discord 인증 연결을 확인하세요.')
    limit('verification-code', user.id, 1, 60000)
    const stored = db.prepare('SELECT * FROM lms_users WHERE id=?').get(user.id)
    if (!stored) throw new ApiError(403, '개인 계정으로 로그인하세요.')
    const ticket = randomBytes(32).toString('hex'), value = challenge()
    db.prepare('UPDATE lms_registrations SET expires_at=0 WHERE user_id=? AND verified_at IS NULL').run(user.id)
    db.prepare('INSERT INTO lms_registrations(ticket_hash,code_hash,username,name,password_hash,discord_id,guild_id,created_at,expires_at,renewed_at,user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(hash(ticket), hash(value.raw), stored.username, stored.name, '', stored.discord_id, targetGuild, now(), value.expiresAt, now(), user.id)
    return { ticket, code: value.code, expiresAt: value.expiresAt }
  }
  function pending(ticket) {
    const row = db.prepare('SELECT * FROM lms_registrations WHERE ticket_hash=?').get(hash(ticketSchema.parse(ticket)))
    if (!row || row.created_at + 24 * 3600000 <= now()) throw new ApiError(404, '가입 요청을 찾을 수 없습니다. 다시 가입해 주세요.')
    return row
  }
  function status(ticket) {
    const row = pending(ticket)
    return { state: row.verified_at !== null ? 'verified' : row.expires_at <= now() ? 'expired' : 'pending', expiresAt: row.expires_at }
  }
  function renew(ticket) {
    requireEnabled()
    const row = pending(ticket)
    if (row.verified_at !== null) throw new ApiError(409, '이미 인증됐습니다. 로그인해 주세요.')
    if (row.renewed_at + 60000 > now()) throw new ApiError(429, '코드는 1분에 한 번 재발급할 수 있습니다.')
    if (!row.user_id) available(row.username, row.discord_id)
    const value = challenge()
    db.prepare('UPDATE lms_registrations SET code_hash=?,expires_at=?,renewed_at=?,guild_id=? WHERE ticket_hash=?').run(hash(value.raw), value.expiresAt, now(), row.user_id ? row.guild_id : guildId, row.ticket_hash)
    return { code: value.code, expiresAt: value.expiresAt }
  }
  function botAuthorized(header = '') { return botToken.length >= 32 && safeEqual(header, `Bearer ${botToken}`) }
  function verificationRequest(body) {
    const input = verification.parse(body)
    if (botToken.length < 32 || !guildAllowed(input.guildId)) throw new ApiError(403, '인증이 허용된 Discord 서버가 아닙니다.')
    const row = db.prepare('SELECT * FROM lms_registrations WHERE code_hash=?').get(hash(input.code))
    if (!row || row.verified_at !== null || row.expires_at <= now()) throw new ApiError(410, '사용했거나 만료된 인증 코드입니다. 웹에서 코드를 확인해 주세요.')
    if (row.discord_id !== input.discordId || row.guild_id !== input.guildId) throw new ApiError(403, '가입 시 입력한 Discord 계정과 일치하지 않습니다.')
    if (!row.user_id) available(row.username, row.discord_id)
    return row
  }
  function preview(body) { const row = verificationRequest(body); return { username: row.username } }
  function verify(body) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = verificationRequest(body)
      if (row.user_id) db.prepare('UPDATE lms_users SET verified_at=?,guild_id=? WHERE id=?').run(now(), row.guild_id, row.user_id)
      else db.prepare('INSERT INTO lms_users(id,username,name,password_hash,discord_id,guild_id,created_at,verified_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), row.username, row.name, row.password_hash, row.discord_id, row.guild_id, now(), now())
      db.prepare('UPDATE lms_registrations SET verified_at=?,password_hash=? WHERE ticket_hash=?').run(now(), '', row.ticket_hash)
      db.exec('COMMIT')
      return { ok: true }
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function issueSession(user) {
    const token = randomBytes(32).toString('hex')
    db.prepare('INSERT INTO lms_auth_sessions(token_hash,user_id,admin_version,expires_at) VALUES(?,?,?,?)').run(hash(token), user.role === 'student' ? user.id : null, user.role === 'admin' ? hash(adminPassword) : null, now() + 8 * 3600000)
    return { token, user }
  }
  async function login(body) {
    const input = z.object({ username, password: z.string().min(1).max(128) }).strict().parse(body)
    limit('member-name', input.username, 10, 15 * 60000)
    const row = db.prepare('SELECT * FROM lms_users WHERE username=?').get(input.username)
    const matches = await checkPassword(input.password, row?.password_hash || dummyHash)
    if (!matches || !row) throw new ApiError(401, '아이디 또는 비밀번호를 확인하세요. 가입 후 Discord 인증을 완료해야 로그인할 수 있습니다.')
    return issueSession(publicUser(row))
  }
  function adminLogin(value) {
    if (typeof value !== 'string' || value.length > 128 || !adminPassword || !safeEqual(value, adminPassword)) throw new ApiError(401, '관리자 비밀번호가 일치하지 않습니다.')
    return issueSession(admin)
  }
  function session(token) {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null
    const row = db.prepare('SELECT * FROM lms_auth_sessions WHERE token_hash=? AND expires_at>?').get(hash(token), now())
    if (!row) return null
    if (row.admin_version) return adminPassword && safeEqual(row.admin_version, hash(adminPassword)) ? admin : null
    const user = db.prepare('SELECT * FROM lms_users WHERE id=?').get(row.user_id)
    return user ? publicUser(user) : null
  }
  function logout(token) { if (typeof token === 'string') db.prepare('DELETE FROM lms_auth_sessions WHERE token_hash=?').run(hash(token)) }
  function cleanup() {
    db.prepare('DELETE FROM lms_auth_sessions WHERE expires_at<=?').run(now())
    db.prepare('DELETE FROM lms_auth_limits WHERE expires_at<=?').run(now())
    db.prepare('DELETE FROM lms_registrations WHERE created_at<=?').run(now() - 24 * 3600000)
  }
  return { enabled, register, signup, issueVerification, status, renew, botAuthorized, preview, verify, login, adminLogin, session, logout, limit, cleanup }
}

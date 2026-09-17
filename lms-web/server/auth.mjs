import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { z } from 'zod'
import { ApiError } from './store.mjs'
import { initializeVerification, tableExists, workspaceForGuild } from './workspace-verification.mjs'

const derive = promisify(scrypt)
const hash = value => createHash('sha256').update(value).digest('hex')
const snowflake = z.string().regex(/^\d{17,20}$/, 'Discord ID는 17~20자리 숫자여야 합니다.')
const username = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.-]{3,31}$/, '아이디는 영문 소문자·숫자·._- 4~32자로 입력하세요.')
const password = z.string().min(8, '비밀번호는 8자 이상 입력하세요.').max(128)
const registration = z.object({ username, name: z.string().trim().min(1).max(50), password, discordId: snowflake.optional() }).strict()
const ticketSchema = z.string().regex(/^[a-f0-9]{64}$/)
const verification = z.object({ code: z.string().trim().toUpperCase().transform(v => v.replaceAll('-', '')).pipe(z.string().regex(/^[A-F0-9]{16}$/)), discordId: snowflake, guildId: snowflake }).strict()
const publicUser = row => ({ id: row.id, username: row.username, name: row.name, discordId: /^\d{17,20}$/.test(row.discord_id) ? row.discord_id : '', role: row.platform_role || 'student', verified: row.verified_at !== null, mustCompleteProfile: Boolean(row.must_complete_profile), mustChangePassword: Boolean(row.must_change_password) })
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

export function createAuth(db, { adminPassword = '', allowLegacyAdmin = false, botToken = '', guildId = '', now = Date.now, guildAllowed = id => id === guildId } = {}) {
  const enabled = botToken.length >= 32
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
    CREATE TABLE IF NOT EXISTS lms_account_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL, target_id TEXT NOT NULL,
      username TEXT NOT NULL, action TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `)
  if (!db.prepare('PRAGMA table_info(lms_users)').all().some(row => row.name === 'verified_at')) {
    db.exec('ALTER TABLE lms_users ADD COLUMN verified_at INTEGER; UPDATE lms_users SET verified_at=created_at')
  }
  if (!db.prepare('PRAGMA table_info(lms_registrations)').all().some(row => row.name === 'user_id')) db.exec('ALTER TABLE lms_registrations ADD COLUMN user_id TEXT')
  if (!db.prepare('PRAGMA table_info(lms_registrations)').all().some(row => row.name === 'workspace_id')) db.exec('ALTER TABLE lms_registrations ADD COLUMN workspace_id TEXT')
  initializeVerification(db)
  if (!db.prepare('PRAGMA table_info(lms_users)').all().some(row => row.name === 'platform_role')) db.exec("ALTER TABLE lms_users ADD COLUMN platform_role TEXT NOT NULL DEFAULT 'student' CHECK(platform_role IN ('admin','student'))")
  if (!db.prepare('PRAGMA table_info(lms_users)').all().some(row => row.name === 'must_change_password')) db.exec('ALTER TABLE lms_users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0')

  if (!db.prepare('PRAGMA table_info(lms_users)').all().some(row => row.name === 'must_complete_profile')) db.exec('ALTER TABLE lms_users ADD COLUMN must_complete_profile INTEGER NOT NULL DEFAULT 0')

  function hasAdmin() { return Boolean(db.prepare("SELECT 1 FROM lms_users WHERE platform_role='admin'").get()) }
  function setupEnabled() { return adminPassword.length >= 16 && !hasAdmin() }
  function legacyEnabled() { return allowLegacyAdmin && !hasAdmin() }
  async function setup(body) {
    const input = z.object({ username, name: z.string().trim().min(1).max(50), password, setupKey: z.string().min(16).max(256) }).strict().parse(body)
    if (!setupEnabled()) throw new ApiError(409, '최초 관리자 등록이 종료되었거나 설정 키가 없습니다.')
    if (!safeEqual(input.setupKey, adminPassword)) throw new ApiError(401, '관리자 설정 키를 확인하세요.')
    const passwordHash = await hashPassword(input.password)
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!setupEnabled()) throw new ApiError(409, '이미 관리자가 등록되었습니다.')
      const id = randomUUID()
      // A reserved non-snowflake identity keeps the existing UNIQUE constraint without claiming Discord ownership.
      available(input.username, `platform:${id}`)
      db.prepare("INSERT INTO lms_users(id,username,name,password_hash,discord_id,guild_id,created_at,verified_at,platform_role) VALUES(?,?,?,?,?,'',?,?,'admin')").run(id, input.username, input.name, passwordHash, `platform:${id}`, now(), now())
      db.prepare('DELETE FROM lms_auth_sessions WHERE admin_version IS NOT NULL').run()
      const result = issueSession(publicUser(db.prepare('SELECT * FROM lms_users WHERE id=?').get(id)))
      db.exec('COMMIT')
      return result
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }

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
  async function register(body, targetGuild = guildId) {
    requireEnabled()
    if (!/^\d{17,20}$/.test(targetGuild) || !guildAllowed(targetGuild)) throw new ApiError(503, '가입할 워크스페이스의 Discord 서버 연결을 확인하세요.')
    const input = registration.parse(body)
    input.discordId ||= `pending:${randomUUID()}`
    available(input.username, input.discordId)
    const passwordHash = await hashPassword(input.password)
    available(input.username, input.discordId)
    cleanup()
    if (db.prepare('SELECT COUNT(*) AS count FROM lms_registrations').get().count >= 1000) throw new ApiError(503, '가입 요청이 많습니다. 잠시 후 다시 시도하세요.')
    const ticket = randomBytes(32).toString('hex')
    const value = challenge()
    db.prepare(`INSERT INTO lms_registrations(ticket_hash,code_hash,username,name,password_hash,discord_id,guild_id,created_at,expires_at,renewed_at,workspace_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(hash(ticket), hash(value.raw), input.username, input.name, passwordHash, input.discordId, targetGuild, now(), value.expiresAt, now(), workspaceForGuild(db, targetGuild))
    return { ticket, code: value.code, expiresAt: value.expiresAt }
  }
  async function signup(body, onCreated) {
    const input = registration.parse(body)
    input.discordId ||= `pending:${randomUUID()}`
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
  async function createInvitationAccount(body, actor, createInvitation) {
    if (actor.role !== 'admin' || actor.mustChangePassword) throw new ApiError(403, '관리자 계정 발급은 전체 관리자만 할 수 있습니다.')
    const input = z.object({ username, name: z.string().trim().min(1).max(50) }).strict().parse(body)
    const id = randomUUID(), identity = `pending:${id}`
    available(input.username, identity)
    const initialPassword = randomBytes(18).toString('base64url')
    const passwordHash = await hashPassword(initialPassword)
    db.exec('BEGIN IMMEDIATE')
    try {
      available(input.username, identity)
      db.prepare('INSERT INTO lms_users(id,username,name,password_hash,discord_id,guild_id,created_at,verified_at,must_change_password) VALUES(?,?,?,?,?,?,?,NULL,1)').run(id, input.username, input.name, passwordHash, identity, '', now())
      const invitation = createInvitation(input.username)
      // Return the secret once. Neither invitation records nor audit logs store it.
      db.prepare('INSERT INTO lms_audit(actor,action,target,before_json,after_json) VALUES(?,?,?,?,?)').run(actor.username || actor.id, 'account.invite', id, null, JSON.stringify({ username: input.username, invitationId: invitation.id }))
      db.exec('COMMIT')
      return { ...invitation, name: input.name, initialPassword }
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  async function createStudentAccount(body, actor, authorize, assign) {
    const input = z.object({ username, name: z.string().trim().min(1).max(50).optional() }).strict().parse(body)
    authorize()
    const actorBefore = db.prepare('SELECT password_hash,platform_role FROM lms_users WHERE id=?').get(actor.id)
    if (!actorBefore && !(actor.id === 'admin' && legacyEnabled())) throw new ApiError(403, '관리자 계정으로 로그인하세요.')
    const id = randomUUID(), identity = `pending:${id}`, initialPassword = randomBytes(18).toString('base64url')
    available(input.username, identity)
    const passwordHash = await hashPassword(initialPassword)
    db.exec('BEGIN IMMEDIATE')
    try {
      authorize()
      const currentActor = db.prepare('SELECT password_hash,platform_role,must_change_password FROM lms_users WHERE id=?').get(actor.id)
      if (actorBefore && (!currentActor || currentActor.must_change_password || currentActor.password_hash !== actorBefore.password_hash || currentActor.platform_role !== actorBefore.platform_role)) throw new ApiError(403, '관리자 인증이 변경되었습니다. 다시 로그인하세요.')
      if (!actorBefore && !legacyEnabled()) throw new ApiError(403, '개인 관리자 계정으로 로그인하세요.')
      available(input.username, identity)
      db.prepare('INSERT INTO lms_users(id,username,name,password_hash,discord_id,guild_id,created_at,verified_at,must_change_password,must_complete_profile) VALUES(?,?,?,?,?,?,?,NULL,1,1)').run(id, input.username, input.name || input.username, passwordHash, identity, '', now())
      const user = publicUser(db.prepare('SELECT * FROM lms_users WHERE id=?').get(id))
      const assigned = assign(user)
      db.prepare('INSERT INTO lms_account_audit(actor_id,target_id,username,action,created_at) VALUES(?,?,?,?,?)').run(actor.id, id, input.username, 'student.issue', now())
      db.exec('COMMIT')
      return { ...assigned, username: input.username, name: user.name, initialPassword }
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  async function completeFirstLogin(user, body) {
    const input = z.object({ name: z.string().trim().min(1).max(50), currentPassword: z.string().min(1).max(128), newPassword: password }).strict().parse(body)
    limit('first-login', user.id, 5, 15 * 60000)
    const row = db.prepare('SELECT * FROM lms_users WHERE id=?').get(user.id)
    if (!row?.must_complete_profile || !row.must_change_password) throw new ApiError(409, '이미 첫 로그인 설정을 완료했습니다.')
    if (!await checkPassword(input.currentPassword, row.password_hash)) throw new ApiError(401, '초기 비밀번호를 확인하세요.')
    if (input.currentPassword === input.newPassword) throw new ApiError(422, '초기 비밀번호와 다른 비밀번호를 입력하세요.')
    const nextHash = await hashPassword(input.newPassword)
    db.exec('BEGIN IMMEDIATE')
    try {
      const updated = db.prepare('UPDATE lms_users SET name=?,password_hash=?,must_change_password=0,must_complete_profile=0 WHERE id=? AND password_hash=? AND must_complete_profile=1 AND must_change_password=1').run(input.name, nextHash, row.id, row.password_hash)
      if (!updated.changes) throw new ApiError(409, '계정 정보가 변경되었습니다. 다시 로그인하세요.')
      db.prepare('DELETE FROM lms_auth_sessions WHERE user_id=?').run(row.id)
      db.prepare('INSERT INTO lms_account_audit(actor_id,target_id,username,action,created_at) VALUES(?,?,?,?,?)').run(row.id, row.id, row.username, 'student.setup', now())
      const result = issueSession(publicUser(db.prepare('SELECT * FROM lms_users WHERE id=?').get(row.id)))
      db.exec('COMMIT'); return result
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function issueVerification(user, targetGuild) {
    if (botToken.length < 32 || !guildAllowed(targetGuild)) throw new ApiError(503, '이 서버의 Discord 인증 연결을 확인하세요.')
    if (db.prepare('SELECT must_complete_profile,must_change_password FROM lms_users WHERE id=?').get(user.id)?.must_complete_profile) throw new ApiError(403, '첫 로그인 설정을 완료하세요.')
    const workspaceId = workspaceForGuild(db, targetGuild)
    checkWorkspace({ workspace_id: workspaceId, guild_id: targetGuild, user_id: user.id })
    limit('verification-code', `${user.id}:${workspaceId || targetGuild}`, 1, 60000)
    const stored = db.prepare('SELECT * FROM lms_users WHERE id=?').get(user.id)
    if (!stored) throw new ApiError(403, '개인 계정으로 로그인하세요.')
    const ticket = randomBytes(32).toString('hex'), value = challenge()
    db.prepare('UPDATE lms_registrations SET expires_at=0 WHERE user_id=? AND guild_id=? AND verified_at IS NULL').run(user.id, targetGuild)
    db.prepare('INSERT INTO lms_registrations(ticket_hash,code_hash,username,name,password_hash,discord_id,guild_id,created_at,expires_at,renewed_at,user_id,workspace_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(hash(ticket), hash(value.raw), stored.username, stored.name, '', stored.discord_id, targetGuild, now(), value.expiresAt, now(), user.id, workspaceId)
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
    checkWorkspace(row)
    if (row.renewed_at + 60000 > now()) throw new ApiError(429, '코드는 1분에 한 번 재발급할 수 있습니다.')
    if (row.user_id) limit('verification-code', `${row.user_id}:${row.workspace_id || row.guild_id}`, 1, 60000)
    if (!row.user_id) available(row.username, row.discord_id)
    const value = challenge()
    if (row.user_id) db.prepare('UPDATE lms_registrations SET expires_at=0 WHERE user_id=? AND guild_id=? AND verified_at IS NULL').run(row.user_id, row.guild_id)
    db.prepare('UPDATE lms_registrations SET code_hash=?,expires_at=?,renewed_at=?,guild_id=? WHERE ticket_hash=?').run(hash(value.raw), value.expiresAt, now(), row.guild_id, row.ticket_hash)
    return { code: value.code, expiresAt: value.expiresAt }
  }
  function botAuthorized(header = '') { return botToken.length >= 32 && safeEqual(header, `Bearer ${botToken}`) }
  function checkWorkspace(row) {
    if (!tableExists(db, 'lms_workspace_guilds')) return // Standalone legacy authentication.
    if (!row.workspace_id || workspaceForGuild(db, row.guild_id) !== row.workspace_id) throw new ApiError(403, '인증 코드를 발급한 워크스페이스의 서버가 아닙니다.')
    if (db.prepare('SELECT archived_at FROM lms_workspaces WHERE id=?').get(row.workspace_id)?.archived_at != null) throw new ApiError(403, '보관된 워크스페이스에서는 인증할 수 없습니다.')
    if (!row.user_id) return
    const member = db.prepare('SELECT 1 FROM lms_workspace_members WHERE workspace_id=? AND user_id=?').get(row.workspace_id, row.user_id)
    const administrator = db.prepare("SELECT 1 FROM lms_users WHERE id=? AND platform_role='admin'").get(row.user_id)
    const approved = tableExists(db, 'lms_admissions') && db.prepare("SELECT 1 FROM lms_admissions WHERE workspace_id=? AND user_id=? AND guild_id=? AND state='approved'").get(row.workspace_id, row.user_id, row.guild_id)
    if (!member && !administrator && !approved) throw new ApiError(403, '이 워크스페이스의 초대 또는 가입 승인이 필요합니다.')
  }
  function verificationRequest(body) {
    const input = verification.parse(body)
    if (botToken.length < 32 || !guildAllowed(input.guildId)) throw new ApiError(403, '인증이 허용된 Discord 서버가 아닙니다.')
    const row = db.prepare('SELECT * FROM lms_registrations WHERE code_hash=?').get(hash(input.code))
    if (!row || row.verified_at !== null || row.expires_at <= now()) throw new ApiError(410, '사용했거나 만료된 인증 코드입니다. 웹에서 코드를 확인해 주세요.')
    checkWorkspace(row)
    const stored = row.user_id ? db.prepare('SELECT * FROM lms_users WHERE id=?').get(row.user_id) : null
    if (stored?.must_complete_profile) throw new ApiError(403, '첫 로그인 설정을 완료하세요.')
    if (row.user_id && !stored) throw new ApiError(410, '가입 요청을 찾을 수 없습니다.')
    const identity = stored?.discord_id || row.discord_id
    const unlinked = identity.startsWith('pending:') || (stored?.platform_role === 'admin' && identity === `platform:${stored.id}`)
    if ((!unlinked && identity !== input.discordId) || row.guild_id !== input.guildId) throw new ApiError(403, '연결된 Discord 계정 또는 인증 서버를 확인하세요.')
    const owner = db.prepare('SELECT id FROM lms_users WHERE discord_id=?').get(input.discordId)
    if (owner && owner.id !== row.user_id) throw new ApiError(409, '이미 다른 LMS 계정에 연결된 Discord 계정입니다.')
    if (!row.user_id) available(row.username, input.discordId)
    return { ...row, discord_id: input.discordId }
  }
  function preview(body) { const row = verificationRequest(body); return { username: row.username } }
  function verify(body) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = verificationRequest(body)
      const userId = row.user_id || randomUUID()
      if (row.user_id) db.prepare('UPDATE lms_users SET verified_at=?,guild_id=?,discord_id=? WHERE id=?').run(now(), row.guild_id, row.discord_id, row.user_id)
      else db.prepare('INSERT INTO lms_users(id,username,name,password_hash,discord_id,guild_id,created_at,verified_at) VALUES(?,?,?,?,?,?,?,?)').run(userId, row.username, row.name, row.password_hash, row.discord_id, row.guild_id, now(), now())
      if (row.workspace_id) db.prepare(`INSERT INTO lms_workspace_verifications VALUES(?,?,?,?,?)
        ON CONFLICT(workspace_id,user_id,guild_id) DO UPDATE SET discord_id=excluded.discord_id,verified_at=excluded.verified_at`)
        .run(row.workspace_id, userId, row.guild_id, row.discord_id, now())
      db.prepare('UPDATE lms_registrations SET verified_at=?,password_hash=? WHERE ticket_hash=?').run(now(), '', row.ticket_hash)
      db.exec('COMMIT')
      return { ok: true }
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function issueSession(user) {
    const token = randomBytes(32).toString('hex')
    db.prepare('INSERT INTO lms_auth_sessions(token_hash,user_id,admin_version,expires_at) VALUES(?,?,?,?)').run(hash(token), user.id === 'admin' ? null : user.id, user.id === 'admin' ? hash(adminPassword) : null, now() + 8 * 3600000)
    return { token, user }
  }
  async function login(body) {
    const input = z.object({ username, password: z.string().min(1).max(128) }).strict().parse(body)
    limit('member-name', input.username, 10, 15 * 60000)
    const row = db.prepare('SELECT * FROM lms_users WHERE username=?').get(input.username)
    const matches = await checkPassword(input.password, row?.password_hash || dummyHash)
    if (!matches || !row) throw new ApiError(401, '아이디 또는 비밀번호를 확인하세요.')
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = db.prepare('SELECT * FROM lms_users WHERE id=?').get(row.id)
      if (current?.password_hash !== row.password_hash) throw new ApiError(401, '아이디 또는 비밀번호를 확인하세요.')
      const result = issueSession(publicUser(current))
      db.exec('COMMIT')
      return result
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function adminLogin(value) {
    if (!legacyEnabled() || typeof value !== 'string' || value.length > 128 || !adminPassword || !safeEqual(value, adminPassword)) throw new ApiError(401, '아이디와 비밀번호로 로그인하세요.')
    return issueSession(admin)
  }
  function session(token) {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null
    const row = db.prepare('SELECT * FROM lms_auth_sessions WHERE token_hash=? AND expires_at>?').get(hash(token), now())
    if (!row) return null
    if (row.admin_version) return legacyEnabled() && adminPassword && safeEqual(row.admin_version, hash(adminPassword)) ? admin : null
    const user = db.prepare('SELECT * FROM lms_users WHERE id=?').get(row.user_id)
    return user ? publicUser(user) : null
  }
  function logout(token) { if (typeof token === 'string') db.prepare('DELETE FROM lms_auth_sessions WHERE token_hash=?').run(hash(token)) }
  async function changePassword(user, body) {
    const input = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password }).strict().parse(body)
    limit('password-change', user.id, 5, 15 * 60000)
    const row = db.prepare('SELECT * FROM lms_users WHERE id=?').get(user.id)
    if (row?.must_complete_profile) throw new ApiError(403, '이름 입력과 첫 로그인 설정을 먼저 완료하세요.')
    if (!row || !await checkPassword(input.currentPassword, row.password_hash)) throw new ApiError(401, '현재 비밀번호를 확인하세요.')
    if (input.currentPassword === input.newPassword) throw new ApiError(422, '기존과 다른 비밀번호를 입력하세요.')
    const nextHash = await hashPassword(input.newPassword)
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!db.prepare('UPDATE lms_users SET password_hash=?,must_change_password=0 WHERE id=? AND password_hash=?').run(nextHash, user.id, row.password_hash).changes) throw new ApiError(409, '계정 정보가 변경되었습니다. 다시 로그인하세요.')
      db.prepare('DELETE FROM lms_auth_sessions WHERE user_id=?').run(user.id)
      const result = issueSession(publicUser({ ...row, must_change_password: 0 }))
      db.exec('COMMIT')
      return result
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  // Server-console recovery only. Never expose this operation through a public route.
  async function resetPassword(body) {
    const input = z.object({ username, newPassword: password }).strict().parse(body)
    const nextHash = await hashPassword(input.newPassword)
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db.prepare('SELECT id FROM lms_users WHERE username=?').get(input.username)
      if (!row) throw new ApiError(404, '계정을 찾을 수 없습니다.')
      db.prepare('UPDATE lms_users SET password_hash=? WHERE id=?').run(nextHash, row.id)
      db.prepare('DELETE FROM lms_auth_sessions WHERE user_id=?').run(row.id)
      db.exec('COMMIT')
      return { ok: true }
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function platformAdmin(user) {
    const row = db.prepare("SELECT * FROM lms_users WHERE id=? AND platform_role='admin'").get(user?.id || '')
    if (!row || row.must_change_password) throw new ApiError(403, '총괄 관리자 계정으로 로그인하세요.')
    return row
  }
  function accounts(user) {
    platformAdmin(user)
    const memberships = tableExists(db, 'lms_workspace_members') ? db.prepare('SELECT m.user_id,m.role,w.name FROM lms_workspace_members m JOIN lms_workspaces w ON w.id=m.workspace_id').all() : []
    const adminCount = db.prepare("SELECT COUNT(*) AS n FROM lms_users WHERE platform_role='admin'").get().n
    return { accounts: db.prepare('SELECT * FROM lms_users ORDER BY created_at DESC,username').all().map(row => ({ ...publicUser(row), createdAt: row.created_at, canDelete: row.platform_role !== 'admin' || adminCount > 1, memberships: memberships.filter(m => m.user_id === row.id).map(m => ({ role: m.role, name: m.name })) })) }
  }
  function confirmedAccount(id, body) {
    const input = z.object({ username }).strict().parse(body)
    const row = db.prepare('SELECT * FROM lms_users WHERE id=?').get(id)
    if (!row) throw new ApiError(404, '계정을 찾을 수 없습니다.')
    if (input.username !== row.username) throw new ApiError(422, '대상 계정의 아이디를 정확히 입력하세요.')
    return row
  }
  async function resetAccount(user, id, body) {
    const actor = platformAdmin(user)
    const target = confirmedAccount(id, body)
    limit('admin-account-reset', actor.id, 30, 3600000)
    const initialPassword = randomBytes(18).toString('base64url')
    const passwordHash = await hashPassword(initialPassword)
    db.exec('BEGIN IMMEDIATE')
    try {
      if (platformAdmin(user).password_hash !== actor.password_hash) throw new ApiError(409, '관리자 인증이 변경되었습니다. 다시 로그인하세요.')
      const row = confirmedAccount(id, body)
      if (row.password_hash !== target.password_hash) throw new ApiError(409, '이미 비밀번호가 변경되었습니다. 계정 목록을 새로고침하세요.')
      db.prepare('UPDATE lms_users SET password_hash=?,must_change_password=1 WHERE id=?').run(passwordHash, row.id)
      db.prepare('DELETE FROM lms_auth_sessions WHERE user_id=?').run(row.id)
      db.prepare('DELETE FROM lms_registrations WHERE user_id=? OR username=?').run(row.id, row.username)
      db.prepare('DELETE FROM lms_auth_limits WHERE key_hash=?').run(hash(`member-name:${row.username}`))
      db.prepare('INSERT INTO lms_account_audit(actor_id,target_id,username,action,created_at) VALUES(?,?,?,?,?)').run(actor.id, row.id, row.username, 'password.reset', now())
      db.exec('COMMIT')
      return { username: row.username, initialPassword, mustChangePassword: true }
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function deleteAccount(user, id, body) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const actor = platformAdmin(user), row = confirmedAccount(id, body)
      if (row.platform_role === 'admin' && db.prepare("SELECT COUNT(*) AS n FROM lms_users WHERE platform_role='admin'").get().n <= 1) throw new ApiError(409, '마지막 총괄 관리자 계정은 삭제할 수 없습니다.')
      db.prepare('DELETE FROM lms_auth_sessions WHERE user_id=?').run(row.id)
      db.prepare('DELETE FROM lms_registrations WHERE user_id=? OR username=?').run(row.id, row.username)
      for (const table of ['lms_admissions', 'lms_workspace_members', 'lms_workspace_verifications', 'lms_staff_profiles', 'lms_staff_connections']) {
        if (tableExists(db, table)) db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(row.id)
      }
      if (tableExists(db, 'lms_mentor_scopes')) db.prepare('DELETE FROM lms_mentor_scopes WHERE subject_id=?').run(row.id)
      if (tableExists(db, 'lms_workspace_invitations')) db.prepare('UPDATE lms_workspace_invitations SET revoked_at=? WHERE accepted_at IS NULL AND revoked_at IS NULL AND (username=? OR created_by=?)').run(now(), row.username, row.id)
      db.prepare('DELETE FROM lms_users WHERE id=?').run(row.id)
      db.prepare('INSERT INTO lms_account_audit(actor_id,target_id,username,action,created_at) VALUES(?,?,?,?,?)').run(actor.id, row.id, row.username, 'account.delete', now())
      db.exec('COMMIT')
      return { ok: true, signedOut: actor.id === row.id }
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function cleanup() {
    db.prepare('DELETE FROM lms_auth_sessions WHERE expires_at<=?').run(now())
    db.prepare('DELETE FROM lms_auth_limits WHERE expires_at<=?').run(now())
    db.prepare('DELETE FROM lms_registrations WHERE created_at<=?').run(now() - 24 * 3600000)
  }
  return { enabled, setupEnabled, legacyEnabled, setup, changePassword, resetPassword, accounts, resetAccount, deleteAccount, register, signup, createInvitationAccount, createStudentAccount, completeFirstLogin, issueVerification, status, renew, botAuthorized, preview, verify, login, adminLogin, session, logout, limit, cleanup }
}

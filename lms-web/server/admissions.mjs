import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { ApiError } from './store.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const snowflake = z.string().regex(/^\d{17,20}$/)
export function createAdmissions(db, workspaces, { token = '', now = Date.now } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS lms_admissions (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES lms_workspaces(id), user_id TEXT NOT NULL REFERENCES lms_users(id),
    state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','joined')), created_at INTEGER NOT NULL,
    reviewed_by TEXT, reviewed_at INTEGER, guild_id TEXT, reason TEXT NOT NULL DEFAULT '',
    invite_state TEXT NOT NULL DEFAULT 'none', invite_code TEXT, invite_expires INTEGER, claim_hash TEXT, lease_until INTEGER,
    UNIQUE(workspace_id,user_id)
  );`)
  function catalogue() { return db.prepare('SELECT id,name FROM lms_workspaces WHERE archived_at IS NULL ORDER BY created_at,rowid').all() }
  function apply(id, user) {
    if (workspaces.metadata(id).archivedAt !== null) throw new ApiError(409, '보관된 워크스페이스에는 새 가입을 신청할 수 없습니다.')
    if (user.role === 'admin' || workspaces.role(id, user)) throw new ApiError(409, '이미 참여한 계정입니다.')
    const existing = db.prepare('SELECT * FROM lms_admissions WHERE workspace_id=? AND user_id=?').get(id, user.id)
    if (existing) throw new ApiError(409, '이미 신청한 워크스페이스입니다.')
    const applicationId = randomUUID()
    db.prepare("INSERT INTO lms_admissions(id,workspace_id,user_id,state,created_at) VALUES(?,?,?,'pending',?)").run(applicationId, id, user.id, now())
    return { id: applicationId, state: 'pending' }
  }
  function own(user) {
    return db.prepare('SELECT a.id,a.workspace_id AS workspaceId,w.name AS workspaceName,a.state,a.created_at AS createdAt,a.reason,a.invite_state AS inviteState,a.invite_code AS inviteCode,a.invite_expires AS inviteExpires FROM lms_admissions a JOIN lms_workspaces w ON w.id=a.workspace_id WHERE a.user_id=? ORDER BY a.created_at DESC').all(user.id).map(row => {
      const { inviteCode, ...result } = row
      return { ...result, inviteUrl: row.state === 'approved' && inviteCode && row.inviteExpires > now() ? `https://discord.gg/${inviteCode}` : null }
    })
  }
  function reviewList(id, user) {
    workspaces.requireRole(id, user, ['admin', 'instructor'])
    return { guildIds: workspaces.metadata(id).guildIds, applications: db.prepare('SELECT a.id,u.name,u.username,a.state,a.created_at AS createdAt,a.reason,a.invite_state AS inviteState,a.guild_id AS guildId FROM lms_admissions a JOIN lms_users u ON u.id=a.user_id WHERE a.workspace_id=? ORDER BY a.created_at DESC').all(id) }
  }
  function review(id, applicationId, body, user) {
    workspaces.requireRole(id, user, ['admin', 'instructor'])
    const input = z.object({ action: z.enum(['approve', 'reject']), guildId: z.union([snowflake, z.literal('')]).default(''), reason: z.string().trim().max(300).default('') }).strict().parse(body)
    const row = db.prepare('SELECT * FROM lms_admissions WHERE id=? AND workspace_id=?').get(applicationId, id)
    if (!row) throw new ApiError(404, '가입 신청을 찾을 수 없습니다.')
    if (row.state !== 'pending') throw new ApiError(409, '이미 처리한 신청입니다.')
    if (input.action === 'approve') {
      if (!workspaces.metadata(id).guildIds.includes(input.guildId)) throw new ApiError(422, '이 워크스페이스에 연결된 Discord 서버를 선택하세요.')
      db.prepare("UPDATE lms_admissions SET state='approved',reviewed_by=?,reviewed_at=?,guild_id=?,invite_state='queued',reason=? WHERE id=? AND state='pending'").run(user.id, now(), input.guildId, input.reason, row.id)
    } else db.prepare("UPDATE lms_admissions SET state='rejected',reviewed_by=?,reviewed_at=?,reason=? WHERE id=? AND state='pending'").run(user.id, now(), input.reason, row.id)
    return { ok: true }
  }
  function approved(applicationId, user) {
    const row = db.prepare('SELECT * FROM lms_admissions WHERE id=? AND user_id=?').get(applicationId, user.id)
    if (!row || row.state !== 'approved') throw new ApiError(403, '승인된 가입 신청이 필요합니다.')
    return row
  }
  function renew(applicationId, user) {
    const row = approved(applicationId, user)
    if (['queued', 'running'].includes(row.invite_state) || (row.invite_code && row.invite_expires > now())) throw new ApiError(409, '발급 중이거나 사용 가능한 초대 링크가 있습니다.')
    db.prepare("UPDATE lms_admissions SET invite_state='queued',invite_code=NULL,invite_expires=NULL,claim_hash=NULL,lease_until=NULL WHERE id=?").run(row.id)
    return { ok: true }
  }
  function activate(discordId, guildId) {
    const user = db.prepare('SELECT id FROM lms_users WHERE discord_id=? AND guild_id=? AND verified_at IS NOT NULL').get(discordId, guildId)
    if (!user) return
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of db.prepare("SELECT * FROM lms_admissions WHERE user_id=? AND guild_id=? AND state='approved'").all(user.id, guildId)) {
        db.prepare("INSERT OR IGNORE INTO lms_workspace_members VALUES(?,?,'student',?)").run(row.workspace_id, user.id, now())
        db.prepare("UPDATE lms_admissions SET state='joined',invite_code=NULL,invite_expires=NULL WHERE id=?").run(row.id)
      }
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function expire() { db.prepare("UPDATE lms_admissions SET invite_state='failed' WHERE invite_state='running' AND lease_until<=?").run(now()) }
  function authorized(header = '') { return token.length >= 32 && timingSafeEqual(Buffer.from(digest(header)), Buffer.from(digest(`Bearer ${token}`))) }
  function poll(body) {
    const { guildIds } = z.object({ guildIds: z.array(snowflake).max(10000) }).strict().parse(body)
    expire()
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db.prepare("SELECT * FROM lms_admissions WHERE state='approved' AND invite_state='queued' AND guild_id IN (SELECT value FROM json_each(?)) ORDER BY reviewed_at LIMIT 1").get(JSON.stringify(guildIds))
      let job = null
      if (row) {
        const claim = randomBytes(32).toString('hex')
        db.prepare("UPDATE lms_admissions SET invite_state='running',claim_hash=?,lease_until=? WHERE id=?").run(digest(claim), now() + 120000, row.id)
        job = { id: row.id, claim, guildId: row.guild_id }
      }
      db.exec('COMMIT'); return { job }
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function complete(body) {
    const input = z.object({ id: z.string().uuid(), claim: z.string().regex(/^[a-f0-9]{64}$/), code: z.string().regex(/^[a-zA-Z0-9_-]{2,100}$/).nullable(), success: z.boolean() }).strict().parse(body)
    expire()
    const row = db.prepare("SELECT * FROM lms_admissions WHERE id=? AND invite_state='running' AND state='approved'").get(input.id)
    if (!row || row.claim_hash !== digest(input.claim)) throw new ApiError(409, '초대 발급 작업이 만료됐습니다.')
    if (input.success && !input.code) throw new ApiError(422, '발급한 초대 코드가 필요합니다.')
    db.prepare('UPDATE lms_admissions SET invite_state=?,invite_code=?,invite_expires=?,claim_hash=NULL,lease_until=NULL WHERE id=?').run(input.success ? 'ready' : 'failed', input.success ? input.code : null, input.success ? now() + 23 * 3600000 : null, input.id)
    return { ok: true }
  }
  return { catalogue, apply, own, reviewList, review, approved, renew, activate, authorized, poll, complete }
}

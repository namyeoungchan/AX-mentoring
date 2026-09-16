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
  if (!db.prepare('PRAGMA table_info(lms_admissions)').all().some(row => row.name === 'purpose')) db.exec("ALTER TABLE lms_admissions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'student'")
  if (!db.prepare('PRAGMA table_info(lms_admissions)').all().some(row => row.name === 'team_id')) db.exec("ALTER TABLE lms_admissions ADD COLUMN team_id TEXT NOT NULL DEFAULT ''")
  function availableTeams(id, user) {
    const data = workspaces.snapshot(id)
    const scope = workspaces.role(id, user) === 'instructor' ? workspaces.mentorScope(id, user.id) : null
    return data.teams.filter(t => !scope || scope.mentorType === 'main' || scope.teamIds.includes(t.id))
      .map(t => ({ id: t.id, name: t.name, courseId: t.courseId, courseTitle: data.courses.find(c => c.id === t.courseId)?.title || '' }))
  }
  function syncLearner(row, team, account, active = false) {
    const data = workspaces.snapshot(row.workspace_id)
    const discordId = active ? account.discord_id : ''
    const existing = data.learners.find(l => l.id === `admission-${row.id}`) ||
      (account.verified_at !== null && data.learners.find(l => l.discordId === account.discord_id))
    const learner = { ...(existing || { id: `admission-${row.id}`, email: '', progress: 0, color: 'sage' }),
      name: account.name, discordId: discordId || existing?.discordId || '', courseId: team.courseId, team: team.name,
      status: active ? '정상' : existing?.status || '대기' }
    workspaces.mutate(row.workspace_id, { revision: data.revision, changes: [{ kind: 'learners', value: learner }] }, active ? 'admission-verification' : 'admission-approval')
  }
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
  function staffInvite(id, user) {
    workspaces.requireRole(id, user, ['admin', 'instructor'])
    const guilds = workspaces.metadata(id).guildIds
    if (guilds.length !== 1) throw new ApiError(409, '관리자가 Discord 서버를 먼저 연결해야 합니다.')
    const existing = db.prepare('SELECT * FROM lms_admissions WHERE workspace_id=? AND user_id=?').get(id, user.id)
    if (existing && (['queued', 'running'].includes(existing.invite_state) || (existing.state === 'approved' && existing.invite_code && existing.invite_expires > now()))) return
    db.prepare(`INSERT INTO lms_admissions(id,workspace_id,user_id,state,created_at,reviewed_by,reviewed_at,guild_id,invite_state,purpose)
      VALUES(?,?,?,'approved',?,?,?,?, 'queued','staff') ON CONFLICT(workspace_id,user_id) DO UPDATE SET state='approved',purpose='staff',guild_id=excluded.guild_id,invite_state='queued',invite_code=NULL,invite_expires=NULL,claim_hash=NULL,lease_until=NULL`).run(randomUUID(), id, user.id, now(), user.id, now(), guilds[0])
  }
  function reviewList(id, user) {
    workspaces.requireRole(id, user, ['admin', 'instructor'])
    return { guildIds: workspaces.metadata(id).guildIds, teams: availableTeams(id, user), applications: db.prepare("SELECT a.id,u.name,u.username,a.state,a.created_at AS createdAt,a.reason,a.invite_state AS inviteState,a.guild_id AS guildId,a.team_id AS teamId FROM lms_admissions a JOIN lms_users u ON u.id=a.user_id WHERE a.workspace_id=? AND a.purpose='student' ORDER BY a.created_at DESC").all(id) }
  }
  function review(id, applicationId, body, user) {
    workspaces.requireRole(id, user, ['admin', 'instructor'])
    const input = z.object({ action: z.enum(['approve', 'reject']), guildId: z.union([snowflake, z.literal('')]).default(''), reason: z.string().trim().max(300).default(''), teamId: z.string().max(200).default('') }).strict().parse(body)
    const row = db.prepare('SELECT * FROM lms_admissions WHERE id=? AND workspace_id=?').get(applicationId, id)
    if (!row) throw new ApiError(404, '가입 신청을 찾을 수 없습니다.')
    const needsTeam = ['approved', 'joined'].includes(row.state) && row.purpose === 'student' && !row.team_id && input.action === 'approve'
    if (row.state !== 'pending' && !needsTeam) throw new ApiError(409, '이미 처리한 신청입니다.')
    if (input.action === 'approve') {
      if (!workspaces.metadata(id).guildIds.includes(input.guildId)) throw new ApiError(422, '이 워크스페이스에 연결된 Discord 서버를 선택하세요.')
      const team = availableTeams(id, user).find(t => t.id === input.teamId)
      if (!team) throw new ApiError(422, '승인할 수강생의 담당 팀을 반드시 선택하세요.')
      const account = db.prepare('SELECT * FROM lms_users WHERE id=?').get(row.user_id)
      syncLearner(row, team, account, row.state === 'joined')
      if (needsTeam) {
        db.prepare('UPDATE lms_admissions SET team_id=?,reviewed_by=?,reviewed_at=? WHERE id=?').run(input.teamId, user.id, now(), row.id)
        return { ok: true }
      }
      db.prepare("UPDATE lms_admissions SET state='approved',reviewed_by=?,reviewed_at=?,guild_id=?,invite_state='queued',reason=?,team_id=? WHERE id=? AND state='pending'").run(user.id, now(), input.guildId, input.reason, input.teamId, row.id)
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
    const user = db.prepare('SELECT * FROM lms_users WHERE discord_id=? AND guild_id=? AND verified_at IS NOT NULL').get(discordId, guildId)
    if (!user) return
    const approvedRows = db.prepare("SELECT * FROM lms_admissions WHERE user_id=? AND guild_id=? AND state='approved'").all(user.id, guildId)
    // Materialize the approved assignment before granting membership. This is
    // idempotent if a later registry write fails; no role is granted prematurely.
    for (const row of approvedRows.filter(a => a.purpose === 'student')) {
      const data = workspaces.snapshot(row.workspace_id)
      const team = data.teams.find(t => t.id === row.team_id)
      if (!team) throw new ApiError(422, '승인된 팀이 없습니다. 운영자에게 팀 배정을 요청하세요.')
      syncLearner(row, team, user, true)
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of approvedRows) {
        if (row.purpose === 'student') db.prepare("INSERT OR IGNORE INTO lms_workspace_members VALUES(?,?,'student',?)").run(row.workspace_id, user.id, now())
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
  return { catalogue, apply, own, staffInvite, reviewList, review, approved, renew, activate, authorized, poll, complete }
}

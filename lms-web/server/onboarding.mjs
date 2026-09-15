import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ApiError } from './store.mjs'

const snowflake = z.string().regex(/^\d{17,20}$/)
const channelName = z.string().trim().min(1).max(70).regex(/^[\p{L}\p{N}_-]+$/u)
const settings = z.object({ guildId: snowflake, enabled: z.boolean(), courseIds: z.array(z.string().min(1).max(100)).max(50), welcomeText: z.string().trim().min(1).max(1500), onboardingChannel: channelName, introChannel: channelName, revision: z.string().max(64) }).strict()
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const defaults = { enabled: false, courseIds: [], welcomeText: '서버 이용 순서\n1. 웹에서 가입 승인 상태와 Discord 인증을 확인하세요.\n2. 아래 버튼으로 자기소개를 작성하세요.\n3. 웹에 배정된 팀과 채널을 확인하세요.\n팀 배정은 운영자가 관리합니다. 미배정 상태라면 운영자에게 문의하세요.', onboardingChannel: '시작하기', introChannel: '자기소개' }

export function createOnboarding(db, workspaces, provision, { now = Date.now } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS lms_onboarding_settings(guild_id TEXT PRIMARY KEY REFERENCES lms_workspace_guilds(guild_id), data TEXT NOT NULL, revision TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lms_onboarding_reports(guild_id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL, error TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS lms_onboarding_members(guild_id TEXT NOT NULL, discord_id TEXT NOT NULL, intro_done INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(guild_id,discord_id));`)
  function owner(guildId) { return db.prepare('SELECT workspace_id FROM lms_workspace_guilds WHERE guild_id=?').get(guildId)?.workspace_id }
  function config(guildId) {
    const row = db.prepare('SELECT * FROM lms_onboarding_settings WHERE guild_id=?').get(guildId)
    return row ? { guildId, ...JSON.parse(row.data), revision: row.revision } : { guildId, ...defaults, revision: digest({ guildId, ...defaults }) }
  }
  function read(id) {
    const meta = workspaces.metadata(id), data = workspaces.snapshot(id)
    return { guildIds: meta.guildIds, courses: data.courses.map(c => ({ id: c.id, title: c.title })),
      teams: data.teams.map(t => ({ ...t, members: data.learners.filter(l => l.courseId === t.courseId && l.team === t.name && l.status === '정상').length })),
      configs: meta.guildIds.map(guildId => ({ ...config(guildId), report: db.prepare('SELECT revision,state,error,updated_at AS updatedAt FROM lms_onboarding_reports WHERE guild_id=?').get(guildId) || null,
        progress: db.prepare('SELECT discord_id AS discordId,intro_done AS introDone,updated_at AS updatedAt FROM lms_onboarding_members WHERE guild_id=?').all(guildId) })) }
  }
  function save(id, body) {
    const input = settings.parse(body)
    if (owner(input.guildId) !== id) throw new ApiError(403, '이 워크스페이스의 Discord 서버를 선택하세요.')
    if (input.onboardingChannel === input.introChannel) throw new ApiError(422, '시작 안내와 자기소개 채널 이름을 다르게 입력하세요.')
    const data = workspaces.snapshot(id)
    if (new Set(input.courseIds).size !== input.courseIds.length || input.courseIds.some(course => !data.courses.some(c => c.id === course))) throw new ApiError(422, '이 워크스페이스의 과정을 선택하세요.')
    if (data.teams.filter(t => input.courseIds.includes(t.courseId)).length > 50) throw new ApiError(422, 'Discord 서버당 최대 50개 팀을 연결할 수 있습니다.')
    db.exec('BEGIN IMMEDIATE')
    try {
      if (config(input.guildId).revision !== input.revision) throw new ApiError(409, '다른 관리자가 설정을 변경했습니다. 새로고침하세요.')
      const { guildId, revision: _revision, ...value } = input
      db.prepare('INSERT INTO lms_onboarding_settings VALUES(?,?,?) ON CONFLICT(guild_id) DO UPDATE SET data=excluded.data,revision=excluded.revision').run(guildId, JSON.stringify(value), digest({ guildId, ...value }))
      db.prepare('DELETE FROM lms_onboarding_reports WHERE guild_id=?').run(guildId)
      db.exec('COMMIT')
      return read(id)
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function bundle(guildId) {
    const id = owner(guildId)
    if (!id) return null
    const cfg = config(guildId)
    if (!cfg.enabled) return { guildId, enabled: false, revision: cfg.revision }
    const data = workspaces.snapshot(id)
    const teams = data.teams.filter(t => cfg.courseIds.includes(t.courseId)).map(t => ({ id: t.id, name: t.name, courseId: t.courseId }))
    if (teams.length > 50) return { guildId, enabled: true, error: 'team_limit', revision: digest({ ...cfg, teamCount: teams.length }) }
    const memberships = db.prepare('SELECT u.discord_id AS discordId,u.name,m.role FROM lms_workspace_members m JOIN lms_users u ON u.id=m.user_id WHERE m.workspace_id=? AND u.verified_at IS NOT NULL').all(id)
    const participants = memberships.filter(m => m.role !== 'student').map(m => ({ ...m, teamId: '' }))
    for (const learner of data.learners.filter(l => cfg.courseIds.includes(l.courseId) && l.discordId && l.status === '정상')) {
      const member = memberships.find(m => m.discordId === learner.discordId)
      if (!member || participants.some(p => p.discordId === learner.discordId)) continue
      participants.push({ discordId: learner.discordId, name: learner.name, role: member.role, teamId: teams.find(t => t.courseId === learner.courseId && t.name === learner.team)?.id || '' })
    }
    const channels = provision.read([guildId]).plans[0]?.channels || []
    const value = { ...cfg, workspaceName: data.name, teams, participants, channels }
    return { ...value, revision: digest(value) }
  }
  function poll(body) {
    const { guildIds } = z.object({ guildIds: z.array(snowflake).max(10000) }).strict().parse(body)
    return { configs: [...new Set(guildIds)].map(bundle).filter(Boolean) }
  }
  function report(body) {
    const input = z.object({ guildId: snowflake, revision: z.string().length(64), state: z.enum(['ready', 'failed', 'disabled']), error: z.enum(['', 'permissions', 'role_hierarchy', 'discord_error', 'api_error', 'conflict', 'team_limit']) }).strict().parse(body)
    if (!owner(input.guildId)) throw new ApiError(404, '연결된 서버가 아닙니다.')
    if (bundle(input.guildId).revision !== input.revision) throw new ApiError(409, '설정이 변경되었습니다. 최신 설정을 가져오세요.')
    db.prepare('INSERT INTO lms_onboarding_reports VALUES(?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,error=excluded.error,updated_at=excluded.updated_at').run(input.guildId, input.revision, input.state, input.error, now())
    return { ok: true }
  }
  function progress(body) {
    const input = z.object({ guildId: snowflake, discordId: snowflake }).strict().parse(body)
    if (!owner(input.guildId) || !config(input.guildId).enabled) throw new ApiError(403, '온보딩을 사용할 수 없는 서버입니다.')
    db.prepare('INSERT INTO lms_onboarding_members VALUES(?,?,1,?) ON CONFLICT(guild_id,discord_id) DO UPDATE SET intro_done=1,updated_at=excluded.updated_at').run(input.guildId, input.discordId, now())
    return { ok: true }
  }
  return { read, save, poll, report, progress }
}

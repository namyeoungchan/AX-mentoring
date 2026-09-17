import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ApiError } from './store.mjs'
import { workspaceVerified } from './workspace-verification.mjs'

export const mentorGuides = [
  { id: 'assignments', title: '과제 생성', text: '아래 과제 만들기에서 과정, 제목, 마감일을 입력하세요. 과제는 선택한 과정 전체에 공개됩니다. 생성한 과제는 Discord 과제제출 패널에도 반영되며 수강생이 제출할 수 있습니다.' },
  { id: 'approval', title: '멘토링 예약 승인', text: 'Discord에서 /멘토 설정을 실행하고 시간대와 예약 슬롯을 만드세요. 수강생이 멘토링예약 채널에서 신청하면 봇의 개인 메시지로 승인·거절 요청을 받습니다. 서버 개인 메시지를 허용하고, 일정과 요청 내용을 확인한 뒤 승인하거나 사유를 적어 거절하세요.' },
  { id: 'mentoring', title: '멘토링 진행', text: '확정된 시간에 담당 조의 음성 채널에서 멘토링을 진행하세요. 시작 전에 질문과 과제 내용을 확인하고, 종료 시 피드백과 다음 할 일을 조별 대화 채널에 남기세요. 일정 변경이 필요하면 수강생과 조율하고 기존 예약을 취소한 뒤 다시 예약하도록 안내하세요.' },
]

export function createStaffFlow(db, workspaces, onboarding, admissions, { now = Date.now } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS lms_staff_profiles (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, expertise TEXT NOT NULL, bio TEXT NOT NULL, steps TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,user_id));
    CREATE TABLE IF NOT EXISTS lms_group_setup (workspace_id TEXT PRIMARY KEY, course_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lms_staff_connections (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, discord_id TEXT NOT NULL, PRIMARY KEY(workspace_id,user_id));`)
  function active(id) { if (workspaces.metadata(id).archivedAt !== null) throw new ApiError(409, '보관된 워크스페이스입니다.') }
  function enableTeams(id) {
    const selected = db.prepare('SELECT course_id FROM lms_group_setup WHERE workspace_id=?').get(id)
    if (!selected) return
    for (const value of onboarding.read(id).configs) {
      const { report: _report, progress: _progress, ...cfg } = value
      onboarding.save(id, { ...cfg, enabled: true, courseIds: [...new Set([...cfg.courseIds, selected.course_id])] })
    }
  }
  function groups(id) {
    const data = workspaces.snapshot(id)
    return { courses: data.courses.map(c => ({ id: c.id, title: c.title })), teams: data.teams, courseId: db.prepare('SELECT course_id FROM lms_group_setup WHERE workspace_id=?').get(id)?.course_id || '', revision: data.revision }
  }
  function setupGroups(id, body, user) {
    workspaces.requireRole(id, user, ['admin']); active(id)
    const input = z.object({ count: z.number().int().min(1).max(50), courseId: z.string().default(''), title: z.string().trim().min(1).max(100).default('기본 교육 과정'), revision: z.string() }).strict().parse(body)
    const data = workspaces.snapshot(id), changes = []
    if (data.revision !== input.revision) throw new ApiError(409, '운영 정보가 변경됐습니다. 새로고침하세요.')
    const selected = input.courseId || db.prepare('SELECT course_id FROM lms_group_setup WHERE workspace_id=?').get(id)?.course_id
    const courseId = selected || `initial-${id}`
    if (selected && !data.courses.some(c => c.id === courseId)) throw new ApiError(422, '이 워크스페이스의 과정을 선택하세요.')
    // Stable identity recovers a retry after the workspace DB committed but the registry did not.
    if (!data.courses.some(c => c.id === courseId)) {
      const date = new Date(now()).toISOString().slice(0, 10)
      changes.push({ kind: 'courses', value: { id: courseId, title: input.title, category: 'AX', description: '워크스페이스 초기 운영 과정', progress: 0, learners: 0, weeks: '미정', mentor: '', theme: 'green', status: '모집 중', code: 'AX-' + id.slice(0, 8), cohort: '1기', guildId: '', startDate: date, endDate: date } })
    }
    const teams = data.teams.filter(t => t.courseId === courseId)
    if (teams.length > input.count) throw new ApiError(409, '기존 조는 자동 삭제하지 않습니다. 현재 조 수 이상으로 설정하세요.')
    const selectedCourses = new Set([courseId, ...onboarding.read(id).configs.flatMap(c => c.courseIds)])
    if (data.teams.filter(t => selectedCourses.has(t.courseId)).length + input.count - teams.length > 50) throw new ApiError(422, '연결된 과정의 전체 조 수는 최대 50개입니다.')
    for (let number = 1; teams.length + changes.filter(c => c.kind === 'teams').length < input.count; number++) {
      if (teams.some(t => t.code === `TEAM-${number}` || t.name === `${number}조`)) continue
      changes.push({ kind: 'teams', value: { id: randomUUID(), name: `${number}조`, code: `TEAM-${number}`, courseId, mentorId: '' } })
    }
    if (changes.length) workspaces.mutate(id, { revision: input.revision, changes }, user.username)
    db.prepare('INSERT INTO lms_group_setup VALUES(?,?) ON CONFLICT(workspace_id) DO UPDATE SET course_id=excluded.course_id').run(id, courseId)
    enableTeams(id)
    return groups(id)
  }
  function syncMentor(id, userId) {
    const profile = db.prepare('SELECT p.*,u.discord_id,u.verified_at FROM lms_staff_profiles p JOIN lms_users u ON u.id=p.user_id WHERE p.workspace_id=? AND p.user_id=?').get(id, userId)
    if (!profile || !workspaceVerified(db, id, userId) || !/^\d{17,20}$/.test(profile.discord_id)) return
    if (workspaces.role(id, { id: userId }) !== 'instructor') return
    const target = workspaces.open(id).db
    const mentor = target.prepare('SELECT id FROM mentors WHERE discord_id=?').get(profile.discord_id)
    const bio = `${profile.expertise}\n${profile.bio}`.trim()
    if (mentor) target.prepare('UPDATE mentors SET name=?,bio=?,is_active=1 WHERE id=?').run(profile.name, bio, mentor.id)
    else target.prepare('INSERT INTO mentors(name,discord_id,bio) VALUES(?,?,?)').run(profile.name, profile.discord_id, bio)
  }
  function syncDiscord(discordId, guildId) {
    const rows = db.prepare('SELECT m.workspace_id,m.user_id FROM lms_workspace_members m JOIN lms_users u ON u.id=m.user_id JOIN lms_workspace_guilds g ON g.workspace_id=m.workspace_id WHERE u.discord_id=? AND g.guild_id=?').all(discordId, guildId)
    for (const row of rows) {
      if (!workspaceVerified(db, row.workspace_id, row.user_id, guildId)) continue
      db.prepare('INSERT INTO lms_staff_connections VALUES(?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET discord_id=excluded.discord_id').run(row.workspace_id, row.user_id, discordId)
      syncMentor(row.workspace_id, row.user_id)
    }
  }
  function read(id, user) {
    workspaces.requireRole(id, user, ['admin', 'instructor'])
    const profile = db.prepare('SELECT name,expertise,bio,steps FROM lms_staff_profiles WHERE workspace_id=? AND user_id=?').get(id, user.id)
    const guildId = workspaces.metadata(id).guildIds[0] || ''
    const verified = Boolean(guildId && workspaceVerified(db, id, user.id, guildId))
    const invitation = admissions.own(user).find(a => a.workspaceId === id) || null
    const steps = profile ? JSON.parse(profile.steps) : []
    return { profile: profile ? { ...profile, steps } : null, guildId, verified, invitation,
      completed: Boolean(profile && verified && mentorGuides.every(guide => steps.includes(guide.id))),
      ...workspaces.mentorScope(id, user.id), teams: workspaces.snapshot(id).teams.map(t => ({ id: t.id, name: t.name })), guides: mentorGuides }
  }
  function profile(id, body, user) {
    workspaces.requireRole(id, user, ['admin', 'instructor']); active(id)
    const input = z.object({ name: z.string().trim().min(1).max(50), expertise: z.string().trim().min(1).max(150), bio: z.string().trim().max(800).optional() }).strict().parse(body)
    input.bio ??= db.prepare('SELECT bio FROM lms_staff_profiles WHERE workspace_id=? AND user_id=?').get(id, user.id)?.bio || ''
    db.prepare("INSERT INTO lms_staff_profiles(workspace_id,user_id,name,expertise,bio,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET name=excluded.name,expertise=excluded.expertise,bio=excluded.bio,updated_at=excluded.updated_at").run(id, user.id, input.name, input.expertise, input.bio, now())
    syncMentor(id, user.id)
    if (workspaces.metadata(id).guildIds.length && !read(id, user).verified) admissions.staffInvite(id, user)
    return read(id, user)
  }
  function invite(id, user) {
    workspaces.requireRole(id, user, ['admin', 'instructor']); active(id)
    if (!read(id, user).profile) throw new ApiError(422, '기본 정보를 먼저 입력하세요.')
    admissions.staffInvite(id, user)
    return read(id, user)
  }
  function step(id, body, user) {
    const state = read(id, user); active(id)
    const { step } = z.object({ step: z.enum(['assignments', 'approval', 'mentoring']) }).strict().parse(body)
    if (!state.profile || !state.verified) throw new ApiError(409, '기본 정보와 Discord 인증을 먼저 완료하세요.')
    const position = mentorGuides.findIndex(g => g.id === step)
    if (mentorGuides.slice(0, position).some(g => !state.profile.steps.includes(g.id))) throw new ApiError(409, '앞 단계 안내를 먼저 확인하세요.')
    db.prepare('UPDATE lms_staff_profiles SET steps=?,updated_at=? WHERE workspace_id=? AND user_id=?').run(JSON.stringify([...new Set([...state.profile.steps, step])]), now(), id, user.id)
    return read(id, user)
  }
  function members(id, user) {
    const result = workspaces.members(id, user)
    result.members = result.members.map(member => ({ ...member, expertise: '', ...db.prepare('SELECT name,expertise FROM lms_staff_profiles WHERE workspace_id=? AND user_id=?').get(id, member.id) }))
    return result
  }
  function managedMember(id, memberId, user) {
    workspaces.requireRole(id, user, ['admin']); active(id)
    const member = db.prepare('SELECT u.id,u.username,u.discord_id,m.role FROM lms_workspace_members m JOIN lms_users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id=?').get(id, memberId)
    if (!member || !['admin', 'instructor'].includes(member.role)) throw new ApiError(404, '워크스페이스 운영 구성원을 찾을 수 없습니다.')
    if (member.role === 'admin' && user.role !== 'admin') throw new ApiError(403, '워크스페이스 관리자는 총괄 관리자만 수정·삭제할 수 있습니다.')
    return member
  }
  function disableMentor(target, discordId) {
    // Preserve bookings and mentor identity for history; close future booking access.
    target.prepare('UPDATE slots SET is_active=0 WHERE mentor_id IN (SELECT id FROM mentors WHERE discord_id=?)').run(discordId)
    target.prepare('UPDATE mentors SET is_active=0 WHERE discord_id=?').run(discordId)
  }
  function editMember(id, memberId, body, user) {
    const member = managedMember(id, memberId, user)
    const input = z.object({ name: z.string().trim().min(1).max(50), expertise: z.string().trim().max(150), role: z.enum(['admin', 'instructor']), mentorType: z.enum(['main', 'group']).default('main'), teamIds: z.array(z.string()).max(50).default([]) }).strict().parse(body)
    if (input.role === 'admin' && user.role !== 'admin') throw new ApiError(403, '워크스페이스 관리자 지정은 총괄 관리자만 할 수 있습니다.')
    const scope = workspaces.validateScope(id, input.role === 'instructor' ? { mentorType: input.mentorType, teamIds: input.teamIds } : {})
    const target = workspaces.open(id).db
    db.exec('BEGIN IMMEDIATE')
    try {
      if (target !== db) target.exec('BEGIN IMMEDIATE')
      db.prepare('UPDATE lms_workspace_members SET role=? WHERE workspace_id=? AND user_id=?').run(input.role, id, memberId)
      db.prepare("INSERT INTO lms_staff_profiles(workspace_id,user_id,name,expertise,bio,updated_at) VALUES(?,?,?,?,'',?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET name=excluded.name,expertise=excluded.expertise,updated_at=excluded.updated_at").run(id, memberId, input.name, input.expertise, now())
      db.prepare('INSERT INTO lms_mentor_scopes VALUES(?,?,?,?) ON CONFLICT(workspace_id,subject_id) DO UPDATE SET kind=excluded.kind,team_ids=excluded.team_ids').run(id, memberId, scope.mentorType, JSON.stringify(scope.teamIds))
      if (input.role === 'instructor') syncMentor(id, memberId)
      else disableMentor(target, member.discord_id)
      db.prepare('INSERT INTO lms_audit(actor,action,target,before_json,after_json) VALUES(?,?,?,?,?)').run(user.username, 'member.update', `${id}/${memberId}`, JSON.stringify(member), JSON.stringify(input))
      if (target !== db) target.exec('COMMIT'); db.exec('COMMIT')
    } catch (error) { if (target.isTransaction) target.exec('ROLLBACK'); if (db.isTransaction) db.exec('ROLLBACK'); throw error }
    return members(id, user)
  }
  function removeMember(id, memberId, user) {
    const member = managedMember(id, memberId, user), target = workspaces.open(id).db
    db.exec('BEGIN IMMEDIATE')
    try {
      if (target !== db) target.exec('BEGIN IMMEDIATE')
      disableMentor(target, member.discord_id)
      db.prepare('DELETE FROM lms_workspace_members WHERE workspace_id=? AND user_id=?').run(id, memberId)
      db.prepare('DELETE FROM lms_mentor_scopes WHERE workspace_id=? AND subject_id=?').run(id, memberId)
      db.prepare('DELETE FROM lms_staff_connections WHERE workspace_id=? AND user_id=?').run(id, memberId)
      db.prepare('DELETE FROM lms_workspace_verifications WHERE workspace_id=? AND user_id=?').run(id, memberId)
      db.prepare('DELETE FROM lms_registrations WHERE workspace_id=? AND user_id=?').run(id, memberId)
      db.prepare('UPDATE lms_workspace_invitations SET revoked_at=? WHERE workspace_id=? AND username=? AND accepted_at IS NULL AND revoked_at IS NULL').run(now(), id, member.username)
      db.prepare("UPDATE lms_admissions SET state='rejected',invite_state='none',invite_code=NULL,invite_expires=NULL,claim_hash=NULL,lease_until=NULL,reason='워크스페이스 구성원에서 제외되었습니다.' WHERE workspace_id=? AND user_id=? AND purpose='staff'").run(id, memberId)
      db.prepare('INSERT INTO lms_audit(actor,action,target,before_json,after_json) VALUES(?,?,?,?,?)').run(user.username, 'member.remove', `${id}/${memberId}`, JSON.stringify(member), null)
      if (target !== db) target.exec('COMMIT'); db.exec('COMMIT')
    } catch (error) { if (target.isTransaction) target.exec('ROLLBACK'); if (db.isTransaction) db.exec('ROLLBACK'); throw error }
    return members(id, user)
  }
  return { groups, setupGroups, enableTeams, read, profile, invite, step, syncDiscord, members, editMember, removeMember }
}

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ApiError } from './store.mjs'

const koreanDate = ms => new Date(ms + 9 * 3600000).toISOString().slice(0, 10)
export function createAssignmentAlerts(main, workspaces, { now = Date.now } = {}) {
  function roster(id) {
    const db = workspaces.open(id).db, data = workspaces.snapshot(id)
    const assignments = db.prepare('SELECT a.*,c.course_id FROM assignments a LEFT JOIN lms_assignment_courses c ON c.assignment_id=a.id ORDER BY a.id DESC').all()
    const submissions = db.prepare('SELECT id,assignment_id,user_id,user_name,team,submitted_at FROM submissions').all()
    return assignments.map(a => {
      const learners = data.learners.filter(l => l.courseId === a.course_id && l.status === '정상')
      const rows = submissions.filter(s => s.assignment_id === a.id)
      // Freeze known team identities so later team renames do not turn old work into missing work.
      for (const s of rows) {
        const team = data.teams.find(t => t.courseId === a.course_id && t.name === s.team)
        const target = a.type === 'team' ? team ? `team:${team.id}` : '' : `user:${s.user_id}`
        if (target) db.prepare('INSERT OR IGNORE INTO lms_submission_targets VALUES(?,?)').run(s.id, target)
      }
      const mapped = db.prepare('SELECT t.submission_id,t.target_key FROM lms_submission_targets t JOIN submissions s ON s.id=t.submission_id WHERE s.assignment_id=?').all(a.id)
      const completed = new Set(mapped.map(r => r.target_key))
      const targets = a.type === 'team'
        ? data.teams.filter(t => t.courseId === a.course_id && learners.some(l => l.team === t.name)).map(t => ({ key: `team:${t.id}`, name: t.name, audience: 'team', targetId: t.id, completed: completed.has(`team:${t.id}`) }))
        : learners.map(l => ({ key: l.discordId ? `user:${l.discordId}` : `learner:${l.id}`, name: l.name, audience: 'individual', targetId: l.discordId, completed: !!l.discordId && completed.has(`user:${l.discordId}`) }))
      return { id: String(a.id), title: a.title, dueDate: a.due_date.slice(0, 10), active: !!a.is_active, type: a.type, courseId: a.course_id || '', targets, submitted: targets.filter(t => t.completed).length, total: targets.length, unmatchedSubmissions: rows.filter(s => !mapped.some(m => m.submission_id === s.id)).length }
    })
  }
  function read(id, user) {
    workspaces.requireRole(id, user, ['admin'])
    const db = workspaces.open(id).db
    return { courses: workspaces.snapshot(id).courses.map(c => ({ id: c.id, title: c.title })), policy: '개인별 1회 제출 유지 · 팀은 한 건 이상 제출하면 완료', assignments: roster(id),
      deliveries: db.prepare("SELECT id,kind,source_id AS assignmentId,state,attempts,error,message_id AS messageId,channel_id AS channelId,guild_id AS guildId,payload,created_at AS createdAt FROM lms_outbox WHERE kind IN ('submission','reminder') ORDER BY created_at DESC,rowid DESC LIMIT 200").all().map(r => ({ ...r, payload: JSON.parse(r.payload) })) }
  }
  function bind(id, assignmentId, body, user) {
    workspaces.requireRole(id, user, ['admin'])
    const { courseId } = z.object({ courseId: z.string().min(1).max(200) }).strict().parse(body)
    if (workspaces.metadata(id).archivedAt !== null) throw new ApiError(409, '보관된 워크스페이스입니다.')
    const db = workspaces.open(id).db
    if (!db.prepare('SELECT 1 FROM assignments WHERE id=?').get(assignmentId) || !workspaces.snapshot(id).courses.some(c => c.id === courseId)) throw new ApiError(422, '과제와 과정을 확인하세요.')
    db.exec('BEGIN IMMEDIATE')
    try {
      const previous = db.prepare('SELECT course_id FROM lms_assignment_courses WHERE assignment_id=?').get(assignmentId)
      if (previous && previous.course_id !== courseId) throw new ApiError(409, '이미 연결한 과제의 과정은 변경할 수 없습니다.')
      db.prepare('INSERT OR IGNORE INTO lms_assignment_courses VALUES(?,?)').run(assignmentId, courseId)
      db.prepare('INSERT INTO lms_audit(actor,action,target,after_json) VALUES(?,?,?,?)').run(user.username || user.id, 'assignment.bind', assignmentId, JSON.stringify({ courseId }))
      roster(id)
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    return read(id, user)
  }
  function prepare(id, resolveChannel) {
    const db = workspaces.open(id).db, guildId = workspaces.metadata(id).guildIds[0]
    if (!guildId) return
    db.exec('BEGIN IMMEDIATE')
    try {
      const assignments = roster(id), tomorrow = koreanDate(now() + 86400000), hour = new Date(now() + 9 * 3600000).getUTCHours()
      // Catch up after restart during D-1 from 09:00 KST, once per assignment/target/deadline.
      if (hour >= 9) for (const a of assignments.filter(a => a.active && a.courseId && a.dueDate === tomorrow)) for (const target of a.targets.filter(t => !t.completed)) {
        const payload = { title: '과제 마감 D-1 안내', description: `${a.title}\n마감: ${a.dueDate}\n${target.name}: 아직 제출된 과제가 없습니다. Web 제출 원장을 확인하세요.`, assignmentId: a.id, dueDate: a.dueDate, audience: target.audience, targetId: target.targetId, targetKey: target.key }
        db.prepare('INSERT OR IGNORE INTO lms_outbox(id,event_key,kind,source_id,guild_id,payload,actor,created_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), `reminder:${a.id}:${a.dueDate}:${target.key}`, 'reminder', a.id, guildId, JSON.stringify(payload), 'scheduler', now())
      }
      const resource = (key, kind = 'channel') => {
        const row = main.prepare('SELECT data FROM lms_runtime_state WHERE guild_id=? AND kind=? AND record_key=?').get(guildId, kind, key)
        return row ? String(JSON.parse(row.data).id || '') : ''
      }
      for (const row of db.prepare("SELECT * FROM lms_outbox WHERE kind IN ('submission','reminder') AND state IN ('pending','failed')").all()) {
        let channelId = '', error = '', payload = JSON.parse(row.payload)
        if (row.kind === 'submission') {
          if (!assignments.some(a => a.id === row.source_id)) { db.prepare("UPDATE lms_outbox SET state='cancelled',error='assignment_removed' WHERE id=?").run(row.id); continue }
          try { channelId = resolveChannel(id, 'submission').channelId } catch { error = 'channel_unconfigured' }
        } else {
          const a = assignments.find(a => a.id === row.source_id), target = a?.targets.find(t => t.key === payload.targetKey)
          if (!a?.active || !target || target.completed || a.dueDate !== payload.dueDate || a.dueDate !== tomorrow) {
            db.prepare("UPDATE lms_outbox SET state='cancelled',error='no_longer_due' WHERE id=?").run(row.id); continue
          }
          if (payload.audience === 'team') {
            channelId = resource(`team-text:${payload.targetId}`)
            payload.roleId = resource(`team:${payload.targetId}`, 'role')
            if (!payload.roleId) channelId = ''
          } else {
            const verified = main.prepare('SELECT 1 FROM lms_workspace_verifications v JOIN lms_workspace_members m ON m.workspace_id=v.workspace_id AND m.user_id=v.user_id JOIN lms_users u ON u.id=v.user_id AND u.discord_id=v.discord_id WHERE v.workspace_id=? AND v.guild_id=? AND v.discord_id=?').get(id, guildId, payload.targetId || '')
            if (verified) channelId = `dm:${payload.targetId}`
          }
          if (!channelId) error = 'recipient_unavailable'
        }
        db.prepare('UPDATE lms_outbox SET guild_id=?,channel_id=?,payload=?,error=? WHERE id=?').run(guildId, channelId, JSON.stringify(payload), row.state === 'pending' ? error : row.error, row.id)
      }
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
  }
  return { read, bind, prepare }
}

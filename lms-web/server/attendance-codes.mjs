import { createHash, randomInt, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ApiError } from './store.mjs'
import { workspaceForGuild, workspaceVerified } from './workspace-verification.mjs'

const selection = z.object({ courseId: z.string().min(1).max(200), date: z.string().date(), period: z.coerce.number().int().min(1).max(100) })
const issueInput = selection.extend({ minutes: z.number().int().min(1).max(10).default(5) }).strict()
const checkInput = z.object({ guildId: z.string().regex(/^\d{17,20}$/), discordId: z.string().regex(/^\d{17,20}$/), code: z.string().trim().regex(/^\d{6}$/) }).strict()
const digest = code => createHash('sha256').update(code).digest('hex')

export function createAttendanceCodes(identityDb, workspaces, attendance, { now = Date.now, enabled = true } = {}) {
  function context(id, raw, user) {
    const selected = selection.parse(raw)
    const roster = attendance.view(id, selected, user)
    const meta = workspaces.metadata(id)
    if (meta.archivedAt !== null) throw new ApiError(409, '보관된 워크스페이스입니다.')
    return { selected, roster, meta, db: workspaces.open(id).db }
  }
  function status(id, raw, user) {
    const { selected: s, roster, meta, db } = context(id, raw, user)
    const row = db.prepare('SELECT id,expires_at AS expiresAt,revoked_at AS revokedAt FROM lms_attendance_codes WHERE course_id=? AND date=? AND period=? AND actor_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(s.courseId, s.date, s.period, user.id)
    return { enabled: enabled && meta.guildIds.length === 1 && roster.state === '진행 중' && roster.rows.some(r => r.enrollment === '정상'), botConfigured: enabled,
      scope: roster.canManage ? '과정 전체' : '담당 조', guildConnected: meta.guildIds.length === 1,
      active: row && row.expiresAt > now() && row.revokedAt === null && roster.state === '진행 중' ? { id: row.id, expiresAt: row.expiresAt } : null }
  }
  function issue(id, raw, user) {
    if (!enabled) throw new ApiError(409, 'Discord 인증 봇 연결을 설정하세요.')
    const input = issueInput.parse(raw), { roster, meta, db } = context(id, input, user)
    // Issuers must be durable accounts so revoking their role also invalidates their codes.
    if (!identityDb.prepare('SELECT 1 FROM lms_users WHERE id=?').get(user.id)) throw new ApiError(403, '개인 관리자 또는 멘토 계정으로 로그인하세요.')
    if (meta.guildIds.length !== 1) throw new ApiError(409, 'Discord 서버 하나를 연결하세요.')
    if (roster.state !== '진행 중') throw new ApiError(409, '관리자 또는 메인 강사가 회차를 시작한 뒤 코드를 발급하세요.')
    const students = roster.rows.filter(r => r.enrollment === '정상').map(r => r.studentId)
    if (!students.length) throw new ApiError(422, '코드를 사용할 정상 수강생이 없습니다.')
    db.exec('BEGIN IMMEDIATE')
    try {
      const timestamp = now()
      // Retain hashes for a day to avoid immediately reusing a recently expired code.
      db.prepare('DELETE FROM lms_attendance_codes WHERE expires_at<?').run(timestamp - 86400000)
      let code
      for (let attempts = 0; attempts < 30; attempts++) {
        const candidate = String(randomInt(0, 1000000)).padStart(6, '0')
        if (!db.prepare('SELECT 1 FROM lms_attendance_codes WHERE code_hash=?').get(digest(candidate))) { code = candidate; break }
      }
      if (!code) throw new ApiError(503, '코드를 생성하지 못했습니다. 다시 시도하세요.')
      db.prepare('UPDATE lms_attendance_codes SET revoked_at=? WHERE course_id=? AND date=? AND period=? AND actor_id=? AND revoked_at IS NULL').run(timestamp, input.courseId, input.date, input.period, user.id)
      const codeId = randomUUID(), expiresAt = timestamp + input.minutes * 60000
      db.prepare('INSERT INTO lms_attendance_codes VALUES(?,?,?,?,?,?,?,?,?,?,NULL)').run(codeId, digest(code), input.courseId, input.date, input.period, meta.guildIds[0], user.id, JSON.stringify(students), timestamp, expiresAt)
      db.prepare('INSERT INTO lms_audit(actor,action,target,after_json) VALUES(?,?,?,?)').run(user.username, 'attendance.code.issue', codeId, JSON.stringify({ ...input, expiresAt, students: students.length }))
      const result = { ...status(id, input, user), code }
      db.exec('COMMIT')
      return result
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function revoke(id, raw, user) {
    const { selected: s, db } = context(id, selection.strict().parse(raw), user)
    db.prepare('UPDATE lms_attendance_codes SET revoked_at=? WHERE course_id=? AND date=? AND period=? AND actor_id=? AND revoked_at IS NULL').run(now(), s.courseId, s.date, s.period, user.id)
    return status(id, s, user)
  }
  function checkIn(raw) {
    const input = checkInput.parse(raw), id = workspaceForGuild(identityDb, input.guildId)
    if (!id || workspaces.metadata(id).archivedAt !== null) throw new ApiError(403, '이 서버의 출석 등록을 사용할 수 없습니다.')
    const account = identityDb.prepare('SELECT id,username,platform_role AS role FROM lms_users WHERE discord_id=?').get(input.discordId)
    if (!account || workspaces.role(id, account) !== 'student' || !workspaceVerified(identityDb, id, account.id, input.guildId)) throw new ApiError(403, '이 서버에서 LMS 학생 계정의 Discord 인증을 완료하세요.')
    const db = workspaces.open(id).db
    db.exec('BEGIN IMMEDIATE')
    try {
      const code = db.prepare('SELECT * FROM lms_attendance_codes WHERE code_hash=? AND guild_id=?').get(digest(input.code), input.guildId)
      if (!code || code.revoked_at !== null || code.expires_at <= now()) throw new ApiError(410, '만료되었거나 사용할 수 없는 출석 코드입니다. 멘토에게 새 코드를 확인하세요.')
      const selected = { courseId: code.course_id, date: code.date, period: code.period }
      const issuer = identityDb.prepare('SELECT id,username,platform_role AS role FROM lms_users WHERE id=?').get(code.actor_id)
      if (!issuer) throw new ApiError(410, '코드 발급자의 권한이 변경되었습니다. 새 코드를 발급받으세요.')
      const roster = attendance.view(id, selected, issuer)
      if (roster.state !== '진행 중') throw new ApiError(409, '출석 등록이 마감된 회차입니다.')
      const learner = db.prepare("SELECT id,data FROM lms_records WHERE kind='learners' AND json_extract(data,'$.discordId')=?").get(input.discordId)
      if (!learner || !JSON.parse(code.student_ids).includes(learner.id) || !roster.rows.some(r => r.studentId === learner.id && r.enrollment === '정상')) throw new ApiError(403, '이 코드의 출석 대상 수강생이 아닙니다.')
      const existing = db.prepare("SELECT data FROM lms_records WHERE kind='attendance' AND json_extract(data,'$.studentId')=? AND json_extract(data,'$.courseId')=? AND json_extract(data,'$.date')=? AND json_extract(data,'$.period')=?").get(learner.id, code.course_id, code.date, code.period)
      if (existing) {
        db.exec('COMMIT')
        return { ...selected, status: JSON.parse(existing.data).status, alreadyRecorded: true }
      }
      const record = { id: randomUUID(), studentId: learner.id, ...selected, status: '출석', reason: 'Discord 출석 코드 등록' }
      db.prepare("INSERT INTO lms_records(kind,id,data) VALUES('attendance',?,?)").run(record.id, JSON.stringify(record))
      db.prepare('INSERT INTO lms_audit(actor,action,target,after_json) VALUES(?,?,?,?)').run(account.username, 'attendance.checkin', record.id, JSON.stringify(record))
      db.prepare('UPDATE lms_attendance_rounds SET version=version+1 WHERE course_id=? AND date=? AND period=?').run(code.course_id, code.date, code.period)
      db.exec('COMMIT')
      return { ...selected, status: '출석', alreadyRecorded: false }
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  return { status, issue, revoke, checkIn }
}

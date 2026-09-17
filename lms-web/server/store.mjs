import { DatabaseSync } from 'node:sqlite'
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import branding from '../shared/branding.json' with { type: 'json' }

const text = z.string().trim().min(1).max(200)
const id = text
const date = z.string().date()
const discord = z.string().regex(/^\d{17,20}$/, 'Discord ID는 17~20자리 숫자여야 합니다.')
const optionalDiscord = z.union([discord, z.literal('')]).default('')
const schemas = {
  courses: z.object({ id, title: text, category: text, description: z.string().max(2000), progress: z.number().min(0).max(100), learners: z.number().int().nonnegative(), weeks: text, mentor: z.string().max(100), theme: z.enum(['orange', 'green', 'blue']), status: z.enum(['진행 중', '모집 중', '종료']), code: text, cohort: text, guildId: optionalDiscord, startDate: date, endDate: date }).refine(v => v.startDate <= v.endDate, '종료일은 시작일 이후여야 합니다.'),
  learners: z.object({ id, name: text, email: z.union([z.email(), z.literal('')]), courseId: id, team: z.string().max(100), discordId: optionalDiscord, status: z.enum(['대기', '정상', '중도탈락', '수료', '비활성']), progress: z.number().min(0).max(100).default(0), color: z.string().default('sage') }),
  teams: z.object({ id, name: text, code: text, courseId: id, mentorId: z.string().default('') }),
  attendance: z.object({ id, studentId: id, courseId: id, date, period: z.coerce.number().int().min(1).max(100), status: z.enum(['출석', '지각', '결석', '공결']), reason: text }),
  scores: z.object({ id, studentId: id, courseId: id, item: text, score: z.coerce.number().min(0), maximum: z.coerce.number().positive().max(10000) }).refine(v => v.score <= v.maximum, '입력 점수가 최대 배점을 초과했습니다.'),
  notices: z.object({ id, title: text, content: z.string().min(1).max(4000), courseId: id, target: text, status: z.literal('초안') }),
  servers: z.object({ id, name: text, provider: text, region: text, status: z.literal('미연결'), version: z.string().max(40) }),
  mentors: z.object({ id, name: text, discordId: discord, bio: z.string().max(1000) }),
  assignments: z.object({ id, title: text, course: text, courseId: z.string().optional(), due: date, submitted: z.number().int().nonnegative(), total: z.number().int().nonnegative(), status: z.enum(['진행 중', '마감']) }),
  sessions: z.object({ id, title: text, mentor: text, mentorId: id.optional(), studentId: id.optional(), team: z.string(), date, time: z.string().regex(/^\d{2}:\d{2}$/).refine(v => +v.slice(0, 2) < 24 && +v.slice(3) < 60), status: z.enum(['승인 대기', '예약 확정', '완료', '취소']) }),
  settings: z.object({ name: text, reminders: z.boolean(), onboarding: z.boolean(), qa: z.boolean() }),
}
export class ApiError extends Error { constructor(status, message) { super(message); this.status = status } }
export function createStore(dbPath, { workspaceId = 'default', defaultName = branding.name } = {}) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')
  // Reuse the bot's authoritative bootstrap DDL. Existing rows are never replaced.
  const botSource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../database.py'), 'utf8')
  const ddl = botSource.match(/executescript\("""([\s\S]*?)"""\)/)?.[1]
  if (!ddl) throw new Error('봇의 데이터베이스 스키마를 찾을 수 없습니다.')
  db.exec(ddl)
  const addColumn = (table, name, definition) => { if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`) }
  addColumn('mentors', 'is_active', 'INTEGER NOT NULL DEFAULT 1')
  addColumn('bookings', 'status', "TEXT NOT NULL DEFAULT 'approved'")
  addColumn('bookings', 'rejection_reason', "TEXT DEFAULT ''")
  addColumn('assignments', 'fields', `TEXT NOT NULL DEFAULT '["제출 내용"]'`)
  db.exec(`CREATE TABLE IF NOT EXISTS lms_records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS lms_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, before_json TEXT, after_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS lms_assignment_courses (assignment_id INTEGER PRIMARY KEY REFERENCES assignments(id), course_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lms_booking_history (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lms_attendance_rounds (course_id TEXT NOT NULL, date TEXT NOT NULL, period INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('진행 전','진행 중','마감')), version INTEGER NOT NULL, PRIMARY KEY(course_id,date,period));
    CREATE TABLE IF NOT EXISTS lms_attendance_requests (id TEXT PRIMARY KEY, actor TEXT NOT NULL, digest TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS lms_course_code ON lms_records(json_extract(data,'$.code'),json_extract(data,'$.cohort')) WHERE kind='courses';

    CREATE UNIQUE INDEX IF NOT EXISTS lms_learner_discord ON lms_records(json_extract(data,'$.discordId')) WHERE kind='learners' AND json_extract(data,'$.discordId') <> '';
    CREATE UNIQUE INDEX IF NOT EXISTS lms_team_code ON lms_records(json_extract(data,'$.courseId'),json_extract(data,'$.code')) WHERE kind='teams';
    CREATE UNIQUE INDEX IF NOT EXISTS lms_attendance_unique ON lms_records(json_extract(data,'$.studentId'),json_extract(data,'$.courseId'),json_extract(data,'$.date'),json_extract(data,'$.period')) WHERE kind='attendance';
    CREATE UNIQUE INDEX IF NOT EXISTS lms_score_unique ON lms_records(json_extract(data,'$.studentId'),json_extract(data,'$.courseId'),json_extract(data,'$.item')) WHERE kind='scores';`)
  // Accounts approved through LMS do not collect email addresses. Keep real addresses unique.
  const emailIndex = db.prepare("SELECT sql FROM sqlite_master WHERE name='lms_learner_email'").get()
  if (emailIndex && !emailIndex.sql.includes("<> ''")) db.exec('DROP INDEX lms_learner_email')
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS lms_learner_email ON lms_records(lower(json_extract(data,'$.email'))) WHERE kind='learners' AND json_extract(data,'$.email') <> ''")
  const rows = kind => db.prepare('SELECT data FROM lms_records WHERE kind=? ORDER BY rowid').all(kind).map(r => JSON.parse(r.data))
  const get = (kind, key) => { const row = db.prepare('SELECT data FROM lms_records WHERE kind=? AND id=?').get(kind, key); return row ? JSON.parse(row.data) : null }
  const requireRecord = (kind, key) => { const row = get(kind, key); if (!row) throw new ApiError(422, `${kind}: 연결된 항목을 찾을 수 없습니다.`); return row }
  const put = (kind, row) => db.prepare('INSERT INTO lms_records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, row.id || 'workspace', JSON.stringify(row))
  if (workspaceId === 'default') {
    const settings = get('settings', 'workspace')
    if (settings?.name === branding.legacyName) put('settings', { ...settings, name: branding.name })
  }
  function snapshot() {
    const result = Object.fromEntries(['courses', 'learners', 'teams', 'attendance', 'scores', 'notices', 'servers', 'files'].map(kind => [kind, rows(kind)]))
    result.courses = result.courses.map(c => ({ ...c, learners: result.learners.filter(l => l.courseId === c.id).length }))
    result.mentors = db.prepare('SELECT id,name,discord_id AS discordId,bio FROM mentors WHERE is_active=1 ORDER BY id').all().map(m => ({ ...m, id: String(m.id) }))
    result.assignments = db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM submissions WHERE assignment_id=a.id) AS submitted, ac.course_id FROM assignments a LEFT JOIN lms_assignment_courses ac ON ac.assignment_id=a.id ORDER BY a.id`).all().map(a => ({ id: String(a.id), title: a.title, courseId: a.course_id || '', course: result.courses.find(c => c.id === a.course_id)?.title || '기존 봇 과제', due: a.due_date.slice(0, 10), submitted: a.submitted, total: a.type === 'team' ? result.teams.filter(t => t.courseId === a.course_id).length : result.learners.filter(l => l.courseId === a.course_id).length, status: a.is_active ? '진행 중' : '마감' }))
    result.sessions = db.prepare(`SELECT b.*, s.label, s.start_time, m.id AS mentor_id, m.name AS mentor_name FROM bookings b JOIN slots s ON b.slot_id=s.id JOIN mentors m ON s.mentor_id=m.id ORDER BY b.id`).all().map(b => ({ id: String(b.id), title: b.label, mentor: b.mentor_name, mentorId: String(b.mentor_id), studentId: result.learners.find(l => l.discordId === b.user_id)?.id || '', team: b.user_name, date: b.start_time.slice(0, 10), time: b.start_time.slice(11, 16), status: b.status === 'pending' ? '승인 대기' : b.status === 'completed' ? '완료' : '예약 확정' }))
    result.sessions.push(...db.prepare('SELECT data FROM lms_booking_history ORDER BY rowid').all().map(r => JSON.parse(r.data)))
    result.submissions = db.prepare('SELECT id,assignment_id AS assignmentId,user_name AS name,team,content,link,submitted_at AS submittedAt FROM submissions ORDER BY id DESC').all().map(s => ({ ...s, id: String(s.id) }))
    result.logs = db.prepare('SELECT * FROM lms_audit ORDER BY id DESC LIMIT 200').all().reverse().map(l => ({ id: String(l.id), time: l.created_at + ' UTC', text: `${l.actor} · ${l.action} · ${l.target}`, before: l.before_json, after: l.after_json }))
    Object.assign(result, get('settings', 'workspace') || { name: defaultName, reminders: true, onboarding: true, qa: true }, { mode: 'api', workspaceId })
    result.revision = createHash('sha256').update(JSON.stringify(result)).digest('hex')
    return result
  }
  function mutate(body, actor = 'admin') {
    const request = z.object({ revision: text, changes: z.array(z.object({ kind: z.enum(Object.keys(schemas)), value: z.unknown() })).min(1).max(100) }).parse(body)
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = snapshot()
      if (request.revision !== current.revision) throw new ApiError(409, '다른 작업으로 데이터가 변경되었습니다. 새로고침 후 다시 시도하세요.')
      for (const change of request.changes) {
        const { kind } = change
        const value = schemas[kind].parse(change.value)
        const before = kind === 'settings' ? { name: current.name, reminders: current.reminders, onboarding: current.onboarding, qa: current.qa } : current[kind]?.find(r => r.id === value.id)
        if (kind === 'attendance' && [before, value].filter(Boolean).some(row => db.prepare('SELECT 1 FROM lms_attendance_rounds WHERE course_id=? AND date=? AND period=?').get(row.courseId, row.date, row.period))) throw new ApiError(409, '회차가 관리되는 출결은 명단 출결 화면에서 변경하세요.')
        if (['learners', 'teams', 'attendance', 'scores', 'notices'].includes(kind)) requireRecord('courses', value.courseId)
        if (kind === 'learners' && value.team && !rows('teams').some(t => t.name === value.team && t.courseId === value.courseId)) throw new ApiError(422, '해당 과정에 등록된 팀을 선택하세요.')
        if (kind === 'teams' && value.mentorId && !db.prepare('SELECT id FROM mentors WHERE id=?').get(value.mentorId)) throw new ApiError(422, '등록된 멘토를 선택하세요.')
        if (kind === 'teams') {
          if (rows('teams').some(team => team.id !== value.id && team.courseId === value.courseId && team.name === value.name)) throw new ApiError(409, '같은 과정에 같은 팀 이름이 있습니다.')
          const assigned = before ? rows('learners').filter(learner => learner.courseId === before.courseId && learner.team === before.name) : []
          if (assigned.length && before.courseId !== value.courseId) throw new ApiError(422, '팀원이 있는 팀은 다른 과정으로 이동할 수 없습니다.')
          if (before && before.name !== value.name) for (const learner of assigned) {
            const next = { ...learner, team: value.name }
            put('learners', next)
            db.prepare('INSERT INTO lms_audit(actor,action,target,before_json,after_json) VALUES(?,?,?,?,?)').run(actor, 'learners.team-rename', learner.id, JSON.stringify(learner), JSON.stringify(next))
          }
        }
        if (kind === 'attendance' || kind === 'scores') {
          const student = requireRecord('learners', value.studentId)
          if (student.courseId !== value.courseId) throw new ApiError(422, '수강생의 소속 과정이 일치하지 않습니다.')
        }
        if (kind === 'mentors') {
          if (before) db.prepare('UPDATE mentors SET name=?,discord_id=?,bio=? WHERE id=?').run(value.name, value.discordId, value.bio, value.id)
          else db.prepare('INSERT INTO mentors(name,discord_id,bio) VALUES(?,?,?)').run(value.name, value.discordId, value.bio)
        } else if (kind === 'assignments') {
          if (before) {
            if (value.title !== before.title || value.course !== before.course || value.due !== before.due) throw new ApiError(422, '기존 과제는 현재 마감 상태 변경만 지원합니다.')
            db.prepare('UPDATE assignments SET is_active=? WHERE id=?').run(value.status === '진행 중' ? 1 : 0, value.id)
          } else {
            const course = rows('courses').find(c => c.id === value.courseId)
            if (!course) throw new ApiError(422, '등록된 과정을 선택하세요.')
            const row = db.prepare("INSERT INTO assignments(week,title,description,due_date,type) VALUES(1,?,'',?,'team')").run(value.title, value.due)
            db.prepare('INSERT INTO lms_assignment_courses VALUES(?,?)').run(Number(row.lastInsertRowid), course.id)
          }
        } else if (kind === 'sessions') {
          if (before) {
            if (before.status === '완료' || before.status === '취소') throw new ApiError(422, '종료된 예약은 변경할 수 없습니다.')
            if (value.title !== before.title || value.date !== before.date || value.time !== before.time || value.mentorId !== before.mentorId || value.studentId !== before.studentId) throw new ApiError(422, '기존 예약은 승인·완료·취소만 지원합니다.')
            if (value.status === '취소') {
              db.prepare('INSERT INTO lms_booking_history(id,data) VALUES(?,?)').run('cancelled-' + randomUUID(), JSON.stringify({ ...before, id: 'cancelled-' + randomUUID(), status: '취소' }))
              db.prepare('DELETE FROM reminders WHERE booking_id=?').run(value.id)
              db.prepare('DELETE FROM bookings WHERE id=?').run(value.id)
            } else {
              if (!((before.status === '승인 대기' && value.status === '예약 확정') || (before.status === '예약 확정' && value.status === '완료'))) throw new ApiError(422, '허용되지 않은 예약 상태 변경입니다.')
              db.prepare('UPDATE bookings SET status=? WHERE id=?').run(value.status === '완료' ? 'completed' : 'approved', value.id)
            }
          } else {
            const mentor = db.prepare('SELECT * FROM mentors WHERE id=? AND is_active=1').get(value.mentorId || '')
            const student = requireRecord('learners', value.studentId || '')
            if (!mentor || !student.discordId) throw new ApiError(422, '멘토와 Discord ID가 연결된 수강생을 선택하세요.')
            const start = `${value.date}T${value.time}:00`
            const endDate = new Date(`${start}Z`); endDate.setUTCMinutes(endDate.getUTCMinutes() + 50)
            const end = endDate.toISOString().slice(0, 19)
            const overlapping = db.prepare('SELECT s.*, b.id AS booking_id FROM slots s LEFT JOIN bookings b ON b.slot_id=s.id WHERE s.mentor_id=? AND s.is_active=1 AND s.start_time < ? AND s.end_time > ?').all(mentor.id, end, start)
            const available = overlapping.length === 1 && !overlapping[0].booking_id && overlapping[0].start_time === start && overlapping[0].end_time === end ? overlapping[0] : null
            if (overlapping.length && !available) throw new ApiError(409, '해당 시간에 이미 멘토링 슬롯이 있습니다. 다른 시간을 선택하세요.')
            if (db.prepare("SELECT id FROM bookings WHERE user_id=? AND status IN ('pending','approved')").get(student.discordId)) throw new ApiError(409, '해당 수강생에게 승인 대기 또는 확정 예약이 있습니다.')
            const slotId = available?.id || Number(db.prepare('INSERT INTO slots(mentor_id,start_time,end_time,label) VALUES(?,?,?,?)').run(mentor.id, start, end, value.title).lastInsertRowid)
            if (available) db.prepare('UPDATE slots SET label=? WHERE id=?').run(value.title, slotId)
            db.prepare("INSERT INTO bookings(slot_id,user_id,user_name,status) VALUES(?,?,?,'pending')").run(slotId, student.discordId, student.name)
          }
        } else {
          if (kind === 'settings' && (value.reminders !== current.reminders || value.onboarding !== current.onboarding || value.qa !== current.qa)) throw new ApiError(422, '봇 모듈 실행 제어는 아직 연결되지 않았습니다.')
          put(kind, value)
        }
        db.prepare('INSERT INTO lms_audit(actor,action,target,before_json,after_json) VALUES(?,?,?,?,?)').run(actor, `${kind}.${before ? 'update' : 'create'}`, value.id || 'workspace', JSON.stringify(before || null), JSON.stringify(value))
      }
      db.exec('COMMIT')
      return snapshot()
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  return { db, snapshot, mutate }
}

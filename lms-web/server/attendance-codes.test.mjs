import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRuntime } from './runtime.mjs'
import { createAttendanceCodes } from './attendance-codes.mjs'

const guildId = '123456789012345678'
const selected = { courseId: 'course', date: '2026-09-18', period: 1 }
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'attendance-code-'))
  const runtime = createRuntime(join(dir, 'test.db'), { NODE_ENV: 'test' })
  t.after(() => { runtime.close(); rmSync(dir, { recursive: true, force: true }) })
  const { store: { db }, workspaces, attendance } = runtime
  let time = Date.now()
  const codes = createAttendanceCodes(db, workspaces, attendance, { now: () => time })
  const put = (kind, row) => db.prepare('INSERT INTO lms_records VALUES(?,?,?)').run(kind, row.id, JSON.stringify(row))
  const account = (id, role, discordId) => {
    db.prepare('INSERT INTO lms_users(id,username,name,password_hash,discord_id,guild_id,created_at,platform_role) VALUES(?,?,?,?,?,?,?,?)').run(id, id, id, 'unused', discordId, guildId, time, role === 'admin' ? 'admin' : 'student')
    db.prepare('INSERT INTO lms_workspace_members VALUES(?,?,?,?)').run('default', id, role, time)
    db.prepare('INSERT INTO lms_workspace_verifications VALUES(?,?,?,?,?)').run('default', id, guildId, discordId, time)
    return { id, username: id, role: role === 'admin' ? 'admin' : 'student', discordId }
  }
  db.prepare('INSERT INTO lms_workspace_guilds VALUES(?,?)').run(guildId, 'default')
  const admin = account('owner', 'admin', '123456789012345680')
  const mentor = account('mentor', 'instructor', '123456789012345681')
  const student = account('student', 'student', '123456789012345682')
  const other = account('other', 'student', '123456789012345683')
  put('courses', { id: 'course', title: '테스트 과정' })
  put('teams', { id: 't1', name: '1조', courseId: 'course' }); put('teams', { id: 't2', name: '2조', courseId: 'course' })
  for (const [user, team] of [[student, '1조'], [other, '2조']]) put('learners', { id: user.id, discordId: user.discordId, courseId: 'course', name: user.id, team, status: '정상' })
  workspaces.assignMentor('default', mentor.id, { mentorType: 'group', teamIds: ['t1'] }, admin)
  const view = () => attendance.view('default', selected, admin)
  const save = (action, entries = []) => attendance.save('default', { ...selected, action, entries, revision: view().revision, requestId: randomUUID() }, admin)
  const issue = (user = admin, raw = {}) => codes.issue('default', { ...selected, ...raw }, user)
  const check = (code, user = student, guild = guildId) => codes.checkIn({ guildId: guild, discordId: user.discordId, code })
  return { db, codes, workspaces, admin, mentor, student, other, put, view, save, issue, check, advance: ms => { time += ms } }
}

test('verified students check in once per round, change roster revision, and cannot overwrite mentor corrections', t => {
  const f = fixture(t)
  assert.throws(() => f.issue(), { status: 409 })
  f.save('start')
  const issued = f.issue(), before = f.view().revision
  assert.match(issued.code, /^\d{6}$/)
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM lms_attendance_codes').get()).includes(issued.code))
  assert.equal(f.check(issued.code).alreadyRecorded, false)
  assert.notEqual(f.view().revision, before)
  assert.equal(f.check(issued.code).alreadyRecorded, true)
  assert.equal(f.view().history.length, 1)
  f.save('save', [{ studentId: 'student', status: '지각', reason: '멘토 도착 확인' }])
  assert.equal(f.check(issued.code).status, '지각')
  assert.equal(f.check(f.issue().code).status, '지각')
  assert.equal(f.view().counts['지각'], 1)
  assert.equal(f.view().history.length, 2)
})

test('expiry boundary, replacement, explicit revocation, closure and archive reject registration', t => {
  const f = fixture(t); f.save('start')
  const first = f.issue(), second = f.issue()
  assert.throws(() => f.check(first.code), { status: 410 })
  f.advance(5 * 60000)
  assert.throws(() => f.check(second.code), { status: 410 })
  const third = f.issue()
  f.codes.revoke('default', selected, f.admin)
  assert.throws(() => f.check(third.code), { status: 410 })
  const fourth = f.issue()
  f.save('save', ['student', 'other'].map(studentId => ({ studentId, status: '결석' }))); f.save('close')
  assert.throws(() => f.check(fourth.code), { status: 409 })
  assert.equal(f.codes.status('default', selected, f.admin).active, null)
  f.db.prepare('UPDATE lms_workspaces SET archived_at=1 WHERE id=?').run('default')
  assert.throws(() => f.check(fourth.code), { status: 403 })
})

test('guild, membership, workspace verification, enrollment and current mentor scope are enforced', t => {
  const f = fixture(t); f.save('start')
  assert.throws(() => f.issue(f.student), { status: 403 })
  const issued = f.issue(f.mentor)
  assert.throws(() => f.check(issued.code, f.other), { status: 403 })
  assert.throws(() => f.check(issued.code, f.student, '123456789012345699'), { status: 403 })
  f.db.prepare('DELETE FROM lms_workspace_verifications WHERE user_id=?').run('student')
  assert.throws(() => f.check(issued.code), { status: 403 })
  f.db.prepare('INSERT INTO lms_workspace_verifications VALUES(?,?,?,?,?)').run('default', 'student', guildId, f.student.discordId, 1)
  f.db.prepare("UPDATE lms_records SET data=json_set(data,'$.status','중도탈락') WHERE kind='learners' AND id='student'").run()
  assert.throws(() => f.check(issued.code), { status: 403 })
  f.db.prepare("UPDATE lms_records SET data=json_set(data,'$.status','정상') WHERE kind='learners' AND id='student'").run()
  f.workspaces.assignMentor('default', f.mentor.id, { mentorType: 'group', teamIds: ['t2'] }, f.admin)
  assert.throws(() => f.check(issued.code), { status: 403 })
  assert.throws(() => f.check(issued.code, f.other), { status: 403 })
  const current = f.issue(f.mentor)
  f.db.prepare('DELETE FROM lms_workspace_members WHERE user_id=?').run(f.mentor.id)
  assert.throws(() => f.check(current.code, f.other), { status: 403 })
  const adminCode = f.issue()
  f.db.prepare('DELETE FROM lms_workspace_members WHERE user_id=?').run(f.student.id)
  assert.throws(() => f.check(adminCode.code), { status: 403 })
})

test('two mentors codes remain independent and codes cannot be retargeted to another course', t => {
  const f = fixture(t); f.save('start')
  const whole = f.issue(), group = f.issue(f.mentor)
  f.codes.revoke('default', selected, f.mentor)
  assert.throws(() => f.check(group.code), { status: 410 })
  assert.equal(f.check(whole.code, f.other).status, '출석')
  f.db.prepare("UPDATE lms_records SET data=json_set(data,'$.courseId','another') WHERE kind='learners' AND id='student'").run()
  assert.throws(() => f.check(whole.code), { status: 403 })
})

test('failed audit rolls back attendance and revision; malformed input cannot select arbitrary identity', t => {
  const f = fixture(t); f.save('start'); const issued = f.issue(), before = f.view().revision
  f.db.exec("CREATE TRIGGER fail_attendance BEFORE INSERT ON lms_audit WHEN NEW.action='attendance.checkin' BEGIN SELECT RAISE(ABORT,'disk failure'); END")
  assert.throws(() => f.check(issued.code), /disk failure/)
  assert.equal(f.view().revision, before)
  assert.equal(f.view().counts['출석'], 0)
  f.db.exec('DROP TRIGGER fail_attendance')
  assert.equal(f.check(issued.code).alreadyRecorded, false)
  assert.throws(() => f.codes.checkIn({ code: issued.code, guildId, discordId: f.student.discordId, studentId: 'other' }))
  for (const code of ['12345', '1234567', "' OR 1=1", '１２３４５６']) assert.throws(() => f.check(code))
})

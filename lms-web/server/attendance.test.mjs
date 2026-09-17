import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createStore } from './store.mjs'
import { createAuth } from './auth.mjs'
import { createRenderSync } from './render-sync.mjs'
import { createProvision } from './provision.mjs'
import { createWorkspaces } from './workspaces.mjs'
import { createAttendance } from './attendance.mjs'
import { studentLearning } from './student.mjs'
import { exportAttendance, importAttendance } from '../shared/attendance-csv.mjs'

const admin = { id: 'admin', username: 'operator', role: 'admin' }
const selection = { courseId: 'c1', date: '2026-09-18', period: 1 }
function fixture(t, count = 2) {
  const dir = mkdtempSync(join(tmpdir(), 'attendance-')), dbPath = join(dir, 'test.db'), store = createStore(dbPath)
  const auth = createAuth(store.db)
  createRenderSync(store.db)
  const workspaces = createWorkspaces({ store, dbPath, provision: createProvision(store.db) })
  const service = createAttendance(workspaces)
  const put = (kind, value) => store.db.prepare('INSERT INTO lms_records(kind,id,data) VALUES(?,?,?)').run(kind, value.id, JSON.stringify(value))
  put('courses', { id: 'c1', title: '과정' })
  put('teams', { id: 't1', name: '1조', courseId: 'c1', code: '1' })
  put('teams', { id: 't2', name: '2조', courseId: 'c1', code: '2' })
  for (let i = 0; i < count; i++) put('learners', { id: `s${i}`, name: `학생${i}`, email: '', discordId: String(123456789012345678n + BigInt(i)), courseId: 'c1', team: i % 2 ? '2조' : '1조', status: '정상' })
  const view = (user = admin, selected = selection) => service.view('default', selected, user)
  const payload = (action, entries = [], user = admin) => ({ ...selection, requestId: randomUUID(), revision: view(user).revision, action, entries })
  const save = (body, user = admin) => service.save('default', body, user)
  const entries = () => view().rows.map(r => ({ studentId: r.studentId, status: '출석' }))
  const signup = async role => {
    const { user } = await auth.signup({ username: `attendance.${role}`, password: 'testing-password-1234', name: role }, () => {})
    if (role === 'instructor') workspaces.acceptInvitation(workspaces.invite('default', { username: user.username, role, mentorType: 'group', teamIds: ['t1'] }, admin).token, user)
    else store.db.prepare('INSERT INTO lms_workspace_members VALUES(?,?,?,?)').run('default', user.id, 'student', Date.now())
    return user
  }
  t.after(() => { workspaces.close(); store.db.close(); rmSync(dir, { force: true, recursive: true }) })
  return { store, service, auth, workspaces, view, payload, save, entries, signup }
}

test('120-person roster saves atomically and rolls back records, history and receipts on a late failure', t => {
  const f = fixture(t, 120)
  assert.equal(f.view().counts['미처리'], 120)
  f.save(f.payload('start'))
  f.store.db.exec("CREATE TRIGGER fail_late BEFORE INSERT ON lms_records WHEN NEW.kind='attendance' AND json_extract(NEW.data,'$.studentId')='s119' BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END")
  const request = f.payload('save', f.entries()), revision = f.view().revision
  assert.throws(() => f.save(request), /simulated disk failure/)
  assert.equal(f.store.snapshot().attendance.length, 0)
  assert.equal(f.view().history.length, 0)
  assert.equal(f.view().revision, revision)
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM lms_attendance_requests').get().n, 1)
  f.store.db.exec('DROP TRIGGER fail_late')
  assert.equal(f.save(request).counts['출석'], 120)
})

test('identical retries are idempotent while stale and reused requests cannot overwrite newer data', t => {
  const f = fixture(t); f.save(f.payload('start'))
  const body = f.payload('save', f.entries()), stale = f.payload('save', [{ studentId: 's0', status: '결석' }])
  const first = f.save(body)
  assert.equal(f.save(body).revision, first.revision)
  assert.equal(f.view().history.length, 2)
  assert.throws(() => f.save(stale), { status: 409 })
  assert.throws(() => f.save({ ...body, entries: [] }), { status: 409 })
  assert.equal(f.store.snapshot().attendance.length, 2)
})

test('closing requires complete roster and corrections require reasons with before/after and actor', t => {
  const f = fixture(t)
  assert.throws(() => f.save(f.payload('save', f.entries())), { status: 409 })
  f.save(f.payload('start'))
  assert.throws(() => f.save(f.payload('close')), { status: 422 })
  f.save(f.payload('save', f.entries())); f.save(f.payload('close'))
  assert.throws(() => f.save(f.payload('start')), { status: 409 })
  const before = f.view().revision
  assert.throws(() => f.save(f.payload('save', [{ studentId: 's0', status: '지각', reason: '도착 확인' }, { studentId: 's1', status: '공결', reason: ' ' }])), { status: 422 })
  assert.equal(f.view().revision, before)
  const result = f.save(f.payload('save', [{ studentId: 's0', status: '지각', reason: '도착 확인' }]))
  assert.equal(result.state, '마감')
  assert.equal(result.history[0].before.status, '출석')
  assert.equal(result.history[0].after.status, '지각')
  assert.equal(result.history[0].actor, 'operator')
  const row = f.store.snapshot().attendance[0]
  for (const value of [{ ...row, status: '결석', reason: '우회' }, { ...row, date: '2026-09-19' }]) assert.throws(() => f.store.mutate({ revision: f.store.snapshot().revision, changes: [{ kind: 'attendance', value }] }), { status: 409 })
})

test('instructors cannot see or write other teams, close rounds, or use stale scope; students cannot use roster API', async t => {
  const f = fixture(t), mentor = await f.signup('instructor'), student = await f.signup('student')
  f.save(f.payload('start'))
  assert.deepEqual(f.view(mentor).rows.map(r => r.studentId), ['s0'])
  assert.throws(() => f.save(f.payload('save', f.entries(), mentor), mentor), { status: 403 })
  assert.throws(() => f.save(f.payload('close', [], mentor), mentor), { status: 403 })
  f.save(f.payload('save', [{ studentId: 's0', status: '출석' }], mentor), mentor)
  f.save(f.payload('save', [{ studentId: 's1', status: '공결', reason: '비공개 사유' }]))
  assert.equal(f.view(mentor).history.length, 1)
  assert.ok(!JSON.stringify(f.view(mentor)).includes('비공개 사유'))
  const oldScope = f.payload('save', [{ studentId: 's0', status: '결석' }], mentor)
  f.workspaces.assignMentor('default', mentor.id, { mentorType: 'group', teamIds: ['t2'] }, admin)
  assert.throws(() => f.save(oldScope, mentor), { status: 403 })
  assert.throws(() => f.view(student), { status: 403 })
  assert.throws(() => f.service.view('asan-ax', selection, mentor), { status: 403 })
})

test('students see only their own finalized attendance; archive blocks even replayed writes', t => {
  const f = fixture(t), student = { discordId: '123456789012345678' }
  f.save(f.payload('start')); const body = f.payload('save', f.entries()); f.save(body)
  assert.deepEqual(studentLearning(f.store.db, student, true).attendance, [])
  f.save(f.payload('close'))
  const learning = studentLearning(f.store.db, student, true)
  assert.equal(learning.attendance.length, 1)
  assert.equal(learning.attendance[0].status, '출석')
  assert.ok(!('reason' in learning.attendance[0]))
  assert.equal(studentLearning(f.store.db, student, false).attendance.length, 0)
  f.workspaces.setArchived('default', true, admin)
  assert.throws(() => f.save(body), { status: 409 })
})

test('duplicate learners and invalid dates or statuses never partially save', t => {
  const f = fixture(t); f.save(f.payload('start'))
  assert.throws(() => f.save(f.payload('save', [{ studentId: 's0', status: '출석' }, { studentId: 's0', status: '결석' }])), { status: 422 })
  assert.throws(() => f.save({ ...f.payload('save', f.entries()), date: '2026-02-30' }))
  assert.throws(() => f.save(f.payload('save', [{ studentId: 's0', status: 'invalid' }])))
  assert.equal(f.store.snapshot().attendance.length, 0)
})

test('CSV roundtrip preserves quoted newlines, safe formula text, IDs and pending states', () => {
  const rows = [{ studentId: 's0', name: '=formula', team: '"1,조"', status: '미처리', reason: '줄1\n줄2' }, { studentId: 's1', name: '학생', team: '', status: '공결', reason: ' +SUM(1,2)' }]
  const csv = exportAttendance(selection, rows)
  assert.ok(csv.includes("'=formula")); assert.ok(csv.includes("' +SUM"))
  assert.deepEqual(importAttendance(csv, selection, ['s0', 's1']), rows.map(({ studentId, status, reason }) => ({ studentId, status, reason })))
  for (const invalid of [csv.replace('s1', 's0'), csv.replace('s1', 'foreign'), csv.replace('공결', '오류'), csv.replace('2026-09-18', '2026-09-19'), csv + '"']) assert.throws(() => importAttendance(invalid, selection, ['s0', 's1']))
})

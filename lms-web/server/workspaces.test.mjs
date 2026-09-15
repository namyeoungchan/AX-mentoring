import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from './store.mjs'
import { createAuth } from './auth.mjs'
import { createRenderSync } from './render-sync.mjs'
import { createProvision } from './provision.mjs'
import { createWorkspaces } from './workspaces.mjs'

const guildId = '123456789012345678'
const admin = { id: 'admin', role: 'admin' }
const token = 'test-only-integration-token-12345678901234567890'
const course = { id: 'course1', title: '독립 과정', category: 'AX', description: '1기', progress: 0, learners: 0, weeks: '8주', mentor: '', theme: 'green', status: '모집 중', code: 'AX', cohort: '1', guildId: '', startDate: '2026-09-01', endDate: '2026-12-01' }
const plan = { guildId, name: '교육 서버', autoApply: false, channels: [{ id: 'notice', name: '공지', type: 'text', parentId: '' }], revision: '' }
const payload = (sourceId, guild = guildId) => ({ sourceId, name: '운영 봇', capturedAt: new Date().toISOString(), rowLimit: 1000, bot: { name: 'AX', ready: true, latencyMs: 50, guildId: guild, guildName: '교육 서버', memberCount: 1 }, counts: { mentors: 0, bookings: 0, assignments: 0, submissions: 0, onboarding_progress: 0, pending_bookings: 0 }, mentors: [], bookings: [], assignments: [], submissions: [] })
function fixture(t, seed = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'learningops-workspaces-'))
  const dbPath = join(directory, 'test.db')
  const store = createStore(dbPath)
  const auth = createAuth(store.db, { adminPassword: 'test-admin-password-1234', botToken: token, guildId })
  const sync = createRenderSync(store.db, { token, sourceId: 'asan-ax' })
  const provision = createProvision(store.db, { token })
  seed({ store, sync, provision })
  const options = { store, dbPath, provision, syncToken: token }
  const manager = createWorkspaces(options)
  t.after(() => { manager.close(); store.db.close(); rmSync(directory, { recursive: true, force: true }) })
  return { manager, store, auth, provision, options }
}
const write = (manager, id, kind, value) => manager.mutate(id, { revision: manager.snapshot(id).revision, changes: [{ kind, value }] }, 'admin')

test('migration preserves existing learning rows and assigns the previous Render source to Asan', t => {
  const { manager } = fixture(t, ({ store, sync }) => {
    store.mutate({ revision: store.snapshot().revision, changes: [{ kind: 'courses', value: course }] })
    sync.ingest(payload('asan-ax'))
  })
  assert.deepEqual(manager.list(admin).map(w => w.name), ['천안 AX', '아산 AX'])
  assert.equal(manager.snapshot('default').courses[0].id, course.id)
  assert.deepEqual(manager.snapshot('asan-ax').courses, [])
  assert.equal(manager.remote('asan-ax').read().snapshot.bot.guildId, guildId)
  assert.equal(manager.remote('default').read().snapshot, null)
  assert.deepEqual(manager.metadata('asan-ax').guildIds, [guildId])
})

test('workspace stores isolate records, revisions, references and audit history and survive reopening', t => {
  const { manager, options } = fixture(t)
  const created = manager.create({ name: '세종 AX' })
  write(manager, created.id, 'courses', course)
  assert.deepEqual(manager.snapshot('default').courses, [])
  assert.deepEqual(manager.snapshot('asan-ax').courses, [])
  assert.throws(() => manager.mutate('asan-ax', { revision: manager.snapshot(created.id).revision, changes: [{ kind: 'courses', value: course }] }), { status: 409 })
  const student = { id: 's1', name: '학생', email: 'student@example.com', discordId: '555456789012345678', courseId: course.id, team: '', status: '정상', progress: 0, color: 'sage' }
  assert.throws(() => write(manager, 'asan-ax', 'learners', student))
  write(manager, created.id, 'learners', student)
  assert.equal(manager.open('asan-ax').db.prepare('SELECT COUNT(*) AS n FROM lms_audit').get().n, 0)
  const reopened = createWorkspaces(options)
  try { assert.equal(reopened.snapshot(created.id).learners[0].name, '학생') } finally { reopened.close() }
  assert.throws(() => manager.create({ name: '세종 AX' }), { status: 409 })
  assert.throws(() => manager.snapshot('../test'), { status: 404 })
})

test('legacy membership migration runs once; later registrations do not inherit guild access on restart', t => {
  const { manager, store, options } = fixture(t, ({ store, sync }) => {
    sync.ingest(payload('asan-ax'))
    store.db.prepare('INSERT INTO lms_users VALUES(?,?,?,?,?,?,?,?)').run('legacy-user', 'legacy.user', '기존 수강생', 'test-hash', '855456789012345678', guildId, 1, 1)
  })
  assert.equal(manager.role('asan-ax', { id: 'legacy-user', role: 'student' }), 'student')
  store.db.prepare('INSERT INTO lms_users VALUES(?,?,?,?,?,?,?,?)').run('later-user', 'later.user', '신규 계정', 'test-hash', '955456789012345678', guildId, 2, 2)
  const reopened = createWorkspaces(options)
  try {
    assert.equal(reopened.role('asan-ax', { id: 'legacy-user', role: 'student' }), 'student')
    assert.equal(reopened.role('asan-ax', { id: 'later-user', role: 'student' }), null)
  } finally { reopened.close() }
})

test('guild ownership filters plans and jobs and rejects cross-workspace writes atomically', t => {
  const { manager } = fixture(t)
  const saved = manager.savePlan('asan-ax', plan)
  assert.deepEqual(manager.provisionRead('default').plans, [])
  assert.throws(() => manager.savePlan('default', saved), { status: 409 })
  assert.throws(() => manager.enqueue('default', saved), { status: 403 })
  manager.enqueue('asan-ax', saved)
  assert.equal(manager.provisionRead('asan-ax').jobs.length, 1)
  assert.equal(manager.provisionRead('default').jobs.length, 0)
  assert.throws(() => manager.savePlan('default', { ...plan, guildId: '223456789012345678', channels: [] }))
  assert.deepEqual(manager.metadata('default').guildIds, [])
  assert.throws(() => manager.create({ name: '충돌', guildId }), { status: 409 })
  assert.equal(manager.list(admin).length, 2)
})

test('remote delivery selects its registered workspace and rolls back conflicting guild snapshots', t => {
  const { manager } = fixture(t)
  manager.ingest(payload('asan-ax'))
  const next = manager.create({ name: '대전 AX' })
  assert.throws(() => manager.ingest(payload(next.sourceId)), { status: 409 })
  assert.equal(manager.remote(next.id).read().snapshot, null)
  manager.ingest(payload(next.sourceId, '323456789012345678'))
  assert.equal(manager.remote(next.id).read().snapshot.bot.guildId, '323456789012345678')
  assert.equal(manager.remote('asan-ax').read().snapshot.bot.guildId, guildId)
  assert.throws(() => manager.ingest(payload('unknown')), { status: 403 })
})

test('shared worker status stays common but guild data and guild-routed snapshots remain scoped', t => {
  const { manager, provision } = fixture(t)
  const secondId = '323456789012345678'
  manager.savePlan('asan-ax', plan)
  const other = manager.create({ name: '공통 봇 연결 워크스페이스', guildId: secondId })
  provision.heartbeat({ bot: { id: '999456789012345678', name: 'Render 공통 봇', ready: true }, guilds: [
    { id: guildId, name: '아산 AX 서버', manageChannels: true, memberCount: 30 },
    { id: secondId, name: '추가 서버', manageChannels: true, memberCount: 10 },
  ] })
  assert.equal(manager.connection('asan-ax').worker.id, manager.connection(other.id).worker.id)
  assert.deepEqual(manager.connection('asan-ax').guilds.map(g => g.id), [guildId])
  assert.deepEqual(manager.connection(other.id).guilds.map(g => g.id), [secondId])
  const body = payload('ignored'); delete body.sourceId
  manager.ingest(body)
  assert.equal(manager.remote('asan-ax').read().snapshot.bot.guildId, guildId)
  assert.equal(manager.remote(other.id).read().snapshot, null)
  assert.throws(() => manager.ingest({ ...body, bot: { ...body.bot, guildId: '823456789012345678' } }), { status: 403 })
})

test('verified accounts need an invitation and roles belong to individual workspaces', async t => {
  const { manager, auth, store } = fixture(t)
  manager.savePlan('asan-ax', plan)
  const member = { username: 'workspace.student', name: '학생', password: 'student-password-1234', discordId: '555456789012345678' }
  const pending = await auth.register(member)
  auth.verify({ code: pending.code, discordId: member.discordId, guildId })
  const { user } = await auth.login({ username: member.username, password: member.password })
  assert.deepEqual(manager.list(user), [])
  assert.throws(() => manager.invite('asan-ax', { username: user.username, role: 'student' }, admin), { status: 422 })
  // Membership after admission approval and Discord proof is covered in admissions.test.mjs.
  store.db.prepare("INSERT INTO lms_workspace_members VALUES(?,?,'student',?)").run('asan-ax', user.id, Date.now())
  assert.deepEqual(manager.list(user).map(w => w.id), ['asan-ax'])
  assert.throws(() => manager.requireAccess('default', user), { status: 403 })
  write(manager, 'default', 'courses', course)
  write(manager, 'default', 'learners', { id: 's1', name: '학생', email: 'student@example.com', discordId: member.discordId, courseId: course.id, team: '', status: '정상', progress: 0, color: 'sage' })
  assert.throws(() => manager.requireAccess('default', user), { status: 403 })
  const second = manager.invite('default', { username: user.username, role: 'instructor' }, admin)
  manager.acceptInvitation(second.token, user)
  assert.deepEqual(manager.list(user).map(w => w.id), ['default', 'asan-ax'])
  assert.equal(manager.role('default', user), 'instructor')
  assert.equal(manager.role('asan-ax', user), 'student')
  assert.equal(manager.requireAccess('default', user).id, 'default')
})

test('invitations bind account and role, are hashed, single-use, revocable and cannot escalate staff permissions', async t => {
  const { manager, auth, store } = fixture(t)
  const member = { username: 'workspace.owner', name: '관리자', password: 'owner-password-1234', discordId: '655456789012345678' }
  const pending = await auth.register(member)
  auth.verify({ code: pending.code, discordId: member.discordId, guildId })
  const { user } = await auth.login({ username: member.username, password: member.password })
  const invitation = manager.invite('asan-ax', { username: user.username, role: 'admin' }, admin)
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM lms_workspace_invitations').all()).includes(invitation.token), false)
  assert.throws(() => manager.acceptInvitation(invitation.token, { ...user, username: 'wrong.user' }), { status: 403 })
  assert.throws(() => manager.acceptInvitation(invitation.token, { ...user, verified: false }), { status: 403 })
  manager.acceptInvitation(invitation.token, user)
  assert.throws(() => manager.acceptInvitation(invitation.token, user), { status: 410 })
  assert.throws(() => manager.invite('asan-ax', { username: 'next.owner', role: 'admin' }, user), { status: 403 })
  assert.throws(() => manager.invite('default', { username: 'next.teacher', role: 'instructor' }, user), { status: 403 })
  const teacher = manager.invite('asan-ax', { username: 'next.teacher', role: 'instructor' }, user)
  assert.equal(manager.previewInvitation(teacher.token).role, 'instructor')
  manager.revokeInvitation('asan-ax', teacher.id, user)
  assert.throws(() => manager.previewInvitation(teacher.token), { status: 410 })
  const expired = manager.invite('asan-ax', { username: 'old.teacher', role: 'instructor' }, user)
  store.db.prepare('UPDATE lms_workspace_invitations SET expires_at=0 WHERE id=?').run(expired.id)
  assert.throws(() => manager.previewInvitation(expired.token), { status: 410 })
})

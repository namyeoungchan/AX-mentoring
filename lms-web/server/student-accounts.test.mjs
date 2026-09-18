import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from './store.mjs'
import { createAuth } from './auth.mjs'
import { createProvision } from './provision.mjs'
import { createRenderSync } from './render-sync.mjs'
import { createWorkspaces } from './workspaces.mjs'
import { createAdmissions } from './admissions.mjs'
const guildId = '123456789012345678', token = 'student-account-test-token-12345678901234567890'
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'student-accounts-')), dbPath = join(dir, 'main.db'), store = createStore(dbPath)
  const auth = createAuth(store.db, { adminPassword: 'setup-key-for-test-1234', guildId, botToken: token })
  createRenderSync(store.db)
  const workspaces = createWorkspaces({ store, dbPath, provision: createProvision(store.db), authGuildId: guildId })
  const admissions = createAdmissions(store.db, workspaces)
  const owner = (await auth.signup({ username: 'workspace.owner', name: '운영자', password: 'owner-test-password' }, () => {})).user
  store.db.prepare("INSERT INTO lms_workspace_members VALUES('asan-ax',?,'admin',0)").run(owner.id)
  workspaces.mutate('asan-ax', { revision: workspaces.snapshot('asan-ax').revision, changes: [
    { kind: 'courses', value: { id: 'c1', title: '실습 과정', category: 'AX', description: '', progress: 0, learners: 0, weeks: '4주', mentor: '', theme: 'green', status: '진행 중', code: 'C1', cohort: '1', guildId, startDate: '2026-09-01', endDate: '2026-12-01' } },
    { kind: 'teams', value: { id: 't1', name: '1조', courseId: 'c1', code: 'T1', mentorId: '' } },
    { kind: 'teams', value: { id: 't2', name: '2조', courseId: 'c1', code: 'T2', mentorId: '' } },
  ] }, 'test')
  const issue = (username, actor = owner, team = 't1', assign) => auth.createStudentAccount({ username }, actor,
    () => admissions.validateStudentIssue('asan-ax', team, actor),
    assign || (user => admissions.assignStudent('asan-ax', team, user, actor)))
  t.after(() => { workspaces.close(); store.db.close(); rmSync(dir, { recursive: true, force: true }) })
  return { store, auth, workspaces, admissions, owner, issue }
}
test('workspace owner issues an approved student; first setup is mandatory before Discord and revokes old sessions', async t => {
  const f = await fixture(t), issued = await f.issue('new.student')
  assert.equal(issued.initialPassword.length, 24)
  const first = await f.auth.login({ username: issued.username, password: issued.initialPassword })
  assert.equal(first.user.mustCompleteProfile, true); assert.equal(first.user.mustChangePassword, true)
  assert.equal(f.workspaces.role('asan-ax', first.user), 'student')
  assert.equal(f.admissions.own(first.user)[0].state, 'approved')
  assert.throws(() => f.auth.issueVerification(first.user, guildId), { status: 403 })
  await assert.rejects(f.auth.changePassword(first.user, { currentPassword: issued.initialPassword, newPassword: 'new-password-1234' }), { status: 403 })
  await assert.rejects(f.auth.completeFirstLogin(first.user, { name: ' ', currentPassword: issued.initialPassword, newPassword: 'new-password-1234' }))
  await assert.rejects(f.auth.completeFirstLogin(first.user, { name: '학생 이름', currentPassword: issued.initialPassword, newPassword: issued.initialPassword }), { status: 422 })
  const setup = await f.auth.completeFirstLogin(first.user, { name: '학생 이름', currentPassword: issued.initialPassword, newPassword: 'new-password-1234' })
  assert.equal(setup.user.name, '학생 이름'); assert.equal(setup.user.mustCompleteProfile, false)
  assert.equal(setup.user.mustChangePassword, false); assert.equal(f.auth.session(first.token), null)
  const code = f.auth.issueVerification(setup.user, guildId).code
  f.auth.verify({ code, guildId, discordId: '223456789012345678' })
  f.admissions.activate('223456789012345678', guildId)
  const learner = f.workspaces.snapshot('asan-ax').learners[0]
  assert.equal(learner.name, '학생 이름'); assert.equal(learner.team, '1조'); assert.equal(learner.status, '정상')
  assert.equal(f.admissions.studentAccounts('asan-ax', f.owner).accounts[0].setupPending, 0)
  assert.ok(!JSON.stringify(f.admissions.studentAccounts('asan-ax', f.owner)).includes(issued.initialPassword))
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM lms_account_audit').all()).includes(issued.initialPassword))
})
test('issue enforces workspace, mentor, duplicate and archive boundaries and rolls back assignment failures', async t => {
  const f = await fixture(t)
  const other = (await f.auth.signup({ username: 'other.owner', name: '다른 운영자', password: 'other-password-1234' }, () => {})).user
  await assert.rejects(f.issue('denied.student', other), { status: 403 })
  f.store.db.prepare("INSERT INTO lms_workspace_members VALUES('asan-ax',?,'instructor',0)").run(other.id)
  await assert.rejects(f.issue('denied.student', other), { status: 403 })
  await assert.rejects(f.issue('wrong.team', f.owner, 'foreign-team'), { status: 422 })
  const issued = await f.issue('existing.student')
  await assert.rejects(f.issue('existing.student'), { status: 409 })
  await f.auth.login({ username: issued.username, password: issued.initialPassword })
  await assert.rejects(f.issue('rollback.student', f.owner, 't1', user => {
    f.admissions.assignStudent('asan-ax', 't1', user, f.owner)
    throw new Error('simulated assignment failure')
  }), /simulated/)
  assert.equal(f.store.db.prepare("SELECT id FROM lms_users WHERE username='rollback.student'").get(), undefined)
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM lms_admissions').get().n, 1)
  f.store.db.prepare("UPDATE lms_workspaces SET archived_at=1 WHERE id='asan-ax'").run()
  await assert.rejects(f.issue('archived.student'), { status: 409 })
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), [])
})
test('first setup concurrent saves cannot overwrite credentials; permission loss while issuing leaves no account', async t => {
  const f = await fixture(t), issued = await f.issue('concurrent.student')
  const { user } = await f.auth.login({ username: issued.username, password: issued.initialPassword })
  const results = await Promise.allSettled(['학생 A', '학생 B'].map(name => f.auth.completeFirstLogin(user, { name, currentPassword: issued.initialPassword, newPassword: 'changed-password-1234' })))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409)
  const pending = f.issue('revoked.student')
  f.store.db.prepare("DELETE FROM lms_workspace_members WHERE workspace_id='asan-ax' AND user_id=?").run(f.owner.id)
  await assert.rejects(pending, { status: 403 })
  assert.equal(f.store.db.prepare("SELECT id FROM lms_users WHERE username='revoked.student'").get(), undefined)
})

test('student team changes before and after Discord verification preserve records and follow roster moves', async t => {
  const f = await fixture(t), issued = await f.issue('moving.student')
  const first = await f.auth.login({ username: issued.username, password: issued.initialPassword })
  const view = () => f.admissions.studentAccounts('asan-ax', f.owner)
  const move = teamId => f.admissions.changeStudentTeam('asan-ax', first.user.id, { teamId, expectedTeamId: view().accounts[0].teamId, revision: view().revision }, f.owner)
  assert.equal(move('t2').accounts[0].teamId, 't2')
  assert.equal(f.workspaces.snapshot('asan-ax').learners.length, 0)
  const setup = await f.auth.completeFirstLogin(first.user, { name: '이동 학생', currentPassword: issued.initialPassword, newPassword: 'changed-password-1234' })
  const code = f.auth.issueVerification(setup.user, guildId).code
  f.auth.verify({ code, guildId, discordId: '323456789012345678' }); f.admissions.activate('323456789012345678', guildId)
  let data = f.workspaces.snapshot('asan-ax'), learner = data.learners[0]
  assert.equal(learner.team, '2조')
  f.workspaces.mutate('asan-ax', { revision: data.revision, changes: [{ kind: 'scores', value: { id: 'score', courseId: 'c1', studentId: learner.id, item: '기존 평가', score: 80, maximum: 100 } }] }, 'test')
  const scores = f.workspaces.snapshot('asan-ax').scores
  assert.equal(move('t1').accounts[0].teamId, 't1')
  data = f.workspaces.snapshot('asan-ax')
  assert.deepEqual(data.scores, scores); assert.equal(data.learners[0].id, learner.id); assert.equal(data.learners[0].status, '정상')
  // Existing bulk/learner editors must be reflected in the account screen too.
  f.workspaces.mutate('asan-ax', { revision: data.revision, changes: [{ kind: 'learners', value: { ...data.learners[0], team: '2조' } }] }, 'bulk-test')
  assert.equal(view().accounts[0].teamId, 't2')
  // A pending admission with a roster must not revert to its original team on activation.
  f.store.db.prepare("UPDATE lms_admissions SET state='approved',team_id='t1' WHERE user_id=?").run(first.user.id)
  f.admissions.activate('323456789012345678', guildId)
  assert.equal(f.workspaces.snapshot('asan-ax').learners[0].team, '2조')
})

test('team changes reject stale assignments, other courses, non-admin actors and archived workspaces', async t => {
  const f = await fixture(t), issued = await f.issue('guarded.student')
  const { user } = await f.auth.login({ username: issued.username, password: issued.initialPassword })
  let data = f.workspaces.snapshot('asan-ax')
  f.workspaces.mutate('asan-ax', { revision: data.revision, changes: [
    { kind: 'courses', value: { ...data.courses[0], id: 'c2', code: 'C2' } },
    { kind: 'teams', value: { id: 'foreign', name: '다른 과정 조', code: 'F', courseId: 'c2', mentorId: '' } },
  ] }, 'test')
  data = f.admissions.studentAccounts('asan-ax', f.owner)
  const body = { revision: data.revision, expectedTeamId: 't1', teamId: 't2' }
  const change = (input = body, actor = f.owner, id = user.id) => f.admissions.changeStudentTeam('asan-ax', id, input, actor)
  assert.throws(() => change(body, user), { status: 403 })
  f.store.db.prepare("UPDATE lms_workspace_members SET role='instructor' WHERE workspace_id='asan-ax' AND user_id=?").run(user.id)
  assert.throws(() => change(body, user), { status: 403 })
  assert.throws(() => change(body, f.owner, f.owner.id), { status: 404 })
  assert.throws(() => change({ ...body, teamId: 'foreign' }), { status: 422 })
  assert.throws(() => change({ ...body, teamId: 'missing' }), { status: 422 })
  assert.throws(() => change({ ...body, revision: 'stale' }), { status: 409 })
  change()
  assert.throws(() => change(), { status: 409 })
  f.store.db.prepare("UPDATE lms_workspaces SET archived_at=1 WHERE id='asan-ax'").run()
  assert.throws(() => change({ ...body, expectedTeamId: 't2', teamId: 't1' }), { status: 409 })
  assert.equal(f.admissions.studentAccounts('asan-ax', f.owner).accounts[0].teamId, 't2')
})

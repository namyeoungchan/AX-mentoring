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
import { createOnboarding } from './onboarding.mjs'
import { createTeamOperations } from './team-operations.mjs'

const guildId = '123456789012345678'
const course = { id: 'c1', title: '교육 과정', category: 'AX', description: '', progress: 0, learners: 0, weeks: '4주', mentor: '', theme: 'green', status: '진행 중', code: 'COURSE', cohort: '1기', guildId, startDate: '2026-09-01', endDate: '2026-12-01' }
function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'lms-onboarding-')), dbPath = join(folder, 'main.db')
  const store = createStore(dbPath), auth = createAuth(store.db, { botToken: 'test-key-123456789012345678901234567890', guildAllowed: () => true })
  createRenderSync(store.db)
  const provision = createProvision(store.db, { token: 'test-key-123456789012345678901234567890' })
  const workspaces = createWorkspaces({ store, dbPath, provision })
  const workspace = workspaces.create({ name: '온보딩 테스트', guildId })
  const onboarding = createOnboarding(store.db, workspaces, provision)
  const write = (kind, value) => workspaces.mutate(workspace.id, { revision: workspaces.snapshot(workspace.id).revision, changes: [{ kind, value }] }, 'operator')
  write('courses', course)
  t.after(() => { workspaces.close(); store.db.close(); rmSync(folder, { recursive: true, force: true }) })
  const configuration = () => { const { report: _report, progress: _progress, ...cfg } = onboarding.read(workspace.id).configs[0]; return cfg }
  return { store, auth, provision, workspaces, workspace, onboarding, write, configuration }
}

test('onboarding settings are opt-in, scoped to guild ownership and reject stale or foreign course changes', t => {
  const { workspaces, workspace, onboarding, configuration } = fixture(t)
  assert.equal(onboarding.poll({ guildIds: [guildId] }).configs[0].enabled, false)
  const cfg = configuration()
  assert.throws(() => onboarding.save('default', { ...cfg, enabled: true }), { status: 403 })
  assert.throws(() => onboarding.save(workspace.id, { ...cfg, courseIds: ['outside'] }), { status: 422 })
  onboarding.save(workspace.id, { ...cfg, enabled: true, courseIds: ['c1'] })
  assert.throws(() => onboarding.save(workspace.id, cfg), { status: 409 })
  assert.deepEqual(onboarding.poll({ guildIds: ['999456789012345678'] }).configs, [])
  const isolated = workspaces.create({ name: '다른 교육', guildId: '888456789012345678' })
  assert.equal(onboarding.read(isolated.id).configs[0].enabled, false)
})

test('teams and verified memberships drive roles; rename, reassignment and removal change the desired revision', async t => {
  const { store, auth, workspace, onboarding, write, configuration } = fixture(t)
  write('teams', { id: 't1', name: '1팀', code: 'T1', courseId: 'c1', mentorId: '' })
  write('teams', { id: 't2', name: '2팀', code: 'T2', courseId: 'c1', mentorId: '' })
  const user = (await auth.signup({ name: '수강생', username: 'onboard.student', password: 'test-password-123456', discordId: '555456789012345678' }, () => {})).user
  const learner = { id: 'l1', name: '수강생', email: 'student@example.com', discordId: user.discordId, courseId: 'c1', team: '1팀', status: '정상' }
  write('learners', learner)
  onboarding.save(workspace.id, { ...configuration(), enabled: true, courseIds: ['c1'] })
  assert.deepEqual(onboarding.poll({ guildIds: [guildId] }).configs[0].participants, [])
  store.db.prepare('INSERT INTO lms_workspace_members VALUES(?,?,?,?)').run(workspace.id, user.id, 'student', 1)
  auth.verify({ code: auth.issueVerification(user, guildId).code, discordId: user.discordId, guildId })
  const original = onboarding.poll({ guildIds: [guildId] }).configs[0]
  assert.equal(original.participants[0].teamId, 't1')
  assert.equal(original.teams.length, 2)
  assert.ok(!JSON.stringify(original).includes(learner.email))
  write('teams', { id: 't1', name: '새 이름', code: 'T1', courseId: 'c1', mentorId: '' })
  const renamed = onboarding.poll({ guildIds: [guildId] }).configs[0]
  assert.equal(renamed.participants[0].teamId, 't1')
  assert.equal(renamed.teams[0].name, '새 이름')
  assert.notEqual(renamed.revision, original.revision)
  write('learners', { ...learner, team: '2팀' })
  assert.equal(onboarding.poll({ guildIds: [guildId] }).configs[0].participants[0].teamId, 't2')
  write('learners', { ...learner, team: '2팀', status: '비활성' })
  assert.deepEqual(onboarding.poll({ guildIds: [guildId] }).configs[0].participants, [])
  assert.throws(() => onboarding.report({ guildId, revision: original.revision, state: 'ready', error: '' }), { status: 409 })
})

test('onboarding completion is guild-scoped and cannot grant a membership or role', t => {
  const { workspaces, workspace, onboarding, configuration } = fixture(t)
  onboarding.save(workspace.id, { ...configuration(), enabled: true })
  onboarding.progress({ guildId, discordId: '555456789012345678' })
  onboarding.progress({ guildId, discordId: '555456789012345678' })
  assert.equal(onboarding.read(workspace.id).configs[0].progress.length, 1)
  assert.deepEqual(onboarding.poll({ guildIds: [guildId] }).configs[0].participants, [])
  const other = workspaces.create({ name: '별도 워크스페이스', guildId: '888456789012345678' })
  assert.equal(onboarding.read(other.id).configs[0].progress.length, 0)
  assert.throws(() => onboarding.progress({ guildId: '888456789012345678', discordId: '555456789012345678' }), { status: 403 })
})

test('100 existing learners move atomically; foreign students and stale revisions never partially apply', t => {
  const f = fixture(t), admin = { id: 'admin', username: 'operator', role: 'admin' }, operations = createTeamOperations(f.workspaces, f.onboarding)
  for (const id of ['t1', 't2']) f.write('teams', { id, name: id, code: id, courseId: 'c1', mentorId: '' })
  const changes = Array.from({ length: 100 }, (_, i) => ({ kind: 'learners', value: { id: `l${i}`, name: `학생${i}`, email: '', discordId: '', courseId: 'c1', team: 't1', status: '정상' } }))
  f.workspaces.mutate(f.workspace.id, { revision: f.workspaces.snapshot(f.workspace.id).revision, changes }, 'operator')
  const before = operations.read(f.workspace.id, admin)
  const body = { revision: before.revision, teamId: 't2', learnerIds: before.learners.map(l => l.id) }
  assert.throws(() => operations.save(f.workspace.id, { ...body, learnerIds: ['l0', 'foreign'] }, admin), { status: 403 })
  assert.equal(operations.read(f.workspace.id, admin).learners.filter(l => l.team === 't1').length, 100)
  const db = f.workspaces.open(f.workspace.id).db
  db.exec("CREATE TRIGGER fail_team BEFORE UPDATE ON lms_records WHEN NEW.id='l99' BEGIN SELECT RAISE(ABORT,'test failure'); END")
  assert.throws(() => operations.save(f.workspace.id, body, admin), /test failure/)
  assert.equal(operations.read(f.workspace.id, admin).revision, before.revision)
  db.exec('DROP TRIGGER fail_team')
  const after = operations.save(f.workspace.id, body, admin)
  assert.equal(after.learners.filter(l => l.team === 't2').length, 100)
  assert.equal(after.history.filter(h => h.before === 't1' && h.after === 't2').length, 100)
  assert.throws(() => operations.save(f.workspace.id, body, admin), { status: 409 })
})

test('member reports track verified desired revision, failures and selected retry without granting mentor access', async t => {
  const f = fixture(t), admin = { id: 'admin', role: 'admin' }, operations = createTeamOperations(f.workspaces, f.onboarding)
  for (const id of ['t1', 't2']) f.write('teams', { id, name: id, code: id, courseId: 'c1', mentorId: '' })
  const user = (await f.auth.signup({ name: '수강생', username: 'sync.student', password: 'test-password-123456', discordId: '565456789012345678' }, () => {})).user
  f.write('learners', { id: 'l1', name: '수강생', email: '', discordId: user.discordId, courseId: 'c1', team: 't1', status: '정상' })
  f.onboarding.save(f.workspace.id, { ...f.configuration(), enabled: true, courseIds: ['c1'] })
  assert.equal(operations.read(f.workspace.id, admin).learners[0].syncState, 'Discord 미인증')
  f.store.db.prepare('INSERT INTO lms_workspace_members VALUES(?,?,?,?)').run(f.workspace.id, user.id, 'student', 1)
  f.auth.verify({ code: f.auth.issueVerification(user, guildId).code, discordId: user.discordId, guildId })
  const cfg = f.onboarding.poll({ guildIds: [guildId] }).configs[0]
  f.onboarding.report({ guildId, revision: cfg.revision, state: 'failed', error: 'permissions', members: [{ discordId: user.discordId, state: 'failed', error: 'permissions' }] })
  assert.equal(operations.read(f.workspace.id, admin).learners[0].syncState, '동기화 실패')
  assert.equal(operations.retry(f.workspace.id, { learnerIds: ['l1'] }, admin).learners[0].syncState, '적용 대기')
  assert.deepEqual(f.onboarding.poll({ guildIds: [guildId] }).configs[0].retryDiscordIds, [user.discordId])
  f.onboarding.report({ guildId, revision: cfg.revision, state: 'ready', error: '', members: [{ discordId: user.discordId, state: 'ready', error: '' }] })
  assert.equal(operations.read(f.workspace.id, admin).learners[0].syncState, '적용 완료')
  assert.throws(() => operations.read(f.workspace.id, user), { status: 403 })
  const mentor = (await f.auth.signup({ name: '멘토', username: 'sync.mentor', password: 'test-password-123456' }, () => {})).user
  f.workspaces.acceptInvitation(f.workspaces.invite(f.workspace.id, { username: mentor.username, role: 'instructor', mentorType: 'group', teamIds: ['t1'] }, admin).token, mentor)
  const state = operations.read(f.workspace.id, mentor)
  assert.throws(() => operations.save(f.workspace.id, { revision: state.revision, teamId: 't2', learnerIds: ['l1'] }, mentor), { status: 422 })
  operations.save(f.workspace.id, { revision: state.revision, teamId: 't2', learnerIds: ['l1'] }, admin)
  assert.equal(operations.read(f.workspace.id, mentor).learners.length, 0)
  assert.throws(() => f.onboarding.report({ guildId, revision: cfg.revision, state: 'ready', error: '' }), { status: 409 })
  assert.equal(operations.read(f.workspace.id, admin).learners[0].syncState, '적용 대기')
})

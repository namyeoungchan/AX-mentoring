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

const token = 'test-admission-worker-token-12345678901234567890', guildId = '123456789012345678'
const admin = { id: 'admin', role: 'admin' }
const input = { name: '가입 학생', username: 'admission.student', password: 'admission-password-1234', discordId: '755456789012345678' }
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'learningops-admissions-')), dbPath = join(directory, 'test.db')
  const store = createStore(dbPath)
  let clock = Date.now()
  const now = () => clock
  const auth = createAuth(store.db, { adminPassword: 'admin-password-1234', guildId, botToken: token, now })
  createRenderSync(store.db)
  const provision = createProvision(store.db, { token })
  const manager = createWorkspaces({ store, dbPath, provision, authGuildId: guildId, now })
  const course = { id: 'c1', title: '승인 과정', category: 'AX', description: '', progress: 0, learners: 0, weeks: '4주', mentor: '', theme: 'green', status: '진행 중', code: 'C1', cohort: '1', guildId, startDate: '2026-09-01', endDate: '2026-12-01' }
  manager.mutate('asan-ax', { revision: manager.snapshot('asan-ax').revision, changes: [{ kind: 'courses', value: course }, { kind: 'teams', value: { id: 't1', name: '1조', courseId: 'c1', code: 'T1', mentorId: '' } }] }, 'test')
  const admissions = createAdmissions(store.db, manager, { token, now })
  t.after(() => { manager.close(); store.db.close(); rmSync(directory, { recursive: true, force: true }) })
  return { store, auth, manager, admissions, advance: ms => { clock += ms } }
}

test('signup creates an approval-only account; approval precedes a private Discord invitation and identity proof', async t => {
  const { auth, manager, admissions } = fixture(t)
  const { user } = await auth.signup(input, user => admissions.apply('asan-ax', user))
  assert.equal(user.verified, false)
  assert.deepEqual(manager.list(user), [])
  const application = admissions.own(user)[0]
  assert.equal(application.state, 'pending'); assert.equal(application.inviteUrl, null)
  assert.throws(() => admissions.approved(application.id, user), { status: 403 })
  assert.throws(() => admissions.review('asan-ax', application.id, { action: 'approve', guildId }, user), { status: 403 })
  assert.throws(() => admissions.review('asan-ax', application.id, { action: 'approve', guildId: '223456789012345678' }, admin), { status: 422 })
  admissions.review('asan-ax', application.id, { action: 'approve', guildId, teamId: 't1' }, admin)
  assert.equal(admissions.own(user)[0].inviteUrl, null)
  const waiting = manager.snapshot('asan-ax').learners[0]
  assert.equal(waiting.status, '대기')
  assert.equal(waiting.team, '1조')
  assert.equal(waiting.discordId, '')
  assert.equal(admissions.poll({ guildIds: ['223456789012345678'] }).job, null)
  const { job } = admissions.poll({ guildIds: [guildId] })
  admissions.complete({ id: job.id, claim: job.claim, success: true, code: 'private-test-invite' })
  assert.equal(admissions.own(user)[0].inviteUrl, 'https://discord.gg/private-test-invite')
  assert.deepEqual(admissions.own({ id: 'different-user' }), [])
  assert.equal(JSON.stringify(admissions.reviewList('asan-ax', admin)).includes('private-test-invite'), false)
  assert.deepEqual(manager.list(user), [])
  const challenge = auth.issueVerification(user, guildId)
  assert.throws(() => auth.verify({ code: challenge.code, discordId: '955456789012345678', guildId }), { status: 403 })
  auth.verify({ code: challenge.code, discordId: input.discordId, guildId })
  admissions.activate(input.discordId, guildId)
  assert.equal(admissions.own(user)[0].state, 'joined')
  assert.equal(manager.role('asan-ax', user), 'student')
  const roster = manager.snapshot('asan-ax').learners
  assert.equal(roster.length, 1)
  assert.equal(roster[0].id, waiting.id)
  assert.equal(roster[0].discordId, input.discordId)
  assert.equal(roster[0].status, '정상')
  assert.equal(roster[0].team, '1조')
  admissions.activate(input.discordId, guildId)
  assert.equal(manager.snapshot('asan-ax').learners.length, 1)
  assert.throws(() => auth.verify({ code: challenge.code, discordId: input.discordId, guildId }), { status: 410 })
})

test('signup rolls back invalid applications and rejection never queues a Discord invite', async t => {
  const { auth, store, admissions } = fixture(t)
  await assert.rejects(auth.signup(input, user => admissions.apply('missing', user)), { status: 404 })
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM lms_users').get().n, 0)
  const { user } = await auth.signup(input, user => admissions.apply('asan-ax', user))
  const application = admissions.own(user)[0]
  admissions.review('asan-ax', application.id, { action: 'reject', reason: '대상 과정 확인 필요' }, admin)
  assert.equal(admissions.own(user)[0].reason, '대상 과정 확인 필요')
  assert.equal(admissions.poll({ guildIds: [guildId] }).job, null)
  assert.throws(() => admissions.review('asan-ax', application.id, { action: 'approve', guildId, teamId: 't1' }, admin), { status: 409 })
})

test('worker claims expire and cannot be replayed; expired invitations can be renewed only by their applicant', async t => {
  const { auth, admissions, advance } = fixture(t)
  const { user } = await auth.signup(input, user => admissions.apply('asan-ax', user))
  const application = admissions.own(user)[0]
  admissions.review('asan-ax', application.id, { action: 'approve', guildId, teamId: 't1' }, admin)
  assert.equal(admissions.authorized(`Bearer ${token}`), true); assert.equal(admissions.authorized('Bearer wrong'), false)
  const { job } = admissions.poll({ guildIds: [guildId] })
  advance(121000)
  assert.throws(() => admissions.complete({ id: job.id, claim: job.claim, success: true, code: 'expired' }), { status: 409 })
  assert.throws(() => admissions.renew(application.id, { id: 'another' }), { status: 403 })
  admissions.renew(application.id, user)
  const next = admissions.poll({ guildIds: [guildId] }).job
  assert.throws(() => admissions.complete({ id: job.id, claim: job.claim, success: true, code: 'replayed' }), { status: 409 })
  admissions.complete({ id: next.id, claim: next.claim, success: true, code: 'fresh-invite' })
  advance(24 * 3600000)
  assert.equal(admissions.own(user)[0].inviteUrl, null)
  admissions.renew(application.id, user)
  assert.equal(admissions.own(user)[0].inviteState, 'queued')
})

test('archived workspaces leave the public catalogue and reject new applications until restored', async t => {
  const { manager, admissions, auth } = fixture(t)
  const { user } = await auth.signup(input, () => {})
  manager.setArchived('asan-ax', true, admin)
  assert.equal(admissions.catalogue().some(row => row.id === 'asan-ax'), false)
  assert.throws(() => admissions.apply('asan-ax', user), { status: 409 })
  manager.setArchived('asan-ax', false, admin)
  assert.ok(admissions.catalogue().some(row => row.id === 'asan-ax'))
  assert.equal(admissions.apply('asan-ax', user).state, 'pending')
})

test('approval requires a local team and rejects missing/foreign teams without inviting or creating a learner', async t => {
  const { auth, manager, admissions } = fixture(t)
  const { user } = await auth.signup(input, u => admissions.apply('asan-ax', u))
  const application = admissions.own(user)[0]
  for (const teamId of ['', 'foreign-team']) {
    assert.throws(() => admissions.review('asan-ax', application.id, { action: 'approve', guildId, teamId }, admin), { status: 422 })
    assert.equal(admissions.own(user)[0].state, 'pending')
    assert.equal(admissions.poll({ guildIds: [guildId] }).job, null)
    assert.equal(manager.snapshot('asan-ax').learners.length, 0)
  }
  assert.equal(admissions.reviewList('asan-ax', admin).teams[0].id, 't1')
})

test('legacy approvals missing a team can be repaired and approved learners without email remain distinct', async t => {
  const { auth, store, manager, admissions } = fixture(t)
  for (let i = 0; i < 2; i++) {
    const { user } = await auth.signup({ ...input, username: `repair.student${i}`, discordId: `75545678901234567${i}` }, u => admissions.apply('asan-ax', u))
    const application = admissions.own(user)[0]
    store.db.prepare("UPDATE lms_admissions SET state='approved',guild_id=? WHERE id=?").run(guildId, application.id)
    admissions.review('asan-ax', application.id, { action: 'approve', guildId, teamId: 't1' }, admin)
    assert.throws(() => admissions.review('asan-ax', application.id, { action: 'approve', guildId, teamId: 't1' }, admin), { status: 409 })
  }
  const learners = manager.snapshot('asan-ax').learners
  assert.equal(learners.length, 2)
  assert.ok(learners.every(l => l.email === '' && l.team === '1조' && l.status === '대기'))
})

test('bulk approval assigns only selected students and reports stale selections without duplicate invites', async t => {
  const { auth, manager, admissions } = fixture(t)
  const people = []
  for (let i = 0; i < 3; i++) {
    const { user } = await auth.signup({ name: `일괄 학생 ${i}`, username: `bulk.student${i}`, password: 'bulk-password-1234' }, u => admissions.apply('asan-ax', u))
    people.push({ user, id: admissions.own(user)[0].id })
  }
  const body = { applicationIds: people.slice(0, 2).map(p => p.id), guildId, teamId: 't1' }
  assert.throws(() => admissions.bulkReview('asan-ax', body, people[0].user), { status: 403 })
  assert.throws(() => admissions.bulkReview('asan-ax', { ...body, teamId: 'missing' }, admin), { status: 422 })
  assert.equal(manager.snapshot('asan-ax').learners.length, 0)
  admissions.review('asan-ax', people[0].id, { action: 'approve', guildId, teamId: 't1' }, admin)
  const result = admissions.bulkReview('asan-ax', body, admin)
  assert.deepEqual(result.succeeded, [people[1].id])
  assert.equal(result.failed[0].id, people[0].id)
  assert.equal(admissions.own(people[2].user)[0].state, 'pending')
  assert.equal(manager.snapshot('asan-ax').learners.length, 2)
  assert.ok(manager.snapshot('asan-ax').learners.every(l => l.team === '1조' && l.status === '대기'))
  assert.equal(admissions.bulkReview('asan-ax', body, admin).succeeded.length, 0)
  const jobs = [admissions.poll({ guildIds: [guildId] }).job, admissions.poll({ guildIds: [guildId] }).job]
  assert.deepEqual(jobs.map(j => j.id).sort(), body.applicationIds.sort())
  assert.equal(admissions.poll({ guildIds: [guildId] }).job, null)
})

test('bulk approval validates the whole workspace selection and instructor team scope before any writes', async t => {
  const { auth, manager, admissions, store } = fixture(t)
  const { user } = await auth.signup(input, u => admissions.apply('asan-ax', u))
  const application = admissions.own(user)[0]
  const other = manager.create({ name: '별도 일괄 승인', guildId: '223456789012345678' })
  const foreign = admissions.apply(other.id, user)
  const body = { applicationIds: [application.id], guildId, teamId: 't1' }
  assert.throws(() => admissions.bulkReview('asan-ax', { ...body, applicationIds: [application.id, foreign.id] }, admin), { status: 404 })
  assert.throws(() => admissions.bulkReview('asan-ax', { ...body, applicationIds: [application.id, application.id] }, admin))
  assert.throws(() => admissions.bulkReview('asan-ax', { ...body, applicationIds: [] }, admin))
  assert.throws(() => admissions.bulkReview('asan-ax', { ...body, applicationIds: Array(101).fill(application.id) }, admin))
  assert.equal(manager.snapshot('asan-ax').learners.length, 0)
  const { user: teacher } = await auth.signup({ name: '담당 강사', username: 'bulk.teacher', password: 'bulk-password-1234' }, () => {})
  store.db.prepare("INSERT INTO lms_workspace_members VALUES(?,?,'instructor',?)").run('asan-ax', teacher.id, Date.now())
  store.db.prepare("INSERT INTO lms_mentor_scopes VALUES(?,?,'group',?)").run('asan-ax', teacher.id, '[]')
  assert.throws(() => admissions.bulkReview('asan-ax', body, teacher), { status: 422 })
  assert.equal(admissions.own(user)[0].state, 'pending')
  store.db.prepare('UPDATE lms_mentor_scopes SET team_ids=? WHERE subject_id=?').run('["t1"]', teacher.id)
  assert.deepEqual(admissions.bulkReview('asan-ax', body, teacher).succeeded, [application.id])
})

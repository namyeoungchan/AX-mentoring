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
  admissions.review('asan-ax', application.id, { action: 'approve', guildId }, admin)
  assert.equal(admissions.own(user)[0].inviteUrl, null)
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
  assert.throws(() => admissions.review('asan-ax', application.id, { action: 'approve', guildId }, admin), { status: 409 })
})

test('worker claims expire and cannot be replayed; expired invitations can be renewed only by their applicant', async t => {
  const { auth, admissions, advance } = fixture(t)
  const { user } = await auth.signup(input, user => admissions.apply('asan-ax', user))
  const application = admissions.own(user)[0]
  admissions.review('asan-ax', application.id, { action: 'approve', guildId }, admin)
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

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
import { createAdmissions } from './admissions.mjs'
import { createOnboarding } from './onboarding.mjs'
import { createStaffFlow } from './staff-flow.mjs'
import { migrateVerification, workspaceVerified } from './workspace-verification.mjs'
import { studentLearning } from './student.mjs'

const admin = { id: 'admin', role: 'admin', username: 'admin' }
const guildA = '111456789012345678', guildB = '222456789012345678', discordId = '333456789012345678'
const token = 'test-only-workspace-auth-token-1234567890'
function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'workspace-verification-')), dbPath = join(folder, 'main.db')
  let time = Date.now()
  const store = createStore(dbPath), db = store.db
  const auth = createAuth(db, { adminPassword: 'test-platform-setup-key-1234', botToken: token, guildAllowed: () => true, now: () => time })
  createRenderSync(db)
  const provision = createProvision(db, { token })
  const workspaces = createWorkspaces({ store, dbPath, provision })
  const admissions = createAdmissions(db, workspaces, { token })
  const onboarding = createOnboarding(db, workspaces, provision)
  const staff = createStaffFlow(db, workspaces, onboarding, admissions)
  const a = workspaces.create({ name: '인증 A', guildId: guildA }), b = workspaces.create({ name: '인증 B', guildId: guildB })
  for (const w of [a, b]) staff.setupGroups(w.id, { count: 1, revision: staff.groups(w.id).revision }, admin)
  const signup = async () => (await auth.signup({ username: 'separate.user', name: '사용자', password: 'test-password-1234' }, () => {})).user
  const invite = (w, user) => workspaces.acceptInvitation(workspaces.invite(w.id, { username: user.username, role: 'instructor' }, admin).token, user)
  const verify = (challenge, guildId) => auth.verify({ code: challenge.code, discordId, guildId })
  const participants = guildId => onboarding.poll({ guildIds: [guildId] }).configs[0].participants
  t.after(() => { workspaces.close(); db.close(); rmSync(folder, { recursive: true, force: true }) })
  return { db, auth, workspaces, admissions, onboarding, staff, a, b, signup, invite, verify, participants, advance: () => { time += 61000 } }
}

test('concurrent workspace codes are independent; verifying A cannot register a mentor or grant roles in B', async t => {
  const { auth, workspaces, staff, a, b, signup, invite, verify, participants } = fixture(t)
  const user = await signup()
  for (const w of [a, b]) { invite(w, user); staff.profile(w.id, { name: w.name, expertise: 'AI' }, user) }
  const first = auth.issueVerification(user, guildA), second = auth.issueVerification(user, guildB)
  assert.throws(() => verify(first, guildB), { status: 403 })
  verify(first, guildA); staff.syncDiscord(discordId, guildA)
  assert.equal(auth.status(second.ticket).state, 'pending')
  assert.equal(staff.read(a.id, user).verified, true)
  assert.equal(staff.read(b.id, user).verified, false)
  staff.profile(b.id, { name: 'B 강사', expertise: 'AI' }, user)
  staff.syncDiscord(discordId, guildB) // A callback alone cannot create proof.
  assert.equal(workspaces.snapshot(b.id).mentors.length, 0)
  assert.equal(participants(guildA).length, 1)
  assert.equal(participants(guildB).length, 0)
  assert.equal(workspaces.list(user).find(w => w.id === b.id).discordVerified, false)
  verify(second, guildB); staff.syncDiscord(discordId, guildB)
  assert.equal(staff.read(a.id, user).verified, true)
  assert.equal(staff.read(b.id, user).verified, true)
  assert.equal(participants(guildB).length, 1)
  assert.equal(workspaces.snapshot(b.id).mentors[0].name, 'B 강사')
  assert.ok(workspaces.list(user).every(w => w.discordVerified))
})

test('renewal replaces only its workspace code; removal revokes only that proof and its pending tickets', async t => {
  const { auth, workspaces, staff, a, b, signup, invite, verify, advance } = fixture(t)
  const user = await signup(); invite(a, user); invite(b, user)
  const first = auth.issueVerification(user, guildA), second = auth.issueVerification(user, guildB)
  advance()
  const renewed = auth.renew(first.ticket)
  assert.throws(() => verify(first, guildA), { status: 410 })
  verify(renewed, guildA); verify(second, guildB)
  advance()
  const pending = auth.issueVerification(user, guildA)
  staff.removeMember(a.id, user.id, admin)
  assert.equal(workspaces.list(user).find(w => w.id === b.id).discordVerified, true)
  assert.throws(() => verify(pending, guildA), { status: 410 })
  assert.throws(() => auth.renew(pending.ticket), { status: 404 })
  assert.throws(() => auth.issueVerification(user, guildA), { status: 403 })
  invite(a, user)
  assert.equal(staff.read(a.id, user).verified, false)
})

test('student approval and activation remain independent in two workspaces', async t => {
  const { db, auth, workspaces, admissions, staff, a, b, signup, verify, participants } = fixture(t)
  const user = await signup()
  for (const w of [a, b]) {
    const application = admissions.apply(w.id, user)
    admissions.review(w.id, application.id, { action: 'approve', guildId: w.guildIds[0], teamId: staff.groups(w.id).teams[0].id }, admin)
  }
  const first = auth.issueVerification(user, guildA), second = auth.issueVerification(user, guildB)
  verify(first, guildA); admissions.activate(discordId, guildA); admissions.activate(discordId, guildB)
  assert.equal(workspaces.role(a.id, user), 'student')
  assert.equal(workspaces.role(b.id, user), null)
  assert.equal(admissions.own(user).find(a => a.workspaceId === b.id).state, 'approved')
  assert.equal(participants(guildB).length, 0)
  verify(second, guildB); admissions.activate(discordId, guildB)
  assert.equal(workspaces.role(b.id, user), 'student')
  assert.equal(participants(guildA).length, 1)
  assert.equal(participants(guildB).length, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lms_workspace_verifications WHERE user_id=?').get(user.id).n, 2)
  db.prepare('DELETE FROM lms_workspace_verifications WHERE workspace_id=?').run(b.id)
  const account = { ...user, discordId, verified: true }
  assert.equal(studentLearning(workspaces.open(a.id).db, account, workspaces.requireAccess(a.id, user).discordVerified).courses.length, 1)
  assert.equal(studentLearning(workspaces.open(b.id).db, account, workspaces.requireAccess(b.id, user).discordVerified).courses.length, 0)
})

test('migration preserves only recorded guild proofs, including earlier staff and student verifications, and never resurrects revoked proof', async t => {
  const { db, workspaces, admissions, a, b, signup, invite } = fixture(t)
  const user = await signup(); invite(a, user); invite(b, user)
  const c = workspaces.create({ name: '이전 수강', guildId: '444456789012345678' })
  const d = workspaces.create({ name: '미인증', guildId: '555456789012345678' }); invite(d, user)
  const application = admissions.apply(c.id, user)
  db.prepare("UPDATE lms_admissions SET state='joined',guild_id=? WHERE id=?").run(c.guildIds[0], application.id)
  db.prepare('UPDATE lms_users SET discord_id=?,guild_id=?,verified_at=1 WHERE id=?').run(discordId, guildA, user.id)
  db.prepare('INSERT INTO lms_staff_connections VALUES(?,?,?)').run(b.id, user.id, discordId)
  db.prepare("DELETE FROM lms_workspace_migrations WHERE name='verification-v1'").run()
  migrateVerification(db)
  for (const w of [a, b, c]) assert.equal(workspaceVerified(db, w.id, user.id), true)
  assert.equal(workspaceVerified(db, d.id, user.id), false)
  db.prepare('DELETE FROM lms_workspace_verifications WHERE workspace_id=?').run(a.id)
  migrateVerification(db)
  assert.equal(workspaceVerified(db, a.id, user.id), false)
})

test('workspace archive and guild reassignment invalidate issued codes without producing a proof', async t => {
  const { db, auth, workspaces, a, b, signup, invite, verify } = fixture(t)
  const user = await signup(); invite(a, user); invite(b, user)
  const first = auth.issueVerification(user, guildA), second = auth.issueVerification(user, guildB)
  workspaces.setArchived(a.id, true, admin)
  assert.throws(() => verify(first, guildA), { status: 403 })
  const other = workspaces.create({ name: '서버 재연결 대상' })
  db.prepare('UPDATE lms_workspace_guilds SET workspace_id=? WHERE guild_id=?').run(other.id, guildB)
  assert.throws(() => verify(second, guildB), { status: 403 })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lms_workspace_verifications').get().n, 0)
})

test('a personal platform administrator links once and cannot switch identity or reuse another workspace proof', async t => {
  const { auth, db, workspaces, a, b, advance } = fixture(t)
  const { user } = await auth.setup({ username: 'platform.owner', name: '총괄 관리자', password: 'test-password-1234', setupKey: 'test-platform-setup-key-1234' })
  const first = auth.issueVerification(user, guildA)
  assert.throws(() => auth.verify({ code: first.code, discordId, guildId: guildB }), { status: 403 })
  assert.equal(auth.preview({ code: first.code, discordId, guildId: guildA }).username, user.username)
  auth.verify({ code: first.code, discordId, guildId: guildA })
  assert.equal(workspaces.requireAccess(a.id, user).discordVerified, true)
  assert.equal(workspaces.requireAccess(b.id, user).discordVerified, false)
  const second = auth.issueVerification(user, guildB)
  assert.throws(() => auth.verify({ code: second.code, discordId: '999456789012345678', guildId: guildB }), { status: 403 })
  assert.throws(() => auth.verify({ code: first.code, discordId, guildId: guildA }), { status: 410 })
  advance()
  workspaces.setArchived(b.id, true, admin)
  assert.throws(() => auth.verify({ code: second.code, discordId, guildId: guildB }), { status: 403 })
  assert.equal(db.prepare('SELECT discord_id FROM lms_users WHERE id=?').get(user.id).discord_id, discordId)
})

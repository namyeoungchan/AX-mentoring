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

const admin = { id: 'admin', username: 'admin', role: 'admin' }
const guildId = '555456789012345678', discordId = '655456789012345678'
const secret = 'test-only-token-12345678901234567890'
function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'staff-flow-')), dbPath = join(folder, 'main.db')
  const store = createStore(dbPath), auth = createAuth(store.db, { botToken: secret, guildAllowed: () => true })
  createRenderSync(store.db)
  const provision = createProvision(store.db, { token: secret })
  const workspaces = createWorkspaces({ store, dbPath, provision })
  const admissions = createAdmissions(store.db, workspaces, { token: secret })
  const onboarding = createOnboarding(store.db, workspaces, provision)
  const staff = createStaffFlow(store.db, workspaces, onboarding, admissions)
  const workspace = workspaces.create({ name: '멘토 운영' })
  const signup = async (username, role = 'instructor', scope = {}, actor = admin) => {
    const invitation = workspaces.invite(workspace.id, { username, role, ...scope }, actor)
    const { user } = await auth.signup({ username, name: username, password: 'test-staff-password-1234' }, () => {})
    workspaces.acceptInvitation(invitation.token, user)
    return user
  }
  const setup = count => staff.setupGroups(workspace.id, { count, revision: staff.groups(workspace.id).revision }, admin)
  const connect = () => { workspaces.addServer(workspace.id, { guildId, templateRevision: workspaces.template(workspace.id).revision }); staff.enableTeams(workspace.id) }
  t.after(() => { workspaces.close(); store.db.close(); rmSync(folder, { recursive: true, force: true }) })
  return { store, auth, workspaces, workspace, staff, admissions, onboarding, signup, setup, connect }
}

test('workspace administrator joins before a Discord server exists and invites scoped mentors without platform privileges', async t => {
  const { workspaces, workspace, signup, setup } = fixture(t)
  const owner = await signup('workspace.owner', 'admin')
  assert.equal(owner.verified, false)
  assert.equal(owner.role, 'student')
  assert.equal(workspaces.role(workspace.id, owner), 'admin')
  assert.deepEqual(workspaces.metadata(workspace.id).guildIds, [])
  assert.throws(() => workspaces.invite(workspace.id, { username: 'new.admin', role: 'admin' }, owner), { status: 403 })
  const groups = setup(3)
  const mentor = await signup('group.mentor', 'instructor', { mentorType: 'group', teamIds: [groups.teams[0].id] }, owner)
  assert.equal(workspaces.role(workspace.id, mentor), 'instructor')
  assert.throws(() => workspaces.requireRole(workspace.id, mentor, ['admin']), { status: 403 })
  assert.throws(() => workspaces.requireAccess('default', mentor), { status: 403 })
})

test('group count creates durable teams, survives retries, enables the bound server, and never removes existing teams', t => {
  const { store, staff, workspace, setup, connect, onboarding } = fixture(t)
  const first = setup(3), ids = first.teams.map(t => t.id)
  assert.deepEqual(setup(3).teams.map(t => t.id), ids)
  store.db.prepare('DELETE FROM lms_group_setup WHERE workspace_id=?').run(workspace.id)
  assert.deepEqual(setup(3).teams.map(t => t.id), ids)
  assert.equal(staff.groups(workspace.id).courses.length, 1)
  assert.equal(setup(5).teams.length, 5)
  assert.throws(() => setup(2), { status: 409 })
  assert.throws(() => staff.setupGroups(workspace.id, { count: 6, revision: first.revision }, admin), { status: 409 })
  connect()
  const cfg = onboarding.poll({ guildIds: [guildId] }).configs[0]
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.teams.length, 5)
  assert.equal(cfg.courseIds[0], first.courseId)
})

test('mentor profile queues only their guild invite, verified identity registers one mentor, and ordered guide progress persists', async t => {
  const { store, staff, workspace, workspaces, auth, admissions, onboarding, signup, setup, connect } = fixture(t)
  setup(2); connect()
  const user = await signup('main.mentor')
  assert.throws(() => staff.invite(workspace.id, user), { status: 422 })
  const result = staff.profile(workspace.id, { name: '강사', expertise: 'AI', bio: '자기소개' }, user)
  assert.equal(result.invitation.inviteState, 'queued')
  assert.equal(admissions.reviewList(workspace.id, admin).applications.length, 0)
  assert.equal(admissions.poll({ guildIds: ['755456789012345678'] }).job, null)
  const { job } = admissions.poll({ guildIds: [guildId] })
  assert.equal(job.guildId, guildId)
  admissions.complete({ id: job.id, claim: job.claim, success: true, code: 'MentorTest' })
  assert.equal(staff.read(workspace.id, user).invitation.inviteUrl, 'https://discord.gg/MentorTest')
  assert.throws(() => staff.step(workspace.id, { step: 'assignments' }, user), { status: 409 })
  const verification = auth.issueVerification(user, guildId)
  auth.verify({ code: verification.code, discordId, guildId }); admissions.activate(discordId, guildId); staff.syncDiscord(discordId, guildId)
  staff.syncDiscord(discordId, guildId)
  assert.equal(workspaces.open(workspace.id).db.prepare('SELECT COUNT(*) AS n FROM mentors').get().n, 1)
  assert.equal(workspaces.role(workspace.id, user), 'instructor')
  assert.equal(onboarding.poll({ guildIds: [guildId] }).configs[0].participants[0].name, '강사')
  const updated = staff.profile(workspace.id, { name: '변경된 활동명', expertise: 'AI' }, user)
  assert.equal(updated.profile.bio, '자기소개')
  assert.equal(onboarding.poll({ guildIds: [guildId] }).configs[0].participants[0].name, '변경된 활동명')
  assert.equal(staff.read(workspace.id, user).verified, true)
  assert.throws(() => staff.step(workspace.id, { step: 'mentoring' }, user), { status: 409 })
  for (const step of ['assignments', 'approval', 'mentoring', 'mentoring']) staff.step(workspace.id, { step }, user)
  assert.equal(staff.read(workspace.id, user).profile.steps.length, 3)
  store.db.prepare('UPDATE lms_users SET guild_id=? WHERE id=?').run('755456789012345678', user.id)
  assert.equal(staff.read(workspace.id, user).verified, true)
})

test('changing mentor teams changes bot roles and LMS scope; foreign teams and out-of-scope edits are rejected', async t => {
  const { store, workspace, workspaces, onboarding, signup, setup, connect } = fixture(t)
  const { teams, courseId } = setup(2); connect()
  const user = await signup('scoped.mentor', 'instructor', { mentorType: 'group', teamIds: [teams[0].id] })
  store.db.prepare('UPDATE lms_users SET discord_id=?,verified_at=1 WHERE id=?').run(discordId, user.id)
  const write = changes => workspaces.mutate(workspace.id, { revision: workspaces.snapshot(workspace.id).revision, changes }, 'test')
  for (const [index, team] of teams.entries()) write([{ kind: 'learners', value: { id: `l${index}`, name: '학습자', email: `l${index}@example.com`, courseId, team: team.name, status: '정상', discordId: '' } }])
  assert.deepEqual(workspaces.teaching(workspace.id, user).learners.map(l => l.id), ['l0'])
  const before = onboarding.poll({ guildIds: [guildId] }).configs[0]
  assert.deepEqual(before.participants[0].teamIds, [teams[0].id])
  assert.throws(() => workspaces.assignMentor(workspace.id, user.id, { mentorType: 'group', teamIds: ['foreign'] }, admin), { status: 422 })
  assert.throws(() => workspaces.assignMentor(workspace.id, user.id, { mentorType: 'main' }, user), { status: 403 })
  const score = { id: 'score', studentId: 'l1', courseId, item: '과제', score: 5, maximum: 10 }
  assert.throws(() => workspaces.teach(workspace.id, { revision: workspaces.snapshot(workspace.id).revision, changes: [{ kind: 'scores', value: score }] }, user), { status: 403 })
  workspaces.assignMentor(workspace.id, user.id, { mentorType: 'group', teamIds: [teams[1].id] }, admin)
  const after = onboarding.poll({ guildIds: [guildId] }).configs[0]
  assert.notEqual(after.revision, before.revision)
  assert.deepEqual(after.participants[0].teamIds, [teams[1].id])
  assert.deepEqual(workspaces.teaching(workspace.id, user).learners.map(l => l.id), ['l1'])
  workspaces.teach(workspace.id, { revision: workspaces.snapshot(workspace.id).revision, changes: [{ kind: 'scores', value: score }] }, user)
  workspaces.assignMentor(workspace.id, user.id, { mentorType: 'main', teamIds: [] }, admin)
  assert.equal(workspaces.teaching(workspace.id, user).learners.length, 2)
  assert.equal(onboarding.poll({ guildIds: [guildId] }).configs[0].participants[0].teamIds.length, 2)
})

test('member editing is workspace scoped, updates mentor identity, and prevents administrator escalation', async t => {
  const { store, staff, workspace, workspaces, signup, setup, connect } = fixture(t)
  const { teams } = setup(2); connect()
  const owner = await signup('edit.owner', 'admin'), mentor = await signup('edit.mentor')
  store.db.prepare('UPDATE lms_users SET discord_id=?,verified_at=1 WHERE id=?').run(discordId, mentor.id)
  staff.profile(workspace.id, { name: '기존 활동명', expertise: 'AI' }, mentor)
  const other = workspaces.create({ name: '다른 워크스페이스' })
  workspaces.acceptInvitation(workspaces.invite(other.id, { username: mentor.username, role: 'instructor' }, admin).token, mentor)
  staff.profile(other.id, { name: '다른 활동명', expertise: '개발' }, mentor)
  const update = { name: '수정된 활동명', expertise: '데이터', role: 'instructor', mentorType: 'group', teamIds: [teams[1].id] }
  assert.throws(() => staff.editMember(workspace.id, mentor.id, { ...update, role: 'admin' }, owner), { status: 403 })
  assert.throws(() => staff.editMember(workspace.id, owner.id, update, owner), { status: 403 })
  assert.throws(() => staff.editMember(workspace.id, mentor.id, { ...update, teamIds: ['foreign'] }, owner), { status: 422 })
  assert.throws(() => staff.editMember(workspace.id, mentor.id, update, mentor), { status: 403 })
  assert.throws(() => staff.editMember(other.id, mentor.id, update, owner), { status: 403 })
  const result = staff.editMember(workspace.id, mentor.id, update, owner)
  assert.equal(result.members.find(m => m.id === mentor.id).name, update.name)
  assert.deepEqual(workspaces.mentorScope(workspace.id, mentor.id).teamIds, [teams[1].id])
  assert.equal(workspaces.snapshot(workspace.id).mentors[0].name, update.name)
  assert.equal(workspaces.snapshot(other.id).mentors[0].name, '다른 활동명')
  assert.equal(store.db.prepare('SELECT name FROM lms_users WHERE id=?').get(mentor.id).name, mentor.name)
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM lms_audit WHERE action='member.update'").get().n, 1)
  staff.editMember(workspace.id, owner.id, { ...update, role: 'admin' }, admin)
  assert.equal(staff.members(workspace.id, admin).members.find(m => m.id === owner.id).name, update.name)
})

test('removal revokes only one membership and pending staff invites, preserves history, and closes booking access', async t => {
  const { store, staff, workspace, workspaces, signup, setup, connect, admissions, onboarding } = fixture(t)
  setup(1); connect()
  const owner = await signup('remove.owner', 'admin'), mentor = await signup('remove.mentor')
  store.db.prepare('UPDATE lms_users SET discord_id=?,verified_at=1 WHERE id=?').run(discordId, mentor.id)
  staff.profile(workspace.id, { name: '멘토', expertise: '개발' }, mentor)
  const other = workspaces.create({ name: '별도 운영' })
  workspaces.acceptInvitation(workspaces.invite(other.id, { username: mentor.username, role: 'instructor' }, admin).token, mentor)
  staff.profile(other.id, { name: '별도 멘토', expertise: '개발' }, mentor)
  const target = workspaces.open(workspace.id).db, mentorId = target.prepare('SELECT id FROM mentors').get().id
  target.prepare("INSERT INTO slots(mentor_id,start_time,end_time,label) VALUES(?,'2030-01-01T12:00:00','2030-01-01T13:00:00','보존할 예약')").run(mentorId)
  target.prepare("INSERT INTO bookings(slot_id,user_id,user_name,status) VALUES(1,'student','학생','approved')").run()
  const { job } = admissions.poll({ guildIds: [guildId] })
  assert.ok(job)
  assert.throws(() => staff.removeMember(workspace.id, owner.id, owner), { status: 403 })
  assert.throws(() => staff.removeMember(workspace.id, mentor.id, mentor), { status: 403 })
  staff.removeMember(workspace.id, mentor.id, owner)
  assert.throws(() => workspaces.requireAccess(workspace.id, mentor), { status: 403 })
  assert.throws(() => staff.profile(workspace.id, { name: '다시', expertise: 'AI' }, mentor), { status: 403 })
  assert.throws(() => staff.removeMember(workspace.id, mentor.id, owner), { status: 404 })
  assert.equal(workspaces.role(other.id, mentor), 'instructor')
  assert.equal(workspaces.snapshot(other.id).mentors.length, 1)
  assert.equal(target.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 1)
  assert.equal(target.prepare('SELECT is_active FROM mentors').get().is_active, 0)
  assert.equal(target.prepare('SELECT is_active FROM slots').get().is_active, 0)
  assert.equal(workspaces.snapshot(workspace.id).mentors.length, 0)
  assert.equal(workspaces.snapshot(workspace.id).sessions.length, 1)
  assert.equal(onboarding.poll({ guildIds: [guildId] }).configs[0].participants.some(p => p.discordId === discordId), false)
  assert.throws(() => admissions.complete({ id: job.id, claim: job.claim, success: true, code: 'StaleInvite' }), { status: 409 })
  assert.equal(staff.members(workspace.id, owner).members.some(m => m.id === mentor.id), false)
  staff.removeMember(workspace.id, owner.id, admin)
  assert.equal(workspaces.role(workspace.id, owner), null)
  assert.ok(store.db.prepare('SELECT id FROM lms_users WHERE id=?').get(owner.id))
  const fresh = workspaces.invite(workspace.id, { username: mentor.username, role: 'instructor' }, admin)
  workspaces.acceptInvitation(fresh.token, mentor)
  staff.profile(workspace.id, { name: '재초대 멘토', expertise: 'AI' }, mentor)
  assert.equal(target.prepare('SELECT COUNT(*) AS n FROM mentors').get().n, 1)
  assert.equal(target.prepare('SELECT is_active FROM mentors').get().is_active, 1)
  assert.equal(target.prepare('SELECT is_active FROM slots').get().is_active, 0)
})

test('pending invitations can change scope and role with the same token, but cannot bypass administrator boundaries', async t => {
  const { workspaces, workspace, signup, setup, auth } = fixture(t)
  const owner = await signup('invite.owner', 'admin'), { teams } = setup(2)
  const invitation = workspaces.invite(workspace.id, { username: 'invite.mentor', role: 'instructor' }, owner)
  const input = { role: 'instructor', mentorType: 'group', teamIds: [teams[1].id] }
  workspaces.editInvitation(workspace.id, invitation.id, input, owner)
  assert.deepEqual(workspaces.previewInvitation(invitation.token).teamIds, input.teamIds)
  assert.throws(() => workspaces.editInvitation(workspace.id, invitation.id, { ...input, role: 'admin' }, owner), { status: 403 })
  workspaces.editInvitation(workspace.id, invitation.id, { role: 'admin' }, admin)
  assert.throws(() => workspaces.editInvitation(workspace.id, invitation.id, input, owner), { status: 403 })
  assert.throws(() => workspaces.invite(workspace.id, { username: 'invite.mentor', role: 'instructor' }, owner), { status: 403 })
  assert.throws(() => workspaces.revokeInvitation(workspace.id, invitation.id, owner), { status: 403 })
  workspaces.editInvitation(workspace.id, invitation.id, input, admin)
  const { user } = await auth.signup({ username: 'invite.mentor', name: '멘토', password: 'test-staff-password-1234' }, () => {})
  workspaces.acceptInvitation(invitation.token, user)
  assert.deepEqual(workspaces.mentorScope(workspace.id, user.id).teamIds, input.teamIds)
  assert.throws(() => workspaces.editInvitation(workspace.id, invitation.id, input, owner), { status: 409 })
  const cancelled = workspaces.invite(workspace.id, { username: 'cancel.mentor', role: 'instructor' }, owner)
  workspaces.revokeInvitation(workspace.id, cancelled.id, owner)
  assert.throws(() => workspaces.editInvitation(workspace.id, cancelled.id, input, owner), { status: 409 })
})

test('default workspace member edits and removal use a single transaction on the shared registry database', async t => {
  const { staff, workspaces, auth } = fixture(t)
  const invitation = workspaces.invite('default', { username: 'default.mentor', role: 'instructor' }, admin)
  const { user } = await auth.signup({ username: 'default.mentor', name: '기본 멘토', password: 'test-staff-password-1234' }, () => {})
  workspaces.acceptInvitation(invitation.token, user)
  staff.editMember('default', user.id, { name: '수정', expertise: '', role: 'instructor' }, admin)
  assert.equal(staff.members('default', admin).members.find(m => m.id === user.id).name, '수정')
  staff.removeMember('default', user.id, admin)
  assert.equal(workspaces.role('default', user), null)
})

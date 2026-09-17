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
import { createOnboarding } from './onboarding.mjs'
import { createBotStorage } from './bot-storage.mjs'
import { createAssignmentAlerts } from './assignment-alerts.mjs'
import { createOutbox } from './outbox.mjs'
const guildId = '123456789012345678', channelId = '223456789012345678', admin = { id: 'admin', username: 'operator', role: 'admin' }
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'assignment-alerts-')), dbPath = join(dir, 'test.db'), store = createStore(dbPath)
  const auth = createAuth(store.db, { botToken: 'test-secret-123456789012345678901234567890', guildAllowed: () => true }); createRenderSync(store.db)
  const provision = createProvision(store.db), workspaces = createWorkspaces({ store, dbPath, provision }), workspace = workspaces.create({ name: '과제 알림', guildId })
  const onboarding = createOnboarding(store.db, workspaces, provision), storage = createBotStorage(store.db, workspaces, onboarding), db = workspaces.open(workspace.id).db
  storage.state(workspace.id)
  let clock = Date.parse('2026-09-18T00:00:00Z')
  const alerts = createAssignmentAlerts(store.db, workspaces, { now: () => clock }), outbox = createOutbox(store.db, workspaces, { now: () => clock, prepare: alerts.prepare })
  const put = (kind, value) => db.prepare('INSERT INTO lms_records VALUES(?,?,?)').run(kind, value.id, JSON.stringify(value))
  put('courses', { id: 'c1', title: '과정' })
  for (let i = 0; i < 2; i++) { put('teams', { id: `t${i}`, name: `${i}팀`, courseId: 'c1' }); put('learners', { id: `l${i}`, name: `학생${i}`, courseId: 'c1', team: `${i}팀`, status: '정상', discordId: String(333456789012345678n + BigInt(i)) }) }
  db.prepare("INSERT INTO assignments(id,week,title,due_date,type) VALUES(1,1,'팀 과제','2026-09-19','team'),(2,1,'개인 과제','2026-09-19','individual')").run()
  db.prepare("INSERT INTO lms_assignment_courses VALUES(1,'c1'),(2,'c1')").run()
  const resource = (kind, key, value) => store.db.prepare('INSERT OR REPLACE INTO lms_runtime_state VALUES(?,?,?,?)').run(guildId, kind, key, JSON.stringify({ id: value }))
  resource('channel', 'team-text:t0', channelId); resource('channel', 'team-text:t1', '423456789012345678'); resource('role', 'team:t0', '523456789012345678'); resource('role', 'team:t1', '623456789012345678')
  const prepare = () => alerts.prepare(workspace.id, outbox.channel)
  t.after(() => { workspaces.close(); store.db.close(); rmSync(dir, { recursive: true, force: true }) })
  return { db, store, auth, workspaces, workspace, storage, alerts, outbox, prepare, setTime: value => { clock = Date.parse(value) } }
}
test('submission and minimal outbox commit together through storage API, independent of Discord', async t => {
  const f = fixture(t), request = { guildId, operation: 'create_submission', args: [1, '333456789012345678', '학생', '0팀', '비공개 본문', 'https://private.example/answer'], requestId: randomUUID() }
  assert.equal((await f.storage.call(request)).result, true)
  assert.equal((await f.storage.call(request)).result, true)
  const rows = f.db.prepare("SELECT * FROM lms_outbox WHERE kind='submission'").all()
  assert.equal(rows.length, 1)
  assert.ok(!rows[0].payload.includes('비공개 본문')); assert.ok(!rows[0].payload.includes('private.example'))
  f.prepare()
  assert.equal(f.db.prepare('SELECT error FROM lms_outbox WHERE id=?').get(rows[0].id).error, 'channel_unconfigured')
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n, 1)
  f.db.exec('BEGIN IMMEDIATE')
  f.db.prepare("INSERT INTO submissions(assignment_id,user_id,user_name,team,content,link) VALUES(1,'other','학생','1팀','','')").run()
  f.db.exec('ROLLBACK')
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM lms_outbox WHERE kind='submission'").get().n, 1)
})
test('team completion is per stable team while individual completion remains per user; D-1 deduplicates and cancels stale targets', t => {
  const f = fixture(t)
  for (const user of ['333456789012345678', '733456789012345678']) f.db.prepare("INSERT INTO submissions(assignment_id,user_id,user_name,team,content,link) VALUES(1,?,'학생','0팀','','')").run(user)
  let a = f.alerts.read(f.workspace.id, admin).assignments.find(a => a.id === '1')
  assert.equal(a.submitted, 1); assert.equal(a.total, 2)
  f.db.prepare("UPDATE lms_records SET data=json_set(data,'$.name','이름 변경') WHERE kind='teams' AND id='t0'").run()
  f.db.prepare("UPDATE lms_records SET data=json_set(data,'$.team','이름 변경') WHERE kind='learners' AND id='l0'").run()
  a = f.alerts.read(f.workspace.id, admin).assignments.find(a => a.id === '1'); assert.equal(a.submitted, 1)
  f.setTime('2026-09-17T23:59:00Z'); f.prepare(); assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM lms_outbox WHERE kind='reminder'").get().n, 0)
  f.setTime('2026-09-18T00:00:00Z'); f.prepare(); f.prepare()
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM lms_outbox WHERE kind='reminder'").get().n, 3)
  f.db.prepare("INSERT INTO submissions(assignment_id,user_id,user_name,team,content,link) VALUES(1,'999456789012345678','완료','1팀','','')").run()
  f.prepare(); assert.equal(f.db.prepare("SELECT state FROM lms_outbox WHERE kind='reminder' AND source_id='1'").get().state, 'cancelled')
  f.db.prepare("UPDATE assignments SET due_date='2026-09-20' WHERE id=2").run(); f.prepare()
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM lms_outbox WHERE kind='reminder' AND state='pending'").get().n, 0)
})
test('only verified recipients receive individual reminders and existing imports do not generate new submission alerts', async t => {
  const f = fixture(t)
  const user = (await f.auth.signup({ username: 'reminder.student', password: 'password-test-1234', name: '학생', discordId: '333456789012345678' }, () => {})).user
  f.store.db.prepare('INSERT INTO lms_workspace_members VALUES(?,?,?,?)').run(f.workspace.id, user.id, 'student', 1)
  f.auth.verify({ code: f.auth.issueVerification(user, guildId).code, discordId: user.discordId, guildId })
  f.prepare()
  const rows = f.db.prepare("SELECT channel_id,error FROM lms_outbox WHERE kind='reminder' AND source_id='2'").all()
  assert.ok(rows.some(r => r.channel_id === `dm:${user.discordId}`)); assert.ok(rows.some(r => r.error === 'recipient_unavailable'))
  f.db.prepare('UPDATE lms_notification_control SET importing=1').run()
  f.db.prepare("INSERT INTO submissions(assignment_id,user_id,user_name,team,content,link) VALUES(2,'old','기존','','','')").run()
  f.db.prepare('UPDATE lms_notification_control SET importing=0').run()
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM lms_outbox WHERE kind='submission'").get().n, 0)
  assert.throws(() => f.alerts.read(f.workspace.id, user), { status: 403 })
  assert.throws(() => f.alerts.bind(f.workspace.id, '2', { courseId: 'foreign' }, admin), { status: 422 })
})

test('assignment preparation never cancels or lists attendance deliveries', t => {
  const f = fixture(t)
  f.db.prepare("INSERT INTO lms_outbox(id,event_key,kind,source_id,payload,actor,created_at) VALUES('attendance-job','attendance-event','attendance','round','{}','teacher',0)").run()
  f.prepare()
  assert.equal(f.db.prepare("SELECT state FROM lms_outbox WHERE id='attendance-job'").get().state, 'pending')
  assert.ok(!f.alerts.read(f.workspace.id, admin).deliveries.some(d => d.kind === 'attendance'))
})

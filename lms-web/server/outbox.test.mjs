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
import { createOutbox } from './outbox.mjs'
const guildId = '123456789012345678', channelId = '223456789012345678', messageId = '323456789012345678', admin = { id: 'admin', username: 'operator', role: 'admin' }
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-')), dbPath = join(dir, 'test.db'), store = createStore(dbPath)
  createAuth(store.db); createRenderSync(store.db)
  const provision = createProvision(store.db), workspaces = createWorkspaces({ store, dbPath, provision }), workspace = workspaces.create({ name: '공지 테스트', guildId })
  const db = workspaces.open(workspace.id).db
  store.db.prepare("UPDATE lms_discord_jobs SET state='succeeded',completed_at=1,results=? WHERE guild_id=?").run(JSON.stringify([{ id: 'notice', discordId: channelId, action: 'created' }]), guildId)
  const put = (kind, value) => db.prepare('INSERT INTO lms_records VALUES(?,?,?)').run(kind, value.id, JSON.stringify(value))
  put('courses', { id: 'c1', title: '과정' }); put('notices', { id: 'n1', courseId: 'c1', title: '공지', content: '@everyone 안내', target: '과정 전체', status: '초안' })
  let clock = 1000
  const outbox = createOutbox(store.db, workspaces, { now: () => clock })
  const read = () => outbox.notices(workspace.id, admin).notices[0]
  const send = () => outbox.enqueueNotice(workspace.id, 'n1', { revision: read().revision }, admin)
  const poll = () => outbox.poll({ guildIds: [guildId] }).job
  const complete = (job, state = 'sent', error = '', msg = messageId) => outbox.complete({ workspaceId: workspace.id, id: job.id, claim: job.claim, state, error, messageId: msg })
  t.after(() => { workspaces.close(); store.db.close(); rmSync(dir, { recursive: true, force: true }) })
  return { db, store, workspaces, workspace, outbox, read, send, poll, complete, advance: () => { clock += 120001 } }
}
test('one immutable notice delivery survives repeated requests and records a claimed result', t => {
  const f = fixture(t); f.send(); f.send()
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM lms_outbox').get().n, 1)
  const job = f.poll(); assert.ok(job); assert.equal(f.poll(), null)
  assert.equal(job.channelId, channelId); assert.equal(job.reconcile, false)
  assert.throws(() => f.workspaces.mutate(f.workspace.id, { revision: f.workspaces.snapshot(f.workspace.id).revision, changes: [{ kind: 'notices', value: { id: 'n1', courseId: 'c1', title: '수정', content: '수정', target: '과정 전체', status: '초안' } }] }, 'operator'), { status: 409 })
  f.complete(job); assert.equal(f.read().delivery.messageId, messageId)
  assert.throws(() => f.complete(job), { status: 409 })
  assert.equal(f.read().attempts.length, 2)
})
test('lost completion and restart reconcile the original channel, never blindly resend', t => {
  const f = fixture(t); f.send(); const first = f.poll(); f.advance()
  const recovered = f.poll(); assert.equal(recovered.id, first.id); assert.equal(recovered.nonce, first.nonce); assert.equal(recovered.reconcile, true)
  assert.throws(() => f.complete(first), { status: 409 })
  f.complete(recovered, 'uncertain', 'not_found', '')
  assert.equal(f.poll(), null)
  f.outbox.retry(f.workspace.id, first.id, admin)
  const checked = f.poll(); assert.equal(checked.reconcile, true)
  f.complete(checked); assert.equal(f.read().delivery.state, 'sent')
})
test('known failure can retry; manual delivery must first hold the queue and validate channel evidence', t => {
  const f = fixture(t); f.send(); const job = f.poll()
  assert.throws(() => f.outbox.hold(f.workspace.id, job.id, admin), { status: 409 })
  f.complete(job, 'failed', 'permissions', '')
  f.outbox.retry(f.workspace.id, job.id, admin)
  assert.equal(f.read().delivery.state, 'pending')
  f.outbox.hold(f.workspace.id, job.id, admin)
  assert.equal(f.poll(), null)
  assert.throws(() => f.outbox.manual(f.workspace.id, job.id, { messageUrl: `https://discord.com/channels/${guildId}/${messageId}/${messageId}` }, admin), { status: 422 })
  f.outbox.manual(f.workspace.id, job.id, { messageUrl: `https://discord.com/channels/${guildId}/${channelId}/${messageId}` }, admin)
  assert.equal(f.read().delivery.state, 'manual'); assert.equal(f.poll(), null)
})
test('scope, stale previews, private targets, archive and arbitrary destination inputs fail closed', t => {
  const f = fixture(t)
  assert.throws(() => f.outbox.notices(f.workspace.id, { id: 'foreign', role: 'student' }), { status: 403 })
  assert.throws(() => f.outbox.enqueueNotice(f.workspace.id, 'n1', { revision: 'stale' }, admin), { status: 409 })
  assert.throws(() => f.outbox.enqueueNotice(f.workspace.id, 'n1', { revision: f.read().revision, channelId }, admin))
  f.db.prepare("UPDATE lms_records SET data=json_set(data,'$.target','관리자') WHERE kind='notices'").run()
  assert.throws(() => f.send(), { status: 422 })
  f.db.prepare("UPDATE lms_records SET data=json_set(data,'$.target','과정 전체') WHERE kind='notices'").run()
  f.send(); f.workspaces.setArchived(f.workspace.id, true, admin)
  assert.equal(f.poll(), null)
  assert.throws(() => f.send(), { status: 409 })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createStore } from './store.mjs'
import { createAuth } from './auth.mjs'
import { createRenderSync } from './render-sync.mjs'
import { createProvision } from './provision.mjs'
import { createWorkspaces } from './workspaces.mjs'
import { createBotStorage, BOT_TABLES } from './bot-storage.mjs'
import { createOnboarding } from './onboarding.mjs'

const guildId = '123456789012345678'
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-storage-')), dbPath = join(dir, 'web.db'), store = createStore(dbPath)
  createAuth(store.db); createRenderSync(store.db)
  const provision = createProvision(store.db)
  const workspaces = createWorkspaces({ store, dbPath, provision })
  createOnboarding(store.db, workspaces, provision)
  const workspace = workspaces.create({ name: '이관 대상', guildId })
  const storage = createBotStorage(store.db, workspaces)
  t.after(() => { workspaces.close(); store.db.close(); rmSync(dir, { recursive: true, force: true }) })
  const data = { version: 1, guildId, tables: Object.fromEntries(Object.keys(BOT_TABLES).map(k => [k, []])), settings: { channels: {}, teams: [], qaUnansweredHours: 24 }, runtime: [] }
  function payload() { const archive = JSON.stringify(data); return { guildId, archive, checksum: createHash('sha256').update(archive).digest('hex') } }
  const call = (operation, args = [], extra = {}) => storage.call({ guildId, operation, args, requestId: randomUUID(), ...extra })
  return { storage, workspace, workspaces, data, payload, call }
}

test('full migration preserves more than 1000 rows, original IDs, backup and workspace isolation', t => {
  const { storage, workspace, workspaces, data, payload } = fixture(t)
  data.tables.qa_alerts = Array.from({ length: 1005 }, (_, i) => ({ thread_id: String(123456789012345600n + BigInt(i)), alerted_at: '2026-09-01' }))
  data.tables.mentors = [{ id: 41, discord_id: '555456789012345678', name: '기존 멘토', bio: '원문' }]
  const input = payload()
  assert.equal(storage.bootstrap(input).migrated, true)
  assert.equal(storage.bootstrap(input).checksum, input.checksum)
  assert.equal(storage.archive(workspace.id, input.checksum), input.archive)
  assert.equal(storage.table(workspace.id, 'qa_alerts', 10).rows.length, 5)
  assert.equal(storage.table(workspace.id, 'mentors').rows[0].id, 41)
  const other = workspaces.create({ name: '다른 과정', guildId: '888456789012345678' })
  assert.equal(storage.table(other.id, 'mentors').rows.length, 0)
  assert.throws(() => storage.archive(other.id, input.checksum), { status: 404 })
  assert.throws(() => storage.table(workspace.id, 'lms_users'), { status: 404 })
})

test('migration conflicts roll back all inserts and retain the source for review', t => {
  const { storage, workspace, workspaces, data, payload } = fixture(t)
  workspaces.open(workspace.id).db.prepare('INSERT INTO mentors(id,discord_id,name) VALUES(1,?,?)').run('555456789012345678', '웹 편집본')
  data.tables.mentors = [{ id: 2, discord_id: '666456789012345678', name: '먼저 입력될 행' }, { id: 1, discord_id: '555456789012345678', name: '옛 봇 값' }]
  const input = payload()
  assert.throws(() => storage.bootstrap(input), { status: 409 })
  assert.equal(storage.table(workspace.id, 'mentors').rows.length, 1)
  assert.equal(storage.table(workspace.id, 'mentors').rows[0].name, '웹 편집본')
  assert.equal(storage.state(workspace.id).imports[0].state, 'conflict')
  assert.equal(storage.archive(workspace.id, input.checksum), input.archive)
  assert.throws(() => storage.bootstrap({ ...input, checksum: '0'.repeat(64) }), { status: 422 })
})

test('web-owned legacy operations preserve transactions, retry receipts and revision conflicts', async t => {
  const { storage, workspace, payload, call } = fixture(t)
  storage.bootstrap(payload())
  const requestId = randomUUID()
  const first = await call('add_mentor', ['555456789012345678', '한글 멘토', '소개'], { requestId })
  assert.deepEqual(await call('add_mentor', ['555456789012345678', '한글 멘토', '소개'], { requestId }), first)
  assert.equal(storage.table(workspace.id, 'mentors').total, 1)
  const revision = storage.state(workspace.id).revision
  await call('add_slot', [first.result, '2026-10-01T10:00:00', '2026-10-01T10:50:00', '예약 시간'])
  await assert.rejects(call('add_mentor', ['777456789012345678', '오래된 요청'], { revision }), { status: 409 })
  const slot = storage.table(workspace.id, 'slots').rows[0]
  assert.equal((await call('create_booking', [slot.id, '777456789012345678', '수강생'])).result, true)
  assert.equal((await call('create_booking', [slot.id, '888456789012345678', '중복'])).result, false)
  assert.equal(storage.table(workspace.id, 'bookings').total, 1)
  await assert.rejects(call('init_db'), { status: 422 })
  await assert.rejects(call('create_onboarding', ['777456789012345678', '888456789012345678']), { status: 422 })
})

test('runtime panel and onboarding state lives in the web and stays scoped to each guild', t => {
  const { storage, workspaces } = fixture(t)
  workspaces.create({ name: '별도', guildId: '888456789012345678' })
  storage.runtime({ guildId, kind: 'member', key: '555456789012345678', operation: 'put', value: { introDone: true } })
  assert.equal(storage.runtime({ guildId, kind: 'member', key: '555456789012345678', operation: 'get' }).introDone, true)
  assert.equal(storage.runtime({ guildId: '888456789012345678', kind: 'member', key: '555456789012345678', operation: 'get' }), null)
})

test('migration preserves shared bot metadata under each registered guild and never imports stale settings caches', t => {
  const { storage, workspaces, data, payload } = fixture(t)
  const otherGuild = '888456789012345678'
  workspaces.create({ name: '공통 봇의 다른 서버', guildId: otherGuild })
  data.runtime = [guildId, otherGuild].map(id => ({ guild_id: id, kind: 'channel', record_key: 'start', data: JSON.stringify({ id: '999456789012345678' }) }))
  data.runtime.push({ guild_id: '0', kind: 'config', record_key: 'snapshot', data: '{}' })
  storage.bootstrap(payload())
  assert.equal(storage.runtime({ guildId: otherGuild, kind: 'channel', key: 'start', operation: 'get' }).id, '999456789012345678')
  assert.equal(storage.runtime({ guildId: '0', kind: 'config', key: 'snapshot', operation: 'get' }), null)
})

test('nested schedule generation accepts bot date values and skips configured holidays', async t => {
  const { storage, workspace, payload, call } = fixture(t)
  storage.bootstrap(payload())
  const mentor = (await call('add_mentor', ['555456789012345678', '예약 멘토'])).result
  await call('set_slot_template', [mentor, 10, 0, 11, 0, 30])
  await call('block_date', [mentor, '2026-10-02'])
  const result = await call('generate_slots_for_range', [mentor, { $lms: 'date', value: '2026-10-01' }, { $lms: 'date', value: '2026-10-02' }])
  assert.deepEqual(result.result, { $lms: 'tuple', value: [2, 1] })
  assert.equal(storage.table(workspace.id, 'slots').total, 2)
})

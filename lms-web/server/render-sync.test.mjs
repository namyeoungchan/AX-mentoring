import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createRenderSync } from './render-sync.mjs'
const token = 'test-only-sync-token-12345678901234567890'
const timestamp = Date.parse('2026-09-15T12:00:00Z')
function payload() { return { sourceId: 'asan-ax', name: '아산 AX', capturedAt: new Date(timestamp).toISOString(), rowLimit: 1000, bot: { name: 'asanAX', ready: true, latencyMs: 50, guildId: '123456789012345678', guildName: '아산 AX', memberCount: 80 }, counts: { mentors: 1, bookings: 0, assignments: 0, submissions: 0, onboarding_progress: 10, pending_bookings: 0 }, mentors: [{ id: 1, name: '멘토', discord_id: '223456789012345678', bio: '' }], bookings: [], assignments: [], submissions: [] } }
function fixture(t, options = {}) { const db = new DatabaseSync(':memory:'); t.after(() => db.close()); return { db, sync: createRenderSync(db, { token, now: () => timestamp, ...options }) } }
test('sync token is scoped separately from administrator sessions', t => {
  const { sync } = fixture(t)
  assert.equal(sync.authorized(), false); assert.equal(sync.authorized('Bearer wrong'), false); assert.equal(sync.authorized('Bearer ' + token), true)
  assert.equal(fixture(t, { token: '' }).sync.authorized('Bearer ' + token), false)
})
test('initial state does not claim the worker is connected', t => {
  const { sync } = fixture(t); assert.equal(sync.read().state, 'waiting'); assert.equal(sync.read().snapshot, null)
})
test('snapshot is persisted separately and strips unapproved fields', t => {
  const { sync, db } = fixture(t); sync.ingest({ ...payload(), secret: 'do-not-store' })
  assert.equal(sync.read().state, 'synced'); assert.equal(sync.read().snapshot.mentors.length, 1)
  assert.equal(JSON.stringify(sync.read()).includes('do-not-store'), false)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='mentors'").get().n, 0)
})
test('stale snapshot is never reported as current status', t => {
  let now = timestamp; const { sync } = fixture(t, { now: () => now }); sync.ingest(payload()); now += 181000
  assert.equal(sync.read().state, 'stale'); assert.equal(sync.read().snapshot.bot.ready, true)
})
test('rejects replay, clock skew, wrong source and inconsistent counts', t => {
  const { sync } = fixture(t)
  assert.throws(() => sync.ingest({ ...payload(), sourceId: 'other' }), /데이터 소스/)
  assert.throws(() => sync.ingest({ ...payload(), capturedAt: '2025-01-01T00:00:00Z' }), /시각/)
  assert.throws(() => sync.ingest({ ...payload(), mentors: [] }), /건수/)
  sync.ingest(payload()); assert.throws(() => sync.ingest(payload()), /이전/)
})
test('bot disconnection is retained distinctly from successful sync', t => {
  const { sync } = fixture(t); const body = payload(); body.bot.ready = false; sync.ingest(body)
  assert.equal(sync.read().state, 'synced'); assert.equal(sync.read().snapshot.bot.ready, false)
})

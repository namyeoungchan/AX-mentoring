import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRenderSync } from './render-sync.mjs';
const token = 'test-only-sync-token-12345678901234567890';
const timestamp = Date.parse('2026-09-15T12:00:00Z');
function payload() { return { sourceId: 'asan-ax', name: '아산 AX', capturedAt: new Date(timestamp).toISOString(), rowLimit: 1000, bot: { name: 'asanAX', ready: true, latencyMs: 50, guildId: '123456789012345678', guildName: '아산 AX', memberCount: 80 }, counts: { mentors: 1, bookings: 0, assignments: 0, submissions: 0, onboarding_progress: 10, pending_bookings: 0 }, mentors: [{ id: 1, name: '멘토', discord_id: '223456789012345678', bio: '' }], bookings: [], assignments: [], submissions: [] }; }
async function fixture(t, options = {}) { const db = new DatabaseSync(':memory:'); t.after(() => db.close()); return { db, sync: await createRenderSync(db, { token, now: () => timestamp, ...options }) }; }
test('sync token is scoped separately from administrator sessions', async (t) => {
    const { sync } = await fixture(t);
    assert.equal(sync.authorized(), false);
    assert.equal(sync.authorized('Bearer wrong'), false);
    assert.equal(sync.authorized('Bearer ' + token), true);
    assert.equal((await fixture(t, { token: '' })).sync.authorized('Bearer ' + token), false);
});
test('initial state does not claim the worker is connected', async (t) => {
    const { sync } = await fixture(t);
    assert.equal((await sync.read()).state, 'waiting');
    assert.equal((await sync.read()).snapshot, null);
});
test('snapshot is persisted separately and strips unapproved fields', async (t) => {
    const { sync, db } = await fixture(t);
    await sync.ingest({ ...payload(), secret: 'do-not-store' });
    assert.equal((await sync.read()).state, 'synced');
    assert.equal((await sync.read()).snapshot.mentors.length, 1);
    assert.equal(JSON.stringify(await sync.read()).includes('do-not-store'), false);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='mentors'").get()).n, 0);
});
test('stale snapshot is never reported as current status', async (t) => {
    let now = timestamp;
    const { sync } = await fixture(t, { now: () => now });
    await sync.ingest(payload());
    now += 181000;
    assert.equal((await sync.read()).state, 'stale');
    assert.equal((await sync.read()).snapshot.bot.ready, true);
});
test('rejects replay, clock skew, wrong source and inconsistent counts', async (t) => {
    const { sync } = await fixture(t);
    await assert.rejects(async () => await sync.ingest({ ...payload(), sourceId: 'other' }), /데이터 소스/);
    await assert.rejects(async () => await sync.ingest({ ...payload(), capturedAt: '2025-01-01T00:00:00Z' }), /시각/);
    await assert.rejects(async () => await sync.ingest({ ...payload(), mentors: [] }), /건수/);
    await sync.ingest(payload());
    await assert.rejects(async () => await sync.ingest(payload()), /이전/);
});
test('bot disconnection is retained distinctly from successful sync', async (t) => {
    const { sync } = await fixture(t);
    const body = payload();
    body.bot.ready = false;
    await sync.ingest(body);
    assert.equal((await sync.read()).state, 'synced');
    assert.equal((await sync.read()).snapshot.bot.ready, false);
});

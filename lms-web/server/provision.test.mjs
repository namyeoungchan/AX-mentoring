import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createProvision } from './provision.mjs';
const guildId = '123456789012345678';
const token = 'test-provision-token-12345678901234567890';
const input = () => ({ guildId, name: '교육 서버', autoApply: true, revision: '', channels: [
        { id: 'cat', name: '학습', type: 'category', parentId: '' },
        { id: 'text', name: 'Question', type: 'text', parentId: 'cat' },
        { id: 'voice', name: '멘토링 음성', type: 'voice', parentId: 'cat' },
    ] });
const guilds = [{ id: guildId, name: '교육 서버', manageChannels: true }];
const success = job => ({ id: job.id, claim: job.claim, success: true, errorCode: null, results: job.plan.channels.map((item, i) => ({ id: item.id, discordId: String(223456789012345678n + BigInt(i)), action: 'created' })) });
test('server registration can wait for worker configuration without losing or duplicating the queued layout', async () => {
    const db = new DatabaseSync(':memory:');
    try {
        const offline = await createProvision(db);
        const queued = await offline.install(guildId, input());
        assert.equal(queued.job.state, 'queued');
        assert.equal(offline.authorized(`Bearer ${token}`), false);
        const online = await createProvision(db, { token });
        assert.equal((await online.poll({ guilds })).job.id, queued.job.id);
        assert.equal((await online.install(guildId, input())).created, false);
        assert.equal((await online.read()).jobs.length, 1);
    }
    finally {
        db.close();
    }
});
test('one worker processes distinct guild plans and reports departures and stale status independently of jobs', async () => {
    const db = new DatabaseSync(':memory:');
    let clock = Date.now();
    try {
        const service = await createProvision(db, { token, now: () => clock });
        const secondGuild = { id: '333456789012345678', name: '다른 워크스페이스', manageChannels: true };
        const bot = { id: '999456789012345678', name: '공통 봇', ready: true };
        await service.save(input());
        await service.save({ ...input(), guildId: secondGuild.id });
        const first = (await service.poll({ bot, guilds: [...guilds, secondGuild] })).job;
        assert.equal(first.plan.guildId, guildId);
        await service.complete(success(first));
        const second = (await service.poll({ bot, guilds: [...guilds, secondGuild] })).job;
        assert.equal(second.plan.guildId, secondGuild.id);
        await service.heartbeat({ bot, guilds });
        assert.equal((await service.read([secondGuild.id])).guilds[0].connected, false);
        assert.equal((await service.read([guildId])).guilds[0].connected, true);
        assert.equal((await service.read([guildId])).worker.id, (await service.read([secondGuild.id])).worker.id);
        assert.equal((await service.read([guildId])).jobs[0].guildId, guildId);
        clock += 91000;
        assert.equal((await service.read([guildId])).worker.connected, false);
        assert.equal((await service.read([guildId])).guilds[0].connected, false);
        await service.heartbeat({ bot: { ...bot, ready: false }, guilds });
        assert.equal((await service.read([guildId])).worker.connected, false);
        assert.equal((await service.poll({ bot: { ...bot, ready: false }, guilds })).job, null);
    }
    finally {
        db.close();
    }
});
test('bot join queues only the matching server, claims once, and records applied channels', async () => {
    const db = new DatabaseSync(':memory:');
    try {
        const provision = await createProvision(db, { token });
        const saved = await provision.save(input());
        assert.equal(saved.channels[1].name, 'question');
        assert.equal((await provision.poll({ guilds: [{ ...guilds[0], id: '999456789012345678' }] })).job, null);
        const { job } = await provision.poll({ guilds });
        assert.equal(job.plan.guildId, guildId);
        assert.equal((await provision.poll({ guilds })).job, null);
        await assert.rejects(async () => await provision.save(saved), { status: 409 });
        await assert.rejects(async () => await provision.enqueue(guildId, saved.revision), { status: 409 });
        await assert.rejects(async () => await provision.complete({ ...success(job), claim: '0'.repeat(64) }), { status: 409 });
        await assert.rejects(async () => await provision.complete({ ...success(job), results: [] }), { status: 422 });
        await provision.complete(success(job));
        assert.equal((await provision.read()).jobs[0].state, 'succeeded');
        assert.equal((await provision.read()).jobs[0].results.length, 3);
        assert.ok(!JSON.stringify(await provision.read()).includes(job.claim));
        assert.equal((await provision.poll({ guilds })).job, null);
        await assert.rejects(async () => await provision.complete(success(job)), { status: 409 });
    }
    finally {
        db.close();
    }
});
test('failed and expired jobs require an explicit retry; old claims cannot complete new jobs', async () => {
    const db = new DatabaseSync(':memory:');
    let now = 1000;
    try {
        const provision = await createProvision(db, { token, now: () => now });
        const saved = await provision.save(input());
        const first = (await provision.poll({ guilds })).job;
        await provision.complete({ id: first.id, claim: first.claim, success: false, errorCode: 'forbidden', results: [] });
        assert.equal((await provision.poll({ guilds })).job, null);
        await provision.enqueue(guildId, saved.revision);
        const second = (await provision.poll({ guilds })).job;
        now += 300000;
        assert.equal((await provision.read()).jobs[0].state, 'failed');
        await assert.rejects(async () => await provision.complete(success(second)), { status: 409 });
        assert.equal((await provision.poll({ guilds })).job, null);
        assert.equal((await provision.read()).guilds[0].connected, true);
        now += 90000;
        assert.equal((await provision.read()).guilds[0].connected, false);
    }
    finally {
        db.close();
    }
});
test('manual configuration waits for a request and validates revisions and hierarchy', async () => {
    const db = new DatabaseSync(':memory:');
    try {
        const provision = await createProvision(db, { token });
        assert.equal(provision.authorized(`Bearer ${token}`), true);
        assert.equal(provision.authorized('Bearer unrelated-key'), false);
        const bad = input();
        bad.channels[1].parentId = 'missing';
        await assert.rejects(async () => await provision.save(bad));
        const duplicate = input();
        duplicate.channels.push({ ...duplicate.channels[1], id: 'other' });
        await assert.rejects(async () => await provision.save(duplicate));
        const nested = input();
        nested.channels[0].parentId = 'cat';
        await assert.rejects(async () => await provision.save(nested));
        const saved = await provision.save({ ...input(), autoApply: false });
        assert.equal((await provision.poll({ guilds })).job, null);
        await assert.rejects(async () => await provision.save(input()), { status: 409 });
        await assert.rejects(async () => await provision.enqueue(guildId, ''), { status: 409 });
        await provision.enqueue(guildId, saved.revision);
        assert.ok((await provision.poll({ guilds })).job);
    }
    finally {
        db.close();
    }
});

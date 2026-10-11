import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMentoringCoordination, coordinationState } from './mentoring-coordination.mjs';
import { createMentoringFeedback } from './mentoring-feedback.mjs';
import { createOutbox } from './outbox.mjs';

export async function mentoringCoordinationScenario(runtime) {
    const { store, workspaces, auth } = runtime;
    const guildId = '193456789012345678', mentorDiscord = '293456789012345678', studentDiscord = '393456789012345678';
    const admin = { id: 'admin', username: 'admin', role: 'admin' };
    const ws = await workspaces.create({ name: '일정 재조율 검증', guildId }), id = ws.id;
    const db = (await workspaces.open(id)).db;
    let clock = Date.parse('2031-01-01T00:00:00+09:00');
    const service = createMentoringCoordination(store.db, workspaces, { now: () => clock });
    const feedback = createMentoringFeedback(store.db, workspaces, { now: () => clock });
    const outbox = createOutbox(store.db, workspaces, { now: () => clock, prepare: service.prepare });
    async function member(name, discordId, role, scope) {
        const { user } = await auth.signup({ username: `coord.${name}`, name, discordId, password: 'test-password-12345' }, () => {});
        await store.db.prepare('INSERT INTO lms_workspace_members VALUES(?,?,?,?)').run(id, user.id, role, clock);
        if (scope) await store.db.prepare('INSERT INTO lms_mentor_scopes VALUES(?,?,?,?)').run(id, user.id, scope, '[]');
        await store.db.prepare('INSERT INTO lms_workspace_verifications VALUES(?,?,?,?,?)').run(id, user.id, guildId, discordId, clock);
        return user;
    }
    const mentor = await member('mentor', mentorDiscord, 'instructor', 'group');
    const student = await member('student', studentDiscord, 'student');
    const stranger = await member('stranger', '493456789012345678', 'student');
    const main = await member('main', '593456789012345678', 'instructor', 'main');
    const otherMentor = await member('other', '693456789012345678', 'instructor', 'group');
    await db.prepare("INSERT INTO mentors(id,discord_id,name) VALUES(1,?,'조 담당 멘토')").run(mentorDiscord);
    await db.prepare("INSERT INTO mentors(id,discord_id,name) VALUES(2,?,'다른 멘토')").run(otherMentor.discordId);
    for (let index = 1; index <= 5; index++) {
        const day = `2031-01-0${index + 2}`;
        await db.prepare('INSERT INTO slots(id,mentor_id,start_time,end_time,label) VALUES(?,1,?,?,?)').run(index, `${day}T15:00:00`, `${day}T16:00:00`, `프로젝트 리뷰 ${index}`);
    }
    await db.prepare("INSERT INTO slots(id,mentor_id,start_time,end_time,label) VALUES(6,2,'2031-01-04T15:00:00','2031-01-04T16:00:00','다른 멘토')").run();
    await db.prepare("INSERT INTO bookings(id,slot_id,user_id,user_name,status) VALUES(1,1,?,'수강생','approved')").run(studentDiscord);
    await db.prepare("INSERT INTO bookings(id,slot_id,user_id,user_name,status) VALUES(2,4,?,'다른 수강생','approved')").run(stranger.discordId);
    const state = () => coordinationState(db, '1');
    const command = async (actor, action, extra = {}) => {
        const input = { eventId: randomUUID(), version: (await state()).version, action, ...extra };
        return service.act(id, '1', actor, input);
    };
    const proposal = { slotId: '2', reason: '프로젝트 일정 변경', originalAvailable: false };
    for (const user of [admin, main]) {
        await assert.rejects(service.list(id, user), { status: 403 });
        await assert.rejects(command(user, 'propose', proposal), { status: 403 });
    }
    await assert.rejects(service.read(id, '1', stranger), { status: 404 });
    await assert.rejects(service.read(id, '1', otherMentor), { status: 404 });
    await assert.rejects(service.read('default', '1', student), { status: 403 });
    assert.equal((await service.list(id, mentor)).sessions.length, 2);
    await assert.rejects(command(student, 'propose', { ...proposal, slotId: '6' }), { status: 409 });
    await assert.rejects(command(student, 'propose', { ...proposal, slotId: '4' }), { status: 409 });
    const request = { eventId: randomUUID(), version: 0, action: 'propose', ...proposal };
    const originalPrepare = db.prepare;
    db.prepare = function (sql) {
        if (sql.startsWith('INSERT INTO lms_outbox')) throw new Error('simulated outbox failure');
        return originalPrepare.call(this, sql);
    };
    try { await assert.rejects(service.act(id, '1', student, request), /simulated outbox failure/); }
    finally { db.prepare = originalPrepare; }
    assert.equal((await state()).version, 0, 'notification insertion failure rolls back proposal, audit and holds');
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM lms_audit WHERE action LIKE 'mentoring.%'").get()).n, 0);
    await service.act(id, '1', student, request);
    assert.equal((await db.prepare('SELECT slot_id FROM bookings WHERE id=1').get()).slot_id, 1, 'proposal preserves existing booking');
    assert.equal((await service.act(id, '1', student, request)).duplicate, true);
    assert.equal((await state()).version, 1);
    await assert.rejects(service.act(id, '1', student, { ...request, reason: '다른 내용' }), { status: 409 });
    await assert.rejects(command(student, 'accept'), { status: 403 }, 'cannot accept own proposal');
    await assert.rejects(command(mentor, 'withdraw', { reason: '대신 철회', originalAvailable: true }), { status: 403 });
    await assert.rejects(service.act(id, '2', mentor, { ...request, eventId: randomUUID() }), { status: 409 }, 'hold prevents another proposal for the same mentor and time');
    const snapshot = await workspaces.snapshot(id);
    await assert.rejects(workspaces.mutate(id, { revision: snapshot.revision, changes: [{ kind: 'sessions', value: { ...snapshot.sessions.find(s => s.id === '1'), status: '완료' } }] }, 'admin'), { status: 409 });
    assert.equal((await outbox.poll({ guildIds: [guildId] })).job, null, 'old bots cannot claim coordination jobs');
    const job = (await outbox.poll({ guildIds: [guildId], capabilities: ['mentoring_coordination'] })).job;
    assert.ok([mentorDiscord, studentDiscord].includes(job.payload.targetId));
    assert.equal(job.channelId, `dm:${job.payload.targetId}`);
    await outbox.complete({ workspaceId: id, id: job.id, claim: job.claim, state: 'failed', error: 'permissions' });
    await assert.rejects(service.retry(id, '1', job.id, main), { status: 403 });
    await service.retry(id, '1', job.id, student);
    assert.equal((await db.prepare('SELECT state FROM lms_outbox WHERE id=?').get(job.id)).state, 'pending');
    await command(mentor, 'reject', { reason: '다른 시간 요청', originalAvailable: true });
    assert.equal((await state()).status, 'needs_coordination', 'rejection never restores an unavailable original appointment');
    assert.equal((await state()).proposal, null, 'rejection releases hold');
    await command(mentor, 'propose', { ...proposal, slotId: '3', originalAvailable: true });
    await assert.rejects(service.act(id, '1', student, { eventId: randomUUID(), version: 1, action: 'accept' }), { status: 409 }, 'old buttons cannot accept a newer proposal');
    await db.prepare("INSERT INTO reminders(booking_id,type) VALUES(1,'day_before')").run();
    const currentVersion = (await state()).version;
    const simultaneous = await Promise.allSettled([
        service.act(id, '1', student, { eventId: randomUUID(), version: currentVersion, action: 'accept' }),
        service.act(id, '1', mentor, { eventId: randomUUID(), version: currentVersion, action: 'withdraw', reason: '동시 철회', originalAvailable: true }),
    ]);
    assert.equal(simultaneous.filter(result => result.status === 'fulfilled').length, 1, 'one of simultaneous accept/withdraw wins');
    assert.equal(simultaneous.find(result => result.status === 'rejected').reason.status, 409);
    assert.equal((await db.prepare('SELECT slot_id FROM bookings WHERE id=1').get()).slot_id, 3);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM reminders WHERE booking_id=1').get()).n, 0);
    assert.equal((await state()).status, 'confirmed');
    assert.deepEqual((await state()).unavailable, []);
    await command(student, 'propose', { ...proposal, originalAvailable: true });
    await command(student, 'withdraw', { reason: '기존 일정 가능', originalAvailable: true });
    assert.equal((await state()).status, 'confirmed');
    await command(student, 'propose', proposal);
    clock += 24 * 3600000;
    await createMentoringCoordination(store.db, workspaces, { now: () => clock }).prepare(id);
    assert.equal((await state()).status, 'needs_coordination', 'expiry is durable across restart');
    assert.equal((await state()).proposal, null);
    clock = Date.parse('2031-01-05T17:00:00+09:00');
    await feedback.prepare(id);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM lms_mentoring_feedback_requests WHERE booking_id='1'").get()).n, 0, 'unresolved old end time cannot trigger feedback');
    await command(mentor, 'propose', { ...proposal, slotId: '5', originalAvailable: false });
    await command(student, 'accept');
    clock = Date.parse('2031-01-07T16:00:00+09:00');
    await feedback.prepare(id);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM lms_mentoring_feedback_requests WHERE booking_id='1'").get()).n, 2, 'feedback uses the newly agreed end time');
    // A second appointment covers expiry while the original remains possible and cancellation.
    clock = Date.parse('2031-01-01T00:00:00+09:00');
    const proposeSecond = { eventId: randomUUID(), version: 0, action: 'propose', ...proposal, originalAvailable: true };
    await service.act(id, '2', mentor, proposeSecond);
    clock += 24 * 3600000;
    await assert.rejects(service.act(id, '2', stranger, { eventId: randomUUID(), version: 1, action: 'accept' }), { status: 409 });
    assert.equal((await coordinationState(db, '2')).status, 'confirmed');
    const cancel = { eventId: randomUUID(), version: 2, action: 'cancel', reason: '멘토링 불필요' };
    await service.act(id, '2', stranger, cancel);
    assert.equal((await service.act(id, '2', stranger, cancel)).duplicate, true, 'cancel retry remains safe after booking deletion');
    assert.equal(await db.prepare('SELECT id FROM bookings WHERE id=2').get(), undefined);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM lms_booking_history').get()).n, 1);
    const targets = (await db.prepare("SELECT payload FROM lms_outbox WHERE source_id='1' AND kind='mentoring_coordination'").all()).map(row => JSON.parse(row.payload).targetId);
    assert.deepEqual(new Set(targets), new Set([mentorDiscord, studentDiscord]), 'no main instructor or administrator notifications');
    await workspaces.setArchived(id, true, admin);
    await assert.rejects(command(student, 'propose', proposal), { status: 409 });
    return { workspaceId: id };
}

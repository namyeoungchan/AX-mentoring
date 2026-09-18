import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStore } from './store.mjs';
import { createAuth } from './auth.mjs';
import { createRenderSync } from './render-sync.mjs';
import { createProvision } from './provision.mjs';
import { createWorkspaces } from './workspaces.mjs';
import { createOutbox } from './outbox.mjs';
import { createAttendance } from './attendance.mjs';
import { studentLearning } from './student.mjs';
import { exportAttendance, importAttendance } from '../shared/attendance-csv.mjs';
const admin = { id: 'admin', username: 'operator', role: 'admin' };
const selection = { courseId: 'c1', date: '2026-09-18', period: 1 };
async function fixture(t, count = 2) {
    const dir = mkdtempSync(join(tmpdir(), 'attendance-')), dbPath = join(dir, 'test.db'), store = await createStore(dbPath);
    const auth = await createAuth(store.db);
    await createRenderSync(store.db);
    const workspaces = await createWorkspaces({ store, dbPath, provision: await createProvision(store.db) });
    const outbox = createOutbox(store.db, workspaces);
    const service = createAttendance(workspaces, { outbox });
    const put = async (kind, value) => await store.db.prepare('INSERT INTO lms_records(kind,id,data) VALUES(?,?,?)').run(kind, value.id, JSON.stringify(value));
    await put('courses', { id: 'c1', title: '과정' });
    await put('teams', { id: 't1', name: '1조', courseId: 'c1', code: '1' });
    await put('teams', { id: 't2', name: '2조', courseId: 'c1', code: '2' });
    for (let i = 0; i < count; i++)
        await put('learners', { id: `s${i}`, name: `학생${i}`, email: '', discordId: String(123456789012345678n + BigInt(i)), courseId: 'c1', team: i % 2 ? '2조' : '1조', status: '정상' });
    const view = async (user = admin, selected = selection) => await service.view('default', selected, user);
    const payload = async (action, entries = [], user = admin) => ({ ...selection, requestId: randomUUID(), revision: (await view(user)).revision, action, entries });
    const save = async (body, user = admin) => await service.save('default', body, user);
    const entries = async () => (await view()).rows.map(r => ({ studentId: r.studentId, status: '출석' }));
    const signup = async (role) => {
        const { user } = await auth.signup({ username: `attendance.${role}`, password: 'testing-password-1234', name: role }, () => { });
        if (role === 'instructor')
            await workspaces.acceptInvitation((await workspaces.invite('default', { username: user.username, role, mentorType: 'group', teamIds: ['t1'] }, admin)).token, user);
        else
            await store.db.prepare('INSERT INTO lms_workspace_members VALUES(?,?,?,?)').run('default', user.id, 'student', Date.now());
        return user;
    };
    t.after(() => { workspaces.close(); store.db.close(); rmSync(dir, { force: true, recursive: true }); });
    return { store, service, outbox, auth, workspaces, view, payload, save, entries, signup };
}
test('120-person roster saves atomically and rolls back records, history and receipts on a late failure', async (t) => {
    const f = await fixture(t, 120);
    assert.equal((await f.view()).counts['미처리'], 120);
    await f.save(await f.payload('start'));
    f.store.db.exec("CREATE TRIGGER fail_late BEFORE INSERT ON lms_records WHEN NEW.kind='attendance' AND json_extract(NEW.data,'$.studentId')='s119' BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END");
    const request = await f.payload('save', await f.entries()), revision = (await f.view()).revision;
    await assert.rejects(async () => await f.save(request), /simulated disk failure/);
    assert.equal((await f.store.snapshot()).attendance.length, 0);
    assert.equal((await f.view()).history.length, 0);
    assert.equal((await f.view()).revision, revision);
    assert.equal((await f.store.db.prepare('SELECT COUNT(*) AS n FROM lms_attendance_requests').get()).n, 1);
    f.store.db.exec('DROP TRIGGER fail_late');
    assert.equal((await f.save(request)).counts['출석'], 120);
});
test('identical retries are idempotent while stale and reused requests cannot overwrite newer data', async (t) => {
    const f = await fixture(t);
    await f.save(await f.payload('start'));
    const body = await f.payload('save', await f.entries()), stale = await f.payload('save', [{ studentId: 's0', status: '결석' }]);
    const first = await f.save(body);
    assert.equal((await f.save(body)).revision, first.revision);
    assert.equal((await f.view()).history.length, 2);
    await assert.rejects(async () => await f.save(stale), { status: 409 });
    await assert.rejects(async () => await f.save({ ...body, entries: [] }), { status: 409 });
    assert.equal((await f.store.snapshot()).attendance.length, 2);
});
test('closing requires complete roster and corrections require reasons with before/after and actor', async (t) => {
    const f = await fixture(t);
    await assert.rejects(async () => await f.save(await f.payload('save', await f.entries())), { status: 409 });
    await f.save(await f.payload('start'));
    await assert.rejects(async () => await f.save(await f.payload('close')), { status: 422 });
    await f.save(await f.payload('save', await f.entries()));
    await f.save(await f.payload('close'));
    await assert.rejects(async () => await f.save(await f.payload('start')), { status: 409 });
    const before = (await f.view()).revision;
    await assert.rejects(async () => await f.save(await f.payload('save', [{ studentId: 's0', status: '지각', reason: '도착 확인' }, { studentId: 's1', status: '공결', reason: ' ' }])), { status: 422 });
    assert.equal((await f.view()).revision, before);
    const result = await f.save(await f.payload('save', [{ studentId: 's0', status: '지각', reason: '도착 확인' }]));
    assert.equal(result.state, '마감');
    assert.equal(result.history[0].before.status, '출석');
    assert.equal(result.history[0].after.status, '지각');
    assert.equal(result.history[0].actor, 'operator');
    const row = (await f.store.snapshot()).attendance[0];
    for (const value of [{ ...row, status: '결석', reason: '우회' }, { ...row, date: '2026-09-19' }])
        await assert.rejects(async () => await f.store.mutate({ revision: (await f.store.snapshot()).revision, changes: [{ kind: 'attendance', value }] }), { status: 409 });
});
test('instructors cannot see or write other teams, close rounds, or use stale scope; students cannot use roster API', async (t) => {
    const f = await fixture(t), mentor = await f.signup('instructor'), student = await f.signup('student');
    await f.save(await f.payload('start'));
    assert.deepEqual((await f.view(mentor)).rows.map(r => r.studentId), ['s0']);
    await assert.rejects(async () => await f.save(await f.payload('save', await f.entries(), mentor), mentor), { status: 403 });
    await assert.rejects(async () => await f.save(await f.payload('close', [], mentor), mentor), { status: 403 });
    await f.save(await f.payload('save', [{ studentId: 's0', status: '출석' }], mentor), mentor);
    await f.save(await f.payload('save', [{ studentId: 's1', status: '공결', reason: '비공개 사유' }]));
    assert.equal((await f.view(mentor)).history.length, 1);
    assert.ok(!JSON.stringify(await f.view(mentor)).includes('비공개 사유'));
    const oldScope = await f.payload('save', [{ studentId: 's0', status: '결석' }], mentor);
    await f.workspaces.assignMentor('default', mentor.id, { mentorType: 'group', teamIds: ['t2'] }, admin);
    await assert.rejects(async () => await f.save(oldScope, mentor), { status: 403 });
    await assert.rejects(async () => await f.view(student), { status: 403 });
    await assert.rejects(async () => await f.service.view('asan-ax', selection, mentor), { status: 403 });
});
test('students see only their own finalized attendance; archive blocks even replayed writes', async (t) => {
    const f = await fixture(t), student = { discordId: '123456789012345678' };
    await f.save(await f.payload('start'));
    const body = await f.payload('save', await f.entries());
    await f.save(body);
    assert.deepEqual((await studentLearning(f.store.db, student, true)).attendance, []);
    await f.save(await f.payload('close'));
    const learning = await studentLearning(f.store.db, student, true);
    assert.equal(learning.attendance.length, 1);
    assert.equal(learning.attendance[0].status, '출석');
    assert.ok(!('reason' in learning.attendance[0]));
    assert.equal((await studentLearning(f.store.db, student, false)).attendance.length, 0);
    await f.workspaces.setArchived('default', true, admin);
    await assert.rejects(async () => await f.save(body), { status: 409 });
});
test('duplicate learners and invalid dates or statuses never partially save', async (t) => {
    const f = await fixture(t);
    await f.save(await f.payload('start'));
    await assert.rejects(async () => await f.save(await f.payload('save', [{ studentId: 's0', status: '출석' }, { studentId: 's0', status: '결석' }])), { status: 422 });
    await assert.rejects(async () => await f.save({ ...await f.payload('save', await f.entries()), date: '2026-02-30' }));
    await assert.rejects(async () => await f.save(await f.payload('save', [{ studentId: 's0', status: 'invalid' }])));
    assert.equal((await f.store.snapshot()).attendance.length, 0);
});
test('CSV roundtrip preserves quoted newlines, safe formula text, IDs and pending states', () => {
    const rows = [{ studentId: 's0', name: '=formula', team: '"1,조"', status: '미처리', reason: '줄1\n줄2' }, { studentId: 's1', name: '학생', team: '', status: '공결', reason: ' +SUM(1,2)' }];
    const csv = exportAttendance(selection, rows);
    assert.ok(csv.includes("'=formula"));
    assert.ok(csv.includes("' +SUM"));
    assert.deepEqual(importAttendance(csv, selection, ['s0', 's1']), rows.map(({ studentId, status, reason }) => ({ studentId, status, reason })));
    for (const invalid of [csv.replace('s1', 's0'), csv.replace('s1', 'foreign'), csv.replace('공결', '오류'), csv.replace('2026-09-18', '2026-09-19'), csv + '"'])
        assert.throws(() => importAttendance(invalid, selection, ['s0', 's1']));
});
test('main instructors manage full rounds while group mentors retain scoped editing', async (t) => {
    const f = await fixture(t), instructor = await f.signup('instructor');
    await f.workspaces.assignMentor('default', instructor.id, { mentorType: 'main', teamIds: [] }, admin);
    assert.equal((await f.view(instructor)).canManage, true);
    await f.save(await f.payload('start', [], instructor), instructor);
    await f.save(await f.payload('save', await f.entries(), instructor), instructor);
    assert.equal((await f.save(await f.payload('close', [], instructor), instructor)).state, '마감');
});
test('Discord summaries are scoped, private, immutable and idempotent; delivery failures never undo attendance', async (t) => {
    const f = await fixture(t), mentor = await f.signup('instructor'), student = await f.signup('student');
    const guildId = '123456789012345678', channelId = '223456789012345678';
    await f.workspaces.addServer('default', { guildId, templateRevision: (await f.workspaces.template('default')).revision });
    await f.store.db.prepare("UPDATE lms_discord_jobs SET state='succeeded',completed_at=1,results=? WHERE guild_id=?").run(JSON.stringify([{ id: 'assignment-dashboard', discordId: channelId }]), guildId);
    const share = async (user = admin, revision) => await f.service.share('default', { ...selection, revision: revision ?? (await f.view(user)).revision }, user);
    await assert.rejects(async () => await share(), { status: 409 });
    await f.save(await f.payload('start'));
    await f.save(await f.payload('save', [{ studentId: 's0', status: '지각', reason: '개인 사유' }, { studentId: 's1', status: '결석', reason: '민감 사유' }]));
    await assert.rejects(async () => await share(student), { status: 403 });
    await assert.rejects(async () => await share(admin, 'stale'), { status: 409 });
    const result = await share(mentor);
    assert.ok(result.preview.description.includes('명단 1명'));
    assert.ok(result.preview.description.includes('결석 0명'));
    assert.ok(!JSON.stringify(result.preview).includes('학생'));
    assert.ok(!JSON.stringify(result.preview).includes('개인 사유'));
    assert.equal((await share(mentor)).delivery.id, result.delivery.id);
    const job = (await f.outbox.poll({ guildIds: [guildId] })).job;
    assert.equal(job.kind, 'attendance');
    assert.equal(job.channelId, channelId);
    await f.outbox.complete({ workspaceId: 'default', id: job.id, claim: job.claim, state: 'failed', error: 'permissions' });
    assert.equal((await f.view()).counts['지각'], 1);
    assert.equal((await share(mentor)).delivery.state, 'pending');
    const retried = (await f.outbox.poll({ guildIds: [guildId] })).job;
    assert.equal(retried.nonce, job.nonce);
    await f.outbox.complete({ workspaceId: 'default', id: job.id, claim: retried.claim, state: 'uncertain', error: 'not_found' });
    assert.equal((await share(mentor)).delivery.state, 'reconcile');
    assert.equal((await f.outbox.poll({ guildIds: [guildId] })).job.reconcile, true);
    await f.workspaces.setArchived('default', true, admin);
    await assert.rejects(async () => await share(mentor), { status: 409 });
});

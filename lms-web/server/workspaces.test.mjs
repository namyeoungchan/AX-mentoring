import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.mjs';
import { createAuth } from './auth.mjs';
import { createRenderSync } from './render-sync.mjs';
import { createProvision } from './provision.mjs';
import { createWorkspaces } from './workspaces.mjs';
import { verificationResumeScenario } from './verification-resume-scenario.mjs';
const guildId = '123456789012345678';
const admin = { id: 'admin', role: 'admin' };
const token = 'test-only-integration-token-12345678901234567890';
const course = { id: 'course1', title: '독립 과정', category: 'AX', description: '1기', progress: 0, learners: 0, weeks: '8주', mentor: '', theme: 'green', status: '모집 중', code: 'AX', cohort: '1', guildId: '', startDate: '2026-09-01', endDate: '2026-12-01' };
const plan = { guildId, name: '교육 서버', autoApply: false, channels: [{ id: 'notice', name: '공지', type: 'text', parentId: '' }], revision: '' };
const payload = (sourceId, guild = guildId) => ({ sourceId, name: '운영 봇', capturedAt: new Date().toISOString(), rowLimit: 1000, bot: { name: 'AX', ready: true, latencyMs: 50, guildId: guild, guildName: '교육 서버', memberCount: 1 }, counts: { mentors: 0, bookings: 0, assignments: 0, submissions: 0, onboarding_progress: 0, pending_bookings: 0 }, mentors: [], bookings: [], assignments: [], submissions: [] });
async function fixture(t, seed = () => { }) {
    const directory = mkdtempSync(join(tmpdir(), 'learningops-workspaces-'));
    const dbPath = join(directory, 'test.db');
    const store = await createStore(dbPath);
    const auth = await createAuth(store.db, { adminPassword: 'test-admin-password-1234', botToken: token, guildId });
    const sync = await createRenderSync(store.db, { token, sourceId: 'asan-ax' });
    const provision = await createProvision(store.db, { token });
    await seed({ store, sync, provision });
    const options = { store, dbPath, provision, syncToken: token };
    const manager = await createWorkspaces(options);
    t.after(() => { manager.close(); store.db.close(); rmSync(directory, { recursive: true, force: true }); });
    return { manager, store, auth, provision, options };
}
const write = async (manager, id, kind, value) => await manager.mutate(id, { revision: (await manager.snapshot(id)).revision, changes: [{ kind, value }] }, 'admin');

test('completed Discord proof outlives codes and stays scoped to the current account and server', async t => {
    const { store, manager } = await fixture(t);
    await verificationResumeScenario({ store, workspaces: manager });
});
test('issued admin credentials require a new password, expose no stored secrets, and grant only the accepted workspace', async (t) => {
    const { manager, auth, store } = await fixture(t);
    const created = await auth.createInvitationAccount({ username: 'issued.owner', name: '초대 관리자' }, admin, async (username) => await manager.invite('default', { username, role: 'admin' }, admin));
    assert.equal(created.initialPassword.length, 24);
    assert.equal(created.token.length, 64);
    assert.equal(created.role, 'admin');
    assert.equal(created.name, '초대 관리자');
    const original = await auth.login({ username: created.username, password: created.initialPassword });
    assert.equal(original.user.role, 'student');
    assert.equal(original.user.mustChangePassword, true);
    assert.equal((await auth.session(original.token)).mustChangePassword, true);
    assert.equal(await manager.role('default', original.user), null);
    assert.equal((await store.db.prepare('SELECT COUNT(*) AS n FROM lms_auth_sessions').get()).n, 1);
    for (const table of ['lms_users', 'lms_workspace_invitations', 'lms_audit']) {
        const stored = JSON.stringify(await store.db.prepare(`SELECT * FROM ${table}`).all());
        assert.ok(!stored.includes(created.initialPassword));
        assert.ok(!stored.includes(created.token));
    }
    assert.ok(!JSON.stringify(await manager.previewInvitation(created.token)).includes(created.initialPassword));
    assert.ok(!JSON.stringify(await manager.members('default', admin)).includes(created.initialPassword));
    await assert.rejects(auth.changePassword(original.user, { currentPassword: created.initialPassword, newPassword: created.initialPassword }), { status: 422 });
    const changed = await auth.changePassword(original.user, { currentPassword: created.initialPassword, newPassword: 'private-password-12345' });
    assert.equal(changed.user.mustChangePassword, false);
    assert.equal((await auth.session(changed.token)).mustChangePassword, false);
    assert.equal(await auth.session(original.token), null);
    await assert.rejects(auth.login({ username: created.username, password: created.initialPassword }), { status: 401 });
    assert.equal((await manager.acceptInvitation(created.token, changed.user)).role, 'admin');
    assert.equal(await manager.role('default', changed.user), 'admin');
    assert.equal(await manager.role('asan-ax', changed.user), null);
    assert.equal(changed.user.role, 'student');
    await assert.rejects(async () => await manager.acceptInvitation(created.token, changed.user), { status: 410 });
});
test('account issuance cannot overwrite an existing account or be used by a workspace administrator', async (t) => {
    const { manager, auth, store } = await fixture(t);
    const invite = async (username) => await manager.invite('default', { username, role: 'admin' }, admin);
    const original = await auth.signup({ username: 'existing.owner', name: '기존 계정', password: 'original-password-1234' }, () => { });
    const before = await store.db.prepare('SELECT * FROM lms_users WHERE id=?').get(original.user.id);
    await assert.rejects(auth.createInvitationAccount({ username: 'existing.owner', name: '덮어쓰기' }, admin, invite), { status: 409 });
    assert.deepEqual(await store.db.prepare('SELECT * FROM lms_users WHERE id=?').get(original.user.id), before);
    assert.ok(await auth.session(original.token));
    assert.equal((await store.db.prepare('SELECT COUNT(*) AS n FROM lms_workspace_invitations').get()).n, 0);
    await manager.acceptInvitation((await invite(original.user.username)).token, original.user);
    await assert.rejects(auth.createInvitationAccount({ username: 'unauthorized.owner', name: '권한 없음' }, original.user, invite), { status: 403 });
    assert.equal((await store.db.prepare('SELECT COUNT(*) AS n FROM lms_users').get()).n, 1);
});
test('account and invitation creation roll back together and reject concurrent duplicate usernames', async (t) => {
    const { manager, auth, store } = await fixture(t);
    const input = { username: 'atomic.owner', name: '동시 발급' };
    const invite = async (username) => await manager.invite('default', { username, role: 'admin' }, admin);
    const earlier = await invite(input.username);
    await assert.rejects(auth.createInvitationAccount(input, admin, async (username) => { await invite(username); throw new Error('after invitation failure'); }), /after invitation failure/);
    assert.equal((await store.db.prepare('SELECT COUNT(*) AS n FROM lms_users').get()).n, 0);
    assert.equal((await store.db.prepare('SELECT COUNT(*) AS n FROM lms_workspace_invitations').get()).n, 1);
    assert.equal((await manager.previewInvitation(earlier.token)).username, input.username);
    const results = await Promise.allSettled([auth.createInvitationAccount(input, admin, invite), auth.createInvitationAccount(input, admin, invite)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
    assert.equal((await store.db.prepare('SELECT COUNT(*) AS n FROM lms_users').get()).n, 1);
    await manager.setArchived('default', true, admin);
    await assert.rejects(auth.createInvitationAccount({ ...input, username: 'archived.owner' }, admin, invite), { status: 409 });
    assert.equal((await store.db.prepare('SELECT COUNT(*) AS n FROM lms_users').get()).n, 1);
});
test('migration preserves existing learning rows and assigns the previous Render source to Asan', async (t) => {
    const { manager } = await fixture(t, async ({ store, sync }) => {
        await store.mutate({ revision: (await store.snapshot()).revision, changes: [{ kind: 'courses', value: course }] });
        await sync.ingest(payload('asan-ax'));
    });
    assert.deepEqual((await manager.list(admin)).map(w => w.name), ['AX 학습관리시스템', '아산 AX']);
    assert.equal((await manager.snapshot('default')).courses[0].id, course.id);
    assert.deepEqual((await manager.snapshot('asan-ax')).courses, []);
    assert.equal((await (await manager.remote('asan-ax')).read()).snapshot.bot.guildId, guildId);
    assert.equal((await (await manager.remote('default')).read()).snapshot, null);
    assert.deepEqual((await manager.metadata('asan-ax')).guildIds, [guildId]);
});
test('workspace stores isolate records, revisions, references and audit history and survive reopening', async (t) => {
    const { manager, options } = await fixture(t);
    const created = await manager.create({ name: '세종 AX' });
    await write(manager, created.id, 'courses', course);
    assert.deepEqual((await manager.snapshot('default')).courses, []);
    assert.deepEqual((await manager.snapshot('asan-ax')).courses, []);
    await assert.rejects(async () => await manager.mutate('asan-ax', { revision: (await manager.snapshot(created.id)).revision, changes: [{ kind: 'courses', value: course }] }), { status: 409 });
    const student = { id: 's1', name: '학생', email: 'student@example.com', discordId: '555456789012345678', courseId: course.id, team: '', status: '정상', progress: 0, color: 'sage' };
    await assert.rejects(async () => await write(manager, 'asan-ax', 'learners', student));
    await write(manager, created.id, 'learners', student);
    assert.equal((await ((await manager.open('asan-ax')).db.prepare('SELECT COUNT(*) AS n FROM lms_audit')).get()).n, 0);
    const reopened = await createWorkspaces(options);
    try {
        assert.equal((await reopened.snapshot(created.id)).learners[0].name, '학생');
    }
    finally {
        reopened.close();
    }
    await assert.rejects(async () => await manager.create({ name: '세종 AX' }), { status: 409 });
    await assert.rejects(async () => await manager.snapshot('../test'), { status: 404 });
});
test('legacy membership migration runs once; later registrations do not inherit guild access on restart', async (t) => {
    const { manager, store, options } = await fixture(t, async ({ store, sync }) => {
        await sync.ingest(payload('asan-ax'));
        await (store.db.prepare('INSERT INTO lms_users(id,username,name,password_hash,discord_id,guild_id,created_at,verified_at) VALUES(?,?,?,?,?,?,?,?)')).run('legacy-user', 'legacy.user', '기존 수강생', 'test-hash', '855456789012345678', guildId, 1, 1);
    });
    assert.equal(await manager.role('asan-ax', { id: 'legacy-user', role: 'student' }), 'student');
    await store.db.prepare('INSERT INTO lms_users(id,username,name,password_hash,discord_id,guild_id,created_at,verified_at) VALUES(?,?,?,?,?,?,?,?)').run('later-user', 'later.user', '신규 계정', 'test-hash', '955456789012345678', guildId, 2, 2);
    const reopened = await createWorkspaces(options);
    try {
        assert.equal(await reopened.role('asan-ax', { id: 'legacy-user', role: 'student' }), 'student');
        assert.equal(await reopened.role('asan-ax', { id: 'later-user', role: 'student' }), null);
    }
    finally {
        reopened.close();
    }
});
test('guild ownership filters plans and jobs and rejects cross-workspace writes atomically', async (t) => {
    const { manager } = await fixture(t);
    const saved = await manager.savePlan('asan-ax', plan);
    assert.deepEqual((await manager.provisionRead('default')).plans, []);
    await assert.rejects(async () => await manager.savePlan('default', saved), { status: 409 });
    await assert.rejects(async () => await manager.enqueue('default', saved), { status: 403 });
    await manager.enqueue('asan-ax', saved);
    assert.equal((await manager.provisionRead('asan-ax')).jobs.length, 1);
    assert.equal((await manager.provisionRead('default')).jobs.length, 0);
    await assert.rejects(async () => await manager.savePlan('default', { ...plan, guildId: '223456789012345678', channels: [] }));
    assert.deepEqual((await manager.metadata('default')).guildIds, []);
    await assert.rejects(async () => await manager.create({ name: '충돌', guildId }), { status: 409 });
    assert.equal((await manager.list(admin)).length, 2);
});
test('remote delivery selects its registered workspace and rolls back conflicting guild snapshots', async (t) => {
    const { manager } = await fixture(t);
    await manager.ingest(payload('asan-ax'));
    const next = await manager.create({ name: '대전 AX' });
    await assert.rejects(async () => await manager.ingest(payload(next.sourceId)), { status: 409 });
    assert.equal((await (await manager.remote(next.id)).read()).snapshot, null);
    await manager.ingest(payload(next.sourceId, '323456789012345678'));
    assert.equal((await (await manager.remote(next.id)).read()).snapshot.bot.guildId, '323456789012345678');
    assert.equal((await (await manager.remote('asan-ax')).read()).snapshot.bot.guildId, guildId);
    await assert.rejects(async () => await manager.ingest(payload('unknown')), { status: 403 });
});
test('shared worker status stays common but guild data and guild-routed snapshots remain scoped', async (t) => {
    const { manager, provision } = await fixture(t);
    const secondId = '323456789012345678';
    await manager.savePlan('asan-ax', plan);
    const other = await manager.create({ name: '공통 봇 연결 워크스페이스', guildId: secondId });
    await provision.heartbeat({ bot: { id: '999456789012345678', name: 'Render 공통 봇', ready: true }, guilds: [
            { id: guildId, name: '아산 AX 서버', manageChannels: true, memberCount: 30 },
            { id: secondId, name: '추가 서버', manageChannels: true, memberCount: 10 },
        ] });
    assert.equal((await manager.connection('asan-ax')).worker.id, (await manager.connection(other.id)).worker.id);
    assert.deepEqual((await manager.connection('asan-ax')).guilds.map(g => g.id), [guildId]);
    assert.deepEqual((await manager.connection(other.id)).guilds.map(g => g.id), [secondId]);
    const body = payload('ignored');
    delete body.sourceId;
    await manager.ingest(body);
    assert.equal((await (await manager.remote('asan-ax')).read()).snapshot.bot.guildId, guildId);
    assert.equal((await (await manager.remote(other.id)).read()).snapshot, null);
    await assert.rejects(async () => await manager.ingest({ ...body, bot: { ...body.bot, guildId: '823456789012345678' } }), { status: 403 });
});
test('saved workspace defaults are frozen into automatic jobs when a server ID is added', async (t) => {
    const { manager, provision } = await fixture(t);
    const base = await manager.template('default');
    const saved = await manager.saveTemplate('default', { ...base, name: '신규 교육 기본 구성', channels: [{ id: 'category', type: 'category', name: '강의', parentId: '' }, { id: 'notice', type: 'text', name: '수업공지', parentId: 'category' }] });
    const result = await manager.addServer('default', { guildId, templateRevision: saved.revision });
    assert.equal(result.created, true);
    assert.equal(result.job.state, 'queued');
    assert.deepEqual(result.plan.channels, saved.channels);
    const repeated = await manager.addServer('default', { guildId, templateRevision: saved.revision });
    assert.equal(repeated.created, false);
    assert.equal(repeated.job.id, result.job.id);
    const edited = await manager.saveTemplate('default', { ...saved, name: '다음 서버의 구성' });
    assert.equal((await manager.provisionRead('default')).plans[0].name, saved.name);
    await assert.rejects(async () => await manager.addServer('default', { guildId: '323456789012345678', templateRevision: saved.revision }), { status: 409 });
    assert.deepEqual((await manager.metadata('default')).guildIds, [guildId]);
    assert.equal((await provision.poll({ guilds: [] })).job, null);
    const job = (await provision.poll({ guilds: [{ id: guildId, name: '교육 서버', manageChannels: true }] })).job;
    assert.equal(job.id, result.job.id);
    assert.deepEqual(job.plan.channels, saved.channels);
    await assert.rejects(async () => await manager.addServer('default', { guildId: '323456789012345678', templateRevision: edited.revision }), { status: 409 });
    assert.deepEqual((await manager.metadata('default')).guildIds, [guildId]);
    assert.equal((await manager.provisionRead('default')).jobs.length, 1);
    const second = await manager.create({ name: '별도 서버의 워크스페이스', guildId: '323456789012345678' });
    assert.deepEqual(second.guildIds, ['323456789012345678']);
    await assert.rejects(async () => await manager.addServer('asan-ax', { guildId, templateRevision: (await manager.template('asan-ax')).revision }), { status: 409 });
    assert.deepEqual((await manager.provisionRead('asan-ax')).plans, []);
});
test('workspace creation with a server ID queues the default layout even before the worker is configured', async (t) => {
    const { manager } = await fixture(t);
    const created = await manager.create({ name: '생성 시 서버 구축', guildId });
    const state = await manager.provisionRead(created.id);
    assert.equal(state.plans[0].channels.length, 10);
    assert.ok(state.plans[0].channels.some(c => c.id === 'assignment-dashboard'));
    assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0].state, 'queued');
});
test('templates validate layout and revisions and preserve the last valid definition', async (t) => {
    const { manager } = await fixture(t);
    const original = await manager.template('default');
    await assert.rejects(async () => await manager.saveTemplate('default', { ...original, channels: [{ id: 'bad', name: 'invalid name', type: 'text', parentId: '' }] }));
    assert.deepEqual(await manager.template('default'), original);
    await assert.rejects(async () => await manager.saveTemplate('asan-ax', original), { status: 409 });
    const updated = await manager.saveTemplate('default', { ...original, name: '새 기본 구성' });
    await assert.rejects(async () => await manager.saveTemplate('default', original), { status: 409 });
    assert.deepEqual(await manager.template('default'), updated);
});
test('verified accounts need an invitation and roles belong to individual workspaces', async (t) => {
    const { manager, auth, store } = await fixture(t);
    await manager.savePlan('asan-ax', plan);
    const member = { username: 'workspace.student', name: '학생', password: 'student-password-1234', discordId: '555456789012345678' };
    const pending = await auth.register(member);
    await auth.verify({ code: pending.code, discordId: member.discordId, guildId });
    const { user } = await auth.login({ username: member.username, password: member.password });
    assert.deepEqual(await manager.list(user), []);
    await assert.rejects(async () => await manager.invite('asan-ax', { username: user.username, role: 'student' }, admin), { status: 422 });
    // Membership after admission approval and Discord proof is covered in admissions.test.mjs.
    await store.db.prepare("INSERT INTO lms_workspace_members VALUES(?,?,'student',?)").run('asan-ax', user.id, Date.now());
    assert.deepEqual((await manager.list(user)).map(w => w.id), ['asan-ax']);
    await assert.rejects(async () => await manager.requireAccess('default', user), { status: 403 });
    await write(manager, 'default', 'courses', course);
    await write(manager, 'default', 'learners', { id: 's1', name: '학생', email: 'student@example.com', discordId: member.discordId, courseId: course.id, team: '', status: '정상', progress: 0, color: 'sage' });
    await assert.rejects(async () => await manager.requireAccess('default', user), { status: 403 });
    const second = await manager.invite('default', { username: user.username, role: 'instructor' }, admin);
    await manager.acceptInvitation(second.token, user);
    assert.deepEqual((await manager.list(user)).map(w => w.id), ['default', 'asan-ax']);
    assert.equal(await manager.role('default', user), 'instructor');
    assert.equal(await manager.role('asan-ax', user), 'student');
    assert.equal((await manager.requireAccess('default', user)).id, 'default');
});
test('invitations bind account and role, are hashed, single-use, revocable and cannot escalate staff permissions', async (t) => {
    const { manager, auth, store } = await fixture(t);
    await manager.addServer('asan-ax', { guildId, templateRevision: (await manager.template('asan-ax')).revision });
    const member = { username: 'workspace.owner', name: '관리자', password: 'owner-password-1234', discordId: '655456789012345678' };
    const pending = await auth.register(member);
    await auth.verify({ code: pending.code, discordId: member.discordId, guildId });
    const { user } = await auth.login({ username: member.username, password: member.password });
    const invitation = await manager.invite('asan-ax', { username: user.username, role: 'admin' }, admin);
    assert.equal(JSON.stringify(await store.db.prepare('SELECT * FROM lms_workspace_invitations').all()).includes(invitation.token), false);
    await assert.rejects(async () => await manager.acceptInvitation(invitation.token, { ...user, username: 'wrong.user' }), { status: 403 });
    await manager.acceptInvitation(invitation.token, { ...user, verified: false });
    await assert.rejects(async () => await manager.acceptInvitation(invitation.token, user), { status: 410 });
    await assert.rejects(async () => await manager.invite('asan-ax', { username: 'next.owner', role: 'admin' }, user), { status: 403 });
    await assert.rejects(async () => await manager.invite('default', { username: 'next.teacher', role: 'instructor' }, user), { status: 403 });
    const teacher = await manager.invite('asan-ax', { username: 'next.teacher', role: 'instructor' }, user);
    assert.equal((await manager.previewInvitation(teacher.token)).role, 'instructor');
    await manager.revokeInvitation('asan-ax', teacher.id, user);
    await assert.rejects(async () => await manager.previewInvitation(teacher.token), { status: 410 });
    const expired = await manager.invite('asan-ax', { username: 'old.teacher', role: 'instructor' }, user);
    await store.db.prepare('UPDATE lms_workspace_invitations SET expires_at=0 WHERE id=?').run(expired.id);
    await assert.rejects(async () => await manager.previewInvitation(expired.token), { status: 410 });
});
test('archive and restore preserve data, guild ownership and timestamps across reopening', async (t) => {
    const { manager, options, store } = await fixture(t);
    const created = await manager.create({ name: '보관할 교육', guildId });
    await write(manager, created.id, 'courses', course);
    const before = await manager.snapshot(created.id);
    const archived = await manager.setArchived(created.id, true, admin);
    assert.equal(typeof archived.archivedAt, 'number');
    assert.equal((await manager.list(admin)).some(w => w.id === created.id), false);
    assert.equal((await manager.list(admin, { includeArchived: true })).find(w => w.id === created.id).archivedAt, archived.archivedAt);
    assert.deepEqual(await manager.snapshot(created.id), before);
    assert.deepEqual((await manager.metadata(created.id)).guildIds, [guildId]);
    await assert.rejects(async () => await manager.create({ name: '다른 교육', guildId }), { status: 409 });
    assert.equal((await manager.setArchived(created.id, true, admin)).archivedAt, archived.archivedAt);
    const reopened = await createWorkspaces(options);
    try {
        assert.equal((await reopened.metadata(created.id)).archivedAt, archived.archivedAt);
        assert.equal((await reopened.setArchived(created.id, false, admin)).archivedAt, null);
        assert.ok((await reopened.list(admin)).some(w => w.id === created.id));
        assert.deepEqual(await reopened.snapshot(created.id), before);
        await reopened.setArchived(created.id, false, admin);
    }
    finally {
        reopened.close();
    }
    assert.deepEqual((await store.db.prepare("SELECT action FROM lms_audit WHERE target=? AND action LIKE 'workspace.%' ORDER BY id").all(created.id)).map(row => row.action), ['workspace.archive', 'workspace.restore']);
});
test('only platform and owning workspace administrators can archive or restore', async (t) => {
    const { manager, store } = await fixture(t);
    for (const role of ['admin', 'instructor', 'student']) {
        await store.db.prepare('INSERT INTO lms_users(id,username,name,password_hash,discord_id,guild_id,created_at) VALUES(?,?,?,?,?,?,?)').run(role, `archive.${role}`, role, 'test-hash', `archive-${role}`, guildId, 1);
        await store.db.prepare('INSERT INTO lms_workspace_members VALUES(?,?,?,?)').run('asan-ax', role, role, 1);
    }
    const owner = { id: 'admin', role: 'student' };
    await manager.setArchived('asan-ax', true, owner);
    for (const id of ['instructor', 'student', 'outsider']) {
        const user = { id, role: 'student' };
        for (const archived of [false, true])
            await assert.rejects(async () => await manager.setArchived('asan-ax', archived, user), { status: 403 });
        assert.equal((await manager.list(user)).length, 0);
        assert.equal((await manager.list(user, { includeArchived: true })).length, id === 'outsider' ? 0 : 1);
    }
    await assert.rejects(async () => await manager.setArchived('default', true, owner), { status: 403 });
    await manager.setArchived('asan-ax', false, owner);
    assert.equal((await manager.metadata('asan-ax')).archivedAt, null);
});
test('old workspace schema gains archive state without losing records and all workspaces can be restored', async (t) => {
    const { manager, options } = await fixture(t, async ({ store }) => {
        await store.db.exec('CREATE TABLE lms_workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,source_id TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL)');
        await (store.db.prepare('INSERT INTO lms_workspaces VALUES(?,?,?,?,?)')).run('default', '직접 지정한 이름', '기존 설명', 'local-default', 1);
        await store.mutate({ revision: (await store.snapshot()).revision, changes: [{ kind: 'courses', value: course }] });
    });
    assert.equal((await manager.metadata('default')).name, '직접 지정한 이름');
    assert.equal((await manager.metadata('default')).archivedAt, null);
    for (const row of await manager.list(admin))
        await manager.setArchived(row.id, true, admin);
    assert.deepEqual(await manager.list(admin), []);
    const reopened = await createWorkspaces(options);
    try {
        assert.deepEqual(await reopened.list(admin), []);
        for (const row of await reopened.list(admin, { includeArchived: true }))
            await reopened.setArchived(row.id, false, admin);
        assert.equal((await reopened.list(admin)).length, 2);
        assert.equal((await reopened.snapshot('default')).courses[0].id, course.id);
    }
    finally {
        reopened.close();
    }
});
test('legacy default branding migrates persisted settings and metadata while preserving custom names', async (t) => {
    const { manager, options } = await fixture(t);
    const oldName = 'AX LearningOps';
    await write(manager, 'default', 'settings', { name: oldName, reminders: true, onboarding: true, qa: true });
    const reopenedStore = await createStore(options.dbPath);
    const reopened = await createWorkspaces({ ...options, store: reopenedStore });
    try {
        assert.equal((await reopenedStore.snapshot()).name, 'AX 학습관리시스템');
        assert.equal((await reopened.metadata('default')).name, 'AX 학습관리시스템');
        assert.equal((await reopened.metadata('asan-ax')).name, '아산 AX');
        await write(reopened, 'default', 'settings', { name: '나의 교육 공간', reminders: true, onboarding: true, qa: true });
        const custom = await createStore(options.dbPath);
        try {
            assert.equal((await custom.snapshot()).name, '나의 교육 공간');
        }
        finally {
            custom.db.close();
        }
    }
    finally {
        reopened.close();
        reopenedStore.db.close();
    }
});
test('staff invitation determines verification guild without a global server setting', async (t) => {
    const { manager, store } = await fixture(t);
    const otherGuild = '888456789012345678';
    const a = await manager.create({ name: '초대 서버 A', guildId });
    const b = await manager.create({ name: '초대 서버 B', guildId: otherGuild });
    const auth = await createAuth(store.db, { botToken: token, guildAllowed: id => [guildId, otherGuild].includes(id) });
    const invitation = await manager.invite(b.id, { username: 'dynamic.staff', role: 'instructor' }, admin);
    const target = await manager.invitationGuild(invitation.token, 'dynamic.staff');
    assert.equal(target, otherGuild);
    await assert.rejects(async () => await manager.invitationGuild(invitation.token, 'wrong.user'), { status: 403 });
    const pending = await auth.register({ username: 'dynamic.staff', name: '강사', password: 'dynamic-password-1234' }, target);
    await assert.rejects(async () => await auth.verify({ code: pending.code, discordId: '555456789012345678', guildId }), { status: 403 });
    await auth.verify({ code: pending.code, discordId: '555456789012345678', guildId: otherGuild });
    const { user } = await auth.login({ username: 'dynamic.staff', password: 'dynamic-password-1234' });
    await manager.acceptInvitation(invitation.token, user);
    assert.equal(await manager.role(b.id, user), 'instructor');
    assert.equal(await manager.role(a.id, user), null);
});

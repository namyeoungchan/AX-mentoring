import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createStore } from './store.mjs';
import { createAuth } from './auth.mjs';
import { createRenderSync } from './render-sync.mjs';
import { createProvision } from './provision.mjs';
import { createWorkspaces } from './workspaces.mjs';
import { createBotStorage, BOT_TABLES } from './bot-storage.mjs';
import { createOnboarding } from './onboarding.mjs';
import { assignmentCourseScenario } from './assignment-course-scenario.mjs';
const guildId = '123456789012345678';
async function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), 'bot-storage-')), dbPath = join(dir, 'web.db'), store = await createStore(dbPath);
    const auth = await createAuth(store.db);
    await createRenderSync(store.db);
    const provision = await createProvision(store.db);
    const workspaces = await createWorkspaces({ store, dbPath, provision });
    const onboarding = await createOnboarding(store.db, workspaces, provision);
    const workspace = await workspaces.create({ name: '이관 대상', guildId });
    const storage = await createBotStorage(store.db, workspaces, onboarding);
    t.after(() => { storage.close(); workspaces.close(); store.db.close(); rmSync(dir, { recursive: true, force: true }); });
    const data = { version: 1, guildId, tables: Object.fromEntries(Object.keys(BOT_TABLES).map(k => [k, []])), settings: { channels: {}, teams: [], qaUnansweredHours: 24 }, runtime: [] };
    function payload() { const archive = JSON.stringify(data); return { guildId, archive, checksum: createHash('sha256').update(archive).digest('hex') }; }
    const call = async (operation, args = [], extra = {}) => await storage.call({ guildId, operation, args, requestId: randomUUID(), ...extra });
    const authorizeGroup = async () => {
        const { user } = await auth.signup({ username: 'storage.mentor', name: '멘토', password: 'test-storage-mentor-password' }, () => {});
        await store.db.prepare('UPDATE lms_users SET discord_id=? WHERE id=?').run('555456789012345678', user.id);
        await store.db.prepare('INSERT INTO lms_workspace_members(workspace_id,user_id,role,joined_at) VALUES(?,?,?,?)').run(workspace.id, user.id, 'instructor', Date.now());
        await store.db.prepare('INSERT INTO lms_mentor_scopes VALUES(?,?,?,?)').run(workspace.id, user.id, 'group', '[]');
        await store.db.prepare('INSERT INTO lms_workspace_verifications VALUES(?,?,?,?,?)').run(workspace.id, user.id, guildId, '555456789012345678', Date.now());
        return user;
    };
    return { storage, workspace, workspaces, onboarding, data, payload, call, authorizeGroup, main: store.db };
}
test('assignment creation binds a course atomically and legacy repair only uses an unambiguous course', async t => {
    const f = await fixture(t);
    await assignmentCourseScenario(f.workspaces, f.storage);
});

test('full migration preserves more than 1000 rows, original IDs, backup and workspace isolation', async (t) => {
    const { storage, workspace, workspaces, data, payload } = await fixture(t);
    data.tables.qa_alerts = Array.from({ length: 1005 }, (_, i) => ({ thread_id: String(123456789012345600n + BigInt(i)), alerted_at: '2026-09-01' }));
    data.tables.mentors = [{ id: 41, discord_id: '555456789012345678', name: '기존 멘토', bio: '원문' }];
    const input = payload();
    assert.equal((await storage.bootstrap(input)).migrated, true);
    assert.equal((await storage.bootstrap(input)).checksum, input.checksum);
    assert.equal(await storage.archive(workspace.id, input.checksum), input.archive);
    assert.equal((await storage.table(workspace.id, 'qa_alerts', 10)).rows.length, 5);
    assert.equal((await storage.table(workspace.id, 'mentors')).rows[0].id, 41);
    const other = await workspaces.create({ name: '다른 과정', guildId: '888456789012345678' });
    assert.equal((await storage.table(other.id, 'mentors')).rows.length, 0);
    await assert.rejects(async () => await storage.archive(other.id, input.checksum), { status: 404 });
    await assert.rejects(async () => await storage.table(workspace.id, 'lms_users'), { status: 404 });
});
test('migration conflicts roll back all inserts and retain the source for review', async (t) => {
    const { storage, workspace, workspaces, data, payload } = await fixture(t);
    await ((await workspaces.open(workspace.id)).db.prepare('INSERT INTO mentors(id,discord_id,name) VALUES(1,?,?)')).run('555456789012345678', '웹 편집본');
    data.tables.mentors = [{ id: 2, discord_id: '666456789012345678', name: '먼저 입력될 행' }, { id: 1, discord_id: '555456789012345678', name: '옛 봇 값' }];
    const input = payload();
    await assert.rejects(async () => await storage.bootstrap(input), { status: 409 });
    assert.equal((await storage.table(workspace.id, 'mentors')).rows.length, 1);
    assert.equal((await storage.table(workspace.id, 'mentors')).rows[0].name, '웹 편집본');
    assert.equal((await storage.state(workspace.id)).imports[0].state, 'conflict');
    assert.equal(await storage.archive(workspace.id, input.checksum), input.archive);
    await assert.rejects(async () => await storage.bootstrap({ ...input, checksum: '0'.repeat(64) }), { status: 422 });
});
test('web-owned legacy operations preserve transactions, retry receipts and revision conflicts', async (t) => {
    const { storage, workspace, payload, call, authorizeGroup } = await fixture(t);
    await authorizeGroup();
    await storage.bootstrap(payload());
    const requestId = randomUUID();
    const first = await call('add_mentor', ['555456789012345678', '한글 멘토', '소개'], { requestId });
    assert.deepEqual(await call('add_mentor', ['555456789012345678', '한글 멘토', '소개'], { requestId }), first);
    assert.equal((await storage.table(workspace.id, 'mentors')).total, 1);
    const revision = (await storage.state(workspace.id)).revision;
    await call('add_slot', [first.result, '2026-10-01T10:00:00', '2026-10-01T10:50:00', '예약 시간']);
    await assert.rejects(call('add_mentor', ['777456789012345678', '오래된 요청'], { revision }), { status: 409 });
    const slot = (await storage.table(workspace.id, 'slots')).rows[0];
    assert.equal((await call('create_booking', [slot.id, '777456789012345678', '수강생'])).result, true);
    assert.equal((await call('create_booking', [slot.id, '888456789012345678', '중복'])).result, false);
    assert.equal((await storage.table(workspace.id, 'bookings')).total, 1);
    await assert.rejects(call('init_db'), { status: 422 });
    await assert.rejects(call('create_onboarding', ['777456789012345678', '888456789012345678']), { status: 422 });
});
test('runtime panel and onboarding state lives in the web and stays scoped to each guild', async (t) => {
    const { storage, workspaces } = await fixture(t);
    await workspaces.create({ name: '별도', guildId: '888456789012345678' });
    await storage.runtime({ guildId, kind: 'member', key: '555456789012345678', operation: 'put', value: { introDone: true } });
    assert.equal((await storage.runtime({ guildId, kind: 'member', key: '555456789012345678', operation: 'get' })).introDone, true);
    const previousAccess = { '999456789012345678': null, '999456789012345679': true };
    await storage.runtime({ guildId, kind: 'access-gate', key: '555456789012345678', operation: 'put', value: previousAccess });
    assert.deepEqual(await storage.runtime({ guildId, kind: 'access-gate', key: '555456789012345678', operation: 'get' }), previousAccess);
    assert.equal(await storage.runtime({ guildId: '888456789012345678', kind: 'access-gate', key: '555456789012345678', operation: 'get' }), null);
    assert.equal(await storage.runtime({ guildId: '888456789012345678', kind: 'member', key: '555456789012345678', operation: 'get' }), null);
});
test('migration preserves shared bot metadata under each registered guild and never imports stale settings caches', async (t) => {
    const { storage, workspaces, data, payload } = await fixture(t);
    const otherGuild = '888456789012345678';
    await workspaces.create({ name: '공통 봇의 다른 서버', guildId: otherGuild });
    data.runtime = [guildId, otherGuild].map(id => ({ guild_id: id, kind: 'channel', record_key: 'start', data: JSON.stringify({ id: '999456789012345678' }) }));
    data.runtime.push({ guild_id: '0', kind: 'config', record_key: 'snapshot', data: '{}' });
    await storage.bootstrap(payload());
    assert.equal((await storage.runtime({ guildId: otherGuild, kind: 'channel', key: 'start', operation: 'get' })).id, '999456789012345678');
    assert.equal(await storage.runtime({ guildId: '0', kind: 'config', key: 'snapshot', operation: 'get' }), null);
});
test('nested schedule generation accepts bot date values and skips configured holidays', async (t) => {
    const { storage, workspace, payload, call, authorizeGroup } = await fixture(t);
    await authorizeGroup();
    await storage.bootstrap(payload());
    const mentor = (await call('add_mentor', ['555456789012345678', '예약 멘토'])).result;
    await call('set_slot_template', [mentor, 10, 0, 11, 0, 30]);
    await call('block_date', [mentor, '2026-10-02']);
    const result = await call('generate_slots_for_range', [mentor, { $lms: 'date', value: '2026-10-01' }, { $lms: 'date', value: '2026-10-02' }]);
    assert.deepEqual(result.result, { $lms: 'tuple', value: [2, 1] });
    assert.equal((await storage.table(workspace.id, 'slots')).total, 2);
    assert.deepEqual((await call('generate_slots_for_range', [mentor, { $lms: 'date', value: '2026-10-01' }, { $lms: 'date', value: '2026-10-02' }])).result, { $lms: 'tuple', value: [0, 1] });
});

test('online reservation rechecks current group membership and scoped proof, including stale buttons', async t => {
    const f = await fixture(t), user = await f.authorizeGroup();
    const mentor = (await f.call('add_mentor', ['555456789012345678', '조 담당 멘토'])).result;
    const other = (await f.call('add_mentor', ['666456789012345678', '미인증 멘토'])).result;
    const slot = (await f.call('add_slot', [mentor, '2030-01-01T10:00:00', '2030-01-01T11:00:00', '예약'])).result;
    assert.equal((await f.call('get_online_mentors')).result.length, 1);
    assert.equal((await f.call('get_online_mentor_by_id', [other])).result, null);
    await f.main.prepare("UPDATE lms_mentor_scopes SET kind='main' WHERE subject_id=?").run(user.id);
    assert.equal((await f.workspaces.snapshot(f.workspace.id)).mentors.find(row => row.id === String(mentor)).onlineBookable, false);
    await assert.rejects(f.workspaces.mutate(f.workspace.id, { changes: [{ kind: 'sessions', value: { id: 'new-session', mentorId: String(mentor) } }] }, 'admin'), /조 담당 멘토/);
    assert.deepEqual((await f.call('get_online_mentors')).result, []);
    assert.equal((await f.call('create_booking', [slot, '777456789012345678', '학생'])).result, false);
    await assert.rejects(f.call('set_slot_template', [mentor, 10, 0, 11, 0, 30]), { status: 422 });
    await f.main.prepare("UPDATE lms_mentor_scopes SET kind='group' WHERE subject_id=?").run(user.id);
    await f.main.prepare('DELETE FROM lms_workspace_verifications WHERE user_id=?').run(user.id);
    assert.deepEqual((await f.call('get_online_mentors')).result, []);
    assert.equal((await f.call('create_booking', [slot, '777456789012345678', '학생'])).result, false);
});
test('registry discovers only joined and registered guilds with independent settings and databases', async (t) => {
    const { storage, workspaces, workspace } = await fixture(t);
    const secondGuild = '888456789012345678';
    const second = await workspaces.create({ name: '다른 서버', guildId: secondGuild });
    const registry = await storage.registry({ guildIds: [guildId, secondGuild, '999456789012345678', guildId] });
    assert.equal(registry.workspaces.length, 2);
    assert.deepEqual(registry.workspaces.map(row => row.workspaceId), [workspace.id, second.id]);
    assert.ok(registry.workspaces.every(row => row.migrated === false));
    assert.deepEqual(registry.workspaces[1].settings.channels, {});
    const create = async (guild, name) => await storage.call({ guildId: guild, operation: 'add_mentor', args: ['555456789012345678', name, ''], requestId: randomUUID() });
    const [a, b] = await Promise.all([create(guildId, '첫 서버 멘토'), create(secondGuild, '둘째 서버 멘토')]);
    assert.equal(a.result, b.result); // Local IDs can coincide without selecting the wrong DB.
    assert.equal((await storage.table(workspace.id, 'mentors')).rows[0].name, '첫 서버 멘토');
    assert.equal((await storage.table(second.id, 'mentors')).rows[0].name, '둘째 서버 멘토');
    const userId = '555456789012345678';
    const invoke = async (guild, operation, args) => await storage.call({ guildId: guild, operation, args, requestId: randomUUID() });
    await Promise.all([invoke(guildId, 'create_onboarding', [userId, guildId]), invoke(secondGuild, 'create_onboarding', [userId, secondGuild])]);
    await assert.rejects(invoke(guildId, 'reset_onboarding', [userId, secondGuild]), { status: 422 });
    await invoke(guildId, 'reset_onboarding', [userId, guildId]);
    assert.equal((await storage.table(workspace.id, 'onboarding_progress')).total, 0);
    assert.equal((await storage.table(second.id, 'onboarding_progress')).total, 1);
    await assert.rejects(storage.call({ guildId: '999456789012345678', operation: 'get_mentors', requestId: randomUUID() }), { status: 403 });
    assert.deepEqual((await storage.registry({ guildIds: [secondGuild] })).workspaces.map(row => row.guildId), [secondGuild]);
});

test('provisioning can persist the complete panel binding payload including attendance entrance', async t => {
    const { storage, workspace, workspaces } = await fixture(t);
    const otherGuild = '888456789012345678';
    await workspaces.create({ name: '별도 서버', guildId: otherGuild });
    const before = (await storage.state(workspace.id)).settings.find(row => row.guildId === guildId);
    const preserved = { channels: { ADMIN_ROLE_ID: '777456789012345678' }, teams: [{ name: '1조', channelId: '777456789012345679' }], qaUnansweredHours: 12, qaNotifyRoleIds: [] };
    await storage.settings(workspace.id, { guildId, value: preserved, revision: before?.revision || '' });
    const channels = {
        ONBOARDING_CHANNEL_ID: '555456789012345671',
        ASSIGNMENT_DASHBOARD_CHANNEL_ID: '555456789012345672',
        ASSIGNMENT_SUBMIT_CHANNEL_ID: '555456789012345673',
        MENTORING_CHANNEL_ID: '555456789012345674',
    };
    await storage.bindPanels({ guildId, channels });
    await storage.bindPanels({ guildId, channels }); // A retry safely reuses the same settings.
    assert.deepEqual((await storage.status(guildId)).settings, { ...preserved, channels: { ...preserved.channels, ...channels } });
    assert.deepEqual((await storage.status(otherGuild)).settings.channels, {});
    await assert.rejects(storage.bindPanels({ guildId, channels: { ADMIN_ROLE_ID: '555456789012345675' } }));
});

test('archived workspaces stop bot jobs and onboarding, while restore resumes the saved configuration', async t => {
    const { storage, workspaces, workspace, onboarding, call } = await fixture(t);
    const actor = { id: 'owner', username: 'owner', role: 'admin' };
    const { report: _report, progress: _progress, ...before } = (await onboarding.read(workspace.id)).configs[0];
    await onboarding.save(workspace.id, { ...before, enabled: true });
    const active = (await onboarding.poll({ guildIds: [guildId] })).configs[0];
    assert.equal(active.enabled, true);
    await workspaces.setArchived(workspace.id, true, actor);
    assert.deepEqual(await storage.registry({ guildIds: [guildId] }), { workspaces: [], unavailable: [] });
    const stopped = (await onboarding.poll({ guildIds: [guildId] })).configs[0];
    assert.equal(stopped.enabled, false);
    assert.notEqual(stopped.revision, active.revision);
    await assert.rejects(call('save_assignment_panel', ['attendance', '555456789012345671', '555456789012345672']), { status: 409 });
    await workspaces.setArchived(workspace.id, false, actor);
    assert.equal((await storage.registry({ guildIds: [guildId] })).workspaces.length, 1);
    assert.equal((await onboarding.poll({ guildIds: [guildId] })).configs[0].enabled, true);
});
test('generated channel and role IDs are resolved per guild and change after resource recreation', async (t) => {
    const { storage, workspaces, workspace, onboarding } = await fixture(t);
    const secondGuild = '888456789012345678';
    const second = await workspaces.create({ name: '별도 리소스', guildId: secondGuild });
    const put = async (guild, kind, key, id) => await storage.runtime({ guildId: guild, kind, key, operation: 'put', value: { id } });
    const expected = [];
    for (const [index, [guild, meta]] of [[guildId, workspace], [secondGuild, second]].entries()) {
        const course = { id: 'course', title: '과정', category: 'AX', description: '', progress: 0, learners: 0, weeks: '4주', mentor: '', theme: 'green', status: '진행 중', code: 'COURSE', cohort: '1기', guildId: guild, startDate: '2026-09-01', endDate: '2026-12-01' };
        await workspaces.mutate(meta.id, { revision: (await workspaces.snapshot(meta.id)).revision, changes: [{ kind: 'courses', value: course }, { kind: 'teams', value: { id: 'team', name: '팀', code: 'TEAM', courseId: 'course', mentorId: '' } }] });
        const { revision, ...cfg } = (await onboarding.read(meta.id)).configs[0];
        await onboarding.save(meta.id, { guildId: guild, enabled: true, courseIds: ['course'], welcomeText: cfg.welcomeText, onboardingChannel: cfg.onboardingChannel, introChannel: cfg.introChannel, revision });
        const id = offset => String(600000000000000000n + BigInt(index * 100 + offset));
        for (const [key, offset] of [['admin', 1], ['instructor', 2], ['student', 3], ['complete', 4]])
            await put(guild, 'role', key, id(offset));
        for (const [key, offset] of [['start', 5], ['intro', 6], ['team-text:team', 7], ['assignment-dashboard', 8]])
            await put(guild, 'channel', key, id(offset));
        expected.push({ id, guild });
    }
    for (const { id, guild } of expected) {
        const settings = (await storage.status(guild)).settings;
        assert.equal(settings.channels.STUDENT_ROLE_ID, id(3));
        assert.equal(settings.channels.ADMIN_ROLE_ID, id(1));
        assert.equal(settings.channels.ONBOARDING_COMPLETE_ROLE_ID, id(4));
        assert.equal(settings.channels.ONBOARDING_CHANNEL_ID, id(5));
        assert.equal(settings.channels.INTRO_CHANNEL_ID, id(6));
        assert.equal(settings.channels.ASSIGNMENT_DASHBOARD_CHANNEL_ID, id(8));
        assert.deepEqual(settings.qaNotifyRoleIds, [id(1), id(2)]);
        assert.deepEqual(settings.teams, [{ name: '팀', channelId: id(7) }]);
    }
    await put(guildId, 'role', 'student', '777456789012345678');
    await put(guildId, 'channel', 'team-text:team', '777456789012345679');
    assert.equal((await storage.status(guildId)).settings.channels.STUDENT_ROLE_ID, '777456789012345678');
    assert.equal((await storage.status(guildId)).settings.teams[0].channelId, '777456789012345679');
    assert.equal((await storage.status(secondGuild)).settings.channels.STUDENT_ROLE_ID, expected[1].id(3));
});

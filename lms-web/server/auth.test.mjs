import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuth } from './auth.mjs';
import { createStore } from './store.mjs';
import { studentLearning } from './student.mjs';
import { superAdminScenario } from './super-admin-scenario.mjs';
const options = { adminPassword: 'test-admin-password-1234', allowLegacyAdmin: true, botToken: 'test-discord-auth-token-123456789012345', guildId: '123456789012345678' };
const member = { username: 'student.test', name: '테스트 학생', password: 'test-password-1234', discordId: '555456789012345678' };
const verify = (code, overrides = {}) => ({ code, discordId: member.discordId, guildId: options.guildId, ...overrides });

test('console super account works alongside the first administrator and is protected from web management', async () => {
    const db = new DatabaseSync(':memory:');
    try {
        const auth = await createAuth(db, options);
        const owner = await auth.setup({ username: 'owner.test', name: 'Owner', password: 'owner-test-password', setupKey: options.adminPassword });
        assert.equal(owner.user.isSuperAdmin, false);
        await superAdminScenario(auth, db, owner.user);
        assert.ok(await auth.session(owner.token));
        assert.equal((await auth.login({ username: 'owner.test', password: 'owner-test-password' })).user.isSuperAdmin, false);
    } finally { db.close(); }
});

test('super account can bootstrap without a setup key; public signup cannot set its privilege', async () => {
    const db = new DatabaseSync(':memory:');
    try {
        const auth = await createAuth(db);
        await assert.rejects(auth.signup({ ...member, isSuperAdmin: true }, () => {}), { name: 'ZodError' });
        const student = await auth.signup(member, () => {});
        await assert.rejects(auth.createSuperAdmin({ ...member }), { name: 'ZodError' });
        await assert.rejects(auth.createSuperAdmin({ username: member.username, name: member.name, password: member.password }), { status: 409 });
        assert.equal((await auth.session(student.token)).role, 'student');
        const user = await auth.createSuperAdmin({ username: 'root.test', name: 'Root', password: 'bootstrap-test-password' });
        assert.equal(user.isSuperAdmin, true);
        const reopened = await createAuth(db);
        assert.equal((await reopened.login({ username: user.username, password: 'bootstrap-test-password' })).user.isSuperAdmin, true);
    } finally { db.close(); }
});
test('80 classroom logins queue safely; successful login clears attempts while wrong passwords stay limited', async () => {
    const db = new DatabaseSync(':memory:');
    try {
        const auth = await createAuth(db, options);
        const seed = await auth.signup(member, () => {});
        const usernames = [];
        for (let i = 0; i < 80; i++) {
            const name = `classroom.${i}`; usernames.push(name);
            db.prepare("INSERT INTO lms_users(id,username,name,password_hash,discord_id,guild_id,created_at) SELECT ?,?,?,password_hash,?,'',? FROM lms_users WHERE id=?").run(name,name,name,`pending:${name}`,Date.now(),seed.user.id);
        }
        const logins = await Promise.all(usernames.map(username => auth.login({username,password:member.password})));
        assert.equal(logins.length,80); assert.equal(new Set(logins.map(login=>login.token)).size,80);
        for (let i = 0; i < 12; i++) await auth.login({username:member.username,password:member.password});
        for (let i = 0; i < 10; i++) await assert.rejects(auth.login({username:member.username,password:'wrong-password'}), {status:401});
        await assert.rejects(auth.login({username:member.username,password:member.password}), error => error.status===429 && error.retryAfter>0 && error.retryAfter<=900);
    } finally { db.close(); }
});

test('repeated and simultaneous code requests reuse the live proof without storing plaintext', async () => {
    const db = new DatabaseSync(':memory:'); let now = Date.now();
    try {
        const auth = await createAuth(db, {...options,now:()=>now});
        const first = await auth.signup(member, () => {});
        const codes = await Promise.all(Array.from({length:12},()=>auth.issueVerification(first.user,options.guildId)));
        for (const code of codes) assert.deepEqual(code,codes[0]);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lms_registrations').get().n,1);
        const stored = JSON.stringify(db.prepare('SELECT * FROM lms_registrations').all());
        assert.equal(stored.includes(codes[0].ticket),false); assert.equal(stored.includes(codes[0].code.replaceAll('-','')),false);
        now+=600001;
        const next = await auth.issueVerification(first.user,options.guildId);
        assert.notEqual(next.code,codes[0].code);
        await assert.rejects(auth.verify(verify(codes[0].code)),{status:410});
        await auth.verify(verify(next.code));
        await assert.rejects(auth.verify(verify(next.code)),{status:410});
    } finally { db.close(); }
});
test('signup without Discord ID binds the bot identity once and rejects duplicate accounts', async () => {
    const db = new DatabaseSync(':memory:');
    try {
        const auth = await createAuth(db, options);
        const { discordId, ...input } = member;
        const first = await auth.signup(input, () => { });
        const second = await auth.signup({ ...input, username: 'another.student' }, () => { });
        assert.equal(first.user.discordId, '');
        assert.equal(second.user.discordId, '');
        assert.equal(first.user.verified, false);
        const pending = await auth.issueVerification(first.user, options.guildId);
        await assert.rejects(async () => await auth.verify(verify(pending.code, { guildId: '777456789012345678' })), { status: 403 });
        assert.deepEqual(await auth.preview(verify(pending.code)), { username: input.username });
        assert.equal((await auth.session(first.token)).discordId, '');
        await auth.verify(verify(pending.code));
        assert.equal((await auth.session(first.token)).discordId, discordId);
        assert.equal((await auth.session(first.token)).verified, true);
        await assert.rejects(async () => await auth.verify(verify(pending.code)), { status: 410 });
        const other = await auth.issueVerification(second.user, options.guildId);
        await assert.rejects(async () => await auth.verify(verify(other.code)), { status: 409 });
        assert.equal((await auth.status(other.ticket)).state, 'pending');
        await auth.verify(verify(other.code, { discordId: '666456789012345678' }));
        assert.equal((await auth.session(second.token)).discordId, '666456789012345678');
    }
    finally {
        db.close();
    }
});
test('staff registration without Discord ID creates the account only after bot confirmation', async () => {
    const db = new DatabaseSync(':memory:');
    try {
        const auth = await createAuth(db, options);
        const { discordId, ...input } = member;
        const pending = await auth.register(input);
        await assert.rejects(auth.login({ username: input.username, password: input.password }), { status: 401 });
        await auth.verify(verify(pending.code));
        const result = await auth.login({ username: input.username, password: input.password });
        assert.equal(result.user.discordId, discordId);
        assert.equal(result.user.verified, true);
    }
    finally {
        db.close();
    }
});
test('first administrator needs the server key; setup is atomic, closes permanently and revokes legacy access', async () => {
    const db = new DatabaseSync(':memory:');
    try {
        const auth = await createAuth(db, options);
        const old = await auth.adminLogin(options.adminPassword);
        const input = { username: 'owner.test', name: '운영 관리자', password: 'owner-password-123456', setupKey: options.adminPassword };
        await assert.rejects(auth.setup({ ...input, setupKey: 'incorrect-key-12345678' }), { status: 401 });
        const results = await Promise.allSettled([auth.setup(input), auth.setup({ ...input, username: 'second.owner' })]);
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        const result = results.find(result => result.status === 'fulfilled').value;
        assert.equal(result.user.role, 'admin');
        assert.equal((await auth.session(result.token)).id, result.user.id);
        assert.equal(await auth.session(old.token), null);
        await assert.rejects(async () => await auth.adminLogin(options.adminPassword), { status: 401 });
        assert.equal(await auth.setupEnabled(), false);
        await assert.rejects(auth.setup(input), { status: 409 });
        const restarted = await createAuth(db);
        assert.equal(await restarted.setupEnabled(), false);
        assert.equal((await restarted.session(result.token)).role, 'admin');
        assert.equal((await restarted.login({ username: result.user.username, password: input.password })).user.role, 'admin');
        const serialized = JSON.stringify(await db.prepare('SELECT * FROM lms_users').all());
        assert.ok(!serialized.includes(input.password));
        assert.ok(!serialized.includes(input.setupKey));
    }
    finally {
        db.close();
    }
});
test('public signup cannot choose a platform role or promote an existing username', async () => {
    const db = new DatabaseSync(':memory:');
    try {
        const auth = await createAuth(db, options);
        await assert.rejects(auth.signup({ ...member, platform_role: 'admin' }, () => { }));
        const student = await auth.signup(member, () => { });
        await assert.rejects(auth.setup({ username: member.username, name: member.name, password: member.password, setupKey: options.adminPassword }), { status: 409 });
        assert.equal((await auth.session(student.token)).role, 'student');
        const disabled = await createAuth(db, { ...options, allowLegacyAdmin: false });
        await assert.rejects(async () => await disabled.adminLogin(options.adminPassword), { status: 401 });
    }
    finally {
        db.close();
    }
});
test('password changes reauthenticate, rotate the current session and revoke all old sessions across restarts', async () => {
    const db = new DatabaseSync(':memory:');
    try {
        const auth = await createAuth(db, options);
        const first = await auth.signup(member, () => { });
        const second = await auth.login({ username: member.username, password: member.password });
        const newPassword = 'New12345';
        await assert.rejects(auth.changePassword(first.user, { currentPassword: 'incorrect', newPassword }), { status: 401 });
        assert.ok(await auth.session(second.token));
        await assert.rejects(auth.changePassword(first.user, { currentPassword: member.password, newPassword: member.password }), { status: 422 });
        const changed = await auth.changePassword(first.user, { currentPassword: member.password, newPassword });
        assert.equal(await auth.session(first.token), null);
        assert.equal(await auth.session(second.token), null);
        assert.equal((await auth.session(changed.token)).id, first.user.id);
        await assert.rejects(auth.login({ username: member.username, password: member.password }), { status: 401 });
        const restarted = await createAuth(db, options);
        assert.equal((await restarted.login({ username: member.username, password: newPassword })).user.id, first.user.id);
        assert.equal((await restarted.session(changed.token)).id, first.user.id);
    }
    finally {
        db.close();
    }
});
test('server-console recovery preserves roles and revokes sessions only for the target account', async () => {
    const db = new DatabaseSync(':memory:');
    try {
        const auth = await createAuth(db, options);
        const owner = await auth.setup({ username: 'owner.test', name: '운영자', password: member.password, setupKey: options.adminPassword });
        const student = await auth.signup(member, () => { });
        const newPassword = 'Reset123';
        await auth.resetPassword({ username: owner.user.username, newPassword });
        assert.equal(await auth.session(owner.token), null);
        assert.ok(await auth.session(student.token));
        assert.equal((await auth.login({ username: owner.user.username, password: newPassword })).user.role, 'admin');
        await assert.rejects(auth.resetPassword({ username: 'missing.user', newPassword }), { status: 404 });
    }
    finally {
        db.close();
    }
});
test('Discord verification is required, single use, and secrets are hashed at rest', async () => {
    const db = new DatabaseSync(':memory:');
    try {
        const auth = await createAuth(db, options);
        const pending = await auth.register(member);
        await assert.rejects(auth.login({ username: member.username, password: member.password }), { status: 401 });
        assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM lms_users').get()).n, 0);
        assert.equal((await auth.status(pending.ticket)).state, 'pending');
        assert.deepEqual(await auth.preview(verify(pending.code)), { username: member.username });
        assert.equal((await auth.status(pending.ticket)).state, 'pending');
        await auth.verify(verify(pending.code));
        assert.equal((await auth.status(pending.ticket)).state, 'verified');
        await assert.rejects(async () => await auth.verify(verify(pending.code)), { status: 410 });
        const login = await auth.login({ username: member.username.toUpperCase(), password: member.password });
        assert.equal(login.user.role, 'student');
        assert.equal((await auth.session(login.token)).discordId, member.discordId);
        const privateRows = JSON.stringify([
            await db.prepare('SELECT * FROM lms_users').all(),
            await db.prepare('SELECT * FROM lms_registrations').all(),
            await db.prepare('SELECT * FROM lms_auth_sessions').all(),
        ]);
        for (const secret of [member.password, pending.code.replaceAll('-', ''), pending.ticket, login.token])
            assert.ok(!privateRows.includes(secret));
        assert.ok(!('password_hash' in login.user));
        await assert.rejects(auth.login({ username: member.username, password: 'incorrect' }), { status: 401 });
        await auth.logout(login.token);
        assert.equal(await auth.session(login.token), null);
    }
    finally {
        db.close();
    }
});
test('verification binds guild and Discord member; browsers cannot choose roles', async () => {
    const db = new DatabaseSync(':memory:');
    try {
        const auth = await createAuth(db, options);
        await assert.rejects(auth.register({ ...member, role: 'admin' }));
        const pending = await auth.register(member);
        await assert.rejects(async () => await auth.verify(verify(pending.code, { discordId: '666456789012345678' })), { status: 403 });
        await assert.rejects(async () => await auth.verify(verify(pending.code, { guildId: '777456789012345678' })), { status: 403 });
        assert.equal((await auth.status(pending.ticket)).state, 'pending');
        assert.equal(auth.botAuthorized(`Bearer ${options.adminPassword}`), false);
        assert.equal(auth.botAuthorized(`Bearer ${options.botToken}`), true);
        const adminLogin = await auth.adminLogin(options.adminPassword);
        assert.equal(auth.botAuthorized(`Bearer ${adminLogin.token}`), false);
        assert.equal(await auth.session(options.botToken), null);
        await auth.verify(verify(pending.code));
        await assert.rejects(auth.register(member), { status: 409 });
        await assert.rejects(auth.register({ ...member, username: 'new.name' }), { status: 409 });
        await assert.rejects(auth.register({ ...member, discordId: '666456789012345678' }), { status: 409 });
    }
    finally {
        db.close();
    }
});
test('expired and replaced codes fail; verification remains atomic for competing registrations', async () => {
    const db = new DatabaseSync(':memory:');
    let now = 1000000;
    try {
        const auth = await createAuth(db, { ...options, now: () => now });
        const original = await auth.register(member);
        await assert.rejects(async () => await auth.renew(original.ticket), { status: 429 });
        now += 10 * 60000;
        assert.equal((await auth.status(original.ticket)).state, 'expired');
        await assert.rejects(async () => await auth.verify(verify(original.code)), { status: 410 });
        const renewed = await auth.renew(original.ticket);
        await assert.rejects(async () => await auth.verify(verify(original.code)), { status: 410 });
        const competing = await auth.register({ ...member, discordId: '666456789012345678' });
        await auth.verify(verify(renewed.code));
        await assert.rejects(async () => await auth.verify(verify(competing.code, { discordId: '666456789012345678' })), { status: 409 });
        assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM lms_users').get()).n, 1);
        assert.equal((await auth.status(competing.ticket)).state, 'pending');
        const login = await auth.login({ username: member.username, password: member.password });
        now += 8 * 3600000;
        assert.equal(await auth.session(login.token), null);
        now += 24 * 3600000;
        await auth.cleanup();
        await assert.rejects(async () => await auth.status(original.ticket), { status: 404 });
    }
    finally {
        db.close();
    }
});
test('sessions and throttling persist across restarts; administrator password changes revoke old sessions', async () => {
    const db = new DatabaseSync(':memory:');
    let now = 1000;
    try {
        const auth = await createAuth(db, { ...options, now: () => now });
        const pending = await auth.register(member);
        await auth.verify(verify(pending.code));
        const login = await auth.login({ username: member.username, password: member.password });
        const adminLogin = await auth.adminLogin(options.adminPassword);
        await auth.limit('test', 'ip', 1, 60000);
        const restarted = await createAuth(db, { ...options, now: () => now });
        assert.equal((await restarted.session(login.token)).id, login.user.id);
        assert.equal((await restarted.session(adminLogin.token)).role, 'admin');
        await assert.rejects(async () => await restarted.limit('test', 'ip', 1, 60000), { status: 429 });
        const changed = await createAuth(db, { ...options, adminPassword: 'a-different-admin-password', now: () => now });
        assert.equal(await changed.session(adminLogin.token), null);
        now += 60000;
        await restarted.limit('test', 'ip', 1, 60000);
    }
    finally {
        db.close();
    }
});
test('signup fails closed without the dedicated bot configuration and rejects weak passwords', async () => {
    const db = new DatabaseSync(':memory:');
    try {
        const disabled = await createAuth(db);
        assert.equal(disabled.enabled, false);
        assert.equal(disabled.botAuthorized(''), false);
        await assert.rejects(disabled.register(member), { status: 503 });
        await assert.rejects(async () => await disabled.adminLogin(''), { status: 401 });
        const auth = await createAuth(db, options);
        await assert.rejects(auth.register({ ...member, password: 'short' }));
        await assert.rejects(auth.register({ ...member, username: 'x' }));
    }
    finally {
        db.close();
    }
});
test('student data uses verified identity and hides other students, courses, and drafts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'learningops-student-'));
    const { db } = await createStore(join(directory, 'test.db'));
    try {
        const put = async (kind, row) => await db.prepare('INSERT INTO lms_records VALUES(?,?,?)').run(kind, row.id, JSON.stringify(row));
        await put('courses', { id: 'c1', title: '본인 과정', status: '진행 중' });
        await put('courses', { id: 'c2', title: '다른 과정', status: '진행 중' });
        await put('learners', { id: 'u1', discordId: member.discordId, courseId: 'c1', status: '정상', name: '학생', email: 'private@example.com' });
        await put('learners', { id: 'u2', discordId: '666456789012345678', courseId: 'c2', status: '정상', name: '다른 학생' });
        await put('scores', { id: 's1', studentId: 'u1', courseId: 'c1', item: '내 점수', score: 80, maximum: 100 });
        await put('scores', { id: 's2', studentId: 'u2', courseId: 'c2', item: '다른 학생 점수', score: 90, maximum: 100 });
        await put('attendance', { id: 'a1', studentId: 'u1', courseId: 'c1', date: '2026-09-16', period: 1, status: '출석', reason: '운영자 메모' });
        assert.deepEqual((await studentLearning(db, { discordId: member.discordId, verified: true })).courses, []);
        const data = await studentLearning(db, { discordId: member.discordId }, true);
        assert.equal(data.courses[0].title, '본인 과정');
        assert.deepEqual(data.scores.map(row => row.item), ['내 점수']);
        for (const privateValue of ['다른 학생', '다른 과정', 'private@example.com', '운영자 메모'])
            assert.ok(!JSON.stringify(data).includes(privateValue));
        assert.deepEqual((await studentLearning(db, { discordId: '777456789012345678' }, true)).courses, []);
        await db.prepare("UPDATE lms_records SET data=json_set(data,'$.status','비활성') WHERE kind='learners' AND id='u1'").run();
        assert.deepEqual((await studentLearning(db, { discordId: member.discordId }, true)).scores, []);
    }
    finally {
        db.close();
        rmSync(directory, { recursive: true });
    }
});
test('signup accepts exactly eight characters and rejects seven', async () => {
    const db = new DatabaseSync(':memory:');
    const auth = await createAuth(db, options);
    try {
        await assert.rejects(auth.signup({ ...member, password: '1234567' }, () => { }), error => error.name === 'ZodError');
        assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM lms_users').get()).n, 0);
        const { user } = await auth.signup({ ...member, password: 'Test1234' }, () => { });
        assert.equal((await auth.login({ username: user.username, password: 'Test1234' })).user.id, user.id);
    }
    finally {
        db.close();
    }
});
test('platform-only reset returns one-time initial credentials, revokes sessions and enforces change', async () => {
    const db = new DatabaseSync(':memory:');
    try {
        const auth = await createAuth(db, options);
        const owner = await auth.setup({ username: 'global.owner', name: '총괄', password: 'owner-password-1234', setupKey: options.adminPassword });
        const student = await auth.signup(member, () => { });
        await assert.rejects(async () => await auth.accounts({ ...student.user, role: 'admin' }), { status: 403 });
        await assert.rejects(auth.resetAccount(student.user, owner.user.id, { username: owner.user.username }), { status: 403 });
        await assert.rejects(auth.resetAccount(owner.user, student.user.id, { username: 'wrong.name' }), { status: 422 });
        const initial = await auth.resetAccount(owner.user, student.user.id, { username: member.username });
        assert.equal(initial.initialPassword.length, 24);
        assert.equal(await auth.session(student.token), null);
        await assert.rejects(auth.login({ username: member.username, password: member.password }), { status: 401 });
        const changedLogin = await auth.login({ username: member.username, password: initial.initialPassword });
        assert.equal(changedLogin.user.mustChangePassword, true);
        const changed = await auth.changePassword(changedLogin.user, { currentPassword: initial.initialPassword, newPassword: 'new-personal-password-1234' });
        assert.equal(changed.user.mustChangePassword, false);
        assert.ok(!JSON.stringify(await auth.accounts(owner.user)).includes(initial.initialPassword));
        assert.ok(!JSON.stringify(await db.prepare('SELECT * FROM lms_account_audit').all()).includes(initial.initialPassword));
        const attempts = await Promise.allSettled([1, 2].map(async () => await auth.resetAccount(owner.user, student.user.id, { username: member.username })));
        assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1);
        assert.equal(attempts.find(a => a.status === 'rejected').reason.status, 409);
    }
    finally {
        db.close();
    }
});
test('deletion prevents last-admin removal, revokes login and rolls back on foreign-key failure', async () => {
    const db = new DatabaseSync(':memory:');
    try {
        await db.exec('PRAGMA foreign_keys=ON');
        const auth = await createAuth(db, options);
        const owner = await auth.setup({ username: 'global.owner', name: '총괄', password: 'owner-password-1234', setupKey: options.adminPassword });
        const student = await auth.signup(member, () => { });
        await assert.rejects(async () => await auth.deleteAccount(student.user, owner.user.id, { username: owner.user.username }), { status: 403 });
        await assert.rejects(async () => await auth.deleteAccount(owner.user, owner.user.id, { username: owner.user.username }), { status: 409 });
        await db.exec('CREATE TABLE unexpected_ref(user_id TEXT REFERENCES lms_users(id))');
        await db.prepare('INSERT INTO unexpected_ref VALUES(?)').run(student.user.id);
        await assert.rejects(async () => await auth.deleteAccount(owner.user, student.user.id, { username: member.username }));
        assert.ok(await auth.session(student.token));
        assert.equal((await db.prepare("SELECT COUNT(*) n FROM lms_account_audit WHERE action='account.delete'").get()).n, 0);
        await db.exec('DROP TABLE unexpected_ref');
        await auth.deleteAccount(owner.user, student.user.id, { username: member.username });
        assert.equal(await auth.session(student.token), null);
        await assert.rejects(auth.login({ username: member.username, password: member.password }), { status: 401 });
        assert.equal((await auth.accounts(owner.user)).accounts.length, 1);
        assert.equal((await auth.accounts(owner.user)).accounts[0].canDelete, false);
        assert.deepEqual(await db.prepare('PRAGMA foreign_key_check').all(), []);
    }
    finally {
        db.close();
    }
});

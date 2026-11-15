import assert from 'node:assert/strict';

export async function superAdminScenario(auth, db, owner) {
    const input = { username: 'super.test', name: 'Super test', password: 'test-only-super-password' };
    const user = await auth.createSuperAdmin(input);
    assert.equal(user.role, 'admin');
    assert.equal(user.isSuperAdmin, true);
    const row = await db.prepare('SELECT * FROM lms_users WHERE id=?').get(user.id);
    assert.match(row.password_hash, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
    assert.ok(!JSON.stringify(row).includes(input.password));
    assert.equal(await auth.setupEnabled(), false);
    assert.equal(await auth.legacyEnabled(), false);
    await assert.rejects(auth.createSuperAdmin(input), { status: 409 });
    assert.equal((await db.prepare('SELECT password_hash FROM lms_users WHERE id=?').get(user.id)).password_hash, row.password_hash);
    await assert.rejects(auth.login({ username: input.username, password: 'incorrect' }), { status: 401 });
    const login = await auth.login({ username: input.username, password: input.password });
    assert.equal((await auth.session(login.token)).isSuperAdmin, true);
    const account = (await auth.accounts(owner)).accounts.find(account => account.id === user.id);
    assert.equal(account.canDelete, false);
    assert.equal(account.canResetPassword, false);
    for (const actor of [owner, user, { ...owner, isSuperAdmin: true }]) {
        await assert.rejects(auth.resetAccount(actor, user.id, { username: user.username }), { status: 403 });
        await assert.rejects(auth.deleteAccount(actor, user.id, { username: user.username }), { status: 403 });
    }
    assert.ok(await auth.session(login.token));
    const changed = await auth.changePassword(user, { currentPassword: input.password, newPassword: 'changed-test-super-password' });
    assert.equal(changed.user.isSuperAdmin, true);
    assert.equal(await auth.session(login.token), null);
    await auth.resetPassword({ username: input.username, newPassword: 'recovered-test-super-password' });
    assert.equal(await auth.session(changed.token), null);
    assert.equal((await auth.login({ username: input.username, password: 'recovered-test-super-password' })).user.isSuperAdmin, true);
    const audit = await db.prepare("SELECT * FROM lms_account_audit WHERE action='super-admin.create'").all();
    assert.equal(audit.length, 1);
    assert.ok(!JSON.stringify(audit).includes(input.password));
}

import assert from 'node:assert/strict';
import { issueMentorAccount } from './mentor-accounts.mjs';

export async function mentorAccountsScenario(r, platform) {
    const w = await r.workspaces.create({ name: '멘토 계정 발급 검증' });
    const owner = (await r.auth.signup({ username: 'mentor.issue.owner', name: '과정 관리자', password: 'owner-password-1234' }, () => {})).user;
    await r.workspaces.acceptInvitation((await r.workspaces.invite(w.id, { username: owner.username, role: 'admin' }, platform)).token, owner);
    const groups = await r.staff.setupGroups(w.id, { count: 2, revision: (await r.workspaces.snapshot(w.id)).revision }, owner);
    const input = { username: 'issued.mentor', name: '발급 멘토', mentorType: 'group', teamIds: [groups.teams[0].id] };
    const issue = (body = input, actor = owner, id = w.id) => issueMentorAccount(r.auth, r.workspaces, id, body, actor);
    await assert.rejects(issue(input, owner, 'default'), { status: 403 });
    await assert.rejects(issue({ ...input, teamIds: ['foreign-team'] }), { status: 422 });
    assert.equal(await r.store.db.prepare('SELECT id FROM lms_users WHERE username=?').get(input.username), undefined);
    await assert.rejects(issue({ ...input, role: 'admin' }));
    const issued = await issue();
    assert.equal(issued.role, 'instructor');
    assert.equal(issued.initialPassword.length, 24);
    assert.equal((await r.workspaces.previewInvitation(issued.token)).accountExists, true);
    assert.deepEqual((await r.workspaces.previewInvitation(issued.token)).teamIds, input.teamIds);
    const login = await r.auth.login({ username: input.username, password: issued.initialPassword });
    assert.equal(login.user.mustChangePassword, true);
    assert.equal(login.user.role, 'student'); // The instructor role belongs only to this workspace.
    await assert.rejects(issue({ ...input, username: 'forbidden.mentor' }, login.user), { status: 403 });
    const changed = await r.auth.changePassword(login.user, { currentPassword: issued.initialPassword, newPassword: 'mentor-personal-password-1234' });
    await r.workspaces.acceptInvitation(issued.token, changed.user);
    assert.equal(await r.workspaces.role(w.id, changed.user), 'instructor');
    assert.equal(await r.workspaces.role('default', changed.user), null);
    assert.deepEqual((await r.workspaces.mentorScope(w.id, changed.user.id)).teamIds, input.teamIds);
    await assert.rejects(issue({ ...input, username: 'forbidden.mentor' }, changed.user), { status: 403 });
    await assert.rejects(issue(), { status: 409 });
    for (const table of ['lms_users', 'lms_audit', 'lms_workspace_invitations']) assert.ok(!JSON.stringify(await r.store.db.prepare(`SELECT * FROM ${table}`).all()).includes(issued.initialPassword));
    await r.workspaces.setArchived(w.id, true, platform);
    await assert.rejects(issue({ ...input, username: 'archived.mentor' }), { status: 409 });
    assert.equal(await r.store.db.prepare("SELECT id FROM lms_users WHERE username='archived.mentor'").get(), undefined);
}

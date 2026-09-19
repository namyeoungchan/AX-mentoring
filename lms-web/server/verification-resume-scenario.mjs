import assert from 'node:assert/strict';
import { createAuth } from './auth.mjs';

export async function verificationResumeScenario({ store, workspaces }) {
    const guildId = '823456789012345678', otherGuild = '923456789012345678', discordId = '723456789012345678';
    const workspace = await workspaces.create({ name: '인증 이어가기', guildId });
    await workspaces.create({ name: '별도 서버', guildId: otherGuild });
    let now = Date.now();
    const auth = await createAuth(store.db, { botToken: 'test-resume-token-12345678901234567890', now: () => now, guildAllowed: id => [guildId, otherGuild].includes(id) });
    const { user } = await auth.signup({ username: 'resume.student', name: '학생', password: 'resume-password-1234', discordId }, () => {});
    await store.db.prepare("INSERT INTO lms_workspace_members VALUES(?,?,'student',?)").run(workspace.id, user.id, now);
    const identity = { guildId, discordId };
    assert.deepEqual(await auth.verificationState(identity), { verified: false });
    const code = await auth.issueVerification(user, guildId);
    await auth.verify({ ...identity, code: code.code });
    now += 25 * 3600000;
    await auth.cleanup();
    assert.deepEqual(await auth.verificationState(identity), { verified: true });
    await assert.rejects(auth.preview({ ...identity, code: code.code }), { status: 410 });
    assert.deepEqual(await auth.verificationState({ ...identity, guildId: otherGuild }), { verified: false });
    assert.deepEqual(await auth.verificationState({ ...identity, discordId: '623456789012345678' }), { verified: false });
    await store.db.prepare('UPDATE lms_workspaces SET archived_at=? WHERE id=?').run(now, workspace.id);
    assert.deepEqual(await auth.verificationState(identity), { verified: false });
    await store.db.prepare('UPDATE lms_workspaces SET archived_at=NULL WHERE id=?').run(workspace.id);
    await store.db.prepare('UPDATE lms_users SET discord_id=? WHERE id=?').run('623456789012345678', user.id);
    assert.deepEqual(await auth.verificationState(identity), { verified: false });
    await store.db.prepare('UPDATE lms_users SET discord_id=? WHERE id=?').run(discordId, user.id);
    await store.db.prepare('DELETE FROM lms_workspace_verifications WHERE user_id=?').run(user.id);
    assert.deepEqual(await auth.verificationState(identity), { verified: false });
}

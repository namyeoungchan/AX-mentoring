import assert from 'node:assert/strict';
import { HELP_GUIDES } from './help-catalog.mjs';

export async function helpGuidesScenario({ store: { db }, workspaces, helpGuides: help }) {
  const root = { id: 'admin', username: 'root', role: 'admin' };
  const users = {};
  const time = Date.now();
  for (const role of ['admin', 'main', 'group', 'student']) {
    const id = `help-${role}`;
    await db.prepare('INSERT INTO lms_users(id,username,name,password_hash,discord_id,guild_id,created_at) VALUES(?,?,?,?,?,?,?)').run(id, id, id, 'unused', `pending:${id}`, '', time);
    await db.prepare('INSERT INTO lms_workspace_members VALUES(?,?,?,?)').run('default', id, ['main', 'group'].includes(role) ? 'instructor' : role, time);
    if (['main', 'group'].includes(role)) await db.prepare('INSERT INTO lms_mentor_scopes VALUES(?,?,?,?)').run('default', id, role, '[]');
    users[role] = { id, username: id, role: 'student' };
  }
  for (const [role, user] of Object.entries(users)) {
    const own = await help.list('default', user);
    assert.equal(own.role, role);
    assert.equal(own.canManage, role === 'admin');
    assert.deepEqual(own.guides.map(g => g.id), HELP_GUIDES.filter(g => g.role === role).map(g => g.id));
    assert.ok(own.guides.every(g => g.steps.length >= 3 && g.document.revision === null));
    const g = own.guides[0];
    assert.equal((await help.asset('default', g.id, 'pdf', user)).bytes.subarray(0, 5).toString(), '%PDF-');
    assert.equal((await help.asset('default', g.id, 'image', user)).bytes.subarray(0, 2).toString('hex'), 'ffd8');
    for (const foreign of HELP_GUIDES.filter(g => g.role !== role)) {
      await assert.rejects(help.asset('default', foreign.id, 'pdf', user), { status: 403 });
      await assert.rejects(help.asset('default', foreign.id, 'image', user), { status: 403 });
    }
    if (role !== 'admin') {
      await assert.rejects(help.management('default', user), { status: 403 });
      await assert.rejects(help.upload('default', g.id, {}, user), { status: 403 });
      await assert.rejects(help.reset('default', g.id, {}, user), { status: 403 });
    }
  }
  const input = { filename: 'guide.pdf', base64: Buffer.from('%PDF-1.7\nexample upload\n%%EOF').toString('base64'), revision: null };
  const management = await help.upload('default', 'student-learning', input, users.admin);
  assert.ok(management.guides.every(g => !('steps' in g) && !('base64' in g.document)));
  const updated = management.guides.find(g => g.id === 'student-learning').document;
  assert.ok(updated.revision);
  assert.equal((await help.asset('default', 'student-learning', 'pdf', users.student)).bytes.toString('base64'), input.base64);
  await assert.rejects(help.asset('default', 'student-learning', 'pdf', users.admin), { status: 403 });
  await assert.rejects(help.upload('default', 'student-learning', input, users.admin), { status: 409 });
  await assert.rejects(help.reset('default', 'student-learning', { revision: null }, users.admin), { status: 409 });
  await assert.rejects(help.upload('default', 'student-learning', { ...input, base64: Buffer.from('not PDF').toString('base64') }, users.admin), { status: 422 });
  await assert.rejects(help.upload('default', '../student-learning', input, users.admin), { status: 404 });
  assert.ok(!JSON.stringify(await workspaces.snapshot('default')).includes(input.base64));
  assert.ok(!JSON.stringify(await db.prepare("SELECT * FROM lms_audit WHERE action LIKE 'help.%'").all()).includes(input.base64));
  const other = await workspaces.create({ name: 'Separate help files' }, root);
  await db.prepare('INSERT INTO lms_workspace_members VALUES(?,?,?,?)').run(other.id, users.student.id, 'student', time);
  assert.equal((await help.list(other.id, users.student)).guides.find(g => g.id === 'student-learning').document.revision, null);
  assert.notEqual((await help.asset(other.id, 'student-learning', 'pdf', users.student)).bytes.toString('base64'), input.base64);
  await help.reset('default', 'student-learning', { revision: updated.revision }, users.admin);
  assert.equal((await help.list('default', users.student)).guides[0].document.revision, null);
  await db.prepare("UPDATE lms_mentor_scopes SET kind='group' WHERE subject_id=?").run(users.main.id);
  assert.equal((await help.list('default', users.main)).role, 'group');
  await assert.rejects(help.asset('default', 'main-courses', 'pdf', users.main), { status: 403 });
  await db.prepare('DELETE FROM lms_workspace_members WHERE user_id=?').run(users.student.id);
  await assert.rejects(help.list('default', users.student), { status: 403 });
  await assert.rejects(help.asset('default', 'student-learning', 'pdf', users.student), { status: 403 });
  await workspaces.setArchived('default', true, root);
  assert.equal((await help.list('default', users.admin)).canManage, false);
  await assert.rejects(help.upload('default', 'admin-dashboard', input, users.admin), { status: 409 });
  await assert.rejects(help.reset('default', 'admin-dashboard', { revision: null }, users.admin), { status: 409 });
}

import { learnerRemovalScenario } from './learner-removal-scenario.mjs';
import assert from 'node:assert/strict';

export async function rosterScenario(r, owner) {
  await learnerRemovalScenario(r, owner);
  const w = await r.workspaces.create({ name: '명단 검증 과정' });
  const rows = [
    { row: 2, studentId: 'TEST-01', name: '검증 학생', status: '참여', team: '1팀', email: 'student@example.test', phone: '010-0000-0000', school: '검증대', department: '검증학과' },
    { row: 3, studentId: 'TEST-02', name: '다른 학생', status: '참여', team: '3팀' },
    { row: 4, studentId: 'BAD', name: '형식 오류', status: '참여', team: '3팀' },
    { row: 5, studentId: 'TEST-03', name: '제외 학생', status: '제외', team: '' },
  ];
  const body = { rows, title: '명단 과정', courseId: '' };
  const before = await r.store.db.prepare('SELECT COUNT(*) AS n FROM lms_users').get();
  let plan = await r.studentRoster.preview(w.id, body, owner);
  assert.equal(plan.failed.length, 1); assert.equal(plan.excluded.length, 1); assert.equal(plan.guildReady, false);
  assert.deepEqual(await r.store.db.prepare('SELECT COUNT(*) AS n FROM lms_users').get(), before, 'preview must never create users');
  await assert.rejects(r.studentRoster.apply(w.id, { ...body, revision: plan.revision }, owner, true), { status: 422 });
  const prepared = await r.studentRoster.apply(w.id, { ...body, revision: plan.revision }, owner);
  assert.deepEqual((await r.staff.groups(w.id)).teams.map(t => t.name), ['1팀','3팀']);
  const guildId = '883456789012345678';
  await r.workspaces.addServer(w.id, { guildId, templateRevision: (await r.workspaces.template(w.id)).revision }); await r.staff.enableTeams(w.id);
  const forbidden = { id: 'outsider', role: 'student' };
  await assert.rejects(r.studentRoster.preview(w.id, body, forbidden), { status: 403 });
  plan = await r.studentRoster.preview(w.id, body, owner);
  const result = await r.studentRoster.apply(w.id, { ...body, revision: plan.revision }, owner, true);
  assert.equal(result.results.filter(r => r.result === 'created').length, 2);
  assert.equal(result.results.filter(r => r.result === 'failed').length, 1);
  const login = await r.auth.login({ username: 'TEST-01', password: 'bdaxuser1!' });
  assert.equal(login.user.mustChangePassword, true); assert.equal(login.user.mustCompleteProfile, true);
  const passwordHash = (await r.store.db.prepare('SELECT password_hash FROM lms_users WHERE id=?').get(login.user.id)).password_hash;
  plan = await r.studentRoster.preview(w.id, body, owner);
  const again = await r.studentRoster.apply(w.id, { ...body, revision: plan.revision }, owner, true);
  assert.equal(again.results.filter(r => r.result === 'existing').length, 2);
  assert.equal((await r.store.db.prepare('SELECT password_hash FROM lms_users WHERE id=?').get(login.user.id)).password_hash, passwordHash);
  assert.equal((await r.staff.groups(w.id)).teams.length, 2);
  let list = await r.admissions.studentAccounts(w.id, owner), account = list.accounts.find(a => a.username === 'test-01');
  assert.equal(account.school, '검증대');
  const profile = { username: account.username, name: '수정 이름', email: 'edited@example.test', phone: '010-0000-1111', school: '수정 대학', department: '수정 학과', revision: list.revision, profileRevision: account.profileRevision };
  await assert.rejects(r.admissions.manageStudent(w.id, account.id, profile, forbidden), { status: 403 });
  list = await r.admissions.manageStudent(w.id, account.id, profile, owner);
  assert.equal(list.accounts.find(a => a.id === account.id).name, '수정 이름');
  await assert.rejects(r.admissions.manageStudent(w.id, account.id, profile, owner), { status: 409 });
  account = list.accounts.find(a => a.id === account.id);
  const application = await r.store.db.prepare('SELECT id FROM lms_admissions WHERE user_id=? AND workspace_id=?').get(account.id, w.id);
  const data = await r.workspaces.snapshot(w.id), learnerId = `admission-${application.id}`;
  await r.workspaces.mutate(w.id, { revision: data.revision, changes: [{ kind: 'learners', value: { id: learnerId, name: account.name, email: account.email, courseId: prepared.courseId, team: '1팀', discordId: '', status: '대기', progress: 0, color: 'sage' } }] }, owner.username);
  list = await r.admissions.studentAccounts(w.id, owner);
  const deleted = await r.admissions.manageStudent(w.id, account.id, { username: account.username, revision: list.revision, profileRevision: account.profileRevision }, owner, true);
  assert.equal(deleted.accounts.some(a => a.id === account.id), false);
  assert.equal((await r.workspaces.snapshot(w.id)).learners.find(l => l.id === learnerId), undefined);
  assert.equal((await r.workspaces.snapshot(w.id)).removedLearners.find(l => l.id === learnerId).status, '비활성');
  assert.equal(await r.workspaces.role(w.id, login.user), null);
  assert.ok(await r.store.db.prepare('SELECT id FROM lms_users WHERE id=?').get(account.id), 'global login account is preserved');
  const config = (await r.onboarding.read(w.id)).configs[0];
  assert.ok(config.courseIds.includes(prepared.courseId), 'Discord onboarding uses imported teams');
  const remaining = deleted.accounts.find(a => a.username === 'test-02');
  await r.auth.deleteAccount(owner, remaining.id, { username: remaining.username });
  assert.equal(await r.store.db.prepare("SELECT 1 FROM lms_runtime_state WHERE kind='student-profile' AND record_key=?").get(remaining.id), undefined);
}

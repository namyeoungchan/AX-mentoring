import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from './runtime.mjs';
import { rosterRows, normalizeRoster } from '../shared/student-roster.mjs';
import { rosterScenario } from './roster-scenarios.mjs';

test('roster validates each row and excludes both instances of duplicate IDs', () => {
  const rows = rosterRows([['학생ID','상태','팀','성명'],['AB-01','참여','1팀','예제 A'],['ab-01','참여','1팀','예제 B'],['AB-03','알수없음','','예제 C'],['AB-04','제외','','예제 D'],['AB-05','참여','2팀','예제 E']]);
  const result = normalizeRoster(rows);
  assert.equal(result.failed.length, 3); assert.equal(result.excluded.length, 1); assert.equal(result.participants.length, 1);
  assert.deepEqual(result.teams, ['2팀']);
  assert.throws(() => rosterRows([['이름'],['예제']]), /학생ID/);
  assert.throws(() => normalizeRoster([{ row: 2, studentId: { bad: true } }]), /형식/);
});

test('SQLite roster preview, partial results, fixed password, retry, editing and scoped deletion', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-test-'));
  const env = { NODE_ENV: 'test', ADMIN_PASSWORD: 'roster-setup-key-123456', LEARNINGOPS_AUTH_TOKEN: 'roster-bot-token-1234567890123456789' };
  const r = await createRuntime(join(dir, 'main.db'), env);
  t.after(() => { r.close(); rmSync(dir, { recursive: true, force: true }); });
  const owner = (await r.auth.setup({ username: 'roster.owner', name: '운영자', password: 'roster-password-123', setupKey: env.ADMIN_PASSWORD })).user;
  await rosterScenario(r, owner);
});

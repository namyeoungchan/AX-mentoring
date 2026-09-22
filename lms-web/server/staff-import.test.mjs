import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readSheet } from 'read-excel-file/node';
import { staffRows, staffCsv, staffExport } from '../shared/staff-import.mjs';

test('spreadsheet categories fill down and only known headers are used', () => {
  const rows = staffRows([['구분', '이름', '연락처', '이메일', '아이디', '담당 조'], ['PM', '운영', '', '', 'mentor.pm'], ['강의', '강사', '', '', 'mentor.teacher'], ['', '강사2', '', '', 'Mentor.Teacher2'], ['기술멘토', '멘토', '', '', 'mentor.tech', '1조;2조'], ['자문/운영', '관리자', '', '', 'mentor.admin']]);
  assert.equal(rows[2].category, '강의'); assert.equal(rows[2].username, 'mentor.teacher2');
  assert.deepEqual(rows[3].teamNames, ['1조', '2조']);
  assert.throws(() => staffRows([['이름', '아이디'], ['a', 'user.test']]));
  assert.throws(() => staffRows([['구분', '이름', '아이디'], ...Array.from({ length: 51 }, () => ['PM', 'A', 'test.account'])]));
});
test('CSV supports BOM, quoted commas and empty cells, and exports inert spreadsheet cells', () => {
  const csv = '\uFEFF구분,이름,연락처,이메일,아이디\r\nPM,"김,강사",010-1234-5678,,mentor.test\r\n,다음,,,mentor.next';
  const rows = staffRows(staffCsv(csv)); assert.equal(rows.length, 2); assert.equal(rows[0].name, '김,강사'); assert.equal(rows[1].category, 'PM');
  assert.throws(() => staffCsv('a,"unfinished')); assert.throws(() => staffCsv('a,"ended"bad'));
  assert.ok(staffExport([['=CMD()', '+123', '@SUM()', '-cmd', 'normal']]).includes('"\'=CMD()"'));
});
test('downloadable xlsx template matches the accepted import format', async () => {
  const rows = staffRows(await readSheet(readFileSync(new URL('../public/templates/staff-accounts-template.xlsx', import.meta.url))));
  assert.equal(rows.length, 5); assert.deepEqual(rows.map(r => r.category), ['PM', '강의', '강의', '기술멘토', '자문/운영']);
});

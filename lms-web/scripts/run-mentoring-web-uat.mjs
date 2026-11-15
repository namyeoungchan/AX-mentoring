// Real local browser + HTTP API + SQLite acceptance rehearsal, without production or Discord access.
// Build first. Run from lms-web: DATABASE_URL='' node scripts/run-mentoring-web-uat.mjs
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect } from '@playwright/test';
import { createRuntime } from '../server/runtime.mjs';

// index.mjs loads .env. Refuse to run if a local deployment configuration could be inherited.
await access(resolve('.env')).then(() => { throw new Error('Refusing UAT in a checkout with lms-web/.env. Use an isolated checkout.'); }, () => {});
await access(resolve('dist/index.html'));
const scratch = await mkdtemp(join(tmpdir(), 'ax-mentoring-web-uat-'));
const dbPath = join(scratch, 'uat.db'), origin = 'http://127.0.0.1:3047';
const password = `Local-UAT-${randomBytes(12).toString('hex')}`;
const guildId = '710000000000000001';
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || tmpdir(), TZ: 'Asia/Seoul',
  NODE_ENV: 'test', DATABASE_URL: '', BOT_DB_PATH: dbPath, API_PORT: '3047', ALLOWED_ORIGINS: origin,
  ADMIN_PASSWORD: '', ALLOW_LEGACY_ADMIN: 'false', DISCORD_TOKEN: '',
  LEARNINGOPS_AUTH_TOKEN: 'local-uat-fixture-not-a-real-bot-token', LEARNINGOPS_AUTH_GUILD_ID: guildId,
  LEARNINGOPS_SYNC_TOKEN: '', LEARNINGOPS_PROVISION_TOKEN: '', VIMEO_ACCESS_TOKEN: '',
  ...(process.env.PYTHON_EXECUTABLE ? { PYTHON_EXECUTABLE: process.env.PYTHON_EXECUTABLE } : {}) };
const result = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  startedAt: new Date().toISOString(), environment: 'local-real-web-api-sqlite', origin,
  productionTouched: false, discordDelivery: 'NOT_TESTED', humanAcceptance: 'PENDING',
  preparation: 'Fictitious accounts created with real password hashes; memberships, Discord verification, availability and pending reservations are local fixtures, not Discord UAT.',
  tests: [], consoleErrors: [], pageErrors: [], blockedExternalRequests: [], screenshots: [] };
result.sourceHashes = Object.fromEntries(await Promise.all(['src/InstructorHome.tsx', 'server/staff-flow.mjs', 'server/help-catalog.mjs', 'server/help-rescheduling-catalog.mjs', 'scripts/run-mentoring-web-uat.mjs'].map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const runtime = await createRuntime(dbPath, env), db = runtime.store.db, users = {};
const put = (kind, value) => db.prepare('INSERT INTO lms_records VALUES(?,?,?)').run(kind, value.id || 'workspace', JSON.stringify(value));
await db.prepare("UPDATE lms_workspaces SET name='멘토링 웹 UAT · 예시 데이터' WHERE id='default'").run();
await db.prepare("UPDATE lms_workspace_guilds SET workspace_id='default' WHERE guild_id=?").run(guildId);
await put('settings', { name: '멘토링 웹 UAT · 예시 데이터', reminders: true, onboarding: true, qa: true });
for (const [index, role] of ['group', 'student', 'stranger', 'main'].entries()) {
  const name = { group: '테스트 멘토', student: '테스트 학생', stranger: '다른 테스트 학생', main: '테스트 메인강사' }[role];
  const discordId = `71000000000000001${index}`;
  const { user } = await runtime.auth.signup({ username: `webuat.${role}`, name, password, discordId }, () => {});
  users[role] = user;
  await db.prepare('UPDATE lms_users SET verified_at=?,guild_id=? WHERE id=?').run(Date.now(), guildId, user.id);
  await db.prepare('INSERT INTO lms_workspace_members VALUES(?,?,?,?)').run('default', user.id, ['group', 'main'].includes(role) ? 'instructor' : 'student', Date.now());
  await db.prepare('INSERT INTO lms_workspace_verifications VALUES(?,?,?,?,?)').run('default', user.id, guildId, discordId, Date.now());
  if (['group', 'main'].includes(role)) {
    await db.prepare('INSERT INTO lms_mentor_scopes VALUES(?,?,?,?)').run('default', user.id, role, JSON.stringify(role === 'group' ? ['uat-team'] : []));
    await db.prepare('INSERT INTO lms_staff_profiles VALUES(?,?,?,?,?,?,?)').run('default', user.id, name, 'UAT', '가상 계정', JSON.stringify(['assignments', 'approval', 'mentoring']), Date.now());
    await runtime.staff.syncDiscord(discordId, guildId);
  }
}
const mentorId = (await db.prepare('SELECT id FROM mentors WHERE discord_id=?').get(users.group.discordId)).id;
const date = days => new Date(Date.now() + days * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
await put('courses', { id: 'uat-course', title: '로컬 검증 과정', category: 'AX', description: '운영 데이터가 아닌 테스트 과정', progress: 0, learners: 2, weeks: '4주', mentor: '테스트 멘토', theme: 'green', status: '진행 중', code: 'WEB-UAT', cohort: '1', guildId, startDate: date(0), endDate: date(90) });
await put('teams', { id: 'uat-team', name: '테스트 1조', code: 'UAT-1', courseId: 'uat-course', mentorId: String(mentorId) });
await db.prepare('INSERT INTO lms_group_setup VALUES(?,?)').run('default', 'uat-course');
for (const role of ['student', 'stranger']) await put('learners', { id: `uat-${role}`, name: users[role].name, email: '', courseId: 'uat-course', team: '테스트 1조', discordId: users[role].discordId, status: '정상', progress: 0, color: 'sage' });
const fixtures = {};
for (const [index, key] of ['flow', 'cancel', 'stranger'].entries()) {
  const title = `로컬 UAT · ${key}`, slots = [];
  for (const hour of [14, 15, 16]) {
    const start = `${date(7 + index)}T${hour}:00:00`, end = `${date(7 + index)}T${hour}:50:00`;
    const row = await db.prepare('INSERT INTO slots(mentor_id,start_time,end_time,label) VALUES(?,?,?,?) RETURNING id').get(mentorId, start, end, title);
    slots.push({ id: String(row.id), start, end });
  }
  const owner = key === 'stranger' ? users.stranger : users.student;
  const row = await db.prepare('INSERT INTO bookings(slot_id,user_id,user_name,status) VALUES(?,?,?,?) RETURNING id').get(slots[0].id, owner.discordId, owner.name, key === 'flow' ? 'pending' : 'approved');
  fixtures[key] = { id: String(row.id), title, slots };
}
result.fixtures = fixtures;
result.accounts = Object.fromEntries(Object.entries(users).map(([role, user]) => [role, { id: user.id, username: user.username }]));
runtime.close();
const inspect = new DatabaseSync(dbPath);
inspect.exec('PRAGMA busy_timeout=5000');
let server, browser, serverLog = '';
const pages = {};
async function startServer() {
  // Never attach to a server that was already using this port.
  await fetch(`${origin}/api/health`).then(() => { throw new Error('Port 3047 is already occupied'); }, () => {});
  server = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { serverLog += chunk; });
  server.stderr.on('data', chunk => { serverLog += chunk; });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error('Local API exited: ' + serverLog);
    try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('Local server startup timeout');
}
async function stopServer() {
  if (server && server.exitCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited; }
}
const endpoint = id => `${origin}/api/workspaces/default/mentoring/${id}/coordination`;
const panel = page => page.getByRole('region', { name: '멘토링 일정 재조율', exact: true });
const card = (page, key = 'flow') => page.locator('.coordination-appointment').filter({ has: page.locator('p', { hasText: fixtures[key].title }) });
async function refresh(page) {
  await Promise.all([
    page.waitForResponse(r => r.url() === origin + '/api/workspaces/default/mentoring/coordination' && r.request().method() === 'GET'),
    panel(page).getByRole('button', { name: '멘토링 일정 새로고침', exact: true }).click(),
  ]);
  await page.waitForLoadState('networkidle');
}
async function state(page, key = 'flow') {
  const response = await page.request.get(endpoint(fixtures[key].id));
  assert.equal(response.status(), 200, await response.text()); return response.json();
}
async function shot(page, name) {
  const path = join(scratch, `${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  result.screenshots.push(path); return path;
}
async function test(name, action) {
  const start = result.screenshots.length;
  const row = { name, startedAt: new Date().toISOString() }; result.tests.push(row);
  try { await action(); row.status = 'PASS'; console.log(`PASS ${name}`); }
  catch (error) { row.status = 'FAIL'; row.error = error.message; console.error(`FAIL ${name}: ${error.message.slice(0, 350)}`);
    for (const [role, page] of Object.entries(pages)) await shot(page, `failure-${result.tests.length}-${role}`).catch(() => {});
  }
  row.finishedAt = new Date().toISOString();
  row.screenshots = result.screenshots.slice(start);
}
async function save(page, action, { key = 'flow', expected = 200 } = {}) {
  const [response] = await Promise.all([
    page.waitForResponse(r => r.request().method() === 'POST' && r.url() === endpoint(fixtures[key].id)),
    card(page, key).getByRole('button', { name: `${action} 저장`, exact: true }).click(),
  ]);
  assert.equal(response.status(), expected, await response.text());
  if (expected === 200) await expect(card(page, key).locator('.coordination-form')).toHaveCount(0);
}
async function propose(page, slot, available = 'yes') {
  await refresh(page);
  await card(page).getByRole('button', { name: /^(다른 시간 제안|다른 시간으로 재제안)$/ }).click();
  await card(page).getByLabel('변경할 시간').selectOption(fixtures.flow.slots[slot].id);
  await card(page).getByLabel('기존 일정 참석 가능 여부').selectOption(available);
  await card(page).getByLabel('사유', { exact: true }).fill('로컬 UAT: 팀 프로젝트 일정에 맞춰 변경을 제안합니다.');
  await save(page, '다른 시간 제안');
  await expect(card(page)).toContainText('변경 응답 대기');
}
async function act(page, action, { key = 'flow', available = 'yes' } = {}) {
  await refresh(page);
  await card(page, key).getByRole('button', { name: action, exact: true }).click();
  if (action !== '변경 수락') await card(page, key).getByLabel('사유', { exact: true }).fill(`로컬 UAT: ${action} 검증`);
  if (['제안 철회', '제안 거절'].includes(action)) await card(page, key).getByLabel('기존 일정 참석 가능 여부').selectOption(available);
  await save(page, action, { key });
}
try {
  console.log('Local-only UAT evidence: ' + scratch);
  await startServer();
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  for (const role of Object.keys(users)) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', serviceWorkers: 'block' });
    // Safety guard only; local API responses are never mocked or rewritten.
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      result.blockedExternalRequests.push(url.origin); return route.abort();
    });
    const page = pages[role] = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', e => result.pageErrors.push({ role, message: e.message }));
    page.on('console', m => { if (m.type() === 'error') result.consoleErrors.push({ role, message: m.text() }); });
  }
  await test('01 실제 로그인: 학생·조 멘토·다른 학생·메인 강사 별도 세션', async () => {
    for (const [role, page] of Object.entries(pages)) {
      await page.goto(origin + '/?workspace=default#mentoring');
      await page.getByLabel('아이디', { exact: true }).fill(users[role].username);
      await page.getByLabel('비밀번호', { exact: true }).fill(password);
      const [login] = await Promise.all([
        page.waitForResponse(r => r.url() === origin + '/api/auth/login' && r.request().method() === 'POST'),
        page.locator('form').getByRole('button', { name: '로그인', exact: true }).click(),
      ]);
      assert.equal(login.status(), 200, await login.text());
      await expect(page.getByRole('heading', { name: 'LMS 로그인', exact: true })).toHaveCount(0);
      const response = await page.request.get(origin + '/api/auth/me');
      assert.equal(response.status(), 200, await response.text());
      const me = await response.json();
      assert.equal(me.user.id, users[role].id);
      await page.goto(origin + '/?workspace=default#mentoring');
      await expect(page.locator('main h1')).toBeVisible();
    }
  });
  if (result.tests.at(-1).status !== 'PASS') throw new Error('Login prerequisite failed; dependent scenarios not run.');
  const student = pages.student, mentor = pages.group;
  await test('02 승인 대기 fixture → 멘토 웹 승인 → 양쪽 승인 예약 조회', async () => {
    await expect(card(student)).toHaveCount(0);
    await mentor.getByRole('navigation', { name: '일정 보기' }).getByRole('button', { name: /^승인 대기/ }).click();
    const row = mentor.locator(`[data-session-id="${fixtures.flow.id}"]`);
    await expect(row).toContainText(fixtures.flow.title);
    await row.getByRole('button', { name: '승인', exact: true }).click();
    await expect(mentor.locator('.mentoring-feedback')).toContainText('예약을 승인했습니다.');
    for (const p of [mentor, student]) { await refresh(p); await expect(card(p)).toContainText('예약 확정'); }
    assert.equal(inspect.prepare('SELECT status FROM bookings WHERE id=?').get(fixtures.flow.id).status, 'approved');
    await shot(mentor, '02-mentor-approved');
  });
  await test('03 멘토 제안 → 학생 수락 / 기존 시간 유지·동일 예약 ID', async () => {
    const original = await state(student);
    await propose(mentor, 1); assert.equal((await state(student)).start, original.start);
    await expect(card(mentor).getByRole('button', { name: '변경 수락', exact: true })).toHaveCount(0);
    await refresh(student); await expect(card(student)).toContainText('상대방이 보낸 제안');
    await shot(student, '03-student-incoming-proposal');
    await act(student, '변경 수락');
    for (const p of [student, mentor]) { await refresh(p); const s = await state(p); assert.equal(s.start, fixtures.flow.slots[1].start); assert.equal(s.status, 'confirmed'); assert.equal(s.id, original.id); }
    await shot(student, '03-student-accepted');
  });
  await test('04 학생 제안 → 멘토 거절 / 기존 참석 가능이면 확정 유지', async () => {
    await propose(student, 2); await act(mentor, '제안 거절');
    assert.equal((await state(student)).status, 'confirmed'); assert.equal((await state(student)).start, fixtures.flow.slots[1].start);
    await refresh(student); await shot(student, '04-rejected-keeps-original');
  });
  await test('05 학생 제안 → 멘토 재제안 → 학생 수락', async () => {
    await propose(student, 0); await propose(mentor, 2); await act(student, '변경 수락');
    assert.equal((await state(student)).start, fixtures.flow.slots[2].start);
  });
  await test('06 제안 철회는 예약 취소가 아님', async () => {
    await propose(student, 1); await act(student, '제안 철회');
    assert.equal((await state(student)).status, 'confirmed');
    assert.equal(inspect.prepare('SELECT slot_id FROM bookings WHERE id=?').get(fixtures.flow.id).slot_id, Number(fixtures.flow.slots[2].id));
  });
  await test('07 기존 참석 불가 → 거절·철회 시 재조율 필요 / 다시 합의', async () => {
    await propose(student, 1, 'no'); await act(mentor, '제안 거절');
    assert.equal((await state(student)).status, 'needs_coordination');
    await propose(student, 1, 'no'); await act(student, '제안 철회', { available: 'no' });
    await refresh(mentor); await expect(card(mentor)).toContainText('재조율 필요');
    await shot(mentor, '07-needs-coordination');
    await propose(mentor, 0); await act(student, '변경 수락');
    assert.deepEqual((await state(student)).unavailable, []);
  });
  await test('08 낡은 수락 화면: 상대가 철회하면 409·오래된 시간 확정 차단', async () => {
    await propose(mentor, 1); await refresh(student);
    await card(student).getByRole('button', { name: '변경 수락', exact: true }).click();
    await act(mentor, '제안 철회'); await save(student, '변경 수락', { expected: 409 });
    await expect(panel(student)).toContainText('최신 상태');
    assert.equal((await state(student)).start, fixtures.flow.slots[0].start);
    await shot(student, '08-stale-response-blocked');
    await card(student).getByRole('button', { name: '입력 닫기', exact: true }).click();
  });
  await test('09 빈 사유·시간·참석 여부는 제출되지 않음', async () => {
    await card(student).getByRole('button', { name: '다른 시간 제안', exact: true }).click();
    const version = (await state(student)).version;
    await card(student).getByRole('button', { name: '다른 시간 제안 저장', exact: true }).click();
    assert.equal(await card(student).locator('form').evaluate(form => form.checkValidity()), false);
    assert.equal((await state(student)).version, version);
    await card(student).getByRole('button', { name: '입력 닫기', exact: true }).click();
  });
  await test('10 다른 학생·메인 강사: 본인 아닌 예약 변경 차단', async () => {
    await expect(card(pages.stranger)).toHaveCount(0);
    await expect(panel(pages.main)).toHaveCount(0);
    for (const [role, expected] of [['stranger', 404], ['main', 403]]) {
      const response = await pages[role].request.post(endpoint(fixtures.flow.id), { data: { action: 'cancel', eventId: randomUUID(), version: (await state(student)).version, reason: '권한 차단 검증' } });
      assert.equal(response.status(), expected);
    }
  });
  await test('11 별도 예약 취소: 양쪽 목록 제거·취소 이력 및 알림 큐 보존', async () => {
    await refresh(student);
    await card(student, 'cancel').getByRole('button', { name: '예약 취소', exact: true }).click();
    await expect(card(student, 'cancel')).toContainText('예약 자체를 취소');
    await card(student, 'cancel').getByLabel('사유', { exact: true }).fill('로컬 UAT 별도 예약 취소');
    await shot(student, '11-cancel-confirmation'); await save(student, '예약 취소', { key: 'cancel' });
    for (const p of [student, mentor]) { await refresh(p); await expect(card(p, 'cancel')).toHaveCount(0); }
    assert.equal(inspect.prepare('SELECT id FROM bookings WHERE id=?').get(fixtures.cancel.id), undefined);
    assert.equal(inspect.prepare('SELECT COUNT(*) n FROM lms_booking_history').get().n, 1);
    assert.equal(inspect.prepare("SELECT COUNT(*) n FROM lms_outbox WHERE kind='mentoring_coordination' AND source_id=? AND state='pending'").get(fixtures.cancel.id).n, 2);
  });
  await test('12 가능한 시간 없음 안내 (로컬 슬롯 비활성 fixture)', async () => {
    const active = inspect.prepare('SELECT id FROM slots WHERE is_active=1').all();
    inspect.prepare('UPDATE slots SET is_active=0').run();
    try {
      await refresh(student); await card(student).getByRole('button', { name: '다른 시간 제안', exact: true }).click();
      await expect(card(student)).toContainText('선택 가능한 시간이 없습니다');
      await expect(card(student).getByLabel('변경할 시간').locator('option')).toHaveCount(1);
      await shot(student, '12-no-available-slots');
      await card(student).getByRole('button', { name: '입력 닫기', exact: true }).click();
    } finally { for (const { id } of active) inspect.prepare('UPDATE slots SET is_active=1 WHERE id=?').run(id); }
  });
  await test('13 알림 실패 fixture → 웹 경고·재시도 / 예약 유지 (실 DM 제외)', async () => {
    const job = inspect.prepare("SELECT id FROM lms_outbox WHERE kind='mentoring_coordination' AND source_id=? AND state='pending' LIMIT 1").get(fixtures.flow.id);
    assert.ok(job); const before = await state(student);
    inspect.prepare("UPDATE lms_outbox SET state='failed',error='local_uat_simulated_dm_failure' WHERE id=?").run(job.id);
    await refresh(student); await expect(card(student)).toContainText('발송 실패');
    await shot(student, '13-notification-failure-fixture');
    await card(student).getByRole('button', { name: '알림 재시도', exact: true }).click();
    await expect(panel(student)).toContainText('알림 재시도를 요청했습니다.');
    assert.equal(inspect.prepare('SELECT state FROM lms_outbox WHERE id=?').get(job.id).state, 'pending');
    assert.equal((await state(student)).start, before.start);
  });
  await test('14 모바일 390px에서 두 역할 일정 변경 폼 가로 넘침 없음', async () => {
    for (const [role, p] of [['student', student], ['group', mentor]]) {
      await refresh(p); await p.setViewportSize({ width: 390, height: 900 });
      await card(p).getByRole('button', { name: '다른 시간 제안', exact: true }).click();
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await shot(p, `14-mobile-${role}`);
      await card(p).getByRole('button', { name: '입력 닫기', exact: true }).click();
      await p.setViewportSize({ width: 1440, height: 1000 });
    }
  });
  await test('15 역할별 도움말 6단계 이미지·PDF·기능 화면 이동', async () => {
    for (const [role, p] of [['student', student], ['group', mentor]]) {
      await p.goto(origin + '/?workspace=default#help');
      await p.getByRole('button', { name: '멘토링', exact: true }).click();
      await p.locator('.help-topics button').filter({ hasText: '승인된 멘토링 일정 변경' }).click();
      await expect(p.locator('.help-step-tabs button')).toHaveCount(6);
      for (let i = 0; i < 6; i++) {
        await p.locator('.help-step-tabs button').nth(i).click();
        await expect.poll(() => p.locator('.help-screen img').evaluate(img => img.naturalWidth)).toBe(1440);
        await expect(p.locator('.help-screen figcaption')).toContainText('예시 데이터');
      }
      const pdf = await p.request.get(`${origin}/api/workspaces/default/help/${role}-rescheduling/pdf`);
      assert.equal(pdf.status(), 200); assert.equal((await pdf.body()).subarray(0, 5).toString(), '%PDF-');
      await p.getByRole('button', { name: 'PDF 보기', exact: true }).click();
      await expect(p.getByRole('dialog').locator('iframe')).toHaveAttribute('src', /^blob:/); await p.keyboard.press('Escape');
      await shot(p, `15-help-${role}`);
      await p.getByRole('button', { name: '기능 화면 열기', exact: true }).click();
      await expect(panel(p)).toHaveCount(1); await expect(panel(p)).toBeVisible();
      for (let repeat = 0; repeat < 2; repeat++) {
        await p.locator('.sidebar .nav-item').filter({ hasText: '도움말' }).click();
        await expect(panel(p)).toHaveCount(0);
        await p.getByRole('button', { name: '멘토링', exact: true }).click();
        await p.locator('.help-topics button').filter({ hasText: '승인된 멘토링 일정 변경' }).click();
        await p.getByRole('button', { name: '기능 화면 열기', exact: true }).click();
        await expect(panel(p)).toHaveCount(1);
      }
      await shot(p, `15-return-to-mentoring-${role}`);
    }
  });
  await test('16 서버 재시작·브라우저 새로고침 후 확정 시간·이력 유지', async () => {
    const before = await state(student); await stopServer(); await startServer();
    for (const p of [student, mentor]) {
      await p.reload(); await expect(card(p)).toContainText('예약 확정');
      const after = await state(p); assert.equal(after.start, before.start); assert.equal(after.version, before.version); assert.deepEqual(after.history, before.history);
    }
    await card(student).locator('details summary').click(); await shot(student, '16-persisted-history');
  });
  await test('17 멘토 온보딩에 오래된 취소·재예약 안내가 없는지', async () => {
    await mentor.goto(origin + '/?workspace=default#onboarding');
    await mentor.getByRole('button', { name: /멘토링 진행/ }).click();
    await expect(mentor.locator('#mentor-guide-mentoring')).toBeVisible();
    await expect(panel(mentor)).toHaveCount(0);
    const path = join(scratch, '17-mentor-onboarding.png');
    await mentor.locator('.mentor-onboarding').screenshot({ path, animations: 'disabled' }); result.screenshots.push(path);
    await expect(mentor.locator('#mentor-guide-mentoring')).not.toContainText('기존 예약을 취소한 뒤 다시 예약');
    await expect(mentor.locator('#mentor-guide-mentoring')).toContainText('상대방 수락 후 확정');
  });
} catch (error) { result.fatal = error.stack; process.exitCode = 1; }
finally {
  result.finishedAt = new Date().toISOString();
  result.summary = { passed: result.tests.filter(t => t.status === 'PASS').length, failed: result.tests.filter(t => t.status === 'FAIL').length };
  await browser?.close(); await stopServer(); inspect.close();
  await writeFile(join(scratch, 'results.json'), JSON.stringify(result, null, 2));
  await writeFile(join(scratch, 'server.log'), serverLog);
  console.log(JSON.stringify({ evidence: scratch, ...result.summary, fatal: result.fatal || null }, null, 2));
  if (result.summary.failed) process.exitCode = 1;
}

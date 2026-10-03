// Capture the running application with isolated, fictitious data and real role sessions.
// Requires `npm run build`; never connects to a production database or Discord bot.
import { captureGuideSteps } from './help-guide-capture.mjs';
import { renderGuidePdf } from './render-help-pdf.mjs';
import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createRuntime } from '../server/runtime.mjs';
import { HELP_GUIDES, HELP_ROLES } from '../server/help-catalog.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'ax-help-capture-'));
const dbPath = join(scratch, 'guide.db'), output = resolve('server/help-assets');
const port = 3037, origin = `http://127.0.0.1:${port}`;
const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: '', BOT_DB_PATH: dbPath, API_PORT: String(port), ADMIN_PASSWORD: 'guide-fixture-only-password', ALLOW_LEGACY_ADMIN: 'true', LEARNINGOPS_AUTH_TOKEN: 'guide-fixture-only-token-12345678901234567890', LEARNINGOPS_AUTH_GUILD_ID: '700000000000000001', LEARNINGOPS_SYNC_TOKEN: '', LEARNINGOPS_PROVISION_TOKEN: '', VIMEO_ACCESS_TOKEN: '', ALLOWED_ORIGINS: origin };
const runtime = await createRuntime(dbPath, env), { db } = runtime.store;
const users = {}, today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
const put = async (kind, row) => db.prepare('INSERT INTO lms_records VALUES(?,?,?)').run(kind, row.id || 'workspace', JSON.stringify(row));
await db.prepare("UPDATE lms_workspaces SET name='AX 교육 · 가이드 예시' WHERE id='default'").run();
await db.prepare("UPDATE lms_workspace_guilds SET workspace_id='default' WHERE guild_id=?").run(env.LEARNINGOPS_AUTH_GUILD_ID);
await put('settings', { name: 'AX 교육 · 가이드 예시', reminders: true, onboarding: true, qa: true });
for (const [index, role] of Object.keys(HELP_ROLES).entries()) {
  const name = { admin: '김운영', main: '이강사', group: '박멘토', student: '최학습' }[role];
  const discordId = `70000000000000001${index}`;
  const login = await runtime.auth.signup({ username: `guide.${role}`, name, password: 'guide-fixture-private-password', discordId }, () => {});
  const user = login.user;
  await db.prepare('UPDATE lms_users SET verified_at=?,guild_id=? WHERE id=?').run(Date.now(), env.LEARNINGOPS_AUTH_GUILD_ID, user.id);
  await db.prepare('INSERT INTO lms_workspace_members VALUES(?,?,?,?)').run('default', user.id, ['main', 'group'].includes(role) ? 'instructor' : role, Date.now());
  await db.prepare('INSERT INTO lms_workspace_verifications VALUES(?,?,?,?,?)').run('default', user.id, env.LEARNINGOPS_AUTH_GUILD_ID, discordId, Date.now());
  users[role] = login;
  if (['main', 'group'].includes(role)) {
    await db.prepare('INSERT INTO lms_mentor_scopes VALUES(?,?,?,?)').run('default', user.id, role, JSON.stringify(role === 'group' ? ['team-1'] : []));
    await db.prepare('INSERT INTO lms_staff_profiles VALUES(?,?,?,?,?,?,?)').run('default', user.id, name, 'AI 실무와 프로젝트', '학습 목표와 다음 실천을 함께 정리합니다.', JSON.stringify(['assignments', 'approval', 'mentoring']), Date.now());
    await runtime.staff.syncDiscord(discordId, env.LEARNINGOPS_AUTH_GUILD_ID);
  }
}
await put('courses', { id: 'course-1', title: '생성형 AI 실무 프로젝트', category: 'AI & PRODUCTIVITY', description: '업무 문제를 정의하고 AI를 활용한 팀 프로젝트를 진행합니다.', progress: 38, learners: 3, weeks: '8주', mentor: '이강사', theme: 'green', status: '진행 중', code: 'AX-2026', cohort: '1기', guildId: env.LEARNINGOPS_AUTH_GUILD_ID, startDate: '2026-09-14', endDate: '2026-11-06' });
const mentor = await db.prepare('SELECT id FROM mentors WHERE discord_id=?').get(users.group.user.discordId);
await put('teams', { id: 'team-1', name: '1조', code: 'TEAM-1', courseId: 'course-1', mentorId: String(mentor.id) });
await put('teams', { id: 'team-2', name: '2조', code: 'TEAM-2', courseId: 'course-1', mentorId: '' });
await db.prepare('INSERT INTO lms_group_setup VALUES(?,?)').run('default', 'course-1');
for (const [i, name] of ['최학습', '정실습', '윤탐구'].entries()) {
  const id = `student-${i + 1}`;
  await put('learners', { id, name, email: '', courseId: 'course-1', team: i < 2 ? '1조' : '2조', discordId: i === 0 ? users.student.user.discordId : `70000000000000002${i}`, status: '정상', progress: 38, color: 'sage' });
  await put('scores', { id: `score-${i}`, studentId: id, courseId: 'course-1', item: '문제 정의와 활용 계획', score: 85 + i * 3, maximum: 100 });
  await put('attendance', { id: `att-${i}`, studentId: id, courseId: 'course-1', date: today, period: 1, status: i === 1 ? '지각' : '출석', reason: '강사 확인' });
}
await db.prepare("INSERT INTO lms_attendance_rounds VALUES(?,?,1,'진행 중',1)").run('course-1', today);
await put('notices', { id: 'notice-1', title: '3주차 프로젝트 실습 안내', content: '팀별 문제 정의 문서와 AI 활용 계획을 준비해 주세요.', courseId: 'course-1', target: '전체', status: '초안' });
await put('servers', { id: 'server-1', name: '교육용 봇 환경', provider: 'Render', region: 'Seoul', status: '미연결', version: '' });
await db.prepare('INSERT INTO assignments(week,title,description,due_date,type) VALUES(?,?,?,?,?)').run(3, '팀 프로젝트 문제 정의', '해결할 문제와 AI 활용 계획을 작성하세요.', '2026-11-06', 'team');
await db.prepare('INSERT INTO assignments(week,title,description,due_date,type) VALUES(?,?,?,?,?)').run(3, '나의 AI 활용 계획', '실무에 적용할 아이디어를 정리하세요.', '2026-11-06', 'individual');
await db.prepare('INSERT INTO submissions(assignment_id,user_id,user_name,team,content) VALUES(?,?,?,?,?)').run(1, users.student.user.discordId, '최학습', '1조', '반복 보고서 작성 업무를 줄이기 위한 실습 계획입니다.');
for (const [i, status] of ['pending', 'approved', 'completed'].entries()) {
  await db.prepare('INSERT INTO slots(mentor_id,start_time,end_time,label) VALUES(?,?,?,?)').run(mentor.id, `${today}T${14 + i}:00:00`, `${today}T${14 + i}:50:00`, ['프로젝트 방향 상담', '실습 결과 점검', '다음 단계 피드백'][i]);
  await db.prepare('INSERT INTO bookings(slot_id,user_id,user_name,status) VALUES(?,?,?,?)').run(i + 1, users.student.user.discordId, '최학습 · 1조', status);
}
await db.prepare('INSERT INTO slots(mentor_id,start_time,end_time,label) VALUES(?,?,?,?)').run(mentor.id, '2027-01-04T14:00:00', '2027-01-04T14:50:00', '예약 가능 시간');
await db.prepare('INSERT INTO lms_audit(actor,action,target) VALUES(?,?,?)').run('김운영', '학습 과정 등록', '생성형 AI 실무 프로젝트');
runtime.close();
await mkdir(output, { recursive: true });
let serverLog = '';
const server = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', data => { serverLog += data; });
server.stderr.on('data', data => { serverLog += data; });
let browser;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch { /* starting */ }
    if (i > 100 || server.exitCode !== null) throw new Error(`Capture server did not start: ${serverLog}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const selected = (process.env.HELP_GUIDE_IDS || '').split(',').filter(Boolean);
  const previous = JSON.parse(await readFile(join(output, 'capture-manifest.json'), 'utf8').catch(() => '[]'));
  const checks = selected.length ? previous.filter(g => !selected.includes(g.id)) : [];
  const failures = [];
  for (const [role, login] of Object.entries(users)) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', deviceScaleFactor: 1 });
    await context.addCookies([{ name: 'learningops_session', value: login.token, url: origin + '/api', httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const guide of HELP_GUIDES.filter(g => g.role === role && (!selected.length || selected.includes(g.id)))) {
      try {
      let captureVisit = 0;
      const navigate = async () => {
        await page.goto(`${origin}/?workspace=default&capture=${guide.id}-${captureVisit++}#${guide.route}`);
        await page.locator('main h1').waitFor();
        await page.waitForLoadState('networkidle');
        await page.evaluate(() => document.fonts.ready);
        if (guide.role === 'student' && guide.route === 'assignments') await page.locator('.sa-title button').first().click();
      };
      await navigate();
      const heading = await page.locator('main h1').innerText();
      await page.screenshot({ path: join(output, `${guide.id}.jpg`), type: 'jpeg', quality: 85, animations: 'disabled' });
      const images = [];
      const steps = await captureGuideSteps(page, guide, { navigate, save: async (number, available = true) => {
        if (!available) { images.push(null); return; }
        const file = join(output, `${guide.id}-step-${number}.jpg`);
        await page.screenshot({ path: file, type: 'jpeg', quality: 85, animations: 'disabled' });
        images.push((await readFile(file)).toString('base64'));
      } });
      if (errors.length) throw new Error(`${guide.id}: ${errors.join(', ')}`);
      const pdf = await context.newPage();
      await pdf.setContent(renderGuidePdf(guide, images));
      await pdf.evaluate(() => document.fonts.ready);
      const overflow = await pdf.locator('.sheet').evaluateAll(nodes => nodes.some(n => n.scrollHeight > n.clientHeight + 2));
      if (overflow) throw new Error(`PDF page overflow: ${guide.id}`);
      await pdf.pdf({ path: join(output, `${guide.id}.pdf`), format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true });
      checks.push({ id: guide.id, role, route: guide.route, heading, steps, viewport: '1440×1000', capturedAt: guide.capturedAt });
      await pdf.close();
      console.log(`Captured ${guide.id}: ${steps.length} highlighted steps`);
      } catch (error) { failures.push({ id: guide.id, error: error.message }); console.error(`FAILED ${guide.id}: ${error.message.slice(0, 160)}`); }
    }
    await context.close();
  }
  await writeFile(join(output, 'capture-manifest.json'), JSON.stringify(checks, null, 2));
  await writeFile(resolve('../.venv/help-capture-errors.json'), JSON.stringify(failures, null, 2));
  console.log(`Captured ${checks.length} guides; ${failures.length} failures.`);
  if (failures.length) process.exitCode = 1;
} finally { await browser?.close(); server.kill(); }

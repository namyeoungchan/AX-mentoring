// Capture the running application with isolated, fictitious data and real role sessions.
// Requires `npm run build`; never connects to a production database or Discord bot.
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
  const checks = [];
  for (const [role, login] of Object.entries(users)) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', deviceScaleFactor: 1 });
    await context.addCookies([{ name: 'learningops_session', value: login.token, url: origin + '/api', httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const guide of HELP_GUIDES.filter(g => g.role === role)) {
      await page.goto(`${origin}/?workspace=default#${guide.route}`);
      await page.locator('main h1').waitFor();
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => document.fonts.ready);
      if (guide.feature === 'attendance' && role !== 'student') {
        const course = page.getByLabel('학습 과정', { exact: true });
        if (await course.count()) await course.selectOption('course-1');
        await page.locator('summary').filter({ hasText: '강의 시작·종료 코드' }).click();
      }
      if (guide.id === 'student-assignments') await page.locator('.sa-title button').first().click();
      await page.screenshot({ path: join(output, `${guide.id}.jpg`), type: 'jpeg', quality: 85, animations: 'disabled' });
      if (errors.length) throw new Error(`${guide.id}: ${errors.join(', ')}`);
      const image = (await readFile(join(output, `${guide.id}.jpg`))).toString('base64');
      const pdf = await context.newPage();
      await pdf.setContent(render(guide, image));
      await pdf.evaluate(() => document.fonts.ready);
      const overflow = await pdf.locator('.sheet').evaluateAll(nodes => nodes.some(n => n.scrollHeight > n.clientHeight + 2));
      if (overflow) throw new Error(`PDF page overflow: ${guide.id}`);
      await pdf.pdf({ path: join(output, `${guide.id}.pdf`), format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true });
      checks.push({ id: guide.id, role, route: guide.route, heading: await page.locator('main h1').innerText(), viewport: '1440×1000', capturedAt: guide.capturedAt });
      await pdf.close();
      console.log(`Captured ${guide.id}`);
    }
    await context.close();
  }
  await writeFile(join(output, 'capture-manifest.json'), JSON.stringify(checks, null, 2));
  console.log(`Created ${checks.length} protected screenshot/PDF pairs.`);
} finally { await browser?.close(); server.kill(); }

function escape(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
function render(guide, image) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escape(HELP_ROLES[guide.role])} · ${escape(guide.title)}</title><style>
  @page{size:A4 landscape;margin:0}*{box-sizing:border-box}body{margin:0;color:#1b342c;background:white;font-family:'Malgun Gothic','Noto Sans CJK KR',sans-serif}.sheet{width:297mm;height:210mm;padding:11mm 14mm;position:relative;overflow:hidden;break-after:page}.sheet:last-child{break-after:auto}.eyebrow{font-size:10pt;font-weight:700;color:#356d52;margin:0 0 2mm}h1{font-size:22pt;margin:0 0 2mm;letter-spacing:-.7px}.summary{font-size:10pt;color:#59665e;margin:0 0 4mm}.screen{display:block;height:158mm;max-width:269mm;object-fit:contain;object-position:left top;border:1px solid #d8e3dc}footer{position:absolute;bottom:6mm;left:14mm;right:14mm;display:flex;justify-content:space-between;font-size:8pt;color:#61766a}.steps{padding:0;list-style:none;margin:7mm 0 0;display:grid;grid-template-columns:1fr 1fr;gap:7mm 10mm}.step{display:flex;gap:4mm}.number{font-size:21pt;font-weight:700;color:#458367}.step h2{font-size:14pt;margin:0 0 3mm}.step p{font-size:12pt;line-height:1.8;margin:0;color:#374d42;word-break:keep-all}.note{margin-top:8mm;border-left:3px solid #438362;padding:4mm 6mm;background:#eef5ef;font-size:11pt;line-height:1.75}.path{font-size:11pt;margin-top:5mm;color:#356d52}.brand{font-size:10pt;font-weight:bold}
  </style></head><body><section class="sheet"><p class="eyebrow">${escape(HELP_ROLES[guide.role])} 전용 · ${escape(guide.category)}</p><h1>${escape(guide.title)}</h1><p class="summary">${escape(guide.summary)}</p><img class="screen" src="data:image/jpeg;base64,${image}" alt="${escape(guide.title)} 실제 화면"><footer><span>실제 LMS 화면 · 가이드용 예시 데이터 · ${guide.capturedAt}</span><span>화면 확인 01 / 02</span></footer></section><section class="sheet"><p class="eyebrow">${escape(HELP_ROLES[guide.role])} 전용 · 사용 순서</p><h1>${escape(guide.title)}</h1><p class="path">LMS 로그인 → 워크스페이스 선택 → 해당 기능 메뉴</p><ol class="steps">${guide.steps.map((s, i) => `<li class="step"><span class="number">0${i + 1}</span><div><h2>${escape(s.title)}</h2><p>${escape(s.body)}</p></div></li>`).join('')}</ol>${guide.note ? `<aside class="note">${escape(guide.note)}</aside>` : ''}<footer><span class="brand">AX 학습관리시스템 · 역할별 기능 도움말</span><span>사용 순서 02 / 02</span></footer></section></body></html>`;
}

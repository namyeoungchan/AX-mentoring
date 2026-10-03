// Select real, visible controls in the running app. Missing targets fail the build.
const click = selector => async page => { await page.locator(selector).first().click(); };
const plan = (target, prepare) => ({ target, prepare });
const nav = id => `.sidebar .nav-item:has-text("${id}")`;
const activeNav = '.sidebar .nav-item.active';
const openMentoring = click('.mentoring-views button:has-text("전체")');
const openCode = async page => { const details = page.locator('.attendance-code details'); if (await details.getAttribute('open') === null) await details.locator('summary').click(); };
const openScore = click('.operations-toolbar button:has-text("등록")');
const mentorStage = index => async page => { await page.locator('.mentor-stage-nav button').nth(index).click(); };
const courseDetails = click('.course-card');
const openAssignment = click('.assignment-expand');
const issueCode = phase => async page => {
  const date = await page.locator('.attendance-context input[type="date"]').inputValue();
  const response = await page.request.post(new URL('/api/workspaces/default/attendance/code', page.url()).href, { data: { courseId: 'course-1', date, period: 1, phase, minutes: 10, startTime: '09:00', endTime: '18:00' } });
  if (!response.ok()) throw new Error(`Fixture code failed: ${await response.text()}`);
  await page.reload(); await page.waitForLoadState('networkidle'); await openCode(page);
};

function plans(guide) {
  const { feature, role } = guide;
  if (feature.startsWith('discord-') && guide.category === 'Discord 연계') return guide.steps.map(step => step.imageAvailable === false ? null : plans({ ...guide, feature: step.capture.feature, category: '' })[step.capture.index]);
  if (role === 'student') return {
    learning: [plan('[aria-label="워크스페이스 선택"]'), plan('.student-course'), plan('.role-shortcuts')],
    participation: [plan('[aria-label="워크스페이스 선택"]'), plan('.admissions-status'), plan('.admissions-status'), plan('.admissions-status')],
    attendance: [plan('.student-attendance-date'), plan('.student-attendance-code-form'), plan('.student-attendance-code-form'), plan('.student-attendance-help')],
    assignments: [plan('.sa-filters'), plan('.sa-instructions'), plan('.sa-submit'), plan('.sa-filters button:has-text("제출 완료")')],
    scores: [plan(activeNav), plan('main table'), plan('main .panel .card-heading')],
    videos: [plan(activeNav), plan('.video-empty'), plan('.video-empty p')],
  }[feature];
  if (role !== 'admin') return {
    courses: [plan(activeNav), plan('.student-course'), plan('main table')],
    attendance: [plan('.attendance-context'), plan('.attendance-code', role === 'main' ? issueCode('in') : openCode), plan('.attendance-status-buttons'), plan(role === 'main' ? '.attendance-finalize' : '.attendance-savebar')],
    mentoring: [plan('.mentoring-toolbar', openMentoring), plan('.mentoring-session-actions:has(button:has-text("승인"))', openMentoring), plan('.mentoring-session-actions:has(button:has-text("완료"))', openMentoring), plan('.mentoring-report', async page => { await openMentoring(page); await page.locator('.mentoring-report summary').first().click(); })],
    teams: [plan('.team-controls'), plan('.team-operations table tbody tr'), plan('.team-controls button:has-text("미리보기")')],
    scores: [plan('.operations-toolbar'), plan('dialog .modal-form', openScore), plan('main table')],
    videos: [plan(activeNav), plan('.video-actions button:has-text("업로드")'), plan('.video-catalogue-body')],
    onboarding: [plan('.mentor-context'), plan('.mentor-profile-form', mentorStage(0)), plan('.mentor-server', mentorStage(1)), plan('.mentor-guide-list', mentorStage(2))],
  }[feature];
  return {
    dashboard: [plan('[aria-label="워크스페이스 선택"]'), plan('.stats-grid'), plan(nav('멘토링 일정'))],
    discord: [plan('.membership-invite .modal-form', click('.quick-steps li:nth-child(1) button')), plan('.quick-stage-content', click('.quick-steps li:nth-child(2) button')), plan('.quick-stage-content', click('.quick-steps li:nth-child(3) button'))],
    members: [plan('.membership-form .form-row'), plan('.mentor-team-picker', async page => { await page.locator('.invite-role-section select').selectOption('group'); }), plan('.membership-actions button.primary'), plan('main .panel:has(.card-heading :text-is("구성원")) table')],
    'student-accounts': [plan('.student-account-form'), plan('.student-account-form'), plan('.student-account-form button[type="submit"]'), plan('.student-account-panel table')],
    courses: [plan('.courses-grid'), plan('dialog .modal-form', click('main .page-actions .button.primary')), plan('.course-schedule-form', async page => { await courseDetails(page); await page.locator('.course-management-tabs button:has-text("일정")').click(); }), plan('.course-summary', courseDetails)],
    teams: [plan('.team-controls'), plan('dialog .modal-form', openScore), plan('.team-operations table')],
    attendance: [plan('.attendance-context'), plan('.attendance-code', issueCode('in')), plan('.attendance-code-controls', issueCode('out')), plan('.attendance-finalize')],
    scores: [plan('.operations-toolbar'), plan('dialog .modal-form', openScore), plan('main table')],
    assignments: [plan('dialog .modal-form', click('main button:has-text("과제 만들기")')), plan('.publication-preview', openAssignment), plan('main button:has-text("과제 배포")', openAssignment), plan('.assignment-delivery-history', openAssignment)],
    submissions: [plan(activeNav), plan('main table'), plan('main table tbody tr')],
    mentoring: [plan('.mentoring-toolbar', openMentoring), plan('.mentoring-session-actions:has(button:has-text("승인"))', openMentoring), plan('.mentoring-session-actions:has(button:has-text("완료"))', openMentoring), plan('.mentoring-report', async page => { await openMentoring(page); await page.locator('.mentoring-report summary').first().click(); })],
    videos: [plan(activeNav), plan('.video-actions button:has-text("업로드")'), plan('.video-catalogue-body')],
    notices: [plan('dialog .modal-form', openScore), plan('dialog', click('main button:has-text("발송 미리보기")')), plan('main .panel:has(.card-heading :text-is("Discord 공지 발송"))')],
    onboarding: [plan('.onboarding-grid .form-row'), plan('.onboarding-courses'), plan('.onboarding-grid aside')],
    connection: [plan('.shared-bot-status'), plan('.remote-status'), plan('main button:has-text("새로고침")')],
    'bot-data': [plan('main .panel:has(.card-heading :text-is("데이터 이관"))'), plan('.bot-data-grid form'), plan('.bot-data-grid .panel:has(h2:text-is("채널 · 역할 설정"))')],
    bots: [plan('.server-card'), plan('dialog .modal-form', click('main .page-actions .button.primary')), plan('main .inline-note')],
    logs: [plan('.log-console'), plan('.log-console > div'), plan(nav('학습 과정'))],
    settings: [plan('.settings-form label'), plan('.settings-form button[type="submit"]'), plan('.settings-info')],
    files: [plan('main .panel'), plan('main .panel'), plan(nav('도움말'))],
    'discord-identities': [plan(activeNav), plan('.identity-row'), plan('.identity-row button')],
  }[feature];
}

export async function captureGuideSteps(page, guide, { navigate, save }) {
  const steps = plans(guide);
  if (!steps || steps.length !== guide.steps.length) throw new Error(`${guide.id}: capture plan has ${steps?.length} steps; expected ${guide.steps.length}`);
  const result = [];
  for (const [index, item] of steps.entries()) {
    if (!item) { await save(index + 1, false); result.push({ step: index + 1, surface: 'Discord', imageAvailable: false, title: guide.steps[index].title }); continue; }
    await navigate();
    try {
      await item.prepare?.(page);
      const target = page.locator(item.target).filter({ visible: true }).first();
      await target.waitFor({ state: 'visible', timeout: 5000 });
      await target.scrollIntoViewIfNeeded();
      await target.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
      // An annotation is a browser overlay, never a change to the app's controls or labels.
      const box = await target.boundingBox();
      if (!box || box.width < 10 || box.height < 10) throw new Error('Target has no readable bounds');
      const bounds = { x: Math.max(12, box.x - 6), y: Math.max(44, box.y - 6), width: Math.min(box.width + 12, 1416 - Math.max(12, box.x - 6)), height: Math.min(box.height + 12, 930 - Math.max(44, box.y - 6)) };
      if (bounds.height < 20) throw new Error('Target is outside the viewport');
      await page.evaluate(({ bounds: b, number }) => {
        const root = document.createElement('div'); root.id = 'guide-annotation'; root.setAttribute('popover', 'manual');
        root.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0;margin:0;padding:0;background:transparent;pointer-events:none;overflow:hidden';
        const box = document.createElement('div');
        box.style.cssText = `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px;border:4px solid #b94716;border-radius:9px;box-shadow:0 0 0 9999px #10221b66;box-sizing:border-box`;
        const badge = document.createElement('span'); badge.textContent = String(number);
        badge.style.cssText = 'position:absolute;left:7px;top:-21px;background:#b94716;color:white;border:3px solid white;border-radius:50%;width:40px;height:40px;display:grid;place-items:center;font:bold 24px Arial;box-shadow:0 2px 8px #0003';
        box.append(badge); root.append(box); document.body.append(root); root.showPopover();
      }, { bounds, number: index + 1 });
      await save(index + 1);
      await page.locator('#guide-annotation').evaluate(node => node.remove());
      result.push({ step: index + 1, selector: item.target, bounds, title: guide.steps[index].title });
    } catch (error) {
      const controls = await page.locator('main, dialog').evaluateAll(nodes => nodes.map(n => ({ text: n.innerText.slice(0, 6500), classes: [...new Set([...n.querySelectorAll('[class]')].map(e => e.className).filter(x => typeof x === 'string'))] })));
      throw new Error(`${guide.id} step ${index + 1}: ${error.message}\n${JSON.stringify(controls)}`);
    }
  }
  return result;
}

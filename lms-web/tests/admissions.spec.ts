import { test, expect, type Page } from '@playwright/test'

test('workspace administrator invites an instructor; student signs up, instructor approves and Discord invite precedes verification', async ({ page, request, browser }) => {
  test.setTimeout(90000)
  const platform = await (await request.post('/api/login', { data: { password: 'test-only-password-1234' } })).json()
  const platformHeaders = { Authorization: `Bearer ${platform.token}` }
  const botHeaders = { Authorization: 'Bearer test-only-auth-token-12345678901234567890' }
  const workerHeaders = { Authorization: 'Bearer test-only-provision-token-12345678901234567890' }
  const guildId = '488456789012345678'
  const workspace = await (await request.post('/api/workspaces', { headers: platformHeaders, data: { name: '승인 프로세스 AX', guildId } })).json()
  const members = [
    { username: 'admission.owner', name: '워크스페이스 운영자', password: 'test-owner-password-1234', discordId: '488456789012345670' },
    { username: 'admission.teacher', name: '승인 강사', password: 'test-teacher-password-1234', discordId: '488456789012345671' },
  ]
  for (const member of members) {
    const response = await request.post('/api/auth/register', { data: member }); expect(response.status()).toBe(201)
    const { code } = await response.json()
    expect((await request.post('/api/integrations/discord/verify', { headers: botHeaders, data: { code, discordId: member.discordId, guildId: '123456789012345678' } })).status()).toBe(200)
  }
  const ownerInvite = await (await request.post(`/api/workspaces/${workspace.id}/invitations`, { headers: platformHeaders, data: { username: members[0].username, role: 'admin' } })).json()
  async function accept(target: Page, url: string, member: typeof members[number]) {
    await target.goto(url)
    await target.getByLabel('아이디', { exact: true }).fill(member.username)
    await target.getByLabel('비밀번호', { exact: true }).fill(member.password)
    await target.locator('form').getByRole('button', { name: '로그인', exact: true }).click()
    await target.getByRole('button', { name: '초대 수락', exact: true }).click()
  }
  await accept(page, `/#invite=${ownerInvite.token}`, members[0])
  await expect(page.getByRole('heading', { name: '운영 대시보드' })).toBeVisible()
  await page.getByRole('button', { name: '워크스페이스 선택', exact: true }).click()
  await expect(page.getByRole('button', { name: '새 워크스페이스', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '워크스페이스 목록 닫기' }).click()
  expect((await page.request.post('/api/workspaces', { data: { name: '무단 생성' } })).status()).toBe(403)
  expect((await page.request.get('/api/workspaces/default/workspace')).status()).toBe(403)
  await page.getByRole('navigation').getByRole('button', { name: '구성원 · 초대' }).click()
  await page.getByLabel('초대할 아이디').fill(members[1].username)
  await page.getByLabel('참여 권한').selectOption('instructor')
  await page.getByRole('button', { name: '초대 링크 만들기' }).click()
  const teacherLink = await page.getByLabel('초대 링크', { exact: true }).inputValue()
  expect((await page.request.post(`/api/workspaces/${workspace.id}/invitations`, { data: { username: 'escalated.owner', role: 'admin' } })).status()).toBe(403)
  const teacherContext = await browser.newContext(), studentContext = await browser.newContext()
  try {
    const teacher = await teacherContext.newPage(), student = await studentContext.newPage()
    await accept(teacher, teacherLink, members[1])
    await expect(teacher.getByRole('heading', { name: '강사 수업 관리' })).toBeVisible()
    for (const route of ['workspace', 'members', 'discord/provision']) expect((await teacher.request.get(`http://127.0.0.1:5174/api/workspaces/${workspace.id}/${route}`)).status()).toBe(403)
    const teaching = await (await teacher.request.get(`http://127.0.0.1:5174/api/workspaces/${workspace.id}/teaching`)).json()
    expect(teaching.servers).toEqual([])
    expect((await teacher.request.patch(`http://127.0.0.1:5174/api/workspaces/${workspace.id}/teaching`, { data: { revision: teaching.revision, changes: [{ kind: 'settings', value: { name: '권한 우회' } }] } })).status()).toBe(403)
    await student.goto('http://127.0.0.1:5174/')
    await student.getByRole('button', { name: '회원가입', exact: true }).click()
    await student.getByLabel('가입할 워크스페이스').selectOption(workspace.id)
    await student.getByLabel('이름', { exact: true }).fill('승인 대기 학생')
    await student.getByLabel('아이디', { exact: true }).fill('admission.learner')
    await student.getByLabel('비밀번호', { exact: true }).fill('test-learner-password-1234')
    await student.getByLabel('비밀번호 확인', { exact: true }).fill('test-learner-password-1234')
    await student.getByRole('button', { name: '가입 및 승인 요청' }).click()
    await expect(student.getByText('승인 대기', { exact: true })).toBeVisible()
    expect((await student.request.get(`http://127.0.0.1:5174/api/workspaces/${workspace.id}/me/learning`)).status()).toBe(403)
    await expect(student.getByRole('link', { name: 'Discord 서버 참여' })).toHaveCount(0)
    await student.reload()
    await expect(student.getByText('승인 대기', { exact: true })).toBeVisible()
    await teacher.getByRole('button', { name: '가입 승인', exact: true }).click()
    await expect(teacher.getByRole('heading', { name: '승인 대기 학생 · admission.learner' })).toBeVisible()
    await teacher.locator('form').getByRole('button', { name: '가입 승인', exact: true }).click()
    await expect(teacher.getByText('승인 완료', { exact: true })).toBeVisible()
    const poll = await request.post('/api/integrations/discord/admissions/poll', { headers: workerHeaders, data: { guildIds: [guildId] } })
    const { job } = await poll.json(); expect(job.guildId).toBe(guildId)
    expect((await request.post('/api/integrations/discord/admissions/complete', { headers: workerHeaders, data: { id: job.id, claim: job.claim, success: true, code: 'test-private-guild-invite' } })).status()).toBe(200)
    await student.getByRole('button', { name: '승인 상태 확인' }).click()
    await expect(student.getByRole('link', { name: 'Discord 서버 참여' })).toHaveAttribute('href', 'https://discord.gg/test-private-guild-invite')
    await student.getByRole('button', { name: 'Discord 인증 코드 받기' }).click()
    const code = await student.getByLabel('인증 코드', { exact: true }).textContent()
    expect((await request.post('/api/integrations/discord/verify', { headers: botHeaders, data: { code, discordId: '488456789012345672', guildId: '123456789012345678' } })).status()).toBe(403)
    expect((await request.post('/api/integrations/discord/verify', { headers: botHeaders, data: { code, discordId: '488456789012345672', guildId } })).status()).toBe(200)
    await student.getByRole('button', { name: '인증 후 학습 화면 열기' }).click()
    await expect(student.getByRole('button', { name: '워크스페이스 선택', exact: true })).toContainText('승인 프로세스 AX')
    await expect(student.getByText('Discord 인증 완료', { exact: true })).toBeVisible()
    expect((await student.request.get(`http://127.0.0.1:5174/api/workspaces/${workspace.id}/teaching`)).status()).toBe(403)
    const current = await (await request.get(`/api/workspaces/${workspace.id}/workspace`, { headers: platformHeaders })).json()
    const course = { id: 'approved-course', title: '승인 후 수업', category: 'AX', description: '출결 성적 연결', progress: 0, learners: 0, weeks: '8주', mentor: '', theme: 'green', status: '모집 중', code: 'APPROVED', cohort: '1', guildId: '', startDate: '2026-09-01', endDate: '2026-12-01' }
    const learner = { id: 'approved-learner', name: '승인 대기 학생', email: 'approved@example.com', discordId: '488456789012345672', courseId: course.id, team: '', status: '정상', progress: 0, color: 'sage' }
    expect((await request.patch(`/api/workspaces/${workspace.id}/workspace`, { headers: platformHeaders, data: { revision: current.revision, changes: [{ kind: 'courses', value: course }, { kind: 'learners', value: learner }] } })).status()).toBe(200)
    await teacher.getByRole('button', { name: '새로고침', exact: true }).click()
    await teacher.getByRole('button', { name: '성적 관리', exact: true }).click()
    await teacher.getByRole('button', { name: '성적 등록' }).click()
    const gradeDialog = teacher.getByRole('dialog')
    await gradeDialog.getByLabel('수강생', { exact: true }).selectOption(learner.id)
    await gradeDialog.getByLabel('평가항목').fill('승인 과정 평가')
    await gradeDialog.getByLabel('점수', { exact: true }).fill('85')
    await gradeDialog.getByRole('button', { name: '저장', exact: true }).click()
    await expect(gradeDialog).not.toBeVisible()
    await student.getByRole('button', { name: '새로고침', exact: true }).click()
    await expect(student.getByRole('cell', { name: '승인 과정 평가' })).toBeVisible()
    await expect(student.getByRole('cell', { name: '85', exact: true })).toBeVisible()
    for (const target of [teacher, student]) {
      await target.setViewportSize({ width: 390, height: 844 })
      expect(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    await teacher.screenshot({ path: 'test-results/instructor-admissions-mobile.png', fullPage: true })
    await student.screenshot({ path: 'test-results/student-admissions-mobile.png', fullPage: true })
  } finally { await teacherContext.close(); await studentContext.close() }
})

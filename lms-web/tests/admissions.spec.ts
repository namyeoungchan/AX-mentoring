import { test, expect, type Page } from '@playwright/test'
test('a shared classroom IP is not blocked after 120 login requests', async ({ request }) => {
  for (let batch = 0; batch < 15; batch++) {
    const responses = await Promise.all(Array.from({length:10}, () => request.post('/api/auth/login', {data:{}})));
    for (const response of responses) expect(response.status()).toBe(422);
  }
})

test('workspace administrator invites an instructor; student signs up, administrator approves and Discord invite precedes verification', async ({ page, request, browser }) => {
  test.setTimeout(90000)
  const platform = await (await request.post('/api/login', { data: { password: 'test-only-password-1234' } })).json()
  const platformHeaders = { Authorization: `Bearer ${platform.token}` }
  const botHeaders = { Authorization: 'Bearer test-only-auth-token-12345678901234567890' }
  const workerHeaders = { Authorization: 'Bearer test-only-provision-token-12345678901234567890' }
  const guildId = '488456789012345678'
  const workspace = await (await request.post('/api/workspaces', { headers: platformHeaders, data: { name: '승인 프로세스 AX', guildId } })).json()
  const initial = await (await request.get(`/api/workspaces/${workspace.id}/workspace`, { headers: platformHeaders })).json()
  const groupResponse = await request.post(`/api/workspaces/${workspace.id}/discord/groups`, { headers: platformHeaders, data: { count: 2, title: '승인 후 수업', revision: initial.revision } })
  expect(groupResponse.status()).toBe(200)
  const groups = await groupResponse.json()
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
  await page.getByRole('radio', { name: /\uAE30\uC874 \uACC4\uC815 \uCD08\uB300/ }).check()
  await page.getByLabel('초대할 아이디').fill(members[1].username)
  await page.getByRole('button', { name: '초대 링크 만들기' }).click()
  const teacherLink = await page.getByLabel('초대 링크', { exact: true }).inputValue()
  expect((await page.request.post(`/api/workspaces/${workspace.id}/invitations`, { data: { username: 'escalated.owner', role: 'admin' } })).status()).toBe(403)
  const teacherContext = await browser.newContext(), studentContext = await browser.newContext()
  try {
    const teacher = await teacherContext.newPage(), student = await studentContext.newPage()
    await accept(teacher, teacherLink, members[1])
    await expect(teacher.getByRole('heading', { name: '멘토 활동 관리' })).toBeVisible()
    for (const route of ['workspace', 'members', 'discord/provision']) expect((await teacher.request.get(`http://127.0.0.1:5174/api/workspaces/${workspace.id}/${route}`)).status()).toBe(403)
    const teaching = await (await teacher.request.get(`http://127.0.0.1:5174/api/workspaces/${workspace.id}/teaching`)).json()
    expect(teaching.servers).toEqual([])
    expect((await teacher.request.patch(`http://127.0.0.1:5174/api/workspaces/${workspace.id}/teaching`, { data: { revision: teaching.revision, changes: [{ kind: 'settings', value: { name: '권한 우회' } }] } })).status()).toBe(403)
    await student.goto('http://127.0.0.1:5174/')
    await student.getByRole('button', { name: '회원가입', exact: true }).click()
    await student.getByLabel('가입할 워크스페이스').selectOption(workspace.id)
    await student.getByLabel('이름', { exact: true }).fill('승인 대기 학생')
    await student.getByLabel('아이디', { exact: true }).fill('admission.learner')
    await student.getByLabel('비밀번호', { exact: true }).fill('Test1234')
    await student.getByLabel('비밀번호 확인', { exact: true }).fill('Test1234')
    await student.getByRole('button', { name: '가입 및 승인 요청' }).click()
    await expect(student.getByText('승인 대기', { exact: true })).toBeVisible()
    expect((await student.request.get(`http://127.0.0.1:5174/api/workspaces/${workspace.id}/me/learning`)).status()).toBe(403)
    await expect(student.getByRole('link', { name: 'Discord 서버 참여' })).toHaveCount(0)
    await student.reload()
    await expect(student.getByText('승인 대기', { exact: true })).toBeVisible()
    const pendingApplications = await (await page.request.get('/api/workspaces/' + workspace.id + '/admissions')).json()
    const pendingApplication = pendingApplications.applications.find((a: { username: string }) => a.username === 'admission.learner')
    expect((await page.request.post('/api/workspaces/' + workspace.id + '/admissions/' + pendingApplication.id + '/review', { data: { action: 'approve', guildId, teamId: groups.teams[0].id } })).status()).toBe(200)
    const pendingRoster = await (await request.get(`/api/workspaces/${workspace.id}/workspace`, { headers: platformHeaders })).json()
    expect(pendingRoster.learners).toHaveLength(1)
    expect(pendingRoster.learners[0].status).toBe('대기')
    expect(pendingRoster.learners[0].team).toBe('1조')
    await student.getByRole('button', { name: '참여 상태 확인' }).click()
    await student.getByRole('button', { name: 'Discord 인증 코드 받기' }).click()
    const verification = student.getByRole('region', { name: 'Discord 계정 인증', exact: true })
    await expect(verification.getByRole('status', { name: '서버 초대 상태', exact: true })).toContainText('서버 초대 링크를 발급하고 있습니다.')
    await expect(verification.getByRole('link')).toHaveCount(0)
    const poll = await request.post('/api/integrations/discord/admissions/poll', { headers: workerHeaders, data: { guildIds: [guildId] } })
    let { job } = await poll.json(); expect(job.guildId).toBe(guildId)
    const applicationId = (await (await student.request.get('/api/me/admissions')).json()).applications.find((a: { workspaceId: string }) => a.workspaceId === workspace.id).id
    // Staff invitations are now queued automatically when their onboarding opens.
    for (let count = 0; job.id !== applicationId && count < 3; count++) {
      expect((await request.post('/api/integrations/discord/admissions/complete', { headers: workerHeaders, data: { id: job.id, claim: job.claim, success: true, code: 'test-staff-invite' } })).status()).toBe(200)
      job = (await (await request.post('/api/integrations/discord/admissions/poll', { headers: workerHeaders, data: { guildIds: [guildId] } })).json()).job
    }
    expect(job.id).toBe(applicationId)
    expect((await request.post('/api/integrations/discord/admissions/complete', { headers: workerHeaders, data: { id: job.id, claim: job.claim, success: false, code: null } })).status()).toBe(200)
    await student.getByRole('button', { name: '참여 상태 확인' }).click()
    await expect(verification.getByRole('button', { name: '초대 링크 재발급' })).toBeVisible()
    await verification.getByRole('button', { name: '초대 링크 재발급' }).click()
    await expect(verification.getByRole('status', { name: '서버 초대 상태', exact: true })).toContainText('서버 초대 링크를 발급하고 있습니다.')
    const retried = await request.post('/api/integrations/discord/admissions/poll', { headers: workerHeaders, data: { guildIds: [guildId] } })
    job = (await retried.json()).job
    expect((await request.post('/api/integrations/discord/admissions/complete', { headers: workerHeaders, data: { id: job.id, claim: job.claim, success: true, code: 'test-private-guild-invite' } })).status()).toBe(200)
    await student.getByRole('button', { name: '참여 상태 확인' }).click()
    await expect(student.getByRole('link', { name: /Discord 서버 참여/ })).toHaveCount(1)
    await expect(verification.getByRole('link', { name: '1 · Discord 서버 참여', exact: true })).toHaveAttribute('href', 'https://discord.gg/test-private-guild-invite')
    await expect(verification).toContainText('승인 프로세스 AX')
    await expect(verification.getByRole('status', { name: '서버 초대 상태', exact: true })).toHaveCount(0)
    const code = await student.getByLabel('인증 코드', { exact: true }).textContent()
    await expect(verification).toContainText('Discord 인증 패널에 코드를 입력하세요')
    await expect(verification).toContainText('1 · LMS 인증')
    await expect(verification.getByRole('button', { name: 'Discord 인증 코드 받기', exact: true })).toHaveCount(0)
    await student.context().grantPermissions(['clipboard-read','clipboard-write'])
    await student.bringToFront()
    await verification.getByRole('button', { name: '인증 코드 복사' }).click()
    await expect(verification.getByRole('button', { name: '복사됨', exact: true })).toBeVisible()
    expect(await student.evaluate(() => navigator.clipboard.readText())).toBe(code)
    const own = await (await student.request.get('/api/me/admissions')).json()
    const repeated = await student.request.post(`/api/me/admissions/${own.applications.find((a: {workspaceId:string}) => a.workspaceId === workspace.id).id}/verification`, {data:{}})
    expect(repeated.status()).toBe(200)
    expect((await repeated.json()).code).toBe(code)
    await student.setViewportSize({width:390,height:1000})
    expect(await student.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await student.screenshot({path:'test-results/student-discord-guide-390.png',fullPage:true,animations:'disabled'})
    await student.setViewportSize({width:1440,height:1000})

    expect((await request.post('/api/integrations/discord/verify', { headers: botHeaders, data: { code, discordId: '488456789012345672', guildId: '123456789012345678' } })).status()).toBe(403)
    expect((await request.post('/api/integrations/discord/verify', { headers: botHeaders, data: { code, discordId: '488456789012345672', guildId } })).status()).toBe(200)
    await student.getByRole('button', { name: '인증 후 학습 화면 열기' }).click()
    await expect(student.getByRole('button', { name: '워크스페이스 선택', exact: true })).toContainText('승인 프로세스 AX')
    await student.getByLabel('계정 메뉴', { exact: true }).click()
    await expect(student.getByText('Discord 인증 완료', { exact: true })).toBeVisible()
    await student.getByLabel('계정 메뉴', { exact: true }).click()
    expect((await student.request.get(`http://127.0.0.1:5174/api/workspaces/${workspace.id}/teaching`)).status()).toBe(403)
    const current = await (await request.get(`/api/workspaces/${workspace.id}/workspace`, { headers: platformHeaders })).json()
    expect(current.learners).toHaveLength(1)
    const learner = current.learners[0]
    expect(learner.id).toBe(pendingRoster.learners[0].id)
    expect(learner.discordId).toBe('488456789012345672')
    expect(learner.status).toBe('정상')
    await teacher.getByLabel('계정 메뉴', { exact: true }).click()
    await teacher.getByRole('button', { name: '새로고침', exact: true }).click()
    await teacher.getByRole('button', { name: '성적 관리', exact: true }).click()
    await teacher.getByRole('button', { name: '성적 등록' }).click()
    const gradeDialog = teacher.getByRole('dialog')
    await gradeDialog.getByLabel('수강생', { exact: true }).selectOption(learner.id)
    await gradeDialog.getByLabel('평가항목').fill('승인 과정 평가')
    await gradeDialog.getByLabel('점수', { exact: true }).fill('85')
    await gradeDialog.getByRole('button', { name: '저장', exact: true }).click()
    await expect(gradeDialog).not.toBeVisible()
    await student.getByLabel('계정 메뉴', { exact: true }).click()
    await student.getByRole('button', { name: '새로고침', exact: true }).click()
    await student.getByRole('navigation').getByRole('button', { name: '나의 성적', exact: true }).click()
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

import { test, expect } from '@playwright/test'

test('workspace onboarding saves course-driven teams, worker configuration and visible failure status', async ({ page, request }) => {
  const account = await (await request.post('/api/login', { data: { password: 'test-only-password-1234' } })).json()
  const headers = { Authorization: `Bearer ${account.token}` }
  const guildId = '633456789012345678'
  const workspace = await (await request.post('/api/workspaces', { headers, data: { name: '온보딩 운영', guildId } })).json()
  const course = { id: 'onboard-course', title: '온보딩 과정', category: 'AX', description: '', progress: 0, learners: 0, weeks: '4주', mentor: '', theme: 'green', status: '진행 중', code: 'ONBOARD', cohort: '1기', guildId, startDate: '2026-09-01', endDate: '2026-12-01' }
  const data = await (await request.get(`/api/workspaces/${workspace.id}/workspace`, { headers })).json()
  expect((await request.patch(`/api/workspaces/${workspace.id}/workspace`, { headers, data: { revision: data.revision, changes: [{ kind: 'courses', value: course }, { kind: 'teams', value: { id: 'team-alpha', name: '알파팀', code: 'ALPHA', courseId: course.id, mentorId: '' } }] } })).status()).toBe(200)
  await page.goto(`/?workspace=${workspace.id}#onboarding`)
  await page.getByRole('button', { name: '관리자 로그인', exact: true }).click()
  await page.getByLabel('관리자 비밀번호').fill('test-only-password-1234')
  await page.getByRole('button', { name: '로그인', exact: true }).click()
  await expect(page.getByRole('heading', { name: '온보딩 · 팀 연동', exact: true })).toBeVisible()
  await page.getByLabel('서버 참여 시 자동 온보딩', { exact: true }).check()
  await page.getByLabel('온보딩 과정', { exact: true }).check()
  await page.getByLabel('시작 안내 고정글', { exact: true }).fill('가입 승인과 Discord 인증을 확인하고 자기소개를 작성하세요.')
  await page.getByRole('button', { name: '온보딩 저장 및 적용' }).click()
  await expect(page.getByRole('status')).toContainText('저장했습니다.')
  await expect(page.getByRole('heading', { name: '팀 배정 · 1개 팀' })).toBeVisible()
  const botHeaders = { Authorization: 'Bearer test-only-provision-token-12345678901234567890' }
  expect((await request.post('/api/integrations/discord/onboarding/poll', { data: { guildIds: [guildId] } })).status()).toBe(401)
  const poll = await (await request.post('/api/integrations/discord/onboarding/poll', { headers: botHeaders, data: { guildIds: [guildId] } })).json()
  expect(poll.configs[0].teams.map((t: { name: string }) => t.name)).toEqual(['알파팀'])
  expect(poll.configs[0].enabled).toBe(true)
  expect((await request.post('/api/integrations/discord/onboarding/report', { headers: botHeaders, data: { guildId, revision: poll.configs[0].revision, state: 'failed', error: 'permissions' } })).status()).toBe(200)
  await page.getByRole('main').getByRole('button', { name: '새로고침', exact: true }).last().click()
  await expect(page.getByText('봇의 채널 관리·역할 관리·메시지 고정·채널 보기·메시지 보내기·기록 보기·링크 삽입 권한을 확인하세요.', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('온보딩 과정', { exact: true })).toBeChecked()
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    await page.screenshot({ path: `test-results/onboarding-${width}.png`, fullPage: true, animations: 'disabled' })
  }
})

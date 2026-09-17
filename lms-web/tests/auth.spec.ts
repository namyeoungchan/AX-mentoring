import { test, expect } from '@playwright/test'

const discordId = '855456789012345678'
const guildId = '123456789012345678'
const secret = 'test-only-auth-token-12345678901234567890'

test('staff joins LMS first, completes mentor onboarding and keeps workspace role isolation', async ({ page, request }) => {
  const platform = await (await request.post('/api/login', { data: { password: 'test-only-password-1234' } })).json()
  const guildId = '823456789012345678'
  const workspace = await (await request.post('/api/workspaces', { headers: { Authorization: `Bearer ${platform.token}` }, data: { name: '초대 대상 서버', guildId } })).json()
  const headersAdmin = { Authorization: `Bearer ${platform.token}` }
  const groups = await (await request.get(`/api/workspaces/${workspace.id}/discord/groups`, { headers: headersAdmin })).json()
  expect((await request.post(`/api/workspaces/${workspace.id}/discord/groups`, { headers: headersAdmin, data: { count: 2, title: '멘토 교육', revision: groups.revision } })).status()).toBe(200)
  const invitation = await (await request.post(`/api/workspaces/${workspace.id}/invitations`, { headers: { Authorization: `Bearer ${platform.token}` }, data: { username: 'verified.student', role: 'instructor' } })).json()
  await page.goto(`/#invite=${invitation.token}`)
  await page.getByRole('button', { name: '회원가입', exact: true }).click()
  await expect(page.getByLabel('Discord 사용자 ID', { exact: true })).toHaveCount(0)
  await page.getByLabel('이름', { exact: true }).fill('인증 수강생')
  await page.getByLabel('아이디', { exact: true }).fill('verified.student')
  await page.getByLabel('비밀번호', { exact: true }).fill('student-test-password-1234')
  await page.getByLabel('비밀번호 확인', { exact: true }).fill('different-password-1234')
  await page.getByRole('button', { name: '계정 만들기' }).click()
  await expect(page.getByRole('alert')).toContainText('비밀번호가 일치하지 않습니다.')
  await page.getByLabel('비밀번호 확인', { exact: true }).fill('student-test-password-1234')
  await page.getByRole('button', { name: '계정 만들기' }).click()
  await page.getByRole('button', { name: '초대 수락', exact: true }).click()
  await expect(page.getByRole('heading', { name: '멘토 활동 관리', exact: true })).toBeVisible()
  await page.getByLabel('전문 분야').fill('AI 활용')
  await expect(page.getByLabel('자기소개', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '기본 정보 저장' }).click()
  await expect(page.getByText('봇이 초대 링크를 발급하고 있습니다. 잠시 기다려 주세요.')).toBeVisible()
  const botHeaders = { Authorization: 'Bearer test-only-provision-token-12345678901234567890' }
  const { job } = await (await request.post('/api/integrations/discord/admissions/poll', { headers: botHeaders, data: { guildIds: [guildId] } })).json()
  expect(job.guildId).toBe(guildId)
  expect((await request.post('/api/integrations/discord/admissions/complete', { headers: botHeaders, data: { id: job.id, claim: job.claim, success: true, code: 'MentorInvite' } })).status()).toBe(200)
  await page.reload()
  await expect(page.getByRole('link', { name: 'Discord 서버 참여' })).toHaveAttribute('href', 'https://discord.gg/MentorInvite')
  const challenge = await (await page.request.post(`/api/workspaces/${workspace.id}/staff/verification`, { data: {} })).json()
  const code = challenge.code
  expect((await request.post('/api/integrations/discord/verify', { data: { code, discordId, guildId } })).status()).toBe(401)
  const headers = { Authorization: `Bearer ${secret}` }
  expect((await request.post('/api/integrations/discord/verify', { headers, data: { code, discordId, guildId: '955456789012345678' } })).status()).toBe(403)
  expect((await request.post('/api/integrations/discord/verify', { headers, data: { code, discordId, guildId } })).status()).toBe(200)
  expect((await request.post('/api/integrations/discord/verify', { headers, data: { code, discordId, guildId } })).status()).toBe(410)
  await page.reload()
  await expect(page.getByText('Discord 인증 완료', { exact: true })).toBeVisible()
  for (const title of ['1. 과제 생성', '2. 멘토링 예약 승인', '3. 멘토링 진행']) {
    const guide = page.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
    await guide.getByRole('button', { name: '안내 확인했어요', exact: true }).click()
    await expect(guide.getByRole('button', { name: '확인 완료', exact: true })).toBeVisible()
  }
  await page.getByLabel('과제 제목').fill('멘토 첫 과제')
  await page.getByLabel('마감일', { exact: true }).fill('2026-10-01')
  await page.getByRole('button', { name: '과제 생성', exact: true }).click()
  await expect(page.getByText('과제를 생성했습니다.', { exact: true })).toBeVisible()
  const teaching = await (await page.request.get(`/api/workspaces/${workspace.id}/teaching`)).json()
  expect(teaching.assignments.map((a: { title: string }) => a.title)).toContain('멘토 첫 과제')
  await expect(page.getByText('멘토 온보딩을 완료했습니다. 담당 조에서 활동을 시작하세요.')).toBeVisible()
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    await page.screenshot({ path: `test-results/mentor-onboarding-${width}.png`, fullPage: true })
  }
  await page.reload()
  await expect(page.getByRole('heading', { name: '멘토 활동 관리', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '수업 현황', exact: true })).toHaveClass('selected')
  await expect(page.getByRole('heading', { name: '멘토 온보딩', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '멘토 온보딩', exact: true }).click()
  await expect(page.getByText('멘토 온보딩을 완료했습니다. 담당 조에서 활동을 시작하세요.')).toBeVisible()
  await expect(page.getByRole('button', { name: '새 과정 만들기' })).toHaveCount(0)
  for (const path of ['/api/workspace', '/api/audit', '/api/integrations/render', '/api/discord/provision']) expect((await page.request.get(path)).status()).toBe(403)
  expect((await page.request.post('/api/discord/provision/plans', { data: {} })).status()).toBe(403)
  expect((await page.request.patch('/api/workspace', { data: {} })).status()).toBe(403)
  const membership = await (await page.request.get('/api/workspaces')).json()
  expect(membership.workspaces.map((w: { id: string }) => w.id)).toEqual([workspace.id])
  expect((await page.request.get('/api/workspaces/default/me/learning')).status()).toBe(403)
  expect((await page.request.get(`/api/workspaces/${workspace.id}/me/learning`)).status()).toBe(403)
  for (const path of ['workspace', 'audit', 'integrations/render', 'discord/provision', 'discord/onboarding', 'bot-data', 'bot-data/table/peer_evaluations']) expect((await page.request.get(`/api/workspaces/${workspace.id}/${path}`)).status()).toBe(403)
  expect((await page.request.post('/api/workspaces', { data: { name: '권한 없는 생성' } })).status()).toBe(403)
  const own = await (await page.request.get('/api/auth/me')).json()
  expect(own.user.role).toBe('student')
  expect(own.user.password_hash).toBeUndefined()
  await page.getByRole('button', { name: '로그아웃' }).click()
  await expect(page.getByRole('heading', { name: 'LMS 로그인', exact: true })).toBeVisible()
  expect((await page.request.get('/api/auth/me')).status()).toBe(401)
})

test('login and signup layouts fit desktop and mobile', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  for (const mode of ['로그인', '회원가입']) {
    await page.locator('.auth-tabs').getByRole('button', { name: mode, exact: true }).click()
    for (const width of [1440, 390, 360]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
      await page.screenshot({ path: `test-results/auth-${mode}-${width}.png`, fullPage: true, animations: 'disabled' })
    }
  }
  expect(errors).toEqual([])
})

test('student login also works across origins without storing a session token in the browser', async ({ page, request, context }) => {
  const input = { name: '외부 수강생', username: 'external.student', password: 'external-password-1234', discordId: '955456789012345678' }
  const registration = await request.post('/api/auth/register', { data: input })
  expect(registration.status()).toBe(201)
  const { code } = await registration.json()
  expect((await request.post('/api/integrations/discord/verify', { headers: { Authorization: `Bearer ${secret}` }, data: { code, discordId: input.discordId, guildId } })).status()).toBe(200)
  await page.goto('http://127.0.0.1:5176/')
  await page.getByLabel('아이디', { exact: true }).fill(input.username)
  await page.getByLabel('비밀번호', { exact: true }).fill(input.password)
  await page.locator('form').getByRole('button', { name: '로그인', exact: true }).click()
  await expect(page.getByRole('heading', { name: '나의 학습', exact: true })).toBeVisible()
  expect(await context.cookies()).toEqual([])
  expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }))).toEqual({ local: [], session: [] })
  await page.reload()
  await expect(page.getByRole('heading', { name: 'LMS 로그인', exact: true })).toBeVisible()
})

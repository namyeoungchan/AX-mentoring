import { test, expect } from '@playwright/test'

const discordId = '855456789012345678'
const guildId = '123456789012345678'
const secret = 'test-only-auth-token-12345678901234567890'

test('staff signup, Discord identity proof, instructor invitation and API role isolation', async ({ page, request }) => {
  const platform = await (await request.post('/api/login', { data: { password: 'test-only-password-1234' } })).json()
  const invitation = await (await request.post('/api/workspaces/asan-ax/invitations', { headers: { Authorization: `Bearer ${platform.token}` }, data: { username: 'verified.student', role: 'instructor' } })).json()
  await page.goto(`/#invite=${invitation.token}`)
  await page.getByRole('button', { name: '회원가입', exact: true }).click()
  await page.getByLabel('이름', { exact: true }).fill('인증 수강생')
  await page.getByLabel('아이디', { exact: true }).fill('verified.student')
  await page.getByLabel('Discord 사용자 ID', { exact: true }).fill(discordId)
  await page.getByLabel('비밀번호', { exact: true }).fill('student-test-password-1234')
  await page.getByLabel('비밀번호 확인', { exact: true }).fill('different-password-1234')
  await page.getByRole('button', { name: '인증 코드 받기' }).click()
  await expect(page.getByRole('alert')).toContainText('비밀번호가 일치하지 않습니다.')
  await page.getByLabel('비밀번호 확인', { exact: true }).fill('student-test-password-1234')
  await page.getByRole('button', { name: '인증 코드 받기' }).click()
  await expect(page.getByRole('heading', { name: 'Discord 계정 인증', exact: true })).toBeVisible()
  const code = (await page.getByLabel('인증 코드', { exact: true }).textContent())!
  expect((await request.post('/api/auth/login', { data: { username: 'verified.student', password: 'student-test-password-1234' } })).status()).toBe(401)
  expect((await request.post('/api/integrations/discord/verify', { data: { code, discordId, guildId } })).status()).toBe(401)
  const headers = { Authorization: `Bearer ${secret}` }
  expect((await request.post('/api/integrations/discord/verify', { headers, data: { code, discordId: '955456789012345678', guildId } })).status()).toBe(403)
  expect((await request.post('/api/integrations/discord/verify', { headers, data: { code, discordId, guildId } })).status()).toBe(200)
  expect((await request.post('/api/integrations/discord/verify', { headers, data: { code, discordId, guildId } })).status()).toBe(410)
  await page.getByRole('button', { name: '인증 상태 확인', exact: true }).click()
  await expect(page.getByRole('heading', { name: '가입 인증 완료' })).toBeVisible()
  await page.getByRole('button', { name: '로그인으로 이동' }).click()
  await page.getByLabel('아이디', { exact: true }).fill('verified.student')
  await page.getByLabel('비밀번호', { exact: true }).fill('student-test-password-1234')
  await page.locator('form').getByRole('button', { name: '로그인', exact: true }).click()
  await page.getByRole('button', { name: '초대 수락', exact: true }).click()
  await expect(page.getByRole('heading', { name: '강사 수업 관리', exact: true })).toBeVisible()
  await expect(page.getByText('등록된 수업이 없습니다.')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: '강사 수업 관리', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '새 과정 만들기' })).toHaveCount(0)
  for (const path of ['/api/workspace', '/api/audit', '/api/integrations/render', '/api/discord/provision']) expect((await page.request.get(path)).status()).toBe(403)
  expect((await page.request.post('/api/discord/provision/plans', { data: {} })).status()).toBe(403)
  expect((await page.request.patch('/api/workspace', { data: {} })).status()).toBe(403)
  const membership = await (await page.request.get('/api/workspaces')).json()
  expect(membership.workspaces.map((w: { id: string }) => w.id)).toEqual(['asan-ax'])
  expect((await page.request.get('/api/workspaces/default/me/learning')).status()).toBe(403)
  expect((await page.request.get('/api/workspaces/asan-ax/me/learning')).status()).toBe(403)
  for (const path of ['workspace', 'audit', 'integrations/render', 'discord/provision']) expect((await page.request.get(`/api/workspaces/asan-ax/${path}`)).status()).toBe(403)
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

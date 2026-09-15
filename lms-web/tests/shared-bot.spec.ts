import { test, expect } from '@playwright/test'

test('one Render bot is visible across workspaces while guild status and operational data stay isolated', async ({ page, request }) => {
  const headers = { Authorization: 'Bearer test-only-provision-token-12345678901234567890' }
  const bot = { id: '999456789012345678', name: '하나의 Render 봇', ready: true }
  const guilds = [
    { id: '123456789012345678', name: '아산 전용 서버', manageChannels: true, memberCount: 30 },
    { id: '733456789012345678', name: '공통 봇 추가 서버', manageChannels: true, memberCount: 12 },
  ]
  await page.goto('/?workspace=asan-ax#connection')
  await page.getByRole('button', { name: '관리자 로그인', exact: true }).click()
  await page.getByLabel('관리자 비밀번호').fill('test-only-password-1234')
  await page.getByRole('button', { name: '로그인', exact: true }).click()
  await expect(page.getByRole('heading', { name: '봇 연결 현황', exact: true })).toBeVisible()
  const created = await page.request.post('/api/workspaces', { data: { name: '공통 봇 테스트', guildId: guilds[1].id } })
  expect(created.status()).toBe(201)
  expect((await request.post('/api/integrations/discord/provision/heartbeat', { data: { bot, guilds } })).status()).toBe(401)
  expect((await request.post('/api/integrations/discord/provision/heartbeat', { headers, data: { bot, guilds } })).status()).toBe(200)
  await page.reload()
  await expect(page.getByText('공통 봇 온라인', { exact: true })).toBeVisible()
  await expect(page.locator('.shared-bot-status')).toContainText('아산 전용 서버')
  await expect(page.locator('.shared-bot-status')).not.toContainText('공통 봇 추가 서버')
  await page.getByRole('button', { name: '워크스페이스 선택', exact: true }).click()
  await page.getByLabel('워크스페이스 목록', { exact: true }).getByRole('button', { name: /^공통 봇 테스트/ }).click()
  await expect(page.getByText('공통 봇 온라인', { exact: true })).toBeVisible()
  await expect(page.locator('.shared-bot-status')).toContainText(bot.name)
  await expect(page.locator('.shared-bot-status')).toContainText('공통 봇 추가 서버')
  await expect(page.locator('.shared-bot-status')).not.toContainText('아산 전용 서버')
  await expect(page.getByRole('cell', { name: '운영멘토', exact: true })).toHaveCount(0)
  await expect(page.getByText(/LEARNINGOPS_SOURCE_ID/)).toHaveCount(0)
  await request.post('/api/integrations/discord/provision/heartbeat', { headers, data: { bot, guilds: [guilds[0]] } })
  await page.reload()
  await expect(page.getByText('공통 봇 온라인', { exact: true })).toBeVisible()
  await expect(page.getByText('서버 연결 대기', { exact: true })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/shared-bot-mobile.png', fullPage: true })
})

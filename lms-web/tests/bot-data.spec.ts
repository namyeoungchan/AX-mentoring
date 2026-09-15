import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'

test('imported bot data is managed on the web, visible to the bot and backed up without truncation', async ({ page, request }) => {
  const login = await (await request.post('/api/login', { data: { password: 'test-only-password-1234' } })).json()
  const headers = { Authorization: `Bearer ${login.token}` }
  const guildId = '743456789012345678'
  const workspace = await (await request.post('/api/workspaces', { headers, data: { name: '기존 봇 이관', guildId } })).json()
  const state = await (await request.get(`/api/workspaces/${workspace.id}/bot-data`, { headers })).json()
  const tables = Object.fromEntries(state.tables.map((t: { key: string }) => [t.key, []]))
  tables.mentors = [{ id: 12, name: '기존 멘토', discord_id: '555456789012345678', bio: '이관 원문' }]
  const archive = JSON.stringify({ version: 1, guildId, tables, settings: { channels: {}, teams: [], qaUnansweredHours: 24 }, runtime: [] })
  const checksum = createHash('sha256').update(archive).digest('hex')
  const botHeaders = { Authorization: 'Bearer test-only-provision-token-12345678901234567890' }
  expect((await request.post('/api/integrations/discord/storage/bootstrap', { data: { guildId, archive, checksum } })).status()).toBe(401)
  expect((await request.post('/api/integrations/discord/storage/bootstrap', { headers: botHeaders, data: { guildId, archive, checksum } })).status()).toBe(200)
  await page.goto(`/?workspace=${workspace.id}#bot-data`)
  await page.getByRole('button', { name: '관리자 로그인', exact: true }).click()
  await page.getByLabel('관리자 비밀번호').fill('test-only-password-1234')
  await page.getByRole('button', { name: '로그인', exact: true }).click()
  await expect(page.getByRole('heading', { name: '봇 데이터 · 운영', exact: true })).toBeVisible()
  await expect(page.getByText('웹 저장소 사용', { exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: '기존 멘토', exact: true })).toBeVisible()
  await page.getByLabel('Discord 사용자 ID', { exact: true }).fill('666456789012345678')
  await page.getByLabel('이름', { exact: true }).fill('웹에서 등록')
  await page.getByLabel('소개', { exact: true }).fill('봇에서도 조회')
  await page.getByRole('button', { name: '작업 저장' }).click()
  await expect(page.getByRole('status')).toContainText('멘토 등록 작업을 저장했습니다.')
  await expect(page.getByRole('cell', { name: '웹에서 등록', exact: true })).toBeVisible()
  const result = await (await request.post('/api/integrations/discord/storage/call', { headers: botHeaders, data: { guildId, operation: 'get_mentors', requestId: crypto.randomUUID() } })).json()
  expect(JSON.stringify(result)).toContain('웹에서 등록')
  const saved = await (await request.get(`/api/workspaces/${workspace.id}/bot-data/archive/${checksum}`, { headers })).json()
  expect(saved.archive).toBe(archive)
  await page.getByRole('button', { name: '서버 설정 편집' }).click()
  await page.getByLabel('과제·참여도·비밀평가 대시보드 ID', { exact: true }).fill('999456789012345678')
  await page.getByRole('button', { name: '채널 설정 저장' }).click()
  await expect(page.getByRole('status')).toContainText('채널·역할 설정을 저장했습니다.')
  const status = await (await request.post('/api/integrations/discord/storage/status', { headers: botHeaders, data: { guildId } })).json()
  expect(status.settings.channels.ASSIGNMENT_DASHBOARD_CHANNEL_ID).toBe('999456789012345678')
  await page.reload()
  await expect(page.getByRole('cell', { name: '웹에서 등록', exact: true })).toBeVisible()
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    await page.screenshot({ path: `test-results/bot-data-${width}.png`, fullPage: true, animations: 'disabled' })
  }
})

import { test, expect, type APIResponse } from '@playwright/test'
import { randomUUID } from 'node:crypto'

test('mentor sees an automatically prepared server invitation before completing profile and can then verify', async ({ page, request, context }) => {
  test.setTimeout(60000)
  const json = async (response: APIResponse) => { expect(response.ok(), await response.text()).toBeTruthy(); return response.json() }
  const platform = await json(await request.post('/api/login', { data: { password: 'test-only-password-1234' } }))
  const headers = { Authorization: `Bearer ${platform.token}` }
  const guildId = '695456789012345679', discordId = '795456789012345679'
  const workspace = await json(await request.post('/api/workspaces', { headers, data: { name: '멘토 초대 확인', guildId } }))
  const base = `/api/workspaces/${workspace.id}`
  const groups = await json(await request.get(`${base}/discord/groups`, { headers }))
  await json(await request.post(`${base}/discord/groups`, { headers, data: { revision: groups.revision, count: 1 } }))
  const username = `mentor.${randomUUID().slice(0, 8)}`
  const invite = await json(await request.post(`${base}/invitations`, { headers, data: { username, role: 'instructor' } }))
  await json(await page.request.post('/api/auth/register', { data: { invitationToken: invite.token, username, name: '새 멘토', password: 'mentor-join-password-1234' } }))
  await json(await page.request.post('/api/invitations/accept', { data: { token: invite.token } }))
  await page.goto(`/?workspace=${workspace.id}#onboarding`)
  await expect(page.getByRole('status').filter({ hasText: '서버 초대 링크를 준비하고 있습니다' })).toBeVisible()
  expect((await json(await page.request.get(`${base}/staff/onboarding`))).profile).toBeNull()
  const botHeaders = { Authorization: 'Bearer test-only-provision-token-12345678901234567890' }
  const { job } = await json(await request.post('/api/integrations/discord/admissions/poll', { headers: botHeaders, data: { guildIds: [guildId] } }))
  expect(job.guildId).toBe(guildId)
  await page.reload() // Opening the screen again must reuse the in-flight invitation.
  expect((await json(await request.post('/api/integrations/discord/admissions/poll', { headers: botHeaders, data: { guildIds: [guildId] } }))).job).toBeNull()
  await json(await request.post('/api/integrations/discord/admissions/complete', { headers: botHeaders, data: { id: job.id, claim: job.claim, success: false, code: null } }))
  await expect(page.getByText('초대를 발급하지 못했습니다.', { exact: false })).toBeVisible({ timeout: 10000 })
  await page.getByRole('button', { name: '초대 링크 발급 · 재발급', exact: true }).click()
  const { job: retried } = await json(await request.post('/api/integrations/discord/admissions/poll', { headers: botHeaders, data: { guildIds: [guildId] } }))
  await json(await request.post('/api/integrations/discord/admissions/complete', { headers: botHeaders, data: { id: retried.id, claim: retried.claim, success: true, code: 'MentorJoinReady' } }))
  await expect(page.getByRole('link', { name: 'Discord 서버 참여', exact: true })).toHaveAttribute('href', 'https://discord.gg/MentorJoinReady', { timeout: 10000 })
  await page.getByLabel('전문 분야').fill('AI 활용')
  await page.getByRole('button', { name: '기본 정보 저장', exact: true }).click()
  await page.getByRole('button', { name: 'LMS 인증 시작', exact: true }).click()
  const code = await page.getByLabel('인증 코드', { exact: true }).textContent()
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.getByRole('button', { name: '인증 코드 복사', exact: true }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code)
  await expect(page.getByRole('link', { name: 'Discord 서버 참여', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Discord에서 인증하기', exact: true })).toHaveAttribute('href', `https://discord.com/channels/${guildId}`)
  await page.setViewportSize({ width: 390, height: 1000 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/mentor-discord-join.png', fullPage: true, animations: 'disabled' })
  await json(await request.post('/api/integrations/discord/verify', { headers: { Authorization: 'Bearer test-only-auth-token-12345678901234567890' }, data: { code, discordId, guildId } }))
  await expect(page.getByText('Discord 인증 완료', { exact: true })).toBeVisible({ timeout: 10000 })
})

import { test, expect, type APIResponse } from '@playwright/test'
import { randomUUID } from 'node:crypto'

test('group mentor registers Discord availability after verification and LMS advances automatically', async ({ page, request }) => {
  test.setTimeout(60000)
  const json = async (response: APIResponse) => { expect(response.ok(), await response.text()).toBeTruthy(); return response.json() }
  const platform = await json(await request.post('/api/login', { data: { password: 'test-only-password-1234' } }))
  const headers = { Authorization: `Bearer ${platform.token}` }
  const guildId = '695456789012345680', discordId = '795456789012345680'
  const workspace = await json(await request.post('/api/workspaces', { headers, data: { name: '조 담당 가능 시간', guildId } }))
  const base = `/api/workspaces/${workspace.id}`
  const groups = await json(await request.get(`${base}/discord/groups`, { headers }))
  const setup = await json(await request.post(`${base}/discord/groups`, { headers, data: { revision: groups.revision, count: 1 } }))
  const username = `group.${randomUUID().slice(0, 8)}`
  const invitation = await json(await request.post(`${base}/invitations`, { headers, data: { username, role: 'instructor', mentorType: 'group', teamIds: [setup.teams[0].id] } }))
  await json(await page.request.post('/api/auth/register', { data: { invitationToken: invitation.token, username, name: '조 담당 멘토', password: 'mentor-availability-password' } }))
  await json(await page.request.post('/api/invitations/accept', { data: { token: invitation.token } }))
  await json(await page.request.post(`${base}/staff/profile`, { data: { name: '조 담당 멘토', expertise: 'AI' } }))
  const challenge = await json(await page.request.post(`${base}/staff/verification`, { data: {} }))
  await json(await request.post('/api/integrations/discord/verify', { headers: { Authorization: 'Bearer test-only-auth-token-12345678901234567890' }, data: { code: challenge.code, discordId, guildId } }))
  await page.goto(`/?workspace=${workspace.id}#onboarding`)
  const steps = page.getByRole('navigation', { name: '온보딩 단계' })
  await expect(page.getByRole('heading', { name: '온라인 멘토링 가능 시간을 입력해 주세요' })).toBeVisible()
  await expect(steps.getByRole('button', { name: /업무 안내/ })).toBeDisabled()
  await expect(page.getByRole('button', { name: '업무 안내로 계속' })).toBeDisabled()
  const botHeaders = { Authorization: 'Bearer test-only-provision-token-12345678901234567890' }
  const invoke = async (operation: string, args: unknown[] = []) => json(await request.post('/api/integrations/discord/storage/call', { headers: botHeaders, data: { guildId, operation, args, requestId: randomUUID() } }))
  const mentors = await invoke('get_online_mentors')
  const mentorId = mentors.result[0].value.find(([key]: [string, unknown]) => key === 'id')[1]
  await invoke('set_slot_template', [mentorId, 19, 0, 21, 0, 30])
  expect((await json(await page.request.get(`${base}/staff/onboarding`))).availability.configured).toBe(false)
  const { job } = await json(await request.post('/api/integrations/discord/outbox/poll', { headers: botHeaders, data: { guildIds: [guildId], capabilities: ['mentor_availability'] } }))
  expect(job.kind).toBe('mentor_availability'); expect(job.payload.targetId).toBe(discordId)
  await invoke('generate_slots_for_range', [mentorId, { $lms: 'date', value: '2030-01-01' }, { $lms: 'date', value: '2030-01-01' }])
  await expect(steps.getByRole('button', { name: /업무 안내/ })).toHaveAttribute('aria-current', 'step', { timeout: 10000 })
  await steps.getByRole('button', { name: /Discord 연결/ }).click()
  await expect(page.getByRole('heading', { name: '온라인 멘토링 가능 시간 등록 완료' })).toBeVisible()
  await expect(page.getByRole('button', { name: '업무 안내로 계속' })).toBeEnabled()
  await page.setViewportSize({ width: 390, height: 1000 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/mentor-availability-mobile.png', fullPage: true, animations: 'disabled' })
})

test('mentor sees an automatically prepared server invitation before completing profile and can then verify', async ({ page, request, context }) => {
  test.setTimeout(90000)
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
  const steps = page.getByRole('navigation', { name: '온보딩 단계' })
  await expect(steps.getByRole('button', { name: /업무 안내/ })).toBeDisabled()
  await page.screenshot({ path: 'test-results/mentor-profile-desktop.png', fullPage: true, animations: 'disabled' })
  let failProfile = true, releaseSave: () => void = () => {}, saves = 0
  await page.route(`**${base}/staff/profile`, async route => {
    saves++
    if (failProfile) return route.fulfill({ status: 503, json: { error: '저장 서버에 잠시 연결하지 못했습니다.' } })
    await new Promise<void>(resolve => { releaseSave = resolve })
    await route.continue()
  })
  await page.getByRole('button', { name: '기본 정보 저장', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('저장 서버에 잠시 연결하지 못했습니다')
  await page.waitForResponse(response => response.url().endsWith('/staff/onboarding'))
  await expect(page.getByRole('alert')).toBeVisible() // Polling must not erase an action failure.
  await expect(page.getByLabel('전문 분야')).toHaveValue('AI 활용')
  failProfile = false
  await page.getByRole('button', { name: '기본 정보 저장', exact: true }).click()
  await expect(page.getByRole('button', { name: '저장 중…', exact: true })).toBeDisabled()
  await expect(steps.getByRole('button', { name: /Discord 연결/ })).toBeDisabled()
  releaseSave()
  await expect(steps.getByRole('button', { name: /Discord 연결/ })).toHaveAttribute('aria-current', 'step')
  expect(saves).toBe(2)
  await expect(page.getByRole('progressbar', { name: '멘토 온보딩 진행률' })).toHaveAttribute('value', '1')
  await page.getByRole('button', { name: 'LMS 인증 시작', exact: true }).click()
  const code = await page.getByLabel('인증 코드', { exact: true }).textContent()
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.getByRole('button', { name: '인증 코드 복사', exact: true }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code)
  await expect(page.getByRole('button', { name: '인증 코드 복사' })).toContainText('복사 완료')
  await steps.getByRole('button', { name: /기본 정보/ }).click()
  await expect(page.getByLabel('전문 분야')).toHaveValue('AI 활용')
  await steps.getByRole('button', { name: /Discord 연결/ }).click()
  await expect(page.getByLabel('인증 코드', { exact: true })).toHaveText(code!)
  await expect(page.getByRole('link', { name: 'Discord 서버 참여', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Discord에서 인증하기', exact: true })).toHaveAttribute('href', `https://discord.com/channels/${guildId}`)
  await page.setViewportSize({ width: 390, height: 1000 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/mentor-discord-join.png', fullPage: true, animations: 'disabled' })
  await json(await request.post('/api/integrations/discord/verify', { headers: { Authorization: 'Bearer test-only-auth-token-12345678901234567890' }, data: { code, discordId, guildId } }))
  await expect(page.getByRole('complementary', { name: '내 활동과 Discord 참여' }).getByText('Discord 인증 완료', { exact: true })).toBeVisible({ timeout: 10000 })
  await expect(steps.getByRole('button', { name: /업무 안내/ })).toHaveAttribute('aria-current', 'step')
  await expect(page.getByRole('progressbar', { name: '멘토 온보딩 진행률' })).toHaveAttribute('value', '2')
  for (const title of ['과제 생성', '멘토링 예약 승인', '멘토링 진행']) {
    await expect(page.getByRole('button', { name: new RegExp(title + '.*지금 확인') })).toHaveAttribute('aria-expanded', 'true')
    await page.getByRole('button', { name: '안내 확인했어요', exact: true }).click()
  }
  await expect(page.getByRole('heading', { name: '멘토 온보딩을 완료했습니다', exact: true })).toBeVisible()
  await expect(page.getByRole('progressbar', { name: '멘토 온보딩 진행률' })).toHaveAttribute('value', '3')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: 'test-results/mentor-complete-desktop.png', fullPage: true, animations: 'disabled' })
  await page.getByText('과제 만들기', { exact: true }).click()
  await page.getByLabel('과제 제목', { exact: true }).fill('멘토 온보딩 실습')
  await page.getByLabel('마감일', { exact: true }).fill('2026-12-01')
  await page.getByRole('button', { name: '과제 생성', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '과제를 생성했습니다' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: '멘토 활동 준비를 마쳤어요' })).toBeVisible()
  expect((await json(await page.request.get(`${base}/staff/onboarding`))).profile.steps).toHaveLength(3)
})

import { test, expect, type APIResponse } from '@playwright/test'
import { randomUUID } from 'node:crypto'

test('connection check shows progress, unchanged results, errors and timeout without overlapping polls', async ({ page }) => {
  test.setTimeout(60000)
  const json = async (response: APIResponse) => { expect(response.ok(), await response.text()).toBeTruthy(); return response.json() }
  await json(await page.request.post('/api/login', { data: { password: 'test-only-password-1234' } }))
  const workspace = await json(await page.request.post('/api/workspaces', { data: { name: '연결 확인 테스트', guildId: '685456789012345679' } }))
  const base = `/api/workspaces/${workspace.id}`
  const groups = await json(await page.request.get(`${base}/discord/groups`))
  await json(await page.request.post(`${base}/discord/groups`, { data: { revision: groups.revision, courseId: groups.courseId, count: 1, title: '연결 확인 과정' } }))
  const provision = await json(await page.request.get(`${base}/discord/provision`))
  provision.worker = { id: '885456789012345679', connected: true }
  provision.guilds = []
  let mode = 'ok', count = 0, release: () => void = () => {}
  await page.route(`**${base}/discord/provision`, async route => {
    count++
    if (mode === 'hold') await new Promise<void>(resolve => { release = resolve })
    await route.fulfill({ status: mode === 'error' ? 503 : 200, json: mode === 'error' ? { error: '연결 정보를 불러오지 못했습니다.' } : provision }).catch(() => {})
  })
  await page.goto(`/?workspace=${workspace.id}#discord`)
  const check = page.getByRole('button', { name: '연결 상태 확인', exact: true })
  await expect(check).toBeVisible()
  await page.clock.install()
  await page.clock.pauseAt(new Date())
  mode = 'hold'; count = 0
  await check.click()
  await expect(page.getByRole('button', { name: '연결 확인 중…' })).toBeDisabled()
  await expect(page.getByRole('status')).toContainText('연결 상태를 확인하고 있습니다')
  const progress = page.getByLabel('연결 확인 과정')
  await expect(progress.getByText('워크스페이스를 확인했습니다.', { exact: false })).toBeVisible()
  await expect(progress.getByText('봇 응답 확인')).toBeVisible()
  await page.clock.runFor(5000)
  expect(count).toBe(1)
  mode = 'ok'; release()
  await expect(page.getByRole('status')).toContainText('이 서버의 앱 연결은 아직 확인되지 않았습니다')
  await expect(check).toBeEnabled()
  await expect(progress).toContainText('2 / 3 확인 완료')
  await expect(progress).toContainText('서버 참여를 기다리고 있습니다')
  await check.click() // An unchanged result still acknowledges the user's action.
  await expect(page.getByRole('status')).toContainText('확인 · 이 서버의 앱 연결은 아직')
  mode = 'error'
  await check.click()
  await expect(page.getByRole('alert')).toContainText('연결 정보를 불러오지 못했습니다')
  await expect(check).toBeEnabled()
  mode = 'ok'
  await check.click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('이 서버의 앱 연결은 아직')
  mode = 'hold'
  await check.click()
  await page.clock.runFor(16000)
  await expect(page.getByRole('alert')).toContainText('시간이 오래 걸립니다', { timeout: 20000 })
  await expect(check).toBeEnabled()
  mode = 'ok'; release()
  await check.click()
  await expect(page.getByRole('status')).toContainText('이 서버의 앱 연결은 아직')
  await page.clock.resume()
  await page.setViewportSize({ width: 390, height: 900 })
  await expect(page.locator('.sidebar')).not.toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/connection-check-mobile.png', fullPage: true, animations: 'disabled' })
})

test('a personal administrator connects by channel link, recovers setup and verifies without refreshing', async ({ page, request, context }) => {
  test.setTimeout(60000)
  const json = async (response: APIResponse) => { expect(response.ok(), await response.text()).toBeTruthy(); return response.json() }
  const platform = await json(await request.post('/api/login', { data: { password: 'test-only-password-1234' } }))
  const headers = { Authorization: `Bearer ${platform.token}` }
  const w = await json(await request.post('/api/workspaces', { headers, data: { name: '빠른 설정 수업' } }))
  const username = `quick.${randomUUID().slice(0, 8)}`, base = `/api/workspaces/${w.id}`
  const invite = await json(await request.post(`${base}/invitations`, { headers, data: { username, role: 'admin' } }))
  await json(await page.request.post('/api/auth/register', { data: { invitationToken: invite.token, username, name: '초기 운영자', password: 'quick-setup-password-1234' } }))
  await json(await page.request.post('/api/invitations/accept', { data: { token: invite.token } }))
  await page.goto(`/?workspace=${w.id}#discord`)
  await expect(page.getByRole('heading', { name: 'Discord 빠른 설정', exact: true })).toBeVisible()
  await expect(page.getByLabel('설정 이름', { exact: true })).toHaveCount(0)
  await page.getByLabel('운영할 조 수', { exact: true }).fill('2')
  await page.getByRole('button', { name: '조 구성 저장', exact: true }).click()
  const input = page.getByLabel('Discord 채널 링크 또는 서버 ID')
  for (const bad of ['https://discord.gg/invite', 'https://evil.example/channels/683456789012345678/783456789012345678', 'https://discord.com/channels/@me/783456789012345678']) {
    await input.fill(bad)
    await page.getByRole('button', { name: '서버 연결하고 계속' }).click()
    await expect(page.getByRole('alert')).toContainText('초대 링크는 사용할 수 없습니다.')
    expect((await json(await page.request.get(`${base}/discord/provision`))).boundGuildIds).toEqual([])
  }
  const guildId = '683456789012345678', botId = '883456789012345678', startId = '783456789012345678'
  await input.fill(`https://discord.com/channels/${guildId}/${startId}`)
  await page.getByRole('button', { name: '서버 연결하고 계속' }).click()
  await expect(page.getByRole('heading', { name: '3. 앱 초대 및 자동 구축' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: '3. 앱 초대 및 자동 구축' })).toBeVisible()
  const botHeaders = { Authorization: 'Bearer test-only-provision-token-12345678901234567890' }
  const bot = async (path: string, data: unknown) => json(await request.post(`/api/integrations/discord/provision/${path}`, { headers: botHeaders, data }))
  await bot('poll', { bot: { id: botId, name: '교육 앱', ready: true }, guilds: [] })
  await page.getByRole('button', { name: '연결 상태 확인' }).click()
  const install = new URL((await page.getByRole('link', { name: '이 서버에 앱 초대' }).getAttribute('href'))!)
  expect(install.origin).toBe('https://discord.com')
  expect(install.searchParams.get('guild_id')).toBe(guildId)
  expect(install.searchParams.get('client_id')).toBe(botId)
  expect(install.searchParams.get('disable_guild_select')).toBe('true')
  const heartbeat = { bot: { id: botId, name: '교육 앱', ready: true }, guilds: [{ id: guildId, name: '수업 서버', manageChannels: true }] }
  const { job } = await bot('poll', heartbeat)
  await bot('complete', { id: job.id, claim: job.claim, success: false, errorCode: 'forbidden', results: [] })
  await page.getByRole('button', { name: '연결 상태 확인' }).click()
  await expect(page.getByRole('alert')).toContainText('역할 순서')
  const retrySaved = page.waitForResponse(r => r.url().endsWith(`${base}/discord/provision/jobs`) && r.request().method() === 'POST')
  await page.getByRole('button', { name: '구축 다시 시도' }).click()
  expect((await retrySaved).ok()).toBe(true)
  const { job: retried } = await bot('poll', heartbeat)
  const results = retried.plan.channels.map((c: { id: string }, i: number) => ({ id: c.id, discordId: c.id === 'start' ? startId : String(973456789012345678n + BigInt(i)), action: 'created' }))
  await bot('complete', { id: retried.id, claim: retried.claim, success: false, errorCode: 'timeout', results })
  await page.getByRole('button', { name: '연결 상태 확인' }).click()
  await expect(page.getByRole('alert')).toContainText(`채널 ${results.length}/${results.length}개의 생성·연결 결과가 저장됐습니다`)
  await expect(page.getByRole('heading', { name: '4. 내 LMS 인증' })).not.toBeVisible()
  const recovered = page.waitForResponse(r => r.url().endsWith(`${base}/discord/provision/jobs`) && r.request().method() === 'POST')
  await page.getByRole('button', { name: '기존 구축 재확인' }).click()
  expect((await recovered).ok()).toBe(true)
  const { job: rechecked } = await bot('poll', heartbeat)
  expect(rechecked.plan.revision).toBe(retried.plan.revision)
  await bot('complete', { id: rechecked.id, claim: rechecked.claim, success: true, errorCode: null, results: results.map((row: { id: string; discordId: string }) => ({ ...row, action: 'reused' })) })
  await expect(page.getByRole('heading', { name: '4. 내 LMS 인증' })).toBeVisible({ timeout: 10000 })
  await expect(page.getByLabel('연결 확인 과정')).toContainText('3 / 3 확인 완료')
  await expect(page.getByLabel('연결 확인 과정')).not.toContainText('시간 안에 끝나지 않았습니다')
  await page.getByRole('button', { name: 'LMS 인증 시작' }).click()
  const code = await page.getByLabel('인증 코드', { exact: true }).textContent()
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.getByRole('button', { name: '인증 코드 복사', exact: true }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code)
  await expect(page.getByRole('link', { name: 'Discord에서 인증하기' })).toHaveAttribute('href', `https://discord.com/channels/${guildId}/${startId}`)
  for (const width of [1440, 390, 360]) { await page.setViewportSize({ width, height: 1000 }); if (width < 760) await expect(page.locator('.sidebar')).not.toBeInViewport(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: `test-results/discord-quick-${width}.png`, fullPage: true, animations: 'disabled' }) }
  const authHeaders = { Authorization: 'Bearer test-only-auth-token-12345678901234567890' }, discordId = '983456789012345678'
  expect((await request.post('/api/integrations/discord/verify', { headers: authHeaders, data: { code, discordId, guildId: '123456789012345678' } })).status()).toBe(403)
  await json(await request.post('/api/integrations/discord/verify', { headers: authHeaders, data: { code, discordId, guildId } }))
  await expect(page.getByText('Discord 연결과 LMS 인증을 완료했습니다.', { exact: true })).toBeVisible({ timeout: 10000 })
  await page.reload()
  await expect(page.getByText('Discord 연결과 LMS 인증을 완료했습니다.', { exact: true })).toBeVisible()
  expect((await json(await page.request.get(`${base}/discord/groups`))).teams).toHaveLength(2)
  await json(await request.post(`${base}/archive`, { headers, data: {} }))
  expect((await page.request.post(`${base}/me/verification`, { data: {} })).status()).toBe(403)
})

import { test, expect } from '@playwright/test'

test('one account verifies each workspace separately and switching never carries over a code or verified badge', async ({ page, request }) => {
  const admin = await (await request.post('/api/login', { data: { password: 'test-only-password-1234' } })).json()
  const adminHeaders = { Authorization: `Bearer ${admin.token}` }
  const botHeaders = { Authorization: 'Bearer test-only-auth-token-12345678901234567890' }
  const workspaces: { id: string; name: string; guildId: string }[] = []
  for (const [name, guildId] of [['독립 인증 A', '854456789012345678'], ['독립 인증 B', '855456789012345678']]) {
    const response = await request.post('/api/workspaces', { headers: adminHeaders, data: { name, guildId } })
    expect(response.status()).toBe(201)
    workspaces.push({ ...await response.json(), guildId })
  }
  const username = 'workspace.proof', password = 'test-workspace-password-1234'
  const invitations = []
  for (const w of workspaces) invitations.push(await (await request.post(`/api/workspaces/${w.id}/invitations`, { headers: adminHeaders, data: { username, role: 'instructor' } })).json())
  const signup = await request.post('/api/auth/register', { data: { username, password, name: '인증 강사', invitationToken: invitations[0].token } })
  expect(signup.status()).toBe(201)
  const memberHeaders = { Authorization: `Bearer ${(await signup.json()).token}` }
  for (const [i, w] of workspaces.entries()) {
    expect((await request.post('/api/invitations/accept', { headers: memberHeaders, data: { token: invitations[i].token } })).status()).toBe(200)
    expect((await request.post(`/api/workspaces/${w.id}/staff/profile`, { headers: memberHeaders, data: { name: '인증 강사', expertise: 'AI' } })).status()).toBe(200)
  }
  const [a, b] = workspaces
  await page.goto(`/?workspace=${a.id}`)
  await page.getByLabel('아이디', { exact: true }).fill(username)
  await page.getByLabel('비밀번호', { exact: true }).fill(password)
  await page.locator('form').getByRole('button', { name: '로그인', exact: true }).click()
  await expect(page.getByRole('heading', { name: '멘토 활동 관리' })).toBeVisible()
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: '2. Discord 참여 및 인증' }) })
  await section.getByRole('button', { name: '인증 코드 받기', exact: true }).click()
  const codeA = (await section.locator('code').innerText()).split('코드:')[1]
  await page.getByRole('button', { name: '워크스페이스 선택', exact: true }).click()
  await page.getByRole('button', { name: /독립 인증 B/ }).click()
  await expect(section).toContainText('독립 인증 B에서 사용할 인증입니다.')
  await expect(section.locator('code')).toHaveCount(0)
  await section.getByRole('button', { name: '인증 코드 받기', exact: true }).click()
  const codeB = (await section.locator('code').innerText()).split('코드:')[1]
  const verify = (code: string, guildId: string) => request.post('/api/integrations/discord/verify', { headers: botHeaders, data: { code, guildId, discordId: '856456789012345678' } })
  expect((await verify(codeA, b.guildId)).status()).toBe(403)
  expect((await verify(codeA, a.guildId)).status()).toBe(200)
  const statePath = '/api/integrations/discord/verification-state'
  const identity = { guildId: a.guildId, discordId: '856456789012345678' }
  expect((await request.post(statePath, { data: identity })).status()).toBe(401)
  expect((await request.post(statePath, { headers: memberHeaders, data: identity })).status()).toBe(401)
  expect(await (await request.post(statePath, { headers: botHeaders, data: identity })).json()).toEqual({ verified: true })
  expect(await (await request.post(statePath, { headers: botHeaders, data: { ...identity, guildId: b.guildId } })).json()).toEqual({ verified: false })
  expect((await verify(codeA, a.guildId)).status()).toBe(410)
  expect(await (await request.post(statePath, { headers: botHeaders, data: identity })).json()).toEqual({ verified: true })
  await page.getByRole('button', { name: '새로고침', exact: true }).click()
  await expect(section.getByText('Discord 인증 완료', { exact: true })).toHaveCount(0)
  await expect(section.getByRole('button', { name: '인증 코드 받기', exact: true })).toBeVisible()
  expect((await verify(codeB, b.guildId)).status()).toBe(200)
  await page.getByRole('button', { name: '새로고침', exact: true }).click()
  await expect(section.getByText('Discord 인증 완료', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '워크스페이스 선택', exact: true }).click()
  await page.getByRole('button', { name: /독립 인증 A/ }).click()
  await expect(section.getByText('Discord 인증 완료', { exact: true })).toBeVisible()
})

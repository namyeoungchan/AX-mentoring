import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'

test('mentor code UI accepts verified Discord check-ins, updates roster, preserves corrections and revokes codes', async ({ page }) => {
  const request = page.request, suffix = randomUUID().slice(0, 8)
  const guildId = '8' + Date.now().toString().padStart(17, '0'), discordId = '9' + Date.now().toString().padStart(17, '0')
  const legacy = await (await request.post('/api/login', { data: { password: 'test-only-password-1234' } })).json()
  const root = { Authorization: 'Bearer ' + legacy.token }
  const workspace = await (await request.post('/api/workspaces', { headers: root, data: { name: '코드 출석 ' + suffix, guildId } })).json()
  const base = '/api/workspaces/' + workspace.id
  const groups = await (await request.get(base + '/discord/groups', { headers: root })).json()
  const setup = await (await request.post(base + '/discord/groups', { headers: root, data: { count: 1, revision: groups.revision } })).json()
  const username = 'code.owner.' + suffix, password = 'attendance-password-12345'
  const invite = await (await request.post(base + '/invitations', { headers: root, data: { username, role: 'admin' } })).json()
  const ownerResponse = await request.post('/api/auth/register', { data: { invitationToken: invite.token, username, name: '코드 관리자', password } })
  expect(ownerResponse.status()).toBe(201)
  const owner = await ownerResponse.json(), headers = { Authorization: 'Bearer ' + owner.token }
  expect((await request.post('/api/invitations/accept', { headers, data: { token: invite.token } })).status()).toBe(200)
  const issuedResponse = await request.post(base + '/student-accounts', { headers, data: { username: 'code.student.' + suffix, teamId: setup.teams[0].id } })
  expect(issuedResponse.status()).toBe(201)
  const issued = await issuedResponse.json()
  const initial = await (await request.post('/api/auth/login', { data: { username: issued.username, password: issued.initialPassword } })).json()
  const studentResponse = await request.post('/api/auth/first-login', { headers: { Authorization: 'Bearer ' + initial.token }, data: { name: '코드 학생', currentPassword: issued.initialPassword, newPassword: 'student-new-password-12345' } })
  expect(studentResponse.status()).toBe(200)
  const student = await studentResponse.json(), studentHeaders = { Authorization: 'Bearer ' + student.token }
  const proofResponse = await request.post(base + '/me/verification', { headers: studentHeaders, data: {} })
  expect(proofResponse.status()).toBe(200)
  const proof = await proofResponse.json()
  const botHeaders = { Authorization: 'Bearer test-only-auth-token-12345678901234567890' }
  expect((await request.post('/api/integrations/discord/verify', { headers: botHeaders, data: { code: proof.code.replaceAll('-', ''), guildId, discordId } })).status()).toBe(200)
  expect((await request.get(base + '/attendance/code?courseId=' + setup.courseId + '&date=2026-09-18&period=1', { headers: studentHeaders })).status()).toBe(403)
  await request.post('/api/auth/login', { data: { username, password } })
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto('/?workspace=' + workspace.id + '#attendance')
  await page.getByLabel('출결 날짜').fill('2026-09-18')
  await page.getByRole('button', { name: '회차 시작', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('회차를 시작했습니다.')
  await page.getByRole('button', { name: '출석 코드 발급', exact: true }).click()
  const codeOutput = page.getByLabel('발급된 출석 코드')
  await expect(codeOutput).toHaveText(/^\d{6}$/)
  const code = (await codeOutput.textContent())!
  const path = '/api/integrations/discord/attendance/checkin'
  const check = (value = code) => request.post(path, { headers: botHeaders, data: { guildId, discordId, code: value } })
  expect((await request.post(path, { headers: studentHeaders, data: { guildId, discordId, code } })).status()).toBe(401)
  const results = await Promise.all([check(), check()])
  expect(results.map(r => r.status())).toEqual([200, 200])
  expect((await Promise.all(results.map(r => r.json()))).map(r => r.alreadyRecorded).sort()).toEqual([false, true])
  await expect(page.getByRole('group', { name: '코드 학생 출결 상태', exact: true }).getByRole('button', { name: '출석', exact: true })).toHaveAttribute('aria-pressed', 'true', { timeout: 12000 })
  await page.getByRole('group', { name: '코드 학생 출결 상태', exact: true }).getByRole('button', { name: '지각', exact: true }).click()
  await page.getByLabel('등록·정정 사유').fill('멘토가 실제 도착 시간 확인')
  await page.getByRole('button', { name: '출결 일괄 저장' }).click()
  await expect(page.locator('.attendance-panel > p[role="status"]')).toHaveText('명단 출결을 저장했습니다.')
  expect((await (await check()).json()).status).toBe('지각')
  await page.getByRole('button', { name: '출석 코드 재발급', exact: true }).click()
  await expect(codeOutput).not.toHaveText(code)
  const nextCode = (await codeOutput.textContent())!
  expect((await check()).status()).toBe(410)
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: `test-results/attendance-code-${width}.png`, fullPage: true, animations: 'disabled' })
  }
  await page.getByRole('button', { name: '코드 종료', exact: true }).click()
  await expect(codeOutput).toHaveCount(0)
  expect((await check(nextCode)).status()).toBe(410)
  expect((await check(nextCode)).status()).toBe(429)
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: '회차 마감', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('회차를 마감했습니다.')
  await expect(page.getByRole('button', { name: '출석 코드 발급', exact: true })).toBeDisabled()
  expect(errors).toEqual([])
})

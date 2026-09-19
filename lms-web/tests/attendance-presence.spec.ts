import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'

test('students enter on web and exit through Discord with one durable attendance record', async ({ page }) => {
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
  const date = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)
  const selected = { courseId: setup.courseId, date, period: 1 }
  const roster = async () => (await request.get(base + '/attendance?' + new URLSearchParams({ ...selected, period: '1' }), { headers: root })).json()
  const issuedCode = await request.post(base + '/attendance/code', {headers, data: {...selected, phase:'in', startTime:'10:00', endTime:'12:00'}})
  expect(issuedCode.status()).toBe(200)
  const startCode = (await issuedCode.json()).code
  expect((await request.post(base + '/me/attendance', { headers: studentHeaders, data: { ...selected, action: 'out' } })).status()).toBe(422)
  await page.goto('/?workspace=' + workspace.id + '#attendance')
  const round = page.getByRole('article', { name: '1차시 입퇴실' })
  await expect(round).toContainText('10:00–12:00')
  await page.getByLabel('시작·종료 코드', {exact:true}).fill(startCode)
  await page.getByRole('button', {name:'코드로 출석하기'}).click()
  await expect(page.getByRole('status')).toContainText('입실 시각')
  const first = (await roster()).rows[0]
  expect(first.checkInAt).toBeGreaterThan(0)
  expect(first.status).toBe('미처리')
  const endpoint = '/api/integrations/discord/attendance/presence/mark'
  const endResponse = await request.post(base + '/attendance/code', {headers, data: {...selected, phase:'out'}})
  expect(endResponse.status()).toBe(200)
  const endCode = (await endResponse.json()).code
  const body = { code: endCode, guildId, discordId, action: 'out' }
  expect((await request.post(endpoint, { headers: studentHeaders, data: body })).status()).toBe(401)
  const outputs = await Promise.all([request.post(endpoint, { headers: botHeaders, data: body }), request.post(base + '/me/attendance', { headers: studentHeaders, data: { code: endCode } })])
  expect(outputs.map(r => r.status())).toEqual([200, 200])
  expect((await Promise.all(outputs.map(r => r.json()))).map(r => r.alreadyRecorded).sort()).toEqual([false, true])
  await page.getByRole('button', { name: '출석 새로고침' }).click()
  await expect(round).toContainText('출석 기록 완료')
  const after = await roster()
  expect(after.rows[0].checkInAt).toBe(first.checkInAt)
  expect(after.rows[0].checkOutAt).toBeGreaterThanOrEqual(first.checkInAt)
  expect(after.rows[0].status).toBe('출석')
  expect((await request.post(base + '/attendance', { headers: root, data: { ...selected, action: 'close', revision: after.revision, requestId: randomUUID() } })).status()).toBe(200)
  await page.getByRole('button', { name: '출석 새로고침' }).click()
  await expect(page.getByRole('cell', { name: '출석', exact: true })).toBeVisible()
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `test-results/student-attendance-${width}.png`, fullPage: true, animations: 'disabled' })
  }
})

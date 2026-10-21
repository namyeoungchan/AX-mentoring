import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'

test('mentors record their own work in a modal; admins choose mentors; students cannot access records', async ({ page }) => {
  // This real-API journey provisions accounts, switches three roles, retries a lost
  // save response and captures three viewports. Keep assertion timeouts unchanged.
  test.setTimeout(90000)
  const api = page.request, suffix = randomUUID().slice(0, 8)
  const root = await (await api.post('/api/login', { data: { password: 'test-only-password-1234' } })).json()
  const admin = { Authorization: 'Bearer ' + root.token }
  const ws = await (await api.post('/api/workspaces', { headers: admin, data: { name: '멘토링 입력 검증 ' + suffix, guildId: '7' + Date.now().toString().padStart(17, '0') } })).json()
  const base = '/api/workspaces/' + ws.id
  const initial = await (await api.get(base + '/discord/groups', { headers: admin })).json()
  const groups = await (await api.post(base + '/discord/groups', { headers: admin, data: { count: 2, revision: initial.revision } })).json()
  const users = []
  for (const [index, name] of ['테스트 멘토', '다른 멘토'].entries()) {
    const username = `activity.${index}.${suffix}`, password = 'activity-test-password-12345'
    const invite = await (await api.post(base + '/invitations', { headers: admin, data: { username, role: 'instructor', mentorType: 'group', teamIds: [groups.teams[index].id] } })).json()
    const signup = await api.post('/api/auth/register', { data: { invitationToken: invite.token, username, name, password } })
    expect(signup.status()).toBe(201)
    const account = await signup.json()
    expect((await api.post('/api/invitations/accept', { headers: { Authorization: 'Bearer ' + account.token }, data: { token: invite.token } })).status()).toBe(200)
    users.push({ ...account, username, password })
  }
  const [mentor, other] = users
  const before = await (await api.get(base + '/workspace', { headers: admin })).json()
  expect((await api.post('/api/auth/login', { data: { username: mentor.username, password: mentor.password } })).status()).toBe(200)
  await page.goto('/?workspace=' + ws.id + '#mentoring')
  const add = page.getByRole('button', { name: '멘토링 기록 추가', exact: true })
  await expect(add).toBeVisible()
  expect(await add.innerText()).toBe('')
  await add.click()
  const dialog = page.getByRole('dialog', { name: '멘토링 기록', exact: true })
  await expect(dialog.getByLabel('멘토', { exact: true })).toHaveValue('테스트 멘토')
  await expect(dialog.getByLabel('멘토', { exact: true })).toHaveAttribute('readonly', '')
  await expect(dialog.getByLabel('제목', { exact: true })).toBeFocused()
  await expect(dialog.locator('input[type=file]')).toHaveCount(0)
  await dialog.getByLabel('제목', { exact: true }).fill('서버 환경 설정 지원')
  await dialog.getByRole('combobox', { name: '대상 팀', exact: true }).selectOption(groups.teams[0].id)
  await dialog.getByLabel('진행일', { exact: true }).fill('2026-10-01')
  await dialog.getByLabel('시작 시간', { exact: true }).fill('14:00')
  await dialog.getByLabel('종료 시간', { exact: true }).fill('13:00')
  await dialog.getByLabel('진행 내용', { exact: true }).fill('멘티 요청으로 개발 서버 구성\n접속과 배포 확인')
  await dialog.getByRole('button', { name: '저장', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('종료 시간')
  await dialog.getByLabel('종료 시간', { exact: true }).fill('15:00')
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `test-results/mentoring-activity-modal-${width}.png` })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  // Persist the request, then lose the response. Retrying must not duplicate the record.
  let dropped = false
  await page.route('**/mentoring/activities', async route => {
    if (route.request().method() === 'POST' && !dropped) { dropped = true; await route.fetch(); await route.abort('failed') }
    else await route.continue()
  })
  await dialog.getByRole('button', { name: '저장', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('저장 결과를 확인하지 못했습니다')
  await dialog.getByRole('button', { name: '저장 다시 시도', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const records = page.getByRole('region', { name: '멘토링 기록', exact: true })
  await expect(records.locator('article')).toHaveCount(1)
  await expect(records).toContainText('멘티 요청으로 개발 서버 구성')
  await page.reload()
  await records.locator('button[aria-expanded]').click()
  await expect(records.locator('article')).toHaveCount(1)
  await records.getByRole('button', { name: '서버 환경 설정 지원 수정' }).click()
  const edit = page.getByRole('dialog', { name: '멘토링 기록 수정', exact: true })
  await edit.getByLabel('진행 내용').fill('본인 수정: 서버 접속 확인 완료')
  await edit.getByRole('button', { name: '저장', exact: true }).click()
  await expect(records).toContainText('본인 수정: 서버 접속 확인 완료')
  await add.click()
  await dialog.getByLabel('제목', { exact: true }).fill('취소할 내용')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(add).toBeFocused()
  const saved = await (await api.get(base + '/mentoring/activities')).json()
  expect(saved.records).toHaveLength(1)
  const record = saved.records[0]
  const payload = { id: randomUUID(), mentorId: other.user.id, courseId: record.courseId, teamId: record.teamId, studentIds: [], title: '위조', date: '2026-10-01', time: '14:00', endTime: '15:00', content: '위조 시도' }
  expect((await api.post(base + '/mentoring/activities', { data: payload })).status()).toBe(403)
  const otherRecords = await (await api.get(base + '/mentoring/activities', { headers: { Authorization: 'Bearer ' + other.token } })).json()
  expect(otherRecords.records).toHaveLength(0)

  await api.post('/api/login', { data: { password: 'test-only-password-1234' } })
  await page.reload()
  await add.click()
  await expect(dialog.getByRole('combobox', { name: '멘토', exact: true })).toBeVisible()
  await dialog.getByRole('combobox', { name: '멘토', exact: true }).selectOption(other.user.id)
  await dialog.getByLabel('제목', { exact: true }).fill('관리자 대리 등록')
  await dialog.getByRole('combobox', { name: '대상 팀', exact: true }).selectOption(groups.teams[1].id)
  await dialog.getByLabel('진행일', { exact: true }).fill('2026-10-01')
  await dialog.getByLabel('시작 시간', { exact: true }).fill('16:00')
  await dialog.getByLabel('종료 시간', { exact: true }).fill('17:00')
  await dialog.getByLabel('진행 내용', { exact: true }).fill('테스트 관리자 입력')
  await page.screenshot({ path: 'test-results/mentoring-activity-admin-modal.png' })
  await dialog.getByRole('button', { name: '저장', exact: true }).click()
  await expect(records.locator('article')).toHaveCount(2)
  await records.getByRole('button', { name: '서버 환경 설정 지원 수정' }).click()
  await edit.getByLabel('진행 내용').fill('관리자 수정 완료')
  await edit.getByRole('button', { name: '저장', exact: true }).click()
  await expect(records).toContainText('관리자 수정 완료')
  const after = await (await api.get(base + '/workspace', { headers: admin })).json()
  expect(after.sessions).toEqual(before.sessions)
  await page.screenshot({ path: 'test-results/mentoring-activity-records.png', fullPage: true })

  const studentName = 'activity.student.' + suffix
  const issueResponse = await api.post(base + '/student-accounts', { headers: admin, data: { username: studentName, teamId: groups.teams[0].id } })
  expect(issueResponse.status()).toBe(201)
  const issued = await issueResponse.json()
  const student = await (await api.post('/api/auth/login', { data: { username: studentName, password: issued.initialPassword } })).json()
  expect((await api.post('/api/auth/first-login', { headers: { Authorization: 'Bearer ' + student.token }, data: { name: '테스트 학생', currentPassword: issued.initialPassword, newPassword: 'student-test-password-12345' } })).status()).toBe(200)
  expect((await api.get(base + '/mentoring/activities')).status()).toBe(403)
  expect((await api.post(base + '/mentoring/activities', { data: payload })).status()).toBe(403)
  await page.reload()
  await expect(page.locator('.role-workspace')).toBeVisible()
  await expect(add).toHaveCount(0)
  await expect(records).toHaveCount(0)
})

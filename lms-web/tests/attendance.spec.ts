import { test, expect, type APIRequestContext } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

async function fixture(request: APIRequestContext, count: number) {
  const admin = await (await request.post('/api/login', { data: { password: 'test-only-password-1234' } })).json()
  const headers = { Authorization: `Bearer ${admin.token}` }
  const workspace = await (await request.post('/api/workspaces', { headers, data: { name: `출결 ${randomUUID()}` } })).json()
  const base = `/api/workspaces/${workspace.id}`
  const groups = await (await request.get(`${base}/discord/groups`, { headers })).json()
  const setup = await (await request.post(`${base}/discord/groups`, { headers, data: { count: 2, title: '출결 검증', revision: groups.revision } })).json()
  for (let offset = 0; offset < count; offset += 100) {
    const state = await (await request.get(`${base}/workspace`, { headers })).json()
    const changes = Array.from({ length: Math.min(100, count - offset) }, (_, i) => ({ kind: 'learners', value: { id: `s${offset + i}`, name: `학생${offset + i}`, email: '', discordId: '', courseId: setup.courseId, team: setup.teams[(offset + i) % 2].name, status: '정상', progress: 0, color: 'sage' } }))
    expect((await request.patch(`${base}/workspace`, { headers, data: { revision: state.revision, changes } })).status()).toBe(200)
  }
  const selected = { courseId: setup.courseId, date: '2026-09-18', period: 1 }
  const path = `${base}/attendance?${new URLSearchParams({ ...selected, period: '1' })}`
  return { headers, workspace, base, selected, path, setup }
}

test('120-person save, duplicate retry, simultaneous edits and group authorization use the real API', async ({ request }) => {
  const f = await fixture(request, 120)
  const get = async (headers = f.headers) => (await request.get(f.path, { headers })).json()
  const submit = (data: unknown, headers = f.headers) => request.post(`${f.base}/attendance`, { headers, data })
  let roster = await get()
  expect(roster.counts['미처리']).toBe(120)
  expect((await submit({ ...f.selected, requestId: randomUUID(), revision: roster.revision, action: 'start' })).status()).toBe(200)
  roster = await get()
  const body = { ...f.selected, requestId: randomUUID(), revision: roster.revision, action: 'save', entries: roster.rows.map((r: { studentId: string }) => ({ studentId: r.studentId, status: '출석' })) }
  expect((await submit(body)).status()).toBe(200)
  expect((await submit(body)).status()).toBe(200)
  roster = await get()
  expect(roster.counts['출석']).toBe(120)
  expect(roster.history).toHaveLength(120)
  const competing = await Promise.all(['지각', '결석'].map(status => submit({ ...body, requestId: randomUUID(), revision: roster.revision, entries: [{ studentId: 's0', status }] })))
  expect(competing.map(r => r.status()).sort()).toEqual([200, 409])
  const username = `mentor.${randomUUID().slice(0, 8)}`
  const invite = await (await request.post(`${f.base}/invitations`, { headers: f.headers, data: { username, role: 'instructor', mentorType: 'group', teamIds: [f.setup.teams[0].id] } })).json()
  const mentor = await (await request.post('/api/auth/register', { data: { invitationToken: invite.token, username, name: '담당 멘토', password: 'attendance-password-1234' } })).json()
  const mentorHeaders = { Authorization: `Bearer ${mentor.token}` }
  expect((await request.post('/api/invitations/accept', { headers: mentorHeaders, data: { token: invite.token } })).status()).toBe(200)
  const scoped = await get(mentorHeaders)
  expect(scoped.rows).toHaveLength(60)
  expect(scoped.rows.some((r: { studentId: string }) => r.studentId === 's1')).toBe(false)
  expect((await submit({ ...body, requestId: randomUUID(), revision: scoped.revision, entries: [{ studentId: 's1', status: '결석' }] }, mentorHeaders)).status()).toBe(403)
  expect((await submit({ ...f.selected, requestId: randomUUID(), revision: scoped.revision, action: 'close' }, mentorHeaders)).status()).toBe(403)
  expect((await request.get('/api/workspaces/default/attendance?courseId=foreign&date=2026-09-18&period=1', { headers: mentorHeaders })).status()).toBe(403)
  expect((await submit({ ...body, requestId: randomUUID(), revision: scoped.revision, entries: [{ studentId: 's0', status: '공결', reason: '담당 멘토 확인' }] }, mentorHeaders)).status()).toBe(200)
})

test('roster UI supports exceptions, CSV recovery, finalization, correction history and mobile layouts', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  const f = await fixture(page.request, 3)
  await page.goto(`/?workspace=${f.workspace.id}#attendance`)
  await page.getByLabel('출결 날짜').fill(f.selected.date)
  await expect(page.locator('.attendance-summary')).toContainText('미처리 3명')
  await page.getByRole('button', { name: '회차 시작', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('회차를 시작했습니다.')
  await page.getByRole('button', { name: '전체 명단에 적용' }).click()
  await page.getByLabel('학생1 출결 상태').selectOption('지각')
  await page.getByRole('button', { name: '출결 일괄 저장' }).click()
  await expect(page.getByRole('status')).toHaveText('명단 출결을 저장했습니다.')
  await expect(page.getByRole('button', { name: '회차 마감' })).toBeEnabled()
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: '출결 CSV 내보내기' }).click()
  const download = await downloading, csv = await readFile((await download.path())!, 'utf8')
  expect(csv).toContain('studentId')
  await page.getByLabel('출결 CSV 가져오기').setInputFiles({ name: 'recovery.csv', mimeType: 'text/csv', buffer: Buffer.from(csv.replace('"지각"', '"공결"')) })
  await expect(page.getByRole('status')).toContainText('CSV를 불러왔습니다.')
  await expect(page.getByLabel('학생1 출결 상태')).toHaveValue('공결')
  await page.getByRole('button', { name: '출결 일괄 저장' }).click()
  await expect(page.getByRole('status')).toHaveText('명단 출결을 저장했습니다.')
  await expect(page.getByRole('button', { name: '회차 마감' })).toBeEnabled()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: '회차 마감' }).click()
  await expect(page.getByRole('status')).toHaveText('회차를 마감했습니다.')
  await page.getByLabel('학생0 출결 상태').selectOption('지각')
  await page.getByRole('button', { name: '출결 일괄 저장' }).click()
  await expect(page.getByRole('alert')).toHaveText('마감 후 정정 사유를 입력하세요.')
  await page.getByLabel('등록·정정 사유').fill('수기 명단과 대조')
  await page.getByRole('button', { name: '출결 일괄 저장' }).click()
  await expect(page.getByRole('status')).toHaveText('명단 출결을 저장했습니다.')
  await page.reload()
  await page.getByLabel('출결 날짜').fill(f.selected.date)
  await expect(page.getByLabel('학생0 출결 상태')).toHaveValue('지각')
  await page.getByText('출결 변경 이력 · 최근 200건').click()
  await expect(page.locator('.attendance-history')).toContainText('수기 명단과 대조')
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    await page.screenshot({ path: `test-results/attendance-${width}.png`, fullPage: true, animations: 'disabled' })
  }
  expect(errors).toEqual([])
})

import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { staffCsv } from '../shared/staff-import.mjs'

test('xlsx staff registration previews inherited roles, assigns a team and exports usable invitations', async ({ page, request }) => {
  test.setTimeout(90000)
  const root = await (await request.post('/api/login', { data: { password: 'test-only-password-1234' } })).json()
  const headers = { Authorization: `Bearer ${root.token}` }
  const workspace = await (await request.post('/api/workspaces', { headers, data: { name: '엑셀 구성원 등록' } })).json()
  const initial = await (await request.get(`/api/workspaces/${workspace.id}/discord/groups`, { headers })).json()
  const groups = await (await request.post(`/api/workspaces/${workspace.id}/discord/groups`, { headers, data: { count: 2, revision: initial.revision } })).json()
  await page.context().addCookies([{ name: 'learningops_session', value: root.token, url: 'http://127.0.0.1:5174', httpOnly: true }])
  await page.goto(`/?workspace=${workspace.id}#members`)
  await page.getByRole('button', { name: '엑셀 일괄 등록', exact: true }).click()
  const region = page.getByRole('region', { name: '구성원 엑셀 일괄 등록' })
  const template = await page.request.get('/templates/staff-accounts-template.xlsx')
  expect(template.ok()).toBeTruthy()
  await page.getByLabel('구성원 명단 파일').setInputFiles(resolve('public/templates/staff-accounts-template.xlsx'))
  await expect(region.getByText('발급 대상 5명', { exact: false })).toBeVisible()
  await region.getByRole('button', { name: '명단 검증', exact: true }).click()
  await expect(region.getByText('조 담당 멘토는 담당 조를 하나 이상 선택하세요.', { exact: true })).toBeVisible()
  await expect(region.getByRole('button', { name: '확인 · 5명 계정 발급' })).toBeDisabled()
  await region.getByRole('group', { name: '멘토 예시 담당 조' }).getByLabel('1조', { exact: true }).check()
  await region.getByRole('button', { name: '명단 검증', exact: true }).click()
  await expect(region.getByRole('button', { name: '확인 · 5명 계정 발급' })).toBeEnabled()
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: 950 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `test-results/staff-import-${width}.png`, fullPage: true, animations: 'disabled' })
  }
  await region.getByRole('button', { name: '확인 · 5명 계정 발급' }).click()
  await expect(region.getByRole('status')).toContainText('계정 5개 발급 완료 · 실패 0개')
  await expect(region.getByRole('button', { name: '확인 · 0명 계정 발급' })).toBeDisabled()
  await page.getByRole('button', { name: '한 명씩 초대', exact: true }).click()
  await page.getByRole('button', { name: '엑셀 일괄 등록', exact: true }).click()
  await expect(region.getByRole('status')).toContainText('계정 5개 발급 완료')
  const mentorInvite = page.locator('.membership-history').getByRole('row').filter({ hasText: 'mentor.tech.sample' })
  await mentorInvite.getByRole('button', { name: '초대 링크 재발급', exact: true }).click()
  const renewal = page.getByRole('dialog', { name: '초대 링크 재발급 완료' })
  const newLink = await renewal.getByLabel('재발급된 초대 링크').inputValue()
  await renewal.getByRole('button', { name: '확인', exact: true }).click()
  const saved = page.waitForEvent('download')
  await region.getByRole('button', { name: '발급 결과 CSV 다운로드' }).click()
  const download = await saved
  const rows = staffCsv(await readFile((await download.path())!, 'utf8')) as string[][]
  expect(rows).toHaveLength(6)
  expect(rows[3][0]).toBe('강의')
  expect(rows[4][6]).toBe('1조')
  expect(rows[4][9]).toBe(newLink)
  for (const [i, row] of rows.slice(1).entries()) {
    const token = new URL(row[9]).hash.slice(8)
    const preview = await (await request.post('/api/invitations/preview', { data: { token } })).json()
    expect(preview.role).toBe(i === 4 ? 'admin' : 'instructor')
    expect(preview.mentorType).toBe(i === 3 ? 'group' : 'main')
    if (i === 3) expect(preview.teamIds).toEqual([groups.teams[0].id])
    const login = await (await request.post('/api/auth/login', { data: { username: row[4], password: row[8] } })).json()
    expect(login.user.mustChangePassword).toBe(true)
    const changed = await (await request.post('/api/auth/password', { headers: { Authorization: `Bearer ${login.token}` }, data: { currentPassword: row[8], newPassword: 'bulk-invite-local-password' } })).json()
    expect((await request.post('/api/invitations/accept', { headers: { Authorization: `Bearer ${changed.token}` }, data: { token } })).ok()).toBe(true)
  }
  // Reuploading cannot regenerate or overwrite accounts that were already issued.
  await page.reload()
  await page.getByRole('button', { name: '엑셀 일괄 등록', exact: true }).click()
  await page.getByLabel('구성원 명단 파일').setInputFiles(resolve('public/templates/staff-accounts-template.xlsx'))
  await region.getByRole('button', { name: '명단 검증', exact: true }).click()
  await expect(region.getByText('이미 사용 중인 아이디입니다. 기존 계정 초대를 이용하세요.', { exact: true })).toHaveCount(5)
  await expect(region.getByRole('button', { name: '확인 · 5명 계정 발급' })).toBeDisabled()
})

test('CSV preview reports duplicates and lets operators exclude invalid rows', async ({ page, request }) => {
  const root = await (await request.post('/api/login', { data: { password: 'test-only-password-1234' } })).json()
  await page.context().addCookies([{ name: 'learningops_session', value: root.token, url: 'http://127.0.0.1:5174', httpOnly: true }])
  await page.goto('/?workspace=default#members')
  await page.getByRole('button', { name: '엑셀 일괄 등록', exact: true }).click()
  const region = page.getByRole('region', { name: '구성원 엑셀 일괄 등록' })
  await page.getByLabel('구성원 명단 파일').setInputFiles({ name: 'staff.csv', mimeType: 'text/csv', buffer: Buffer.from('\uFEFF구분,이름,연락처,이메일,아이디\r\nPM,첫째,010-0000-0000,example@example.com,csv.duplicate\r\n,둘째,,,csv.duplicate') })
  await region.getByRole('button', { name: '명단 검증', exact: true }).click()
  await expect(region.getByText('파일 안에 중복된 아이디 또는 행이 있습니다.', { exact: true })).toHaveCount(2)
  await region.getByLabel('둘째 발급 대상').uncheck()
  await region.getByRole('button', { name: '명단 검증', exact: true }).click()
  await expect(region.getByRole('button', { name: '확인 · 1명 계정 발급' })).toBeEnabled()
})

import { test, expect } from '@playwright/test'

test('ended sessions accept actual time and content, and admins download a dated workbook', async ({ page }) => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' })
  let record: null | { date: string; time: string; endTime: string; content: string; revision: number; updatedAt: number; updatedByName: string } = null
  let saved: Record<string, unknown> | null = null, exportUrl = ''
  const feedback = () => ({ activatedAt: 0, endAt: `${today}T00:50:00+09:00`, canRecord: true, record, requests: [
    { id: 'mentor-report', role: 'mentor', name: '김멘토', state: 'sent', error: '', sentAt: Date.now(), responses: [{ id: 'one', content: 'DM으로 남긴 멘토 응답', submittedAt: Date.now(), revision: 0, updatedAt: null }] },
  ] })
  await page.route(/\/api\/(?:workspaces\/default\/)?workspace$/, async route => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch(), data = await response.json()
    data.sessions = [{ id: 'record-session', title: '실제 시간 기록 테스트', mentor: '김멘토', team: '이멘티', date: today, time: '00:00', endDate: today, endTime: '00:50', status: '완료' }]
    await route.fulfill({ response, json: data })
  })
  await page.route('**/api/workspaces/default/mentoring/record-session/feedback**', async route => {
    if (route.request().method() === 'PUT') {
      expect(route.request().url()).toContain('/feedback/record')
      saved = route.request().postDataJSON()
      record = { ...(saved as { date: string; time: string; endTime: string; content: string }), revision: 1, updatedAt: Date.now(), updatedByName: '관리자' }
    }
    await route.fulfill({ json: feedback() })
  })
  await page.route('**/api/workspaces/default/mentoring/export**', async route => {
    exportUrl = route.request().url()
    await route.fulfill({ body: 'xlsx', headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '관리자 로그인', exact: true }).click()
  await page.getByLabel('관리자 비밀번호').fill('test-only-password-1234')
  await page.getByRole('button', { name: '로그인', exact: true }).click()
  await page.getByRole('navigation').getByRole('button', { name: '멘토링 일정' }).click()
  await page.locator('.mentoring-report summary').click()
  const panel = page.getByRole('region', { name: '실제 진행 기록' })
  await panel.getByRole('button', { name: '기록하기' }).click()
  const dialog = page.getByRole('dialog', { name: '실제 진행 기록' })
  await expect(dialog.getByLabel('멘토링 내용')).toHaveValue('DM으로 남긴 멘토 응답')
  await expect(dialog.getByLabel('시작 시간')).toHaveValue('00:00')
  await dialog.getByLabel('종료 시간').fill('00:00')
  await dialog.getByRole('button', { name: '저장', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('종료 시간은')
  await dialog.getByLabel('종료 시간').fill('00:40')
  await dialog.getByLabel('멘토링 내용').fill('실제로는 40분 진행\n다음: 배포 점검')
  await dialog.getByRole('button', { name: '저장', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(saved).toEqual({ date: today, time: '00:00', endTime: '00:40', content: '실제로는 40분 진행\n다음: 배포 점검', revision: 0 })
  await expect(panel).toContainText('00:00–00:40')
  await expect(panel).toContainText('다음: 배포 점검')
  await expect(panel.getByRole('button', { name: '수정' })).toBeVisible()

  await page.getByRole('button', { name: '엑셀 다운로드' }).click()
  const exporter = page.getByRole('dialog', { name: '멘토링 기록 엑셀 다운로드' })
  await exporter.getByLabel('시작일').fill('2026-11-01')
  await exporter.getByLabel('종료일').fill('2026-11-30')
  const download = page.waitForEvent('download')
  await exporter.getByRole('button', { name: '다운로드' }).click()
  expect((await download).suggestedFilename()).toBe('멘토링-기록_2026-11-01_2026-11-30.xlsx')
  expect(exportUrl).toContain('from=2026-11-01&to=2026-11-30')
  for (const width of [1440, 768, 360]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
})

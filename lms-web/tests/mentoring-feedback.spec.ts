import { test, expect } from '@playwright/test'

test('mentoring reports show both responses, delivery retries and readable mobile content', async ({ page }) => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' })
  let failed = true, showReplies = false
  const responses = () => ({ activatedAt: 0, endAt: `${today}T14:50:00+09:00`, requests: [
    { id: 'mentor-report', role: 'mentor', name: '김멘토', state: 'sent', error: '', sentAt: Date.now(), responses: [{ id: 'one', content: '고객 인터뷰를 분석했습니다.\n다음 주에는 가설을 검증합니다.', submittedAt: Date.now() }] },
    { id: 'mentee-report', role: 'mentee', name: '이멘티', state: failed ? 'failed' : 'sent', error: failed ? 'permissions' : '', sentAt: failed ? null : Date.now(), responses: showReplies ? [{ id: 'two', content: '피드백을 통해 가설의 우선순위를 정했습니다. ' + '자세한기록'.repeat(60), submittedAt: Date.now() }] : [] },
  ] })
  await page.route(/\/api\/(?:workspaces\/default\/)?workspace$/, async route => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch(), data = await response.json()
    data.sessions = [{ id: 'feedback-session', title: '프로젝트 결과 리뷰', mentor: '김멘토', team: '이멘티', date: today, time: '14:00', endDate: today, endTime: '14:50', status: '완료' }]
    await route.fulfill({ response, json: data })
  })
  await page.route('**/api/workspaces/default/mentoring/feedback-session/feedback**', async route => {
    if (route.request().method() === 'POST') failed = false
    await route.fulfill({ json: responses() })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '관리자 로그인', exact: true }).click()
  await page.getByLabel('관리자 비밀번호').fill('test-only-password-1234')
  await page.getByRole('button', { name: '로그인', exact: true }).click()
  await expect(page.getByRole('heading', { name: '운영 대시보드' })).toBeVisible()
  await page.getByRole('navigation').getByRole('button', { name: '멘토링 일정' }).click()
  await page.locator('.mentoring-report summary').click()
  await expect(page.getByRole('region', { name: '멘토 응답', exact: true })).toContainText('고객 인터뷰를 분석했습니다.')
  await expect(page.getByRole('region', { name: '멘티 응답', exact: true })).toContainText('DM 발송 실패')
  await page.getByRole('button', { name: 'DM 발송 재시도' }).click()
  await expect(page.getByRole('region', { name: '멘티 응답', exact: true })).toContainText('응답 대기')
  showReplies = true
  await page.locator('.mentoring-report').getByRole('button', { name: '새로고침', exact: true }).click()
  await expect(page.locator('.mentoring-report summary')).toContainText('응답 2/2')
  for (const width of [1440, 768, 360]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.getByRole('region', { name: '멘티 응답', exact: true })).toContainText('가설의 우선순위')
    await page.screenshot({ path: `test-results/mentoring-feedback-${width}.png`, fullPage: true, animations: 'disabled' })
  }
  await page.reload()
  await page.locator('.mentoring-report summary').click()
  await expect(page.locator('.mentoring-report summary')).toContainText('응답 2/2')
})

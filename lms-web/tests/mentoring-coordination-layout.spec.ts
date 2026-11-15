import { test, expect } from '@playwright/test'

test('mentoring panels keep padding, aligned refresh controls and recoverable states at every viewport', async ({ page }) => {
  let fail = false, release: (() => void) | undefined, delayed = false, writes = 0
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() !== 'GET') writes++
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 'mentor', username: 'mentor.layout', name: '테스트 멘토', role: 'student', discordId: '223456789012345678' } } })
    if (path === '/api/workspaces') return route.fulfill({ json: { workspaces: [{ id: 'layout', name: '멘토링 화면 검증', role: 'instructor', discordVerified: true, archivedAt: null, guildIds: ['123456789012345678'] }] } })
    if (path.endsWith('/teaching')) return route.fulfill({ json: {
      workspaceId: 'layout', name: '멘토링 화면 검증', mentorType: 'group', mode: 'api', onboardingComplete: true,
      courses: [], assignments: [], learners: [], mentors: [], teams: [], attendance: [], scores: [], notices: [], files: [], submissions: [], servers: [], logs: [],
      sessions: [1, 2].map(id => ({ id: String(id), title: '완료된 멘토링', mentor: '테스트 멘토', date: '2020-01-01', time: '14:00', status: '완료' })),
    } })
    if (path.endsWith('/mentoring/activities')) return route.fulfill({ json: { admin: false, canCreate: true, mentors: [{ id: 'mentor', name: '테스트 멘토', username: 'mentor.layout' }], courses: [], teams: [], students: [], records: [] } })
    if (path.endsWith('/mentoring/coordination')) {
      if (delayed) await new Promise<void>(resolve => { release = resolve })
      return fail ? route.fulfill({ status: 503, json: { error: '일정을 불러오지 못했습니다. 다시 시도하세요.' } }) : route.fulfill({ json: { sessions: [] } })
    }
    return route.fulfill({ status: 404, json: { error: 'Unexpected test route' } })
  })
  await page.goto('/?workspace=layout#mentoring')
  const panel = page.getByRole('region', { name: '멘토링 일정 재조율', exact: true })
  const refresh = panel.getByRole('button', { name: '멘토링 일정 새로고침', exact: true })
  await expect(panel).toContainText('재조율할 승인 예약이 없습니다.')
  for (const width of [1440, 768, 390, 360]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.evaluate(() => window.scrollTo(0, 0))
    const bounds = await panel.evaluate(node => {
      const box = node.getBoundingClientRect(), title = node.querySelector('h2')!.getBoundingClientRect(), button = node.querySelector('.coordination-refresh')!.getBoundingClientRect()
      return { left: title.left - box.left, top: title.top - box.top, right: box.right - button.right, height: button.height, overlap: title.right > button.left, headingTop: title.top, buttonBottom: button.bottom }
    })
    expect(bounds.left).toBeGreaterThanOrEqual(16)
    expect(bounds.top).toBeGreaterThanOrEqual(16)
    expect(bounds.right).toBeGreaterThanOrEqual(16)
    expect(bounds.height).toBeGreaterThanOrEqual(44)
    expect(bounds.overlap).toBe(false)
    expect(bounds.headingTop).toBeLessThan(bounds.buttonBottom)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const gap = await page.evaluate(() => document.querySelector('.mentoring-workspace')!.getBoundingClientRect().top - document.querySelector('.mentoring-coordination')!.getBoundingClientRect().bottom)
    expect(gap).toBeGreaterThanOrEqual(16)
    expect(gap).toBeLessThanOrEqual(24)
    await page.screenshot({ path: `test-results/mentoring-page-refined-${width}.png`, fullPage: true, animations: 'disabled' })
  }
  await panel.locator('summary').focus()
  await page.keyboard.press('Enter')
  await expect(panel.locator('.coordination-help')).toHaveAttribute('open', '')
  await expect(panel.locator('.coordination-help ol li')).toHaveCount(5)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/mentoring-help-refined-360.png', fullPage: true })
  await panel.locator('summary').click()

  delayed = true
  await refresh.click()
  await expect(refresh).toBeDisabled()
  await expect(refresh).toHaveAttribute('aria-busy', 'true')
  await expect(refresh).toContainText('확인 중')
  await expect.poll(() => !!release).toBe(true)
  fail = true; delayed = false; release!()
  await expect(panel.getByRole('alert')).toContainText('다시 시도')
  await expect(panel.locator('.coordination-empty')).toHaveCount(0)
  await expect(refresh).toBeEnabled()
  fail = false
  await refresh.click()
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await expect(panel).toContainText('재조율할 승인 예약이 없습니다.')
  await expect(refresh).toBeEnabled()
  await page.getByRole('button', { name: '멘토링 기록 새로고침' }).click()
  await expect(page.getByRole('button', { name: '멘토링 기록 새로고침' })).toBeEnabled()
  expect(writes).toBe(0)
})

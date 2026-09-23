import { test, expect } from '@playwright/test'

test('administrator pages remain usable on desktop and narrow mobile screens', async ({ page }) => {
  test.setTimeout(120000)
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: '관리자 로그인', exact: true }).click()
  await page.getByLabel('관리자 비밀번호').fill('test-only-password-1234')
  await page.getByRole('button', { name: '로그인', exact: true }).click()
  await expect(page.getByRole('heading', { name: '운영 대시보드' })).toBeVisible()
  const pages = ['dashboard', 'courses', 'teams', 'attendance', 'scores', 'mentoring', 'assignments', 'submissions', 'notices', 'files', 'members', 'student-accounts', 'discord', 'onboarding', 'connection', 'bot-data', 'bots', 'logs', 'settings']
  for (const route of pages) {
    await page.evaluate(route => { location.hash = route }, route)
    await expect(page.locator('main h1').first()).toBeVisible()
    for (const width of [1440, 390, 360]) {
      await page.setViewportSize({ width, height: 1000 })
      if (width < 760) await expect(page.locator('.sidebar')).not.toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), route + ' at ' + width).toBeTruthy()
      if (width !== 390) await page.screenshot({ path: 'test-results/ui-review/' + route + '-' + width + '.png', fullPage: true, animations: 'disabled' })
    }
  }
  expect(errors).toEqual([])
})

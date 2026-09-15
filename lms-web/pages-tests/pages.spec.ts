import { test, expect } from '@playwright/test'

test('Pages subpath loads demo assets and hash routes without an API', async ({ page }) => {
  const errors: string[] = []
  const failedResources: string[] = []
  const apiRequests: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('requestfailed', request => failedResources.push(request.url()))
  page.on('response', response => { if (response.status() >= 400) failedResources.push(response.url()) })
  page.on('request', request => { if (new URL(request.url()).pathname.includes('/api/')) apiRequests.push(request.url()) })
  await page.goto('/asanAX-mentoring/?demo=1#dashboard')
  await expect(page.getByRole('heading', { name: '운영 대시보드' })).toBeVisible()
  expect(await page.locator('link[rel="icon"]').getAttribute('href')).toBe('/asanAX-mentoring/favicon.svg')
  await page.getByRole('button', { name: '새 과정 만들기' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('과정명', { exact: true }).fill('Pages 테스트 과정')
  await dialog.getByLabel('과정 코드').fill('PAGES-TEST')
  await dialog.getByLabel('시작일').fill('2026-09-01')
  await dialog.getByLabel('종료일').fill('2026-12-01')
  await dialog.getByLabel('과정 소개').fill('Pages 배포 경로 검증')
  await dialog.getByRole('button', { name: '만들기', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await page.reload()
  await page.getByRole('navigation').getByRole('button', { name: '학습 과정', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Pages 테스트 과정' })).toBeVisible()
  await page.goto('/asanAX-mentoring/?demo=1#asan')
  await expect(page.getByText('데모 · 운영 API 미연결', { exact: true })).toBeVisible()
  await expect(page.getByText('현재 상태 확인 불가', { exact: true })).toBeVisible()
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    await page.screenshot({ path: `test-results-pages/pages-${width}.png`, fullPage: true, animations: 'disabled' })
  }
  expect(errors).toEqual([])
  expect(failedResources).toEqual([])
  expect(apiRequests).toEqual([])
})

test('Pages opens login and signup previews with explicit demo entry', async ({ page }) => {
  const apiRequests: string[] = []
  page.on('request', request => { if (new URL(request.url()).pathname.includes('/api/')) apiRequests.push(request.url()) })
  await page.goto('/asanAX-mentoring/')
  await expect(page.getByRole('heading', { name: 'LMS 로그인' })).toBeVisible()
  await expect(page.locator('form').getByRole('button', { name: '로그인', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '회원가입', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'LMS 회원가입' })).toBeVisible()
  await expect(page.getByRole('button', { name: '인증 코드 받기' })).toBeDisabled()
  await page.getByRole('button', { name: '데모 둘러보기' }).click()
  await expect(page.getByRole('heading', { name: '운영 대시보드' })).toBeVisible()
  expect(apiRequests).toEqual([])
})

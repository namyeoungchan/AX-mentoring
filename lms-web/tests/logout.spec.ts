import { test, expect } from '@playwright/test'

async function login(page: import('@playwright/test').Page, url: string) {
  await page.goto(url)
  await page.getByRole('button', { name: '관리자 로그인', exact: true }).click()
  await page.getByLabel('관리자 비밀번호').fill('test-only-password-1234')
  const response = page.waitForResponse(r => r.url().endsWith('/api/login') && r.request().method() === 'POST')
  await page.getByRole('button', { name: '로그인', exact: true }).click()
  const session = await (await response).json()
  await expect(page.getByRole('heading', { name: '운영 대시보드', exact: true })).toBeVisible()
  return session.token
}

test('header logout revokes the cookie session and keeps the login screen after reload', async ({ page }) => {
  const token = await login(page, '/#dashboard')
  await page.setViewportSize({ width: 360, height: 850 })
  const logout = page.getByRole('banner').getByRole('button', { name: '로그아웃', exact: true })
  await expect(logout).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  await logout.click()
  await expect(page.getByRole('heading', { name: 'LMS 로그인', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/#login$/)
  expect((await page.request.get('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(401)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'LMS 로그인', exact: true })).toBeVisible()
})

test('failed logout keeps the session visible and can be retried', async ({ page }) => {
  await login(page, '/#dashboard')
  await page.route('**/api/logout', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary outage' }) }))
  await page.getByRole('banner').getByRole('button', { name: '로그아웃', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('로그아웃하지 못했습니다.')
  await expect(page.getByRole('heading', { name: '운영 대시보드', exact: true })).toBeVisible()
  await page.unroute('**/api/logout')
  await page.getByRole('banner').getByRole('button', { name: '로그아웃', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'LMS 로그인', exact: true })).toBeVisible()
})

test('Pages-style bearer login is revoked on logout and cannot be replayed', async ({ page, request }) => {
  const token = await login(page, 'http://127.0.0.1:5176/#dashboard')
  expect((await request.get('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(200)
  await page.getByRole('banner').getByRole('button', { name: '로그아웃', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'LMS 로그인', exact: true })).toBeVisible()
  expect((await request.get('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(401)
})

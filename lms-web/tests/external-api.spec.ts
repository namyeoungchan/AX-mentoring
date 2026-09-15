import { test, expect } from '@playwright/test'

test('external API login, mutation and logout work without cookies', async ({ page, context }) => {
  await page.goto('http://127.0.0.1:5176/#dashboard')
  await page.getByRole('button', { name: '관리자 로그인', exact: true }).click()
  await expect(page.getByRole('heading', { name: '관리자 로그인' })).toBeVisible()
  await page.getByLabel('관리자 비밀번호').fill('test-only-password-1234')
  await page.getByRole('button', { name: '로그인', exact: true }).click()
  await expect(page.getByRole('heading', { name: '운영 대시보드' })).toBeVisible()
  expect(await context.cookies()).toEqual([])
  await page.getByRole('button', { name: '새 과정 만들기' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('과정명', { exact: true }).fill('외부 API 과정')
  await dialog.getByLabel('과정 코드').fill('CROSS-ORIGIN')
  await dialog.getByLabel('시작일').fill('2026-09-01')
  await dialog.getByLabel('종료일').fill('2026-12-01')
  await dialog.getByLabel('과정 소개').fill('외부 API 저장 검증')
  await dialog.getByRole('button', { name: '만들기', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await page.goto('http://127.0.0.1:5176/#asan')
  await expect(page.getByText('데이터 수신 대기', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '로그아웃' }).click()
  await expect(page.getByRole('heading', { name: 'LMS 로그인' })).toBeVisible()
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([])
})

test('preflight restricts origins and logout invalidates bearer sessions', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3002' })
  try {
    const origin = 'http://127.0.0.1:5176'
    const preflight = await api.fetch('/api/workspace', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'authorization,content-type' } })
    expect(preflight.status()).toBe(204)
    expect(preflight.headers()['access-control-allow-origin']).toBe(origin)
    expect(preflight.headers()['access-control-allow-headers']).toContain('Authorization')
    expect((await api.fetch('/api/workspace', { method: 'OPTIONS', headers: { Origin: 'https://untrusted.example' } })).status()).toBe(403)
    const login = await api.post('/api/login', { data: { password: 'test-only-password-1234' }, headers: { Origin: origin } })
    const { token } = await login.json()
    expect(typeof token).toBe('string')
    const headers = { Origin: origin, Authorization: `Bearer ${token}`, Cookie: '' }
    expect((await api.get('/api/workspace', { headers })).status()).toBe(200)
    expect((await api.get('/api/workspace', { headers: { ...headers, Authorization: 'Bearer invalid' } })).status()).toBe(401)
    expect((await api.post('/api/logout', { headers, data: {} })).status()).toBe(200)
    expect((await api.get('/api/workspace', { headers })).status()).toBe(401)
  } finally { await api.dispose() }
})

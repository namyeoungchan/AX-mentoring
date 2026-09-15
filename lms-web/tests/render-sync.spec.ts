import { test, expect } from '@playwright/test'

test('Render worker data arrives without admin login and displays read-only in the authenticated web', async ({ page, request }) => {
  expect((await request.get('/api/integrations/render')).status()).toBe(401)
  expect((await request.post('/api/integrations/render/snapshot', { data: {} })).status()).toBe(401)
  await page.goto('/#asan')
  await page.getByRole('button', { name: '관리자 로그인', exact: true }).click()
  await page.getByLabel('관리자 비밀번호').fill('test-only-password-1234')
  await page.getByRole('button', { name: '로그인', exact: true }).click()
  await expect(page.getByRole('heading', { name: '봇 연결 현황', exact: true })).toBeVisible()
  await expect(page.getByText('데이터 수신 대기', { exact: true })).toBeVisible()
  const payload = { sourceId: 'asan-ax', name: '아산 AX', capturedAt: new Date().toISOString(), rowLimit: 1000,
    bot: { name: 'asanAX', ready: true, latencyMs: 80, guildId: '123456789012345678', guildName: '아산 AX Discord', memberCount: 84 },
    counts: { mentors: 1, bookings: 1, assignments: 1, submissions: 1, onboarding_progress: 30, pending_bookings: 1 },
    mentors: [{ id: 1, name: '운영멘토', discord_id: '223456789012345678', bio: '개발' }],
    bookings: [{ id: 1, user_name: '운영학생', status: 'pending', label: '프로젝트 점검', start_time: '2026-09-16T14:00:00', end_time: '2026-09-16T14:50:00', mentor_name: '운영멘토' }],
    assignments: [{ id: 1, week: 1, title: '운영과제', due_date: '2026-09-20', type: 'team', is_active: 1, submitted: 1 }],
    submissions: [{ id: 1, assignment_id: 1, user_name: '운영학생', team: '팀1', content: '실제 수신 형식의 제출 데이터', link: 'https://example.com/submission', submitted_at: '2026-09-15', assignment_title: '운영과제' }],
  }
  const response = await request.post('/api/integrations/render/snapshot', { headers: { Authorization: 'Bearer test-only-sync-token-12345678901234567890' }, data: payload })
  expect(response.status()).toBe(200)
  await page.reload()
  await expect(page.getByText('동기화 정상', { exact: true })).toBeVisible()
  await expect(page.getByText('연결됨', { exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: '운영멘토', exact: true })).toBeVisible()
  await page.locator('.remote-tabs').getByRole('button', { name: '멘토링 예약' }).click()
  await expect(page.getByRole('cell', { name: '프로젝트 점검' })).toBeVisible()
  await expect(page.getByRole('button', { name: '승인', exact: true })).toHaveCount(0)
  await page.locator('.remote-tabs').getByRole('button', { name: '제출 내역' }).click()
  await expect(page.getByRole('cell', { name: '실제 수신 형식의 제출 데이터' })).toBeVisible()
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    await page.screenshot({ path: `test-results/asan-${width}.png`, fullPage: true, animations: 'disabled' })
  }
  // Fresh delivery with old capturedAt remains visibly stale, not falsely online.
  await page.route('**/api/workspaces/asan-ax/integrations/render', route => route.fulfill({ json: { configured: true, sourceId: 'asan-ax', state: 'stale', receivedAt: new Date().toISOString(), snapshot: payload } }))
  await page.reload()
  await expect(page.getByText('동기화 지연', { exact: true })).toBeVisible()
  await expect(page.getByText('현재 상태 확인 불가', { exact: true })).toBeVisible()
})

import { test, expect } from '@playwright/test'

test('students and group mentors negotiate through the same UI; main instructors have no coordination controls', async ({ page }) => {
  let role = 'student', mentorType = 'group'
  const appointment = {
    id: '1', title: '프로젝트 리뷰', mentor: '김멘토', student: '이수강', start: '2031-01-03T15:00:00', end: '2031-01-03T16:00:00',
    editable: true, version: 0, status: 'confirmed', unavailable: [] as string[],
    proposal: null as null | { by: string; start: string; end: string; reason: string; expiresAt: number },
    slots: [{ id: '2', start: '2031-01-04T15:00:00', end: '2031-01-04T16:00:00' }], history: [], deliveries: [],
  }
  const submissions: Record<string, unknown>[] = []
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: role, username: role, name: role === 'student' ? '이수강' : '김멘토', role: 'student', discordId: '223456789012345678' } } })
    if (path === '/api/workspaces') return route.fulfill({ json: { workspaces: [{ id: 'coord-ui', name: '일정 조율 검증', role, discordVerified: true, archivedAt: null, guildIds: ['123456789012345678'] }] } })
    if (path.endsWith('/me/learning')) return route.fulfill({ json: { enrollment: null, courses: [], attendance: [], scores: [], assignments: [] } })
    if (path.endsWith('/teaching')) return route.fulfill({ json: { workspaceId: 'coord-ui', name: '일정 조율 검증', mentorType, mode: 'api', onboardingComplete: true, courses: [], sessions: [], assignments: [], learners: [], mentors: [], teams: [], attendance: [], scores: [], notices: [], files: [], submissions: [], servers: [], logs: [] } })
    if (path.endsWith('/mentoring/activities')) return route.fulfill({ json: { admin: false, canCreate: true, mentors: [{ id: 'instructor', name: '김멘토', username: 'instructor' }], courses: [], teams: [], students: [], records: [] } })
    if (path.endsWith('/mentoring/coordination')) return route.fulfill({ json: { sessions: [{ ...appointment, role: role === 'student' ? 'student' : 'mentor' }] } })
    if (path.endsWith('/mentoring/1/coordination') && route.request().method() === 'POST') {
      const body = route.request().postDataJSON()
      submissions.push(body)
      if (body.action === 'propose') {
        appointment.status = 'proposed'; appointment.unavailable = ['student']
        appointment.proposal = { by: 'student', ...appointment.slots[0], reason: body.reason, expiresAt: Date.parse('2031-01-02T00:00:00+09:00') }
      } else if (body.action === 'accept') {
        appointment.status = 'confirmed'; appointment.unavailable = []; appointment.proposal = null
        appointment.start = appointment.slots[0].start; appointment.end = appointment.slots[0].end
      }
      appointment.version++
      return route.fulfill({ json: { ok: true } })
    }
    return route.fulfill({ status: 404, json: { error: 'Unexpected test route' } })
  })
  await page.goto('/?workspace=coord-ui#mentoring')
  const panel = page.getByRole('region', { name: '멘토링 일정 재조율' })
  await expect(panel.getByRole('heading', { name: '멘토링 일정 재조율' })).toBeVisible()
  await panel.getByRole('button', { name: '다른 시간 제안', exact: true }).click()
  await panel.getByLabel('변경할 시간').selectOption('2')
  await panel.getByLabel('기존 일정 참석 가능 여부').selectOption('no')
  await panel.getByLabel('사유', { exact: true }).fill('프로젝트 발표 일정이 변경되었습니다.')
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await panel.locator('.coordination-actions button, .coordination-form button').evaluateAll(buttons => buttons.every(button => button.getBoundingClientRect().height >= 44))).toBe(true)
    await page.screenshot({ path: `test-results/mentoring-coordination-form-${width}.png`, fullPage: true, animations: 'disabled' })
  }
  await panel.getByRole('button', { name: '다른 시간 제안 저장' }).click()
  await expect(panel).toContainText('변경 응답 대기')
  expect(submissions[0]).toMatchObject({ action: 'propose', version: 0, slotId: '2', originalAvailable: false })
  await expect(panel.getByRole('button', { name: '변경 수락', exact: true })).toHaveCount(0)
  await expect(panel).toContainText('기존 시간에 참석할 수 없습니다')
  for (const width of [1440, 768, 360]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  role = 'instructor'
  await page.reload()
  await panel.getByRole('button', { name: '변경 수락', exact: true }).click()
  await panel.getByRole('button', { name: '변경 수락 저장' }).click()
  await expect(panel).toContainText('예약 확정')
  expect(submissions[1]).toMatchObject({ action: 'accept', version: 1 })
  await expect(panel).toContainText('2031-01-04 15:00')
  mentorType = 'main'
  await page.reload()
  await expect(page.getByRole('region', { name: '멘토링 일정 관리' })).toBeVisible()
  await expect(panel).toHaveCount(0)
})

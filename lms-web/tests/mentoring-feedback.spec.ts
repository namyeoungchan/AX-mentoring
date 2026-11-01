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
  await expect(page.getByRole('button', { name: '멘토 응답 수정' })).toHaveCount(0)
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

test('mentor response editing preserves drafts, student content and original submission time', async ({ page }) => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' })
  const submittedAt = Date.now() - 86400000
  const original = 'GPU 사용 가능 여부 질의에 CPU 소형 모델 테스트 안내'
  const student = '학생이 직접 남긴 원문: 수정되면 안 됩니다.'
  let content = original, revision = 0, updatedAt: number | null = null, failure = 0, reads = 0, writes = 0, canEdit = true
  const responses = () => ({ activatedAt: 0, endAt: `${today}T14:50:00+09:00`, requests: [
    { id: 'mentor-report', role: 'mentor', name: '김멘토', state: 'sent', error: '', sentAt: submittedAt, canEdit, responses: [
      { id: 'one', content, submittedAt, revision, updatedAt },
      { id: 'additional', content: '별도 추가 응답은 그대로 유지', submittedAt, revision: 0, updatedAt: null },
    ] },
    // Defense in depth: even a malformed canEdit flag must not expose a student editor.
    { id: 'mentee-report', role: 'mentee', name: '이멘티', state: 'sent', error: '', sentAt: submittedAt, canEdit: true, responses: [{ id: 'two', content: student, submittedAt, revision: 0, updatedAt: null }] },
  ] })
  await page.route(/\/api\/(?:workspaces\/default\/)?workspace$/, async route => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch(), data = await response.json()
    data.sessions = [{ id: 'feedback-edit-session', title: '일지 보완 테스트', mentor: '김멘토', team: '이멘티', date: today, time: '14:00', endDate: today, endTime: '14:50', status: '완료' }]
    await route.fulfill({ response, json: data })
  })
  await page.route('**/api/workspaces/default/mentoring/feedback-edit-session/feedback**', async route => {
    if (route.request().method() === 'PATCH') {
      writes++
      expect(route.request().url()).toContain('/feedback/mentor-report/responses/one')
      if (failure) return route.fulfill({ status: failure, json: { error: failure === 409 ? '다른 창에서 기록이 수정되었습니다. 작성 내용을 보관하고 최신 기록을 다시 확인해 주세요.' : '저장 실패' } })
      const body = route.request().postDataJSON()
      expect(Object.keys(body).sort()).toEqual(['content', 'revision'])
      expect(body.revision).toBe(revision)
      content = body.content.trim(); revision++; updatedAt = Date.now()
    } else reads++
    await route.fulfill({ json: responses() })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '관리자 로그인', exact: true }).click()
  await page.getByLabel('관리자 비밀번호').fill('test-only-password-1234')
  await page.getByRole('button', { name: '로그인', exact: true }).click()
  await page.getByRole('navigation').getByRole('button', { name: '멘토링 일정' }).click()
  await page.locator('.mentoring-report summary').click()
  const mentorPanel = page.getByRole('region', { name: '멘토 응답', exact: true })
  const studentPanel = page.getByRole('region', { name: '멘티 응답', exact: true })
  await expect(mentorPanel.getByRole('button', { name: '멘토 응답 수정' })).toHaveCount(2)
  await expect(studentPanel.getByRole('button')).toHaveCount(0)
  await expect(studentPanel).toContainText(student)
  await mentorPanel.getByRole('button', { name: '멘토 응답 수정' }).first().click()
  const dialog = page.getByRole('dialog', { name: '멘토 응답 수정' })
  const field = dialog.getByLabel('멘토링 내용')
  await expect(field).toHaveValue(original)
  await expect(field).toBeFocused()
  await expect(dialog.getByRole('button', { name: '저장', exact: true })).toBeDisabled()
  await field.fill('  ')
  await expect(dialog.getByRole('button', { name: '저장', exact: true })).toBeDisabled()
  const revised = 'Ollama · qwen3:1.7b 테스트 권고\n후속: 메모리 사용량과 근거 정확도 측정'
  await field.fill(revised)
  // Automatic 30-second refresh must not replace an in-progress edit.
  await page.clock.install()
  const readsBefore = reads
  await page.clock.fastForward(31000)
  expect(reads).toBe(readsBefore)
  await expect(field).toHaveValue(revised)
  page.once('dialog', prompt => prompt.dismiss())
  await dialog.getByRole('button', { name: '취소', exact: true }).click()
  await expect(dialog).toBeVisible()
  expect(writes).toBe(0)
  failure = 500
  await dialog.getByRole('button', { name: '저장', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('저장 결과를 확인하지 못했습니다.')
  await expect(field).toHaveValue(revised)
  failure = 409
  await dialog.getByRole('button', { name: '저장', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('다른 창에서 기록이 수정되었습니다.')
  await expect(field).toHaveValue(revised)
  for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await expect(dialog.getByRole('button', { name: '저장', exact: true })).toBeVisible()
    await page.screenshot({ path: `test-results/mentoring-feedback-edit-${width}.png`, fullPage: true, animations: 'disabled' })
  }
  failure = 0
  await dialog.getByRole('button', { name: '저장', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(mentorPanel).toContainText(revised)
  await expect(mentorPanel).toContainText('수정:')
  await expect(mentorPanel.locator('time').first()).toHaveAttribute('datetime',new Date(submittedAt).toISOString())
  await expect(mentorPanel).toContainText('별도 추가 응답은 그대로 유지')
  await expect(studentPanel).toContainText(student)
  await expect(studentPanel).not.toContainText('수정:')
  await mentorPanel.getByRole('button', { name: '멘토 응답 수정' }).first().click()
  await field.fill('이 초안은 취소')
  page.once('dialog', prompt => prompt.accept())
  await dialog.getByRole('button', { name: '취소', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(writes).toBe(3)
  await expect(mentorPanel).toContainText(revised)
  await page.reload()
  await page.locator('.mentoring-report summary').click()
  await expect(mentorPanel).toContainText(revised)
  canEdit = false
  await page.locator('.mentoring-report').getByRole('button', { name: '새로고침', exact: true }).click()
  await expect(mentorPanel.getByRole('button', { name: '멘토 응답 수정' })).toHaveCount(0)
})

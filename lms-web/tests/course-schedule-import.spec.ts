import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

test('schedule sample downloads, previews and requires explicit replacement and save', async ({ page }) => {
  await page.request.post('/api/login', { data: { password: 'test-only-password-1234' } })
  const w = await (await page.request.post('/api/workspaces', { data: { name: '엑셀 일정 검증' } })).json(), base = `/api/workspaces/${w.id}`
  const course = { id: 'import-course', title: '엑셀 일정 과정', category: 'AX', description: '시간표 가져오기', progress: 0, learners: 0, weeks: '4주 과정', mentor: '', theme: 'green', status: '모집 중', code: 'IMPORT', cohort: '1기', startDate: '2026-09-01', endDate: '2026-09-30' }
  const state = await (await page.request.get(`${base}/workspace`)).json()
  expect((await page.request.patch(`${base}/workspace`, { data: { revision: state.revision, changes: [{ kind: 'courses', value: course }] } })).ok()).toBe(true)
  await page.goto(`/?workspace=${w.id}#courses`)
  await page.getByRole('button', { name: /엑셀 일정 과정/ }).click()
  const modal = page.getByRole('dialog', { name: course.title })
  await modal.getByRole('button', { name: '주차별 일정', exact: true }).click()
  const download = page.waitForEvent('download')
  await modal.getByRole('link', { name: '일정 샘플 다운로드' }).click()
  expect((await download).suggestedFilename()).toBe('과정-일정-샘플.xlsx')
  const file = resolve('public/templates/course-schedule-template.xlsx')
  await modal.getByLabel('일정 엑셀 파일').setInputFiles(file)
  await expect(modal.locator('.schedule-import-preview')).toContainText('등록 가능 5개 · 오류 0개 · 제외 2개')
  expect((await (await page.request.get(`${base}/courses/${course.id}/manage`)).json()).course.schedule || []).toHaveLength(0)
  await modal.getByRole('button', { name: '가져오기 취소' }).click()
  await expect(modal.locator('.course-session-editor')).toHaveCount(0)
  await modal.getByLabel('일정 엑셀 파일').setInputFiles(file)
  await modal.getByRole('button', { name: '확인 · 편집에 반영' }).click()
  await expect(modal.locator('.course-session-editor')).toHaveCount(5)
  await expect(modal.locator('.course-session-editor').first()).toContainText('OT · 과정 안내 및 준비')
  await modal.getByRole('button', { name: '일정 저장', exact: true }).click()
  await expect(modal.getByRole('status')).toContainText('주차별 일정을 저장했습니다.')
  const saved = (await (await page.request.get(`${base}/courses/${course.id}/manage`)).json()).course
  expect(saved.schedule).toHaveLength(5); expect(saved.startDate).toBe('2026-09-12'); expect(saved.weeks).toBe('2주 과정')
  await modal.getByLabel('일정 엑셀 파일').setInputFiles(file)
  await expect(modal.locator('.schedule-import-preview')).toBeVisible()
  await modal.evaluate(el => el.scrollTo(0, 0))
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await modal.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await page.screenshot({ path: `test-results/schedule-import-${width}.png`, animations: 'disabled' })
  }
})

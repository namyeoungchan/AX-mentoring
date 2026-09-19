import { test, expect } from '@playwright/test'

test('learner deletion confirms scope, supports cancellation and preserves historical scores', async ({ page }) => {
  await page.request.post('/api/login', { data: { password: 'test-only-password-1234' } })
  const w = await (await page.request.post('/api/workspaces', { data: { name: '수강생 삭제 화면 검증' } })).json()
  const base = `/api/workspaces/${w.id}`
  const groups = await (await page.request.get(`${base}/discord/groups`)).json()
  const setup = await (await page.request.post(`${base}/discord/groups`, { data: { count: 1, title: '삭제 검증 과정', revision: groups.revision } })).json()
  const state = await (await page.request.get(`${base}/workspace`)).json()
  const learner = { id: 'removal-ui', name: '삭제 검증 학생', courseId: setup.courseId, team: setup.teams[0].name, email: '', discordId: '', status: '정상', progress: 0, color: 'sage' }
  expect((await page.request.patch(`${base}/workspace`, { data: { revision: state.revision, changes: [
    { kind: 'learners', value: learner },
    { kind: 'scores', value: { id: 'removal-score', studentId: learner.id, courseId: learner.courseId, item: '프로젝트', score: 80, maximum: 100 } },
  ] } })).status()).toBe(200)
  await page.goto(`/?workspace=${w.id}#learners`)
  const button = page.getByRole('button', { name: '삭제 검증 학생 수강생 삭제', exact: true })
  await button.click()
  const dialog = page.getByRole('dialog', { name: '수강생 삭제 확인' })
  await expect(dialog).toContainText('성적 1건')
  await expect(dialog).toContainText('다른 워크스페이스 소속은 유지')
  await dialog.getByRole('button', { name: '취소', exact: true }).click()
  await expect(button).toBeVisible()
  await page.setViewportSize({ width: 390, height: 900 })
  await button.click()
  await expect(dialog.getByRole('button', { name: '수강생 삭제', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/learner-removal-mobile.png' })
  await dialog.getByRole('button', { name: '수강생 삭제', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(button).toHaveCount(0)
  await page.reload()
  await expect(button).toHaveCount(0)
  await page.goto(`/?workspace=${w.id}#scores`)
  await expect(page.getByRole('cell', { name: '삭제 검증 학생 (삭제된 수강생)', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '수정', exact: true }).click()
  await expect(page.getByRole('dialog').getByLabel('수강생', { exact: true })).toHaveValue(learner.id)
})

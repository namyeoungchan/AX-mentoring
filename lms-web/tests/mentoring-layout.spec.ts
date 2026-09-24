import { test, expect, type Page } from '@playwright/test'
import type { Session } from '../src/data'

const sessions: Session[] = [
  { id: 'confirmed', title: 'AI 서비스 기획 피드백', mentor: '김민준', mentorId: 'm1', studentId: 'l1', team: '1조', date: '2026-09-15', time: '14:00', status: '예약 확정' },
  { id: 'waiting', title: '프로젝트 중간 점검', mentor: '박서연', mentorId: 'm2', studentId: 'l2', team: '2조', date: '2026-09-15', time: '17:30', status: '승인 대기' },
  { id: 'long', title: '고객 인터뷰 결과를 바탕으로 한 생성형 AI 서비스 검증 및 다음 단계 실행 계획 리뷰', mentor: '김민준', mentorId: 'm1', studentId: 'l3', team: '3조 · 고객경험 개선 프로젝트', date: '2026-09-16', time: '11:00', status: '승인 대기' },
  { id: 'done', title: '데이터 분석 결과 리뷰', mentor: '박서연', mentorId: 'm2', studentId: 'l4', team: '4조', date: '2026-09-14', time: '10:00', status: '완료' },
  { id: 'cancelled', title: '취소된 기획 상담', mentor: '박서연', mentorId: 'm2', studentId: 'l5', team: '5조', date: '2026-09-17', time: '16:00', status: '취소' },
  { id: 'past-waiting', title: '이전 주 미처리 예약', mentor: '김민준', mentorId: 'm1', studentId: 'l6', team: '6조', date: '2026-08-27', time: '10:00', status: '승인 대기' },
  { id: 'future-waiting', title: '다음 달 프로젝트 리뷰', mentor: '박서연', mentorId: 'm2', studentId: 'l7', team: '7조', date: '2026-11-05', time: '15:00', status: '승인 대기' },
  ...Array.from({ length: 12 }, (_, index): Session => ({ id: `history-${index}`, title: `지난 멘토링 ${index + 1}`, mentor: '김민준', mentorId: 'm1', team: '1조', date: `2026-08-${String(index + 1).padStart(2, '0')}`, time: '09:00', status: '완료' })),
]
async function openPlanner(page: Page) {
  await page.addInitScript(records => {
    if (!localStorage.getItem('asanax-campus-demo-v1')) localStorage.setItem('asanax-campus-demo-v1', JSON.stringify({
      sessions: records,
      mentors: [{ id: 'm1', name: '김민준', discordId: '', bio: '' }, { id: 'm2', name: '박서연', discordId: '', bio: '' }],
      learners: Array.from({ length: 7 }, (_, index) => ({ id: `l${index + 1}`, name: ['이도윤', '정하린', '최유진', '김지호', '박수빈', '한서준', '이서현'][index], team: `${index + 1}조`, discordId: '', courseId: 'c1', email: '', status: '정상', progress: 0, color: 'sage' })),
    }))
  }, sessions)
  await page.goto('/?demo=1#mentoring')
  await expect(page.locator('.mentoring-session')).toHaveCount(5)
}
const row = (page: Page, id: string) => page.locator(`[data-session-id="${id}"]`)

test('weekly agenda exposes dates, aligned actions and readable mobile layouts', async ({ page }) => {
  await openPlanner(page)
  for (const width of [1440, 1280, 768, 390, 360]) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: `test-results/mentoring-week-${width}.png`, fullPage: true, animations: 'disabled' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const bounds = await page.locator('.mentoring-week-days button, .mentoring-session-actions button').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right, height: rect.height }
    }))
    expect(bounds.every(rect => rect.left >= 0 && rect.right <= width && rect.height >= 40)).toBe(true)
    expect(await page.locator('.mentoring-agenda').evaluate(element => element.getBoundingClientRect().top)).toBeLessThan(740)
    if (width >= 1280) {
      const lefts = await page.locator('.mentoring-session-actions').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().left))
      expect(Math.max(...lefts) - Math.min(...lefts)).toBeLessThan(1)
    }
  }
  await page.getByRole('button', { name: '2026-09-16 일정', exact: true }).click()
  await expect(page.locator('.mentoring-session')).toHaveCount(1)
  await expect(row(page, 'long')).toBeVisible()
  await page.getByRole('button', { name: '주 전체 보기', exact: true }).click()
  await page.getByRole('button', { name: '다음 주 일정', exact: true }).click()
  await expect(page.getByText('선택한 주에 등록된 일정이 없습니다.')).toBeVisible()
  await page.getByLabel('주간 일정 날짜 이동').fill('2026-11-05')
  await expect(row(page, 'future-waiting')).toBeVisible()
  await page.getByRole('button', { name: '오늘', exact: true }).click()
  await expect(page.locator('.mentoring-session')).toHaveCount(2)
})

test('approval queue spans all dates and supports approval, completion, cancellation and history search', async ({ page }) => {
  await openPlanner(page)
  await page.getByRole('navigation', { name: '일정 보기' }).getByRole('button', { name: /^승인 대기/ }).click()
  await expect(page.locator('.mentoring-session')).toHaveCount(4)
  await expect(row(page, 'past-waiting')).toBeVisible()
  await expect(row(page, 'future-waiting')).toBeVisible()
  await row(page, 'waiting').getByRole('button', { name: '승인', exact: true }).click()
  await expect(row(page, 'waiting')).toHaveCount(0)
  await expect(page.locator('.mentoring-feedback')).toContainText('예약을 승인했습니다.')
  await expect(page.locator('#mentoring-list-title')).toBeFocused()
  await row(page, 'past-waiting').getByRole('button', { name: '취소', exact: true }).click()
  await expect(row(page, 'past-waiting').getByText('이 예약을 취소할까요?')).toBeVisible()
  await row(page, 'past-waiting').getByRole('button', { name: '돌아가기' }).click()
  await expect(row(page, 'past-waiting').getByText('이 예약을 취소할까요?')).toHaveCount(0)
  await row(page, 'past-waiting').getByRole('button', { name: '취소', exact: true }).click()
  await row(page, 'past-waiting').getByRole('button', { name: '예약 취소', exact: true }).click()
  await expect(page.locator('.mentoring-session')).toHaveCount(2)
  await page.getByRole('navigation', { name: '일정 보기' }).getByRole('button', { name: /^주간 일정/ }).click()
  await row(page, 'waiting').getByRole('button', { name: '완료 처리' }).click()
  await expect(row(page, 'waiting')).toContainText('진행 완료')
  await page.getByRole('navigation', { name: '일정 보기' }).getByRole('button', { name: /^전체 일정/ }).click()
  await expect(page.locator('.mentoring-session')).toHaveCount(10)
  await page.getByRole('button', { name: '일정 더 보기' }).click()
  await expect(page.locator('.mentoring-session')).toHaveCount(19)
  await page.getByLabel('일정 검색', { exact: true }).fill('정하린')
  await expect(page.locator('.mentoring-session')).toHaveCount(1)
  await expect(row(page, 'waiting')).toContainText('완료')
  await page.getByLabel('일정 검색', { exact: true }).fill('')
  await page.getByLabel('담당 멘토 필터').selectOption('m1')
  await page.getByLabel('예약 상태 필터').selectOption('취소')
  await expect(page.locator('.mentoring-session')).toHaveCount(1)
  await expect(row(page, 'past-waiting')).toContainText('취소된 예약')
  await page.reload()
  await page.getByRole('navigation', { name: '일정 보기' }).getByRole('button', { name: /^승인 대기/ }).click()
  await expect(page.locator('.mentoring-session')).toHaveCount(2)
  for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 900 })
    await page.screenshot({ path: `test-results/mentoring-pending-${width}.png`, fullPage: true, animations: 'disabled' })
  }
})

test('registering a future appointment opens its date and clears stale search filters', async ({ page }) => {
  await openPlanner(page)
  await page.getByLabel('일정 검색', { exact: true }).fill('없는 주제')
  await page.getByRole('button', { name: '일정 등록', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('날짜', { exact: true })).toHaveValue(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }))
  await dialog.getByLabel('멘토링 주제').fill('연말 프로젝트 회고')
  await dialog.getByRole('combobox', { name: '담당 멘토', exact: true }).selectOption('m1')
  await dialog.getByRole('combobox', { name: '수강생', exact: true }).selectOption('l1')
  await dialog.getByLabel('날짜', { exact: true }).fill('2026-12-31')
  await dialog.getByLabel('시작 시간').fill('14:30')
  await page.setViewportSize({ width: 360, height: 900 })
  await page.screenshot({ path: 'test-results/mentoring-register-360.png', fullPage: true, animations: 'disabled' })
  const formFits = await dialog.evaluate(element => {
    const modal = element.getBoundingClientRect()
    return [...element.querySelectorAll('input, select, .modal-actions button')].every(control => {
      const rect = control.getBoundingClientRect()
      return rect.left >= modal.left + 16 && rect.right <= modal.right - 16
    })
  })
  expect(formFits).toBe(true)
  await dialog.getByRole('button', { name: '일정 등록', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.mentoring-session')).toHaveCount(1)
  await expect(page.locator('.mentoring-session')).toContainText('연말 프로젝트 회고')
  await expect(page.getByLabel('주간 일정 날짜 이동')).toHaveValue('2026-12-31')
  await expect(page.getByLabel('일정 검색', { exact: true })).toHaveValue('')
})

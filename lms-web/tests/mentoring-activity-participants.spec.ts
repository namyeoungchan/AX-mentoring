import { test, expect } from '@playwright/test'
import type { Workspace } from '../src/data'

const emptyWorkspace: Workspace = { name: '', reminders: true, onboarding: true, qa: true, courses: [], learners: [], mentors: [], teams: [], attendance: [], scores: [], notices: [], files: [], submissions: [], sessions: [], assignments: [], servers: [], logs: [], mode: 'api' }

for (const role of ['instructor', 'admin'] as const) {
  test(`${role} participant checkboxes stay beside names, wrap long names and support mouse and keyboard`, async ({ page }) => {
    const students = Array.from({ length: 24 }, (_, index) => ({ id: `student-${index}`, name: index === 1 ? '아주 긴 이름의 참여 학생 레이아웃 검증용 이름' : `참여 학생 ${index + 1}`, courseId: 'course', team: index % 2 ? '2팀' : '8팀' }))
    let writes = 0
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname
      if (route.request().method() !== 'GET') writes++
      if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 'mentor', username: 'mentor.layout', name: '테스트 멘토', role: role === 'admin' ? 'admin' : 'student' } } })
      if (path === '/api/workspaces') return route.fulfill({ json: { workspaces: [{ id: 'checkbox', name: '학생 선택 검증', role, archivedAt: null, guildIds: [] }] } })
      if (path.endsWith('/workspace') || path.endsWith('/teaching')) return route.fulfill({ json: { ...emptyWorkspace, workspaceId: 'checkbox', name: '학생 선택 검증', mode: 'api', authEnabled: true, onboardingComplete: true, mentorType: 'group' } })
      if (path.endsWith('/mentoring/activities')) return route.fulfill({ json: {
        admin: role === 'admin', canCreate: true, mentors: [{ id: 'mentor', name: '테스트 멘토', username: 'mentor.layout' }],
        courses: [{ id: 'course', title: '멘토링 검증 과정' }], teams: [{ id: 'team8', name: '8팀', courseId: 'course' }, { id: 'team2', name: '2팀', courseId: 'course' }], students, records: [],
      } })
      if (path.endsWith('/mentoring/coordination')) return route.fulfill({ json: { sessions: [] } })
      return route.fulfill({ status: 404, json: { error: 'Unexpected test route' } })
    })
    await page.goto('/?workspace=checkbox#mentoring')
    await page.getByRole('button', { name: '멘토링 기록 추가', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '멘토링 기록', exact: true })
    const picker = dialog.locator('.mentoring-activity-students')
    await picker.locator('summary').click()
    await expect(picker.getByRole('checkbox')).toHaveCount(24)
    const first = picker.locator('label').first()
    await expect(first).toHaveCSS('flex-direction', 'row')
    for (const width of [1440, 768, 390, 360]) {
      await page.setViewportSize({ width, height: 1000 })
      await picker.locator('div').evaluate(node => { node.scrollTop = 0 })
      await first.scrollIntoViewIfNeeded()
      const rows = await picker.locator('label').evaluateAll(labels => labels.slice(0, 2).map(label => {
        const row = label.getBoundingClientRect(), checkbox = label.querySelector('input')!.getBoundingClientRect(), text = label.querySelector('span')!.getBoundingClientRect()
        return { height: row.height, width: checkbox.width, checkboxHeight: checkbox.height, left: checkbox.left - row.left, gap: text.left - checkbox.right, textRight: text.right, rowRight: row.right, sameLine: checkbox.top < text.bottom && checkbox.bottom > text.top }
      }))
      for (const row of rows) {
        expect(row.height).toBeGreaterThanOrEqual(44)
        expect(row.width).toBeCloseTo(18, 0)
        expect(row.checkboxHeight).toBeCloseTo(18, 0)
        expect(row.left).toBeLessThan(12)
        expect(row.gap).toBeGreaterThanOrEqual(8)
        expect(row.sameLine).toBe(true)
        expect(row.textRight).toBeLessThanOrEqual(row.rowRight)
      }
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: `test-results/mentoring-participants-${role}-${width}.png`, fullPage: true, animations: 'disabled' })
    }
    await first.locator('span').click()
    await expect(first.getByRole('checkbox')).toBeChecked()
    await expect(picker.locator('summary')).toContainText('1명')
    await first.getByRole('checkbox').focus()
    await page.keyboard.press('Space')
    await expect(first.getByRole('checkbox')).not.toBeChecked()
    await expect(picker.locator('summary')).toContainText('0명')
    const last = picker.getByRole('checkbox').last()
    await last.check()
    await expect(last).toBeChecked()
    expect(await picker.locator('div').evaluate(node => node.scrollTop)).toBeGreaterThan(0)
    await expect(picker.locator('summary')).toContainText('1명')
    await picker.locator('summary').click()
    await picker.locator('summary').click()
    await expect(last).toBeChecked()
    await dialog.getByRole('combobox', { name: '대상 팀', exact: true }).selectOption('team8')
    await expect(picker.getByRole('checkbox')).toHaveCount(12)
    await expect(picker.locator('input:checked')).toHaveCount(12)
    await expect(picker.locator('summary')).toContainText('12명')
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      await picker.locator('div').evaluate(node => { node.scrollTop = 0 })
      await page.screenshot({ path: `test-results/mentoring-team-selected-${role}-${width}.png`, fullPage: true, animations: 'disabled' })
    }
    await picker.getByRole('checkbox').first().uncheck()
    await expect(picker.locator('summary')).toContainText('11명')
    await picker.locator('summary').click()
    await picker.locator('summary').click()
    await expect(picker.getByRole('checkbox').first()).not.toBeChecked()
    await expect(picker.locator('input:checked')).toHaveCount(11)
    await dialog.getByRole('combobox', { name: '대상 팀', exact: true }).selectOption('team2')
    await expect(picker.locator('input:checked')).toHaveCount(12)
    await expect(picker.locator('summary')).toContainText('12명')
    await dialog.getByLabel('제목', { exact: true }).fill('팀 참여 학생 검증')
    await dialog.getByLabel('진행일', { exact: true }).fill('2026-10-01')
    await dialog.getByLabel('시작 시간', { exact: true }).fill('14:00')
    await dialog.getByLabel('종료 시간', { exact: true }).fill('15:00')
    await dialog.getByLabel('진행 내용', { exact: true }).fill('참여하지 않은 학생 제외')
    for (const checkbox of await picker.getByRole('checkbox').all()) await checkbox.uncheck()
    await dialog.getByRole('button', { name: '저장', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('참여 학생을 1명 이상 선택')
    await dialog.getByRole('combobox', { name: '대상 팀', exact: true }).selectOption('')
    await expect(picker.getByRole('checkbox')).toHaveCount(24)
    await expect(picker.locator('summary')).toContainText('0명')
    await dialog.getByRole('button', { name: '닫기', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect(writes).toBe(0)
  })
}

import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'

for (const role of ['instructor', 'student'] as const) {
  test(`${role} workspace navigation preserves routes and supports mobile keyboard access`, async ({ page }) => {
    const request = page.request, suffix = randomUUID().slice(0, 8)
    const root = await (await request.post('/api/login', { data: { password: 'test-only-password-1234' } })).json()
    const admin = { Authorization: 'Bearer ' + root.token }
    const ws = await (await request.post('/api/workspaces', { headers: admin, data: { name: '역할 화면 ' + suffix, guildId: '7' + Date.now().toString().padStart(17, '0') } })).json()
    const base = '/api/workspaces/' + ws.id
    const groups = await (await request.get(base + '/discord/groups', { headers: admin })).json()
    const setup = await (await request.post(base + '/discord/groups', { headers: admin, data: { count: 1, revision: groups.revision } })).json()
    const username = role + '.' + suffix, password = 'role-review-password-12345'
    if (role === 'instructor') {
      const invite = await (await request.post(base + '/invitations', { headers: admin, data: { username, role } })).json()
      const response = await request.post('/api/auth/register', { data: { invitationToken: invite.token, username, name: '화면 점검 멘토', password } })
      expect(response.status()).toBe(201)
      const user = await response.json()
      expect((await request.post('/api/invitations/accept', { headers: { Authorization: 'Bearer ' + user.token }, data: { token: invite.token } })).status()).toBe(200)
    } else {
      const issuedResponse = await request.post(base + '/student-accounts', { headers: admin, data: { username, teamId: setup.teams[0].id } })
      expect(issuedResponse.status()).toBe(201)
      const issued = await issuedResponse.json()
      const user = await (await request.post('/api/auth/login', { data: { username, password: issued.initialPassword } })).json()
      expect((await request.post('/api/auth/first-login', { headers: { Authorization: 'Bearer ' + user.token }, data: { name: '화면 점검 수강생', currentPassword: issued.initialPassword, newPassword: password } })).status()).toBe(200)
    }
    expect((await request.post('/api/auth/login', { data: { username, password } })).status()).toBe(200)
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    const home = role === 'instructor' ? 'courses' : 'learning'
    const destinations = role === 'instructor'
      ? [['courses', '수업 현황'], ['attendance', '출결 관리'], ['teams', '팀 배정'], ['scores', '성적 관리'], ['admissions', '가입 승인'], ['onboarding', '멘토 온보딩'], ['videos', '강의 영상']]
      : [['learning', '나의 학습'], ['attendance', '나의 출결'], ['scores', '나의 성적'], ['assignments', '과제'], ['participation', '워크스페이스 참여'], ['videos', '강의 영상']]
    await page.goto('/?workspace=' + ws.id + '#' + home)
    await expect(page.locator('.role-workspace')).toBeVisible()
    const nav = page.getByRole('navigation', { name: '주 메뉴' })
    for (const [id, name] of destinations) {
      await nav.getByRole('button', { name, exact: true }).click()
      await expect(page).toHaveURL(new RegExp('#' + id + '$'))
      await expect(nav.getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page')
      await expect(page.locator('h1')).toBeFocused()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    }
    await nav.getByRole('button', { name: destinations[1][1], exact: true }).click()
    await page.reload()
    await expect(nav.getByRole('button', { name: destinations[1][1], exact: true })).toHaveAttribute('aria-current', 'page')
    await nav.getByRole('button', { name: destinations[2][1], exact: true }).click()
    await page.goBack()
    await expect(nav.getByRole('button', { name: destinations[1][1], exact: true })).toHaveAttribute('aria-current', 'page')
    await page.getByLabel('계정 메뉴', { exact: true }).click()
    await page.getByRole('button', { name: '새로고침', exact: true }).click()
    await expect(nav.getByRole('button', { name: destinations[1][1], exact: true })).toHaveAttribute('aria-current', 'page')
    await page.screenshot({ path: `test-results/${role}-workspace-1440.png`, fullPage: true, animations: 'disabled' })
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 900 })
      await expect(page.locator('.sidebar')).toHaveAttribute('inert', '')
      const menu = page.locator('.mobile-menu')
      await menu.click()
      await expect(menu).toHaveAttribute('aria-expanded', 'true')
      await expect(page.getByRole('button', { name: '메뉴 접기', exact: true })).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await expect(page.locator('.sidebar .brand')).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await expect(page.locator('.sidebar .role-guide-link')).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(page.locator('.sidebar .brand')).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(menu).toBeFocused()
      await menu.click()
      await nav.locator('[aria-current="page"]').click()
      await expect(page.locator('h1')).toBeFocused()
      await menu.click()
      await page.screenshot({ path: `test-results/${role}-menu-${width}.png`, fullPage: true, animations: 'disabled' })
      for (const [, name] of destinations) {
        if (await menu.getAttribute('aria-expanded') === 'false') await menu.click()
        await nav.getByRole('button', { name, exact: true }).click()
        await expect(menu).toHaveAttribute('aria-expanded', 'false')
        await expect(page.locator('h1')).toBeFocused()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
        await page.screenshot({ path: `test-results/${role}-${name}-${width}.png`, fullPage: true, animations: 'disabled' })
      }
    }
    await page.goto('/?workspace=' + ws.id + '#data-admin')
    await expect(page.locator('.role-workspace')).toBeVisible()
    await expect(page.getByRole('heading', { name: '백업 · 데이터 관리', exact: true })).toHaveCount(0)
    expect((await request.get(base + '/workspace')).status()).toBe(403)
    const guide = page.locator('footer a')
    expect((await request.get((await guide.getAttribute('href'))!)).headers()['content-type']).toContain('application/pdf')
    expect(errors).toEqual([])
  })
}

import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const roles = { admin: '워크스페이스 관리자', main: '메인 강사', group: '조 담당 멘토', student: '수강생' }
for (const [role, label] of Object.entries(roles)) {
  test(`${role} help shows actual screens and only authorizes its own PDFs`, async ({ page, browser }) => {
    const request = page.request, suffix = randomUUID().slice(0, 8)
    const root = await (await request.post('/api/login', { data: { password: 'test-only-password-1234' } })).json()
    const admin = { Authorization: 'Bearer ' + root.token }
    const ws = await (await request.post('/api/workspaces', { headers: admin, data: { name: '도움말 검증 ' + suffix, guildId: '7' + Date.now().toString().padStart(17, '0') } })).json()
    const base = `/api/workspaces/${ws.id}`
    const before = await (await request.get(base + '/discord/groups', { headers: admin })).json()
    const groups = await (await request.post(base + '/discord/groups', { headers: admin, data: { count: 1, revision: before.revision } })).json()
    const username = 'help.' + suffix, password = 'help-review-password-12345'
    if (role === 'student') {
      const issuedResponse = await request.post(base + '/student-accounts', { headers: admin, data: { username, teamId: groups.teams[0].id } })
      expect(issuedResponse.status()).toBe(201)
      const issued = await issuedResponse.json()
      const user = await (await request.post('/api/auth/login', { data: { username, password: issued.initialPassword } })).json()
      expect((await request.post('/api/auth/first-login', { headers: { Authorization: 'Bearer ' + user.token }, data: { name: '도움말 수강생', currentPassword: issued.initialPassword, newPassword: password } })).status()).toBe(200)
    } else {
      const inviteResponse = await request.post(base + '/invitations', { headers: admin, data: { username, role: role === 'admin' ? 'admin' : 'instructor', mentorType: role === 'group' ? 'group' : 'main', teamIds: role === 'group' ? [groups.teams[0].id] : [] } })
      expect(inviteResponse.status()).toBe(201)
      const invite = await inviteResponse.json()
      const user = await (await request.post('/api/auth/register', { data: { invitationToken: invite.token, username, name: '도움말 ' + label, password } })).json()
      expect((await request.post('/api/invitations/accept', { headers: { Authorization: 'Bearer ' + user.token }, data: { token: invite.token } })).status()).toBe(200)
    }
    expect((await request.post('/api/auth/login', { data: { username, password } })).status()).toBe(200)
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(`/?workspace=${ws.id}#help`)
    await expect(page.locator('.help-role')).toHaveText(label + ' 전용')
    const catalog = await (await request.get(base + '/help')).json()
    expect(catalog.role).toBe(role)
    expect(catalog.guides.every((g: { role: string }) => g.role === role)).toBeTruthy()
    await expect(page.locator('.help-screen img')).toBeVisible()
    expect(await page.locator('.help-screen img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1440)
    const own = catalog.guides[0].id
    const foreign = role === 'admin' ? 'student-learning' : 'admin-dashboard'
    for (const type of ['pdf', 'image']) expect((await request.get(`${base}/help/${foreign}/${type}`)).status()).toBe(403)
    const document = await request.get(`${base}/help/${own}/pdf`)
    expect(document.headers()['cache-control']).toContain('no-store')
    expect((await document.body()).subarray(0, 5).toString()).toBe('%PDF-')
    const anonymous = await browser.newContext()
    expect((await anonymous.request.get(`http://127.0.0.1:5174${base}/help/${own}/pdf`)).status()).toBe(401)
    await anonymous.close()
    await page.getByLabel('기능 가이드 검색').fill('존재하지않는기능')
    await expect(page.getByText('검색 결과가 없습니다.')).toBeVisible()
    await page.getByRole('button', { name: '검색 초기화' }).click()
    await page.getByRole('button', { name: 'PDF 보기', exact: true }).click()
    await expect(page.getByRole('dialog').locator('iframe')).toHaveAttribute('src', /^blob:/)
    await page.keyboard.press('Escape')
    const downloaded = page.waitForEvent('download')
    await page.getByRole('button', { name: '다운로드', exact: true }).click()
    expect((await downloaded).suggestedFilename()).toContain(label)
    await page.screenshot({ path: `test-results/help-${role}-desktop.png`, fullPage: true })
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
      await page.getByRole('button', { name: /화면 확대$/ }).click()
      await expect(page.getByRole('dialog').locator('img')).toBeVisible()
      await page.keyboard.press('Escape')
    }
    await page.screenshot({ path: `test-results/help-${role}-mobile.png`, fullPage: true })
    if (role === 'admin') {
      await page.getByRole('button', { name: 'PDF 등록·교체', exact: true }).click()
      await page.getByRole('combobox', { name: '대상 역할', exact: true }).selectOption('student')
      await page.getByRole('combobox', { name: '대상 기능', exact: true }).selectOption('student-learning')
      await expect(page.getByRole('button', { name: 'PDF 보기', exact: true })).toHaveCount(0)
      const bytes = await readFile('server/help-assets/student-learning.pdf')
      await page.getByLabel('가이드 PDF 선택', { exact: true }).setInputFiles({ name: '수강생-학습.pdf', mimeType: 'application/pdf', buffer: bytes })
      await page.getByRole('button', { name: 'PDF 등록', exact: true }).click()
      await expect(page.getByRole('status')).toContainText('PDF를 등록했습니다.')
      await page.reload()
      await page.getByRole('button', { name: 'PDF 등록·교체', exact: true }).click()
      await page.getByRole('combobox', { name: '대상 역할', exact: true }).selectOption('student')
      await expect(page.locator('.help-manager')).toContainText('수강생-학습.pdf')
      expect((await request.get(base + '/help/student-learning/pdf')).status()).toBe(403)
      page.once('dialog', dialog => dialog.accept())
      await page.getByRole('button', { name: '기본 PDF로 복원' }).click()
      await expect(page.getByRole('status')).toContainText('기본 PDF로 복원했습니다.')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    } else {
      await expect(page.getByRole('button', { name: 'PDF 등록·교체', exact: true })).toHaveCount(0)
      expect((await request.get(base + '/help/manage')).status()).toBe(403)
      expect((await request.post(`${base}/help/manage/${own}`, { data: {} })).status()).toBe(403)
    }
    expect((await request.get('http://127.0.0.1:3002/guides/all-role-guides.pdf')).status()).toBe(410)
    expect(errors).toEqual([])
  })
}

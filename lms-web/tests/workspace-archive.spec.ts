import { test, expect, type Page } from '@playwright/test'

async function menu(page: Page) {
  const mobile = page.getByRole('button', { name: '메뉴 열기' })
  if (await mobile.isVisible() && !await page.getByRole('button', { name: '워크스페이스 선택', exact: true }).isVisible()) await mobile.click()
  await page.getByRole('button', { name: '워크스페이스 선택', exact: true }).click()
  return page.getByLabel('워크스페이스 목록', { exact: true })
}

for (const demo of [false, true]) test(`${demo ? 'demo' : 'API'} archives, reloads and restores a workspace with its course intact`, async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const name = `보관 검증 ${demo ? '데모' : 'API'}`
  await page.goto(demo ? '/?demo=1' : '/')
  if (!demo) {
    await page.getByRole('button', { name: '관리자 로그인', exact: true }).click()
    await page.getByLabel('관리자 비밀번호').fill('test-only-password-1234')
    await page.getByRole('button', { name: '로그인', exact: true }).click()
  }
  await menu(page)
  await page.getByRole('button', { name: '새 워크스페이스', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('워크스페이스 이름').fill(name)
  await dialog.getByRole('button', { name: '워크스페이스 만들기', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await page.getByRole('button', { name: '새 과정 만들기' }).click()
  await dialog.getByLabel('과정명', { exact: true }).fill('보관해도 유지할 과정')
  await dialog.getByLabel('과정 코드').fill('ARCHIVE-TEST')
  await dialog.getByLabel('시작일').fill('2026-09-01')
  await dialog.getByLabel('종료일').fill('2026-12-01')
  await dialog.getByLabel('과정 소개').fill('복원 후에도 남는 학습 자료')
  await dialog.getByRole('button', { name: '만들기', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  const id = new URL(page.url()).searchParams.get('workspace')!
  await menu(page)
  await page.getByRole('button', { name: '현재 워크스페이스 보관', exact: true }).click()
  await dialog.getByRole('button', { name: '취소', exact: true }).click()
  await expect(page.getByRole('button', { name: '워크스페이스 선택', exact: true })).not.toContainText('보관됨')
  await menu(page)
  await page.getByRole('button', { name: '현재 워크스페이스 보관', exact: true }).click()
  await dialog.getByRole('button', { name: '보관하기', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('button', { name: '워크스페이스 선택', exact: true })).toContainText('보관됨')
  if (!demo) {
    const list = await (await page.request.get('/api/workspaces')).json()
    expect(list.workspaces.some((w: { id: string }) => w.id === id)).toBe(false)
    const all = await (await page.request.get('/api/workspaces?includeArchived=true')).json()
    expect(all.workspaces.find((w: { id: string }) => w.id === id).archivedAt).toBeGreaterThan(0)
  }
  await page.reload()
  await expect(page.getByRole('heading', { name: '보관해도 유지할 과정' })).toBeVisible()
  const list = await menu(page)
  await expect(list.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveCount(0)
  await list.getByRole('button', { name: /보관함/ }).click()
  await expect(list.getByRole('button', { name: `${name} 복원`, exact: true })).toBeVisible()
  // A failed restore stays archived and exposes the server error.
  if (!demo) {
    await page.route(`**/api/workspaces/${id}/restore`, route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: '복원 권한이 없습니다.' }) }))
    await list.getByRole('button', { name: `${name} 복원`, exact: true }).click()
    await expect(list.getByRole('alert')).toContainText('복원 권한이 없습니다.')
    await expect(page.getByRole('button', { name: '워크스페이스 선택', exact: true })).toContainText('보관됨')
    await page.unroute(`**/api/workspaces/${id}/restore`)
  }
  await list.getByRole('button', { name: `${name} 복원`, exact: true }).click()
  await expect(page.getByRole('button', { name: '워크스페이스 선택', exact: true })).not.toContainText('보관됨')
  await page.reload()
  await expect(page.getByRole('heading', { name: '보관해도 유지할 과정' })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '메뉴 열기' }).click()
  await menu(page)
  await expect(page.getByRole('button', { name: '현재 워크스페이스 보관', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: `test-results/archive-${demo ? 'demo' : 'api'}-mobile.png`, fullPage: true })
  expect(errors).toEqual([])
})

test('all archived demo workspaces remain recoverable from an empty active list', async ({ page }) => {
  await page.goto('/?demo=1')
  await expect(page.getByRole('heading', { name: '운영 대시보드' })).toBeVisible()
  await page.evaluate(() => {
    const data = { workspaces: [{ id: 'saved', name: '복원할 공간', description: '', sourceId: 'saved', guildIds: [], archivedAt: Date.now() }], data: { saved: { workspaceId: 'saved', name: '복원할 공간', mode: 'demo', courses: [], learners: [], mentors: [], teams: [], attendance: [], scores: [], notices: [], files: [], submissions: [], sessions: [], assignments: [], servers: [], logs: [] } } }
    localStorage.setItem('learningops-workspaces-demo-v2', JSON.stringify(data))
  })
  await page.goto('/?demo=1')
  await expect(page.getByRole('heading', { name: '운영 중인 워크스페이스가 없습니다.' })).toBeVisible()
  const list = await menu(page)
  await list.getByRole('button', { name: /보관함/ }).click()
  await list.getByRole('button', { name: '복원할 공간 복원', exact: true }).click()
  await expect(page.getByRole('heading', { name: '운영 대시보드' })).toBeVisible()
  await expect(page.getByRole('button', { name: '워크스페이스 선택', exact: true })).toContainText('복원할 공간')
})

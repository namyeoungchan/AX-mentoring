import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
test('new submission remains saved while notification waits and Web shows team completion', async ({ page, request }) => {
  await page.request.post('/api/login', { data: { password: 'test-only-password-1234' } })
  const guildId = '653456789012345678', botHeaders = { Authorization: 'Bearer test-only-provision-token-12345678901234567890' }
  const w = await (await page.request.post('/api/workspaces', { data: { name: '과제 알림 E2E', guildId } })).json(), base = `/api/workspaces/${w.id}`
  const groups = await (await page.request.get(`${base}/discord/groups`)).json()
  const setup = await (await page.request.post(`${base}/discord/groups`, { data: { count: 2, revision: groups.revision } })).json()
  const data = await (await page.request.get(`${base}/workspace`)).json()
  expect((await page.request.patch(`${base}/workspace`, { data: { revision: data.revision, changes: [0, 1].map(i => ({ kind: 'learners', value: { id: `l${i}`, name: `학생${i}`, email: '', discordId: String(753456789012345678n + BigInt(i)), team: setup.teams[i].name, courseId: setup.courseId, status: '정상' } })) } })).status()).toBe(200)
  const call = async (operation: string, args: unknown[]) => {
    const response = await request.post('/api/integrations/discord/storage/call', { headers: botHeaders, data: { guildId, requestId: randomUUID(), operation, args } })
    expect(response.status()).toBe(200); return (await response.json()).result
  }
  const assignmentId = await call('create_assignment', [1, '발표 과제', '', '2026-09-30', 'team'])
  await page.goto(`/?workspace=${w.id}#assignments`)
  await page.getByText('발표 과제 · 팀 제출 완료 0/0', { exact: true }).click()
  await page.getByLabel('발표 과제 대상 과정').selectOption(setup.courseId)
  await page.getByRole('button', { name: '과제 대상 과정 연결' }).click()
  await expect(page.getByText('발표 과제 · 팀 제출 완료 0/2', { exact: true })).toBeVisible()
  expect(await call('create_submission', [assignmentId, '753456789012345678', '학생0', setup.teams[0].name, '비공개 답변', 'https://private.example/answer'])).toBe(true)
  await page.getByRole('button', { name: '과제 알림 새로고침' }).click()
  await expect(page.getByText('발표 과제 · 팀 제출 완료 1/2', { exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: '대기', exact: true })).toBeVisible()
  const panel = page.locator('.assignment-alerts')
  await expect(panel).not.toContainText('비공개 답변')
  await expect(panel).not.toContainText('private.example')
  await expect(panel).toContainText('미제출: 2조')
  await page.reload()
  await expect(page.getByText('발표 과제 · 팀 제출 완료 1/2', { exact: true })).toBeVisible()
})

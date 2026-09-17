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
  await page.getByText('발표 과제 · 팀 제출 완료 1/2', { exact: true }).click()
  await expect(page.getByText('팀 채팅 2곳에 배포', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '과제 배포', exact: true }).click()
  await expect(page.getByRole('button', { name: '배포 요청 완료', exact: true })).toBeDisabled()
  const notifications = await (await page.request.get(`${base}/assignment-alerts`)).json()
  expect(notifications.deliveries.filter((d: { kind: string }) => d.kind === 'publication')).toHaveLength(2)
  await page.reload()
  await page.getByText('발표 과제 · 팀 제출 완료 1/2', { exact: true }).click()
  await expect(page.getByRole('button', { name: '배포 요청 완료', exact: true })).toBeDisabled()

})


test('web creates individual assignment and publishes one DM job per learner without duplicate requests', async ({ page }) => {
  await page.request.post('/api/login', { data: { password: 'test-only-password-1234' } })
  const w = await (await page.request.post('/api/workspaces', { data: { name: '개인 배포 E2E', guildId: '963456789012345670' } })).json(), base = `/api/workspaces/${w.id}`
  const groups = await (await page.request.get(`${base}/discord/groups`)).json()
  const setup = await (await page.request.post(`${base}/discord/groups`, { data: { count: 1, revision: groups.revision } })).json()
  const data = await (await page.request.get(`${base}/workspace`)).json()
  expect((await page.request.patch(`${base}/workspace`, { data: { revision: data.revision, changes: [{ kind: 'learners', value: { id: 'publication-student', name: '개인 수강생', email: '', discordId: '', team: setup.teams[0].name, courseId: setup.courseId, status: '정상' } }] } })).status()).toBe(200)
  await page.goto(`/?workspace=${w.id}#assignments`)
  await page.getByRole('button', { name: '과제 만들기', exact: true }).click()
  await page.getByLabel('과제명', { exact: true }).fill('개인 실습')
  await page.getByLabel('과제 유형').selectOption('individual')
  await page.getByRole('button', { name: '만들기', exact: true }).click()
  await page.getByText('개인 실습 · 개인 제출 완료 0/1', { exact: true }).click()
  await expect(page.getByText('수강생 1명에게 개인 DM 배포', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '과제 배포', exact: true }).click()
  await expect(page.getByRole('button', { name: '배포 요청 완료', exact: true })).toBeDisabled()
  const alerts = await (await page.request.get(`${base}/assignment-alerts`)).json()
  const jobs = alerts.deliveries.filter((d: { kind: string }) => d.kind === 'publication')
  expect(jobs).toHaveLength(1)
  expect(jobs[0].payload.audience).toBe('individual')
  expect(jobs[0].state).toBe('pending')
  expect((await page.request.post(`${base}/assignment-alerts/${alerts.assignments[0].id}/publish`, { data: { revision: alerts.assignments[0].revision } })).status()).toBe(200)
  expect((await (await page.request.get(`${base}/assignment-alerts`)).json()).deliveries.filter((d: { kind: string }) => d.kind === 'publication')).toHaveLength(1)
})

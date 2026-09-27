import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
test('Discord creation publishes automatically and submission remains saved while notifications wait', async ({ page, request }) => {
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
  const assignmentId = await call('create_assignment', [1, '발표 과제', '', '2099-09-30', 'team'])
  const created = await (await page.request.get(`${base}/assignment-alerts`)).json()
  expect(created.deliveries.filter((d: { kind: string }) => d.kind === 'publication')).toHaveLength(2)
  await page.goto(`/?workspace=${w.id}#assignments`)
  await expect(page.locator('.assignment-item').filter({hasText:'발표 과제'})).toContainText('0 / 2')
  await page.getByRole('button', {name:'발표 과제 제출 현황',exact:true}).click()
  await expect(page.getByText('대상 연결 완료', {exact:true})).toBeVisible()
  await expect(page.getByRole('button', {name:'기존 과제 과정 지정'})).toHaveCount(0)
  await expect(page.getByRole('button', { name: '배포 요청 완료', exact: true })).toBeDisabled()
  expect(await call('create_submission', [assignmentId, '753456789012345678', '학생0', setup.teams[0].name, '비공개 답변', 'https://private.example/answer'])).toBe(true)
  await page.getByRole('button', { name: '과제 새로고침' }).click()
  await expect(page.locator('.assignment-item').filter({hasText:'발표 과제'})).toContainText('1 / 2')
  await page.locator('.assignment-delivery-history > summary').click()
  await expect(page.getByRole('cell', { name: /대기/ }).first()).toBeVisible()
  const panel = page.locator('.assignment-alerts')
  await expect(panel).not.toContainText('비공개 답변')
  await expect(panel).not.toContainText('private.example')
  await expect(page.getByRole('region', { name: '발표 과제 미제출 팀', exact: true })).toContainText('2조')
  await expect(page.getByRole('region', { name: '발표 과제 미제출 팀', exact: true })).not.toContainText('1조')
  await expect(page.getByRole('region', { name: '발표 과제 제출한 팀', exact: true })).toContainText('1조')
  await page.reload()
  await expect(page.locator('.assignment-item').filter({hasText:'발표 과제'})).toContainText('1 / 2')
  await page.getByRole('button', {name:'발표 과제 제출 현황',exact:true}).click()
  await expect(page.getByText('팀 채팅 2곳에 배포', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '배포 요청 완료', exact: true })).toBeDisabled()
  expect((await page.request.post(`${base}/assignment-alerts/${assignmentId}/publish`, { data: { revision: created.assignments[0].revision } })).status()).toBe(200)
  const notifications = await (await page.request.get(`${base}/assignment-alerts`)).json()
  expect(notifications.deliveries.filter((d: { kind: string }) => d.kind === 'publication')).toHaveLength(2)
  await page.reload()
  await page.getByRole('button', {name:'발표 과제 제출 현황',exact:true}).click()
  await expect(page.getByRole('button', { name: '배포 요청 완료', exact: true })).toBeDisabled()
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `test-results/assignment-team-roster-${width}.png`, fullPage: true, animations: 'disabled' })
  }
})


test('web creates individual assignment and publishes one DM job per learner without duplicate requests', async ({ page }) => {
  await page.request.post('/api/login', { data: { password: 'test-only-password-1234' } })
  const w = await (await page.request.post('/api/workspaces', { data: { name: '개인 배포 E2E', guildId: '963456789012345670' } })).json(), base = `/api/workspaces/${w.id}`
  const groups = await (await page.request.get(`${base}/discord/groups`)).json()
  const setup = await (await page.request.post(`${base}/discord/groups`, { data: { count: 1, revision: groups.revision } })).json()
  const data = await (await page.request.get(`${base}/workspace`)).json()
  expect((await page.request.patch(`${base}/workspace`, { data: { revision: data.revision, changes: [
    { kind: 'learners', value: { id: 'publication-student', name: '개인 수강생', email: '', discordId: '', team: setup.teams[0].name, courseId: setup.courseId, status: '정상' } },
    { kind: 'learners', value: { id: 'submitted-student', name: '제출한 수강생', email: '', discordId: '753456789012345699', team: setup.teams[0].name, courseId: setup.courseId, status: '정상' } },
  ] } })).status()).toBe(200)
  await page.goto(`/?workspace=${w.id}#assignments`)
  await page.getByRole('button', { name: '과제 만들기', exact: true }).click()
  await page.getByLabel('과제명', { exact: true }).fill('개인 실습')
  await page.getByRole('dialog').getByLabel('과제 유형').selectOption('individual')
  await page.getByRole('button', { name: '만들기', exact: true }).click()
  await page.getByRole('button', {name:'개인 실습 제출 현황',exact:true}).click()
  await expect(page.getByText('수강생 2명에게 개인 DM 배포', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '과제 배포', exact: true }).click()
  await expect(page.getByRole('button', { name: '배포 요청 완료', exact: true })).toBeDisabled()
  const alerts = await (await page.request.get(`${base}/assignment-alerts`)).json()
  const jobs = alerts.deliveries.filter((d: { kind: string }) => d.kind === 'publication')
  expect(jobs).toHaveLength(2)
  expect(jobs[0].payload.audience).toBe('individual')
  expect(jobs[0].state).toBe('pending')
  expect((await page.request.post(`${base}/assignment-alerts/${alerts.assignments[0].id}/publish`, { data: { revision: alerts.assignments[0].revision } })).status()).toBe(200)
  expect((await (await page.request.get(`${base}/assignment-alerts`)).json()).deliveries.filter((d: { kind: string }) => d.kind === 'publication')).toHaveLength(2)
  expect((await page.request.post('/api/integrations/discord/storage/call', { headers: { Authorization: 'Bearer test-only-provision-token-12345678901234567890' }, data: { guildId: '963456789012345670', operation: 'create_submission', args: [+alerts.assignments[0].id, '753456789012345699', '제출한 수강생', setup.teams[0].name, '개인 실습 내용', ''], requestId: randomUUID() } })).status()).toBe(200)
  await page.getByRole('button', { name: '과제 새로고침' }).click()
  const missing = page.getByRole('region', { name: '개인 실습 미제출 수강생', exact: true })
  const completed = page.getByRole('region', { name: '개인 실습 제출한 수강생', exact: true })
  await expect(missing).toContainText('개인 수강생')
  await expect(missing).toContainText('Discord 미인증')
  await expect(missing).not.toContainText('제출한 수강생')
  await expect(completed.getByRole('list')).toContainText('제출한 수강생')
  await expect(completed.getByRole('list')).not.toContainText('개인 수강생')
  await page.getByLabel('개인 실습 수강생 검색').fill('개인 수강생')
  await expect(completed).toContainText('검색 조건에 맞는 대상이 없습니다.')
  await expect(missing).toContainText('검색 결과 1명 / 전체 1명')
  await page.getByLabel('개인 실습 수강생 검색').fill('')
  for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `test-results/assignment-individual-roster-${width}.png`, fullPage: true, animations: 'disabled' })
  }
})

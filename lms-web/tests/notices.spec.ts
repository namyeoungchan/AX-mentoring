import { test, expect } from '@playwright/test'
test('notice preview queues once, reports failure, and pauses before manual delivery', async ({ page, request }) => {
  const admin = await (await page.request.post('/api/login', { data: { password: 'test-only-password-1234' } })).json()
  const headers = { Authorization: `Bearer ${admin.token}` }, botHeaders = { Authorization: 'Bearer test-only-provision-token-12345678901234567890' }
  const guildId = '643456789012345678', channelId = '743456789012345678'
  const workspace = await (await page.request.post('/api/workspaces', { data: { name: '공지 발송 검증', guildId } })).json(), base = `/api/workspaces/${workspace.id}`
  const { job } = await (await request.post('/api/integrations/discord/provision/poll', { headers: botHeaders, data: { guildIds: [guildId] } })).json()
  expect((await request.post('/api/integrations/discord/provision/complete', { headers: botHeaders, data: { id: job.id, claim: job.claim, success: true, errorCode: null, results: job.plan.channels.map((c: { id: string }, i: number) => ({ id: c.id, discordId: c.id === 'notice' ? channelId : String(843456789012345678n + BigInt(i)), action: 'created' })) } })).status()).toBe(200)
  const groups = await (await page.request.get(`${base}/discord/groups`)).json()
  const setup = await (await page.request.post(`${base}/discord/groups`, { data: { count: 1, revision: groups.revision } })).json()
  let state = await (await page.request.get(`${base}/workspace`)).json()
  expect((await page.request.patch(`${base}/workspace`, { data: { revision: state.revision, changes: [{ kind: 'notices', value: { id: 'notice1', title: '수업 공지', content: '@everyone 수업 안내', courseId: setup.courseId, target: '과정 전체', status: '초안' } }] } })).status()).toBe(200)
  await page.goto(`/?workspace=${workspace.id}#notices`)
  await page.getByRole('button', { name: '발송 미리보기' }).click()
  await expect(page.getByRole('dialog')).toContainText('멘션 없음')
  await page.getByRole('button', { name: 'Discord 발송 요청' }).click()
  await expect(page.getByRole('status')).toContainText('발송 작업을 요청했습니다.')
  state = await (await request.get(`${base}/notices`, { headers })).json()
  expect((await request.post(`${base}/notices/notice1/send`, { headers, data: { revision: state.notices[0].revision } })).status()).toBe(200)
  const delivery = (await (await request.post('/api/integrations/discord/outbox/poll', { headers: botHeaders, data: { guildIds: [guildId] } })).json()).job
  expect(delivery.channelId).toBe(channelId)
  expect((await request.post('/api/integrations/discord/outbox/complete', { headers: botHeaders, data: { workspaceId: workspace.id, id: delivery.id, claim: delivery.claim, state: 'failed', error: 'permissions', messageId: '' } })).status()).toBe(200)
  await page.getByRole('button', { name: '발송 결과 새로고침' }).click()
  await expect(page.getByText('발송 실패', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '발송 미리보기' }).click()
  await page.getByRole('button', { name: '수동 발송으로 전환' }).click()
  await expect(page.getByText('수동 발송 대기', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '발송 미리보기' }).click()
  await page.getByLabel('수동 게시 메시지 링크').fill(`https://discord.com/channels/${guildId}/${channelId}/943456789012345678`)
  await page.getByRole('button', { name: '수동 발송 완료 기록' }).click()
  await expect(page.getByText('수동 발송 완료', { exact: true })).toBeVisible()
})

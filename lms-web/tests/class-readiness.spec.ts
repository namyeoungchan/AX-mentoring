import { test, expect, type APIResponse } from '@playwright/test'
import { randomUUID } from 'node:crypto'

test('team moves invalidate attendance drafts and Discord failures preserve all four Web records', async ({ page, request }) => {
  const json = async (response: APIResponse) => {
    expect(response.ok(), await response.text()).toBeTruthy()
    return response.json()
  }
  await json(await page.request.post('/api/login', { data: { password: 'test-only-password-1234' } }))
  const guildId = '663456789012345678', channelId = '763456789012345678'
  const botHeaders = { Authorization: 'Bearer test-only-provision-token-12345678901234567890' }
  const w = await json(await page.request.post('/api/workspaces', { data: { name: '수업 통합 리허설', guildId } }))
  const base = `/api/workspaces/${w.id}`
  const get = async (path: string) => json(await page.request.get(`${base}/${path}`))
  const post = async (path: string, data: unknown) => json(await page.request.post(`${base}/${path}`, { data }))
  const bot = async (path: string, data: unknown) => json(await request.post(`/api/integrations/discord/${path}`, { headers: botHeaders, data }))
  const { job } = await bot('provision/poll', { guilds: [{ id: guildId, name: 'Rehearsal', manageChannels: true }] })
  await bot('provision/complete', { id: job.id, claim: job.claim, success: true, errorCode: null, results: job.plan.channels.map((c: { id: string }, i: number) => ({ id: c.id, discordId: c.id === 'notice' ? channelId : String(863456789012345678n + BigInt(i)), action: 'created' })) })
  const setup = await post('discord/groups', { count: 2, revision: (await get('discord/groups')).revision })
  const state = await get('workspace')
  await json(await page.request.patch(`${base}/workspace`, { data: { revision: state.revision, changes: [
    ...[0, 1].map(i => ({ kind: 'learners', value: { id: `s${i}`, name: `수강생${i}`, email: '', discordId: String(773456789012345678n + BigInt(i)), team: setup.teams[0].name, courseId: setup.courseId, status: '정상' } })),
    { kind: 'notices', value: { id: 'class-notice', title: '리허설 공지', content: '변경된 팀으로 모여주세요.', courseId: setup.courseId, target: '과정 전체', status: '초안' } },
  ] } }))
  const selection = { courseId: setup.courseId, date: '2026-09-18', period: 1 }
  const rosterPath = `attendance?${new URLSearchParams({ ...selection, period: '1' })}`
  const started = await post('attendance', { ...selection, revision: (await get(rosterPath)).revision, requestId: randomUUID(), action: 'start' })
  await post('team-operations', { revision: (await get('team-operations')).revision, learnerIds: ['s0'], teamId: setup.teams[1].id })
  const entries = [0, 1].map(i => ({ studentId: `s${i}`, status: '출석' }))
  expect((await page.request.post(`${base}/attendance`, { data: { ...selection, revision: started.revision, requestId: randomUUID(), action: 'save', entries } })).status()).toBe(409)
  const refreshed = await get(rosterPath)
  expect(refreshed.rows.find((r: { studentId: string }) => r.studentId === 's0').team).toBe(setup.teams[1].name)
  const saved = await post('attendance', { ...selection, revision: refreshed.revision, requestId: randomUUID(), action: 'save', entries })
  await post('attendance', { ...selection, revision: saved.revision, requestId: randomUUID(), action: 'close' })

  const call = async (operation: string, args: unknown[]) => (await bot('storage/call', { guildId, requestId: randomUUID(), operation, args })).result
  const assignmentId = await call('create_assignment', [1, '통합 팀 과제', '', '2099-09-30', 'team'])
  await post(`assignment-alerts/${assignmentId}/course`, { courseId: setup.courseId })
  expect(await call('create_submission', [assignmentId, '773456789012345678', '수강생0', setup.teams[1].name, '비공개 답변', 'https://private.example/answer'])).toBe(true)
  const notice = (await get('notices')).notices[0]
  await post('notices/class-notice/send', { revision: notice.revision })
  // The worker reports a Discord permissions failure for both queued messages.
  const kinds = []
  for (let i = 0; i < 2; i++) {
    const { job: delivery } = await bot('outbox/poll', { guildIds: [guildId] })
    expect(delivery).toBeTruthy()
    kinds.push(delivery.kind)
    await bot('outbox/complete', { workspaceId: w.id, id: delivery.id, claim: delivery.claim, state: 'failed', error: 'permissions', messageId: '' })
  }
  expect(kinds.sort()).toEqual(['notice', 'submission'])
  await page.goto(`/?workspace=${w.id}#assignments`)
  await expect(page.getByText('통합 팀 과제 · 팀 제출 완료 1/2', { exact: true })).toBeVisible()
  await page.reload()
  const assignment = (await get('assignment-alerts')).assignments[0]
  expect(assignment.targets.find((t: { name: string }) => t.name === setup.teams[1].name).completed).toBe(true)
  expect((await get('assignment-alerts')).deliveries[0].state).toBe('failed')
  expect((await get('notices')).notices[0].delivery.state).toBe('failed')
  const after = await get(rosterPath)
  expect(after.state).toBe('마감')
  expect(after.counts['출석']).toBe(2)
  expect((await get('team-operations')).learners.find((l: { id: string }) => l.id === 's0').team).toBe(setup.teams[1].name)
})

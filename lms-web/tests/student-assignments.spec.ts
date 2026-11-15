import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'

test('student assignments prioritize work, show private receipts and stay usable on mobile', async ({ page }) => {
  const request = page.request, suffix = randomUUID().slice(0, 8)
  const guildId = '8' + Date.now().toString().padStart(17, '0'), discordId = '9' + Date.now().toString().padStart(17, '0')
  const root = { Authorization: 'Bearer ' + (await (await request.post('/api/login', { data: { password: 'test-only-password-1234' } })).json()).token }
  const ws = await (await request.post('/api/workspaces', { headers: root, data: { name: '과제 학습실 ' + suffix, guildId } })).json()
  const base = '/api/workspaces/' + ws.id
  const groups = await (await request.get(base + '/discord/groups', { headers: root })).json()
  const setup = await (await request.post(base + '/discord/groups', { headers: root, data: { count: 1, revision: groups.revision } })).json()
  const issued = await (await request.post(base + '/student-accounts', { headers: root, data: { username: 'assignment.' + suffix, teamId: setup.teams[0].id } })).json()
  const initial = await (await request.post('/api/auth/login', { data: { username: issued.username, password: issued.initialPassword } })).json()
  const student = await (await request.post('/api/auth/first-login', { headers: { Authorization: 'Bearer ' + initial.token }, data: { name: '김서진', currentPassword: issued.initialPassword, newPassword: 'assignment-student-12345' } })).json()
  const headers = { Authorization: 'Bearer ' + student.token }
  await page.goto('/?workspace=' + ws.id + '#assignments')
  await expect(page.getByRole('heading', { name: 'Discord 인증 후 과제를 확인할 수 있습니다.' })).toBeVisible()
  const proof = await (await request.post(base + '/me/verification', { headers, data: {} })).json()
  expect((await request.post('/api/integrations/discord/verify', { headers: { Authorization: 'Bearer test-only-auth-token-12345678901234567890' }, data: { code: proof.code.replaceAll('-', ''), guildId, discordId } })).status()).toBe(200)
  const botHeaders = { Authorization: 'Bearer test-only-provision-token-12345678901234567890' }
  const call = async (operation: string, args: unknown[]) => {
    const result = await request.post('/api/integrations/discord/storage/call', { headers: botHeaders, data: { guildId, operation, args, requestId: randomUUID() } })
    expect(result.status(), await result.text()).toBe(200)
    return (await result.json()).result
  }
  const date = (offset: number) => new Date(Date.now() + 9 * 3600000 + offset * 86400000).toISOString().slice(0, 10)
  const create = (title: string, offset: number, type = 'individual') => call('create_assignment', [2, title, '실습 결과를 정리하고 적용 과정과 개선할 점을 작성하세요.\n결과물 링크를 함께 제출하세요.', date(offset), type, '["실습 내용","결과 링크"]'])
  await create('업무 자동화 흐름 정리', -2)
  const dueToday = await create('고객 문의 분류 실습', 0)
  await create('긴 과제명 확인: 팀별 데이터 분석 결과와 자동화 적용 과정을 문서로 정리하기', 7)
  const own = await create('나의 실습 회고', -1)
  const team = await create('팀 프로젝트 중간 결과', 4, 'team')
  const closed = await create('지난 주 실습', -7)
  await call('deactivate_assignment', [closed])
  await call('create_submission', [own, discordId, '김서진', setup.teams[0].name, '{"실습 내용":"나의 저장된 답변"}', 'https://example.com/my-work'])
  await call('create_submission', [team, '723456789012345678', '팀원', setup.teams[0].name, '팀원의 비공개 본문', 'https://private.example/team'])
  expect((await request.post('/api/integrations/discord/storage/bind-panels', { headers: botHeaders, data: { guildId, channels: { ASSIGNMENT_SUBMIT_CHANNEL_ID: '623456789012345678' } } })).status()).toBe(200)
  await page.reload()
  await expect(page.getByRole('heading', { name: '제출할 과제 3개' })).toBeVisible()
  await expect(page.locator('.sa-assignment').first()).toHaveAttribute('aria-label', '업무 자동화 흐름 정리')
  const today = page.getByRole('article', { name: '고객 문의 분류 실습', exact: true })
  await expect(today).toContainText('오늘 마감')
  await today.getByRole('button', { name: '고객 문의 분류 실습 내용 보기' }).click()
  await expect(today).toContainText('준비할 제출 항목')
  await expect(today.getByRole('link', { name: 'Discord로 이동' })).toHaveAttribute('href', `https://discord.com/channels/${guildId}/623456789012345678`)
  await page.getByLabel('과제 검색').fill('없는 과제')
  await expect(page.getByText('검색 결과가 없습니다.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '검색어 지우기' }).click()
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `test-results/student-assignments-${width}.png`, fullPage: true, animations: 'disabled' })
  }
  await page.getByRole('button', { name: '제출 완료 2', exact: true }).click()
  const receipt = page.getByRole('article', { name: '나의 실습 회고' })
  await receipt.getByRole('button', { name: '나의 실습 회고 내용 보기' }).click()
  await expect(receipt).toContainText('나의 저장된 답변')
  await expect(receipt.getByRole('link', { name: '내 제출 링크 열기' })).toHaveAttribute('href', 'https://example.com/my-work')
  await expect(page.getByRole('article', { name: '팀 프로젝트 중간 결과' })).toContainText('팀 제출 완료')
  expect(JSON.stringify(await (await request.get(base + '/me/learning', { headers })).json())).not.toContain('팀원의 비공개 본문')
  await call('create_submission', [dueToday, discordId, '김서진', setup.teams[0].name, '방금 제출한 내용', ''])
  await page.getByRole('button', { name: '제출 상태 새로고침' }).click()
  await expect(page.getByRole('button', { name: '제출 완료 3', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('article', { name: '고객 문의 분류 실습', exact: true })).toContainText('내 제출 완료')
  await page.getByRole('button', { name: '종료 1', exact: true }).click()
  await expect(page.getByRole('article', { name: '지난 주 실습' })).toContainText('미제출 · 종료')
})

import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'

test('administrator finds orphan Discord records, reviews scope and confirms cleanup', async ({ page, request }) => {
  const base='http://localhost:3004/api'
  const setup=await request.post(`${base}/auth/setup`,{data:{username:'accounts.owner',name:'총괄 관리자',password:'owner-password-1234',setupKey:'account-setup-key-123456'}})
  expect([200,201,409]).toContain(setup.status())
  const login=await (await request.post(`${base}/auth/login`,{data:{username:'accounts.owner',password:'owner-password-1234'}})).json()
  const headers={Authorization:`Bearer ${login.token}`}
  const workspace=await (await request.post(`${base}/workspaces`,{headers,data:{name:'Discord 인증 관리 화면 검증'}})).json()
  const record={kind:'verification',username:'deleted.account',userId:'deleted',workspaceName:'테스트 과정',guildId:'123456789012345678',verifiedAt:Date.now(),expiresAt:null,orphan:true}
  const orphan={discordId:'223456789012345678',account:null,records:[record],state:'orphan',orphanCount:1,revision:'a'.repeat(64)}
  let rows=[orphan,{discordId:'323456789012345678',account:{id:'active',username:'active.student',name:'김학생'},records:[{...record,orphan:false,username:'active.student'}],state:'linked',orphanCount:0,revision:'b'.repeat(64)}]
  let deleted=0, stale=true
  await page.route('**/api/admin/discord-identities**',async route=>{
    if(route.request().method()==='DELETE') {
      expect(route.request().postDataJSON().discordId).toBe(orphan.discordId)
      if(stale) { stale=false; await route.fulfill({status:409,json:{error:'인증 정보가 변경되었습니다. 목록을 새로고침하고 다시 확인하세요.'}}); return }
      deleted++; rows=rows.filter(row=>row.discordId!==orphan.discordId)
      await route.fulfill({json:{ok:true,signedOut:false}})
    } else await route.fulfill({json:{identities:rows}})
  })
  await page.goto(`http://localhost:3004/?workspace=${workspace.id}#discord-identities`)
  await page.getByLabel('아이디',{exact:true}).fill('accounts.owner')
  await page.getByLabel('비밀번호',{exact:true}).fill('owner-password-1234')
  await page.locator('button[type=submit]').click()
  await expect(page.getByRole('heading',{name:'Discord 인증 관리',exact:true})).toBeVisible()
  await expect(page.getByRole('navigation').getByRole('button',{name:'Discord 인증 관리',exact:true})).toBeVisible()
  await page.getByLabel('기록 상태',{exact:true}).selectOption('orphan')
  await expect(page.locator('.identity-list > li')).toHaveCount(1)
  await page.getByLabel('기록 상태',{exact:true}).selectOption('all')
  await page.getByLabel('인증 기록 검색',{exact:true}).fill('active.student')
  await expect(page.locator('.identity-list > li')).toHaveCount(1)
  await expect(page.getByRole('button',{name:'인증 연결 해제',exact:true})).toBeVisible()
  await page.getByLabel('인증 기록 검색',{exact:true}).fill('')
  await page.locator('.identity-list > li').first().locator('summary').click()
  for(const width of [1440,768,360]) {
    await page.setViewportSize({width,height:1000})
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
    await page.screenshot({path:`test-results/discord-identities-${width}.png`,fullPage:true,animations:'disabled'})
  }
  await page.getByRole('button',{name:'인증 기록 삭제',exact:true}).click()
  const dialog=page.getByRole('dialog')
  await expect(dialog.getByRole('button',{name:'인증 기록 삭제',exact:true})).toBeDisabled()
  await dialog.getByLabel('확인할 Discord ID').fill('wrong')
  await expect(dialog.getByRole('button',{name:'인증 기록 삭제',exact:true})).toBeDisabled()
  await dialog.getByLabel('확인할 Discord ID').fill(orphan.discordId)
  await dialog.getByRole('button',{name:'인증 기록 삭제',exact:true}).click()
  await expect(dialog.getByRole('alert')).toContainText('인증 정보가 변경되었습니다')
  expect(deleted).toBe(0)
  await dialog.getByRole('button',{name:'취소',exact:true}).click()
  await page.getByRole('button',{name:'목록 새로고침'}).click()
  await page.getByRole('button',{name:'인증 기록 삭제',exact:true}).click()
  await dialog.getByLabel('확인할 Discord ID').fill(orphan.discordId)
  await dialog.getByRole('button',{name:'인증 기록 삭제',exact:true}).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('인증 기록을 정리했습니다')
  expect(deleted).toBe(1)
  await expect(page.locator('.identity-list > li')).toHaveCount(1)
})

test('workspace administrator sees scoped authentication management and cannot access global or other workspace records', async ({ page, request }) => {
  const base='http://localhost:3004/api', suffix=randomUUID().slice(0,8)
  const setup=await request.post(`${base}/auth/setup`,{data:{username:'accounts.owner',name:'총괄 관리자',password:'owner-password-1234',setupKey:'account-setup-key-123456'}})
  expect([200,201,409]).toContain(setup.status())
  const owner=await (await request.post(`${base}/auth/login`,{data:{username:'accounts.owner',password:'owner-password-1234'}})).json()
  const headers={Authorization:`Bearer ${owner.token}`}
  const workspace=await (await request.post(`${base}/workspaces`,{headers,data:{name:`관리자 인증 범위 ${suffix}`}})).json()
  const other=await (await request.post(`${base}/workspaces`,{headers,data:{name:`비공개 인증 ${suffix}`}})).json()
  const username=`identity.admin.${suffix}`, password='workspace-password-1234'
  const invitation=await (await request.post(`${base}/workspaces/${workspace.id}/invitations`,{headers,data:{username,role:'admin'}})).json()
  const registered=await request.post(`${base}/auth/register`,{data:{invitationToken:invitation.token,username,name:'워크스페이스 관리자',password}})
  expect(registered.status()).toBe(201)
  const user=await registered.json(), adminHeaders={Authorization:`Bearer ${user.token}`}
  expect((await request.post(`${base}/invitations/accept`,{headers:adminHeaders,data:{token:invitation.token}})).status()).toBe(200)
  const scoped=`${base}/workspaces/${workspace.id}/discord-identities`
  expect((await request.get(scoped,{headers:adminHeaders})).status()).toBe(200)
  expect((await request.get(`${base}/admin/discord-identities`,{headers:adminHeaders})).status()).toBe(403)
  expect((await request.get(`${base}/workspaces/${other.id}/discord-identities`,{headers:adminHeaders})).status()).toBe(403)
  const identity={discordId:'923456789012345678',account:{id:'shared',username:'shared.user',name:'공유 계정'},records:[{kind:'verification',userId:'shared',username:'shared.user',workspaceName:workspace.name,guildId:'123456789012345678',verifiedAt:1,expiresAt:null,orphan:false}],state:'linked',orphanCount:0,canUnlink:false,revision:'c'.repeat(64)}
  const deletion={headers:adminHeaders,data:{discordId:identity.discordId,revision:identity.revision}}
  expect((await request.delete(`${base}/admin/discord-identities/${identity.discordId}`,deletion)).status()).toBe(403)
  expect((await request.delete(`${base}/workspaces/${other.id}/discord-identities/${identity.discordId}`,deletion)).status()).toBe(403)
  expect((await request.delete(`${scoped}/${identity.discordId}`,deletion)).status()).toBe(404)
  let deleted=false
  await page.route(`**/api/workspaces/${workspace.id}/discord-identities**`,async route=>{
    if(route.request().method()==='DELETE') {
      expect(route.request().url()).toBe(`${scoped}/${identity.discordId}`)
      expect(route.request().postDataJSON()).toEqual({discordId:identity.discordId,revision:identity.revision})
      deleted=true; await route.fulfill({json:{ok:true,signedOut:false}})
    } else await route.fulfill({json:{identities:deleted?[]:[identity]}})
  })
  await page.goto(`http://localhost:3004/?workspace=${workspace.id}#discord-identities`)
  await page.getByLabel('아이디',{exact:true}).fill(username)
  await page.getByLabel('비밀번호',{exact:true}).fill(password)
  await page.locator('button[type=submit]').click()
  await expect(page.getByRole('heading',{name:'Discord 인증 관리',exact:true})).toBeVisible()
  const nav=page.getByRole('navigation')
  await expect(nav.getByRole('button',{name:'Discord 인증 관리',exact:true})).toBeVisible()
  await expect(nav.getByRole('button',{name:'전체 계정 관리',exact:true})).toHaveCount(0)
  await expect(page.locator('.identity-intro')).toContainText(workspace.name)
  await expect(page.getByRole('button',{name:'인증 연결 해제',exact:true})).toHaveCount(0)
  await page.getByRole('button',{name:'인증 기록 삭제',exact:true}).click()
  const dialog=page.getByRole('dialog')
  await expect(dialog).toContainText('계정의 전체 Discord 연결은 유지됩니다')
  await expect(dialog).toContainText(`${workspace.name}의 서버 인증`)
  await dialog.getByLabel('확인할 Discord ID').fill(identity.discordId)
  await dialog.getByRole('button',{name:'인증 기록 삭제',exact:true}).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('선택한 워크스페이스의 기록만 정리했습니다')
  expect(deleted).toBe(true)
})

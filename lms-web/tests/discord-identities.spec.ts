import { test, expect } from '@playwright/test'

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

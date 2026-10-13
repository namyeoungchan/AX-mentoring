import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'

test('video upload recovers a TUS offset, requires publication, plays and unpublishes on mobile', async ({ page }) => {
  await page.request.post('/api/login', { data: { password: 'test-only-password-1234' } })
  const ws = await (await page.request.post('/api/workspaces', { data: { name: '영상 화면 ' + randomUUID().slice(0,8) } })).json()
  const base = `/api/workspaces/${ws.id}/videos`
  const courses = [{id:'video-course',title:'영상 수업'}]
  type Video = { id: string; courseId: string; title: string; description: string; filename: string; size: number; lastModified: number; status: string; published: boolean; canEdit: boolean; canDelete: boolean; revision: number; duration: number }
  let video: Video | undefined, created = 0, refreshes = 0, head = 0, patches = 0, sent = 0, deletions = 0
  const browserErrors: string[] = []
  page.on('pageerror', e => browserErrors.push(e.message))
  await page.route(`**${base}**`, async route => {
    const req = route.request(), suffix = new URL(req.url()).pathname.slice(base.length)
    if (!suffix && req.method() === 'GET') return route.fulfill({json:{courses, videos:video?[video]:[],canUpload:true,configured:true,maxBytes:5368709120}})
    if (!suffix && req.method() === 'POST') {
      const body = req.postDataJSON(); created++
      video = {...body,id:body.requestId,status:'uploading',published:false,canEdit:true,canDelete:true,revision:1,duration:0}
      return route.fulfill({status:201,json:video})
    }
    if (suffix.endsWith('/upload')) return route.fulfill({json:{uploadUrl:'https://files.tus.vimeo.com/test-course-video',size:video!.size,filename:video!.filename,lastModified:video!.lastModified}})
    if (suffix.endsWith('/refresh')) { refreshes++; video = {...video!, status:refreshes>1?'ready':'processing',revision:video!.revision+1,duration:60}; return route.fulfill({json:video}) }
    if (suffix.endsWith('/playback')) return route.fulfill({json:{title:video!.title,url:'https://player.vimeo.com/video/123456?dnt=1'}})
    if (req.method() === 'PATCH') {video = {...video!,...req.postDataJSON(),revision:video!.revision+1};return route.fulfill({json:video})}
    if (req.method() === 'DELETE') {
      deletions++
      expect(req.postDataJSON()).toEqual({revision:video!.revision})
      if (deletions === 1) {
        video = {...video!,title:'수정된 강의 제목',revision:video!.revision+1}
        return route.fulfill({status:409,json:{error:'영상 정보가 변경되었습니다. 새로고침 후 삭제할 영상을 다시 확인하세요.'}})
      }
      const id = video!.id; video = undefined
      return route.fulfill({json:{id,deleted:true,vimeoDeleted:false}})
    }
    return route.fulfill({status:404,json:{error:'unexpected route'}})
  })
  await page.route('https://files.tus.vimeo.com/**', async route => {
    const req = route.request()
    expect(req.method()).not.toBe('DELETE')
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Upload-Offset,Upload-Length', 'Access-Control-Allow-Methods': 'HEAD,PATCH,OPTIONS', 'Access-Control-Allow-Headers': 'Tus-Resumable,Upload-Offset,Content-Type' }
    expect(req.headers().authorization).toBeUndefined()
    if (req.method() === 'HEAD') {head++;return route.fulfill({status:200,headers:{...cors,'Upload-Offset':String(sent),'Upload-Length':String(video!.size)}})}
    if (req.method() === 'PATCH') {
      patches++
      expect(req.headers()['tus-resumable']).toBe('1.0.0')
      if (patches === 1) return route.fulfill({status:500,headers:cors})
      expect(Number(req.headers()['upload-offset'])).toBe(sent)
      sent += req.postDataBuffer()!.length
      return route.fulfill({status:204,headers:{...cors,'Upload-Offset':String(sent)}})
    }
    return route.fulfill({status:204,headers:cors})
  })
  await page.route('https://player.vimeo.com/**', route => route.fulfill({contentType:'text/html',body:'<p>Video player test</p>'}))
  await page.goto(`/?workspace=${ws.id}#videos`)
  await page.getByRole('button',{name:'영상 업로드',exact:true}).click()
  await page.getByRole('dialog',{name:'강의 영상 업로드'}).getByRole('button',{name:'취소',exact:true}).click()
  expect(created).toBe(0)
  await page.getByRole('button',{name:'영상 업로드',exact:true}).click()
  const form = page.getByRole('dialog',{name:'강의 영상 업로드'})
  await form.getByLabel('영상 제목').fill('Vimeo 강의 검증')
  await form.getByLabel('영상 설명').fill('수강생 전용 강의입니다.')
  await form.getByLabel('영상 파일').setInputFiles({name:'lesson.mp4',mimeType:'video/mp4',buffer:Buffer.alloc(1000)})
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({width,height:1000})
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
    expect(await form.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
    await page.screenshot({animations:'disabled',path:`test-results/video-upload-${width}.png`})
  }
  await form.getByRole('button',{name:'업로드 시작'}).click()
  const card = page.locator('.video-card').filter({hasText:'Vimeo 강의 검증'})
  await expect(card).toContainText('영상 변환 중')
  expect(created).toBe(1);expect(head).toBe(2);expect(sent).toBe(1000)
  await expect(card.getByRole('button',{name:'시청하기'})).toHaveCount(0)
  await card.getByRole('button',{name:'영상 설정'}).click()
  await expect(page.getByRole('dialog').getByLabel('수강생에게 게시')).toBeDisabled()
  await page.getByRole('dialog').getByRole('button',{name:'취소',exact:true}).click()
  await card.getByRole('button',{name:'상태 확인'}).click()
  await expect(card).toContainText('변환 완료')
  await card.getByRole('button',{name:'영상 설정'}).click()
  const settings = page.getByRole('dialog',{name:'강의 영상 설정'})
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({width,height:1000})
    expect(await settings.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
    await page.screenshot({animations:'disabled',path:`test-results/video-settings-${width}.png`})
  }
  await settings.getByLabel('수강생에게 게시').check()
  await settings.getByRole('button',{name:'저장',exact:true}).click()
  await expect(card).toContainText('게시됨')
  await card.getByRole('button',{name:'목록에서 삭제',exact:true}).click()
  const deletionDialog = page.getByRole('dialog',{name:'강의 영상 목록에서 삭제',exact:true})
  await expect(deletionDialog).toContainText('수강생의 LMS 목록에서도 사라집니다')
  await expect(deletionDialog).toContainText('Vimeo 원본과 기존 Vimeo 링크는 유지됩니다')
  await deletionDialog.getByRole('button',{name:'취소',exact:true}).click()
  expect(deletions).toBe(0)
  await page.getByRole('textbox',{name:'영상 검색'}).fill('없는 영상')
  await expect(page.getByText('조건에 맞는 영상이 없습니다')).toBeVisible()
  await page.getByRole('button',{name:'필터 초기화'}).click()
  await page.getByRole('combobox',{name:'영상 게시 상태'}).selectOption('unpublished')
  await expect(card).toHaveCount(0)
  await page.getByRole('button',{name:'필터 초기화'}).click()
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({width,height:1000})
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
    await page.screenshot({animations:'disabled',path:`test-results/video-list-${width}.png`,fullPage:true})
  }
  await card.getByRole('button',{name:'시청하기'}).click()
  const player = page.getByRole('dialog',{name:'Vimeo 강의 검증'})
  await expect(player.locator('iframe')).toHaveAttribute('referrerpolicy','strict-origin-when-cross-origin')
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({width,height:1000})
    expect(await player.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
    await page.screenshot({animations:'disabled',path:`test-results/video-player-${width}.png`})
  }
  await player.getByText('영상이 재생되지 않나요?').click()
  await expect(player.getByText(/인터넷 연결을 확인한 뒤/)).toBeVisible()
  await player.getByRole('button',{name:'닫기',exact:true}).click()
  await page.setViewportSize({width:390,height:900})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  await card.getByRole('button',{name:'영상 설정'}).click()
  await settings.getByLabel('수강생에게 게시').uncheck()
  await settings.getByRole('button',{name:'저장',exact:true}).click()
  await expect(card.getByRole('button',{name:'시청하기'})).toHaveCount(0)
  expect(video!.published).toBe(false)
  await page.screenshot({animations:'disabled',path:'test-results/course-videos-mobile.png',fullPage:true})
  await card.getByRole('button',{name:'목록에서 삭제',exact:true}).click()
  for (const width of [1440,390,360]) {
    await page.setViewportSize({width,height:1000})
    expect(await deletionDialog.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
    await page.screenshot({animations:'disabled',path:`test-results/video-removal-${width}.png`})
  }
  await deletionDialog.getByRole('button',{name:'목록에서 삭제',exact:true}).click()
  await expect(deletionDialog.getByRole('alert')).toContainText('영상 정보가 변경되었습니다')
  await expect(deletionDialog).toContainText('수정된 강의 제목')
  await deletionDialog.getByRole('button',{name:'목록에서 삭제',exact:true}).click()
  await expect(deletionDialog).toHaveCount(0)
  await expect(page.getByText('아직 등록된 강의 영상이 없습니다')).toBeVisible()
  await expect(page.getByRole('status').filter({hasText:'LMS 목록에서 삭제했습니다'})).toContainText('Vimeo 원본은 보존됩니다')
  expect(deletions).toBe(2)
  expect(browserErrors).toEqual([])
})

test('video cards restrict removal controls and show persisted cause-specific errors after a failed refresh', async ({page}) => {
  await page.request.post('/api/login',{data:{password:'test-only-password-1234'}})
  const ws = await (await page.request.post('/api/workspaces',{data:{name:'영상 오류 '+randomUUID().slice(0,8)}})).json()
  const base = `/api/workspaces/${ws.id}/videos`
  const errors = ['업로드 준비: Vimeo 주간 업로드 한도에 도달했습니다.','이전 업로드에서 Vimeo가 접근을 거부했습니다. 당시 상세 원인이 저장되지 않았습니다.']
  let own = {id:'own',courseId:'course',title:'내 실패 항목',description:'',status:'error',published:false,duration:0,revision:1,canEdit:true,canDelete:true,error:errors[0]}
  const peer = {...own,id:'peer',title:'다른 멘토 영상',canEdit:false,canDelete:false,error:errors[1]}
  await page.route(`**${base}**`,async route=>{
    if (route.request().method()==='GET') return route.fulfill({json:{courses:[{id:'course',title:'담당 수업'}],videos:[own,peer],canUpload:true,configured:true,maxBytes:5368709120}})
    own = {...own,error:'재생 보호 설정: 현재 Vimeo 요금제에서 이 설정을 사용할 수 없습니다.',revision:2}
    return route.fulfill({status:502,json:{error:own.error}})
  })
  await page.goto(`/?workspace=${ws.id}#videos`)
  const ownCard=page.locator('.video-card').filter({hasText:'내 실패 항목'}),peerCard=page.locator('.video-card').filter({hasText:'다른 멘토 영상'})
  await expect(ownCard).toContainText(errors[0])
  await expect(peerCard).toContainText(errors[1])
  await expect(ownCard.getByRole('button',{name:'목록에서 삭제',exact:true})).toBeVisible()
  await expect(peerCard.getByRole('button',{name:'목록에서 삭제',exact:true})).toHaveCount(0)
  await ownCard.getByRole('button',{name:'상태 확인',exact:true}).click()
  await expect(ownCard).toContainText('현재 Vimeo 요금제에서 이 설정을 사용할 수 없습니다')
  await expect(page.getByRole('alert')).toContainText('재생 보호 설정')
})

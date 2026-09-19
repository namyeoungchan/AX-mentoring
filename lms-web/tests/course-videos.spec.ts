import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'

test('video upload recovers a TUS offset, requires publication, plays and unpublishes on mobile', async ({ page }) => {
  await page.request.post('/api/login', { data: { password: 'test-only-password-1234' } })
  const ws = await (await page.request.post('/api/workspaces', { data: { name: '영상 화면 ' + randomUUID().slice(0,8) } })).json()
  const base = `/api/workspaces/${ws.id}/videos`
  const courses = [{id:'video-course',title:'영상 수업'}]
  type Video = { id: string; courseId: string; title: string; description: string; filename: string; size: number; lastModified: number; status: string; published: boolean; canEdit: boolean; revision: number; duration: number }
  let video: Video | undefined, created = 0, refreshes = 0, head = 0, patches = 0, sent = 0
  const browserErrors: string[] = []
  page.on('pageerror', e => browserErrors.push(e.message))
  await page.route(`**${base}**`, async route => {
    const req = route.request(), suffix = new URL(req.url()).pathname.slice(base.length)
    if (!suffix && req.method() === 'GET') return route.fulfill({json:{courses, videos:video?[video]:[],canUpload:true,configured:true,maxBytes:5368709120}})
    if (!suffix && req.method() === 'POST') {
      const body = req.postDataJSON(); created++
      video = {...body,id:body.requestId,status:'uploading',published:false,canEdit:true,revision:1,duration:0}
      return route.fulfill({status:201,json:video})
    }
    if (suffix.endsWith('/upload')) return route.fulfill({json:{uploadUrl:'https://files.tus.vimeo.com/test-course-video',size:video!.size,filename:video!.filename,lastModified:video!.lastModified}})
    if (suffix.endsWith('/refresh')) { refreshes++; video = {...video!, status:refreshes>1?'ready':'processing',revision:video!.revision+1,duration:60}; return route.fulfill({json:video}) }
    if (suffix.endsWith('/playback')) return route.fulfill({json:{title:video!.title,url:'https://player.vimeo.com/video/123456?dnt=1'}})
    if (req.method() === 'PATCH') {video = {...video!,...req.postDataJSON(),revision:video!.revision+1};return route.fulfill({json:video})}
    return route.fulfill({status:404,json:{error:'unexpected route'}})
  })
  await page.route('https://files.tus.vimeo.com/**', async route => {
    const req = route.request()
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
  expect(browserErrors).toEqual([])
})

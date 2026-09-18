import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Play, Upload, RefreshCw } from 'lucide-react'
import { workspaceRequest, demoMode } from './api'
import { Badge, CardHeading, ModalShell } from './components'
import { uploadVimeo } from './vimeoUpload'

type Video = { id: string; courseId: string; title: string; description: string; status: string; published: boolean; duration: number; revision: number; canEdit?: boolean; error?: string; filename?: string; size?: number; lastModified?: number }
type Catalogue = { courses: { id: string; title: string }[]; videos: Video[]; canUpload: boolean; configured: boolean; maxBytes: number }
const labels: Record<string, string> = { preparing: '업로드 준비 중', uploading: '업로드 대기', processing: '영상 변환 중', ready: '변환 완료', error: '확인 필요' }
const formats = '.mp4,.mov,.m4v,.webm,.avi,.mkv'

export default function CourseVideos({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<Catalogue | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [adding, setAdding] = useState(false), [editing, setEditing] = useState<Video | null>(null), [playing, setPlaying] = useState<{ url: string; title: string } | null>(null)
  const [busy, setBusy] = useState(false), [transfer, setTransfer] = useState<{ id: string; percent: number } | null>(null)
  const controller = useRef<AbortController | null>(null), active = useRef(true)
  const pendingRequest = useRef<{ fingerprint: string; id: string } | null>(null)
  const load = useCallback(async () => {
    const result = await workspaceRequest(workspaceId, 'videos')
    if (active.current) setData(result)
    return result as Catalogue
  }, [workspaceId])
  useEffect(() => {
    active.current = true
    if (!demoMode && workspaceId) void load().catch(e => setError(e.message))
    return () => { active.current = false; controller.current?.abort() }
  }, [load, workspaceId])
  useEffect(() => {
    if (!transfer) return
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [transfer])
  // Poll only unfinished videos owned by the current mentor, while this page is visible.
  useEffect(() => {
    if (!data?.videos.some(v => v.canEdit && v.status === 'processing') || busy || transfer) return
    let inFlight = false
    const timer = setInterval(async () => {
      if (document.hidden || inFlight) return
      inFlight = true
      try {
        for (const v of data.videos.filter(v => v.canEdit && v.status === 'processing').slice(0, 5)) await workspaceRequest(workspaceId, `videos/${v.id}/refresh`, { method: 'POST', body: '{}' })
        await load()
      } catch { /* Manual refresh retains actionable errors without repetitive alerts. */ }
      finally { inFlight = false }
    }, 15000)
    return () => clearInterval(timer)
  }, [data, busy, transfer, load, workspaceId])
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (e) { if (active.current) setError((e as Error).message) }
    finally { if (active.current) setBusy(false) }
  }
  async function send(video: Video, file: File) {
    if (file.size !== video.size || file.name !== video.filename || file.lastModified !== video.lastModified) throw new Error('처음 선택한 동일한 원본 파일을 선택하세요.')
    const session = await workspaceRequest(workspaceId, `videos/${video.id}/upload`, { method: 'POST', body: '{}' })
    if (!active.current) return
    const aborter = new AbortController(); controller.current = aborter
    setTransfer({ id: video.id, percent: 0 })
    try {
      await uploadVimeo(file, session.uploadUrl, aborter.signal, percent => { if (active.current) setTransfer({ id: video.id, percent }) })
      await workspaceRequest(workspaceId, `videos/${video.id}/refresh`, { method: 'POST', body: '{}' })
      if (active.current) setNotice('전송이 완료되었습니다. 변환 완료 후 게시해 주세요.')
    } catch (e) {
      if (aborter.signal.aborted) { if (active.current) setNotice('업로드를 일시 중지했습니다. 같은 파일로 이어 올릴 수 있습니다.') }
      else throw e
    } finally { controller.current = null; if (active.current) { setTransfer(null); await load() } }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget), file = form.get('file') as File
    if (!file?.size) { setError('영상 파일을 선택하세요.'); return }
    if (file.size > (data?.maxBytes || 0)) { setError('영상 파일이 업로드 용량 제한을 초과했습니다.'); return }
    await run(async () => {
      const input = { courseId: String(form.get('courseId')), title: String(form.get('title')), description: String(form.get('description')), filename: file.name, size: file.size, lastModified: file.lastModified }
      const fingerprint = JSON.stringify(input)
      if (pendingRequest.current?.fingerprint !== fingerprint) pendingRequest.current = { fingerprint, id: crypto.randomUUID() }
      const video: Video = await workspaceRequest(workspaceId, 'videos', { method: 'POST', signal: AbortSignal.timeout(180000), body: JSON.stringify({ ...input, requestId: pendingRequest.current.id }) })
      if (!active.current) return
      setAdding(false); pendingRequest.current = null; await load()
      if (video.status !== 'uploading') throw new Error(video.error || '영상 준비 중입니다. 목록에서 상태를 확인하세요.')
      await send(video, file)
    })
  }
  async function edit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editing) return
    const form = new FormData(event.currentTarget)
    await run(async () => {
      await workspaceRequest(workspaceId, `videos/${editing.id}`, { method: 'PATCH', signal: AbortSignal.timeout(180000), body: JSON.stringify({ revision: editing.revision, title: String(form.get('title')), description: String(form.get('description')), published: form.get('published') === 'on' }) })
      setEditing(null); setPlaying(null); await load(); setNotice('영상 정보를 저장했습니다.')
    })
  }
  if (demoMode) return <section className="panel student-empty"><h2>강의 영상</h2><p>실제 워크스페이스에 로그인하면 이용할 수 있습니다.</p></section>
  return <>
    {error && <p className="error-note" role="alert">{error}</p>}
    {notice && <p className="success-note" role="status">{notice}</p>}
    <section className="panel course-videos">
      <CardHeading title="강의 영상" subtitle="수강 중인 과정의 게시된 영상을 시청할 수 있습니다."><div className="video-actions"><button className="button secondary" disabled={busy} onClick={() => void run(async () => { await load() })}><RefreshCw size={16} />새로고침</button>{data?.canUpload && <button className="button primary" disabled={busy || !data.configured || !data.courses.length} onClick={() => { setError(''); setAdding(true) }}><Upload size={16} />영상 업로드</button>}</div></CardHeading>
      {!data && !error && <p role="status">영상 목록을 불러오는 중…</p>}
      {data?.canUpload && !data.configured && <p className="error-note">영상 서비스 연결 설정이 필요합니다. 관리자에게 문의하세요.</p>}
      {data && !data.videos.length && <p className="calendar-empty">{data.canUpload ? '등록된 영상이 없습니다. 담당 과정을 선택해 영상을 올려 주세요.' : '게시된 강의 영상이 없습니다.'}</p>}
      <div className="video-grid">{data?.videos.map(video => <article className="video-card" key={video.id}>
        <div className="video-meta"><Badge tone={video.published ? 'green' : 'orange'}>{video.published ? '게시됨' : labels[video.status] || video.status}</Badge><span>{data.courses.find(c => c.id === video.courseId)?.title}</span></div>
        <h3>{video.title}</h3><p className="video-description">{video.description}</p>
        {video.duration > 0 && <span>{Math.floor(video.duration / 60)}분 {Math.round(video.duration % 60)}초</span>}
        {video.error && <p className="error-note">{video.error}</p>}
        {transfer?.id === video.id && <div className="video-progress"><label htmlFor={`progress-${video.id}`}>영상 전송 {transfer.percent}%</label><progress id={`progress-${video.id}`} max={100} value={transfer.percent} /><button className="button secondary" onClick={() => controller.current?.abort()}>업로드 일시 중지</button></div>}
        <div className="video-actions">
          {video.published && <button className="button primary" disabled={busy} onClick={() => void run(async () => setPlaying(await workspaceRequest(workspaceId, `videos/${video.id}/playback`)))}><Play size={16} />시청하기</button>}
          {video.canEdit && <>
            <button className="button secondary" disabled={busy} onClick={() => { setError(''); setEditing(video) }}>영상 설정</button>
            <button className="button secondary" disabled={busy} onClick={() => void run(async () => { await workspaceRequest(workspaceId, `videos/${video.id}/refresh`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(180000) }); await load() })}>상태 확인</button>
            {video.status === 'uploading' && <label className={`button secondary video-resume ${busy ? 'disabled' : ''}`}>이어 올리기<input type="file" accept={formats} aria-label={`${video.title} 이어 올리기`} disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(() => send(video,file)) }} /></label>}
          </>}
        </div>
      </article>)}</div>
    </section>
    {adding && <ModalShell title="강의 영상 업로드" close={() => setAdding(false)} busy={busy}><form className="video-form" onSubmit={event => void create(event)}>
      <label>과정<select name="courseId" required>{data?.courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>
      <label>영상 제목<input name="title" required maxLength={150} /></label><label>영상 설명<textarea name="description" maxLength={3000} rows={3} /></label>
      <label>영상 파일<input name="file" type="file" required accept={formats} /></label><p>최대 {((data?.maxBytes || 0) / 1024 ** 3).toFixed(1)}GB · 업로드 중에는 이 화면을 유지하세요. 변환 후 게시하면 수강생에게 표시됩니다.</p>
      {error && <p role="alert" className="error-note">{error}</p>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setAdding(false)}>취소</button><button className="button primary" disabled={busy}>{busy ? '업로드 준비 중…' : '업로드 시작'}</button></div>
    </form></ModalShell>}
    {editing && <ModalShell title="강의 영상 설정" close={() => setEditing(null)} busy={busy}><form className="video-form" onSubmit={event => void edit(event)}>
      <label>영상 제목<input name="title" defaultValue={editing.title} required maxLength={150} /></label><label>영상 설명<textarea name="description" defaultValue={editing.description} maxLength={3000} rows={3} /></label>
      <label className="video-publish"><input type="checkbox" name="published" defaultChecked={editing.published} disabled={editing.status !== 'ready'} />수강생에게 게시</label><p>게시를 해제하면 수강생 목록에서 숨겨지고 Vimeo 재생도 비공개로 전환됩니다.</p>
      {editing.status !== 'ready' && <p>변환 완료 후 게시할 수 있습니다.</p>}{error && <p role="alert" className="error-note">{error}</p>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setEditing(null)}>취소</button><button className="button primary" disabled={busy}>저장</button></div>
    </form></ModalShell>}
    {playing && <ModalShell title={playing.title} close={() => setPlaying(null)} className="video-player-modal"><iframe className="video-player" src={playing.url} title={playing.title} allow="fullscreen; picture-in-picture; encrypted-media" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /><p>재생이 제한되면 현재 웹 주소의 재생 허용 여부를 관리자에게 문의하세요.</p></ModalShell>}
  </>
}

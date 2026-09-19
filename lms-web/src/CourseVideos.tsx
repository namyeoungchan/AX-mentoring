import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Play, Upload, RefreshCw, Film, Search, Clock3, Settings2 } from 'lucide-react'
import { workspaceRequest, demoMode } from './api'
import { Badge, CardHeading, ModalShell } from './components'
import { uploadVimeo } from './vimeoUpload'

type Video = { id: string; courseId: string; title: string; description: string; status: string; published: boolean; duration: number; revision: number; canEdit?: boolean; error?: string; filename?: string; size?: number; lastModified?: number }
type Catalogue = { courses: { id: string; title: string }[]; videos: Video[]; canUpload: boolean; configured: boolean; maxBytes: number }
const labels: Record<string, string> = { preparing: '업로드 준비 중', uploading: '업로드 대기', processing: '영상 변환 중', ready: '변환 완료', error: '확인 필요' }
const durationLabel = (seconds: number) => `${Math.floor(seconds / 60)}분 ${Math.floor(seconds % 60)}초`
const sizeLabel = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`
const formats = '.mp4,.mov,.m4v,.webm,.avi,.mkv'

export default function CourseVideos({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<Catalogue | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [adding, setAdding] = useState(false), [editing, setEditing] = useState<Video | null>(null), [playing, setPlaying] = useState<{ url: string; title: string; courseTitle: string; description: string; duration: number } | null>(null)
  const [busy, setBusy] = useState(false), [transfer, setTransfer] = useState<{ id: string; percent: number } | null>(null)
  const [query, setQuery] = useState(''), [courseFilter, setCourseFilter] = useState(''), [statusFilter, setStatusFilter] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const locked = useRef(false)
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
    if (!data?.videos.some(v => v.canEdit && v.status === 'processing') || busy || transfer || editing || adding) return
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
  }, [data, busy, transfer, editing, adding, load, workspaceId])
  async function run(action: () => Promise<void>) {
    if (locked.current) return
    locked.current = true
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (e) { if (active.current) setError((e as Error).message) }
    finally { locked.current = false; if (active.current) setBusy(false) }
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
      setAdding(false); setQuery(''); setCourseFilter(''); setStatusFilter(''); pendingRequest.current = null; await load()
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
  const courseTitle = (id: string) => data?.courses.find(c => c.id === id)?.title || '강의 과정'
  const visibleVideos = data?.videos.filter(v => (!courseFilter || v.courseId === courseFilter)
    && (!statusFilter || (statusFilter === 'published' ? v.published : !v.published))
    && `${v.title} ${v.description} ${courseTitle(v.courseId)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) || []
  const filtered = Boolean(query || courseFilter || statusFilter)
  if (demoMode) return <section className="panel student-empty"><h2>강의 영상</h2><p>실제 워크스페이스에 로그인하면 이용할 수 있습니다.</p></section>
  return <>
    {error && !adding && !editing && <p className="error-note" role="alert">{error}</p>}
    {notice && <p className="success-note" role="status">{notice}</p>}
    <section className="panel course-videos" aria-label="강의 영상 목록">
      <CardHeading title="강의 영상" subtitle={data?.canUpload ? '영상을 업로드하고 변환이 완료되면 수강생에게 게시하세요.' : '수강 중인 과정의 게시된 영상을 시청하세요.'}><div className="video-actions"><button className="button secondary" disabled={busy} onClick={() => void run(async () => { await load() })}><RefreshCw size={16} />새로고침</button>{data?.canUpload && <button className="button primary" disabled={busy || !data.configured || !data.courses.length} onClick={() => { setError(''); setSelectedFile(null); setAdding(true) }}><Upload size={16} />영상 업로드</button>}</div></CardHeading>
      <div className="video-catalogue-body">
        {!data && !error && <p className="calendar-empty" role="status">영상 목록을 불러오는 중…</p>}
        {data?.canUpload && !data.configured && <p className="error-note">영상 서비스 연결 설정이 필요합니다. 관리자에게 문의하세요.</p>}
        {data?.canUpload && !data.courses.length && <p className="video-help">업로드할 담당 과정이 없습니다. 관리자에게 과정 배정을 요청하세요.</p>}
        {data && data.videos.length > 0 && <>
          <div className="video-toolbar">
            <label className="video-search"><Search size={17} aria-hidden="true" /><input disabled={busy} aria-label="영상 검색" placeholder="제목 또는 설명 검색" value={query} onChange={e => setQuery(e.target.value)} /></label>
            {data.courses.length > 1 && <select disabled={busy} aria-label="영상 과정 필터" value={courseFilter} onChange={e => setCourseFilter(e.target.value)}><option value="">전체 과정</option>{data.courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select>}
            {data.canUpload && <select disabled={busy} aria-label="영상 게시 상태" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="">전체 상태</option><option value="published">게시됨</option><option value="unpublished">미게시</option></select>}
          </div>
          <div className="video-result-count"><span role="status">전체 {data.videos.length}개{filtered ? ` · 검색 결과 ${visibleVideos.length}개` : ` · 게시 ${data.videos.filter(v => v.published).length}개`}</span>{filtered && <button className="text-button" onClick={() => { setQuery(''); setCourseFilter(''); setStatusFilter('') }}>필터 초기화</button>}</div>
        </>}
        {data && !visibleVideos.length && <div className="video-empty"><Film size={32} aria-hidden="true" /><h3>{filtered ? '조건에 맞는 영상이 없습니다' : '아직 등록된 강의 영상이 없습니다'}</h3><p>{filtered ? '검색어나 필터를 변경해 보세요.' : data.canUpload ? '영상 업로드 → 변환 확인 → 게시 순서로 강의를 준비하세요.' : '멘토가 영상을 게시하면 이곳에서 시청할 수 있습니다.'}</p></div>}
        <div className="video-grid">{visibleVideos.map(video => <article className="video-card" key={video.id}>
          <div className="video-card-cover" aria-hidden="true"><Film size={34} /><span>강의 영상</span>{video.duration > 0 && <span className="video-duration"><Clock3 size={13} />{durationLabel(video.duration)}</span>}</div>
          <div className="video-card-body">
            <div className="video-meta"><Badge tone={video.published ? 'green' : 'orange'}>{video.published ? '게시됨' : labels[video.status] || video.status}</Badge>{!video.published && video.status === 'ready' && <span>미게시</span>}</div>
            <span className="video-course-name">{courseTitle(video.courseId)}</span><h3>{video.title}</h3><p className="video-description">{video.description || '등록된 영상 설명이 없습니다.'}</p>
            {!video.published && video.canEdit && <p className="video-help">{video.status === 'ready' ? '영상 설정에서 게시하면 수강생이 시청할 수 있습니다.' : video.status === 'processing' ? '영상 변환 중입니다. 완료되면 게시할 수 있습니다.' : video.status === 'uploading' ? '같은 원본 파일을 선택하면 이어서 전송합니다.' : '상태를 확인해 업로드를 진행하세요.'}</p>}
            {video.error && <p className="error-note">{video.error}</p>}
            {transfer?.id === video.id && <div className="video-progress"><label htmlFor={`progress-${video.id}`}>영상 전송 {transfer.percent}%</label><progress id={`progress-${video.id}`} max={100} value={transfer.percent} /><p>전송 중에는 이 화면을 유지하세요.</p><button className="button secondary" onClick={() => controller.current?.abort()}>업로드 일시 중지</button></div>}
            <div className="video-card-footer"><div className="video-actions">
              {video.published && <button className="button primary" disabled={busy} onClick={() => void run(async () => { const playback = await workspaceRequest(workspaceId, `videos/${video.id}/playback`); setPlaying({ ...playback, courseTitle: courseTitle(video.courseId), description: video.description, duration: video.duration }) })}><Play size={16} />시청하기</button>}
              {video.canEdit && <>
                <button className="button secondary" disabled={busy} onClick={() => { setError(''); setEditing(video) }}><Settings2 size={16} />영상 설정</button>
                {video.status === 'uploading' && !transfer && <label className={`button secondary video-resume ${busy ? 'disabled' : ''}`}>이어 올리기<input type="file" accept={formats} aria-label={`${video.title} 이어 올리기`} disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(() => send(video,file)) }} /></label>}
              </>}
            </div>{video.canEdit && <button className="text-button video-refresh" disabled={busy} onClick={() => void run(async () => { await workspaceRequest(workspaceId, `videos/${video.id}/refresh`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(180000) }); await load() })}><RefreshCw size={14} />상태 확인</button>}</div>
          </div>
        </article>)}</div>
      </div>
    </section>
    {adding && <ModalShell title="강의 영상 업로드" close={() => setAdding(false)} busy={busy}><form className="modal-form video-form" onSubmit={event => void create(event)}>
      <div className="video-form-intro"><Upload size={20} aria-hidden="true" /><div><strong>수강생에게 전달할 강의를 준비하세요</strong><p>파일 전송 후 변환이 완료되면 영상 설정에서 게시할 수 있습니다.</p></div></div>
      <fieldset disabled={busy}>
        <label>과정<select name="courseId" required defaultValue={data?.courses.length === 1 ? data.courses[0].id : ''}><option value="" disabled>업로드할 과정을 선택하세요</option>{data?.courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>
        <label>영상 제목<input name="title" placeholder="예: 1주차 · 생성형 AI 시작하기" required maxLength={150} data-modal-autofocus /></label><label>영상 설명<textarea name="description" placeholder="학습 내용과 시청 전 안내를 적어 주세요. (선택)" maxLength={3000} rows={3} /></label>
        <label className="video-file-field">영상 파일<input name="file" type="file" required accept={formats} aria-describedby="video-file-help" onChange={e => setSelectedFile(e.target.files?.[0] || null)} /><span>{selectedFile ? `${selectedFile.name} · ${sizeLabel(selectedFile.size)}` : '업로드할 영상 파일을 선택하세요.'}</span></label>
        <p id="video-file-help" className="video-help">최대 {sizeLabel(data?.maxBytes || 0)} · MP4, MOV, M4V, WEBM, AVI, MKV<br />전송 중에는 이 화면을 유지하세요. 업로드만으로 수강생에게 공개되지 않습니다.</p>
      </fieldset>
      {error && <p role="alert" className="error-note">{error}</p>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setAdding(false)}>취소</button><button className="button primary" disabled={busy}>{busy ? '업로드 준비 중…' : '업로드 시작'}</button></div>
    </form></ModalShell>}
    {editing && <ModalShell title="강의 영상 설정" close={() => setEditing(null)} busy={busy}><form className="modal-form video-form" onSubmit={event => void edit(event)}>
      <div className="video-form-intro"><Settings2 size={20} aria-hidden="true" /><div><strong>{courseTitle(editing.courseId)}</strong><p>영상 정보와 수강생 공개 여부를 관리하세요.</p></div><Badge tone={editing.published ? 'green' : 'orange'}>{editing.published ? '게시됨' : labels[editing.status] || editing.status}</Badge></div>
      <fieldset disabled={busy}>
        <label>영상 제목<input name="title" defaultValue={editing.title} required maxLength={150} data-modal-autofocus /></label><label>영상 설명<textarea name="description" defaultValue={editing.description} maxLength={3000} rows={3} /></label>
        <label className="video-publish"><input type="checkbox" name="published" defaultChecked={editing.published} disabled={editing.status !== 'ready'} aria-describedby="video-publish-help" /><span>수강생에게 게시</span></label>
        <p id="video-publish-help" className="video-help">{editing.status !== 'ready' ? '변환 완료 후 게시할 수 있습니다. 목록에서 상태를 확인하세요.' : '게시하면 이 과정 수강생이 시청할 수 있습니다. 게시를 해제하면 목록에서 숨겨지고 영상 재생도 비공개로 전환됩니다.'}</p>
      </fieldset>
      {error && <p role="alert" className="error-note">{error}</p>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setEditing(null)}>취소</button><button className="button primary" disabled={busy}>{busy ? '저장 중…' : '저장'}</button></div>
    </form></ModalShell>}
    {playing && <ModalShell title={playing.title} close={() => setPlaying(null)} className="video-player-modal"><div className="video-player-content"><div className="video-playback-meta"><span>{playing.courseTitle}</span>{playing.duration > 0 && <span><Clock3 size={14} />{durationLabel(playing.duration)}</span>}<Badge tone="green">수강생 전용</Badge></div><iframe className="video-player" src={playing.url} title={playing.title} allow="fullscreen; picture-in-picture; encrypted-media" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /><div className="video-player-details">{playing.description && <p className="video-description">{playing.description}</p>}<details className="video-playback-help"><summary>영상이 재생되지 않나요?</summary><p>인터넷 연결을 확인한 뒤 창을 닫고 다시 시청해 보세요. 계속 제한되면 현재 웹 주소와 영상 제목을 관리자에게 알려 주세요.</p></details></div></div></ModalShell>}
  </>
}

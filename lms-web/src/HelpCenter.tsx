import { useEffect, useRef, useState } from 'react'
import { BookOpen, Download, FileText, Search, Upload, ZoomIn, ArrowUpRight, RotateCcw, ChevronLeft, ChevronRight } from 'lucide-react'
import { apiDownload, workspaceRequest } from './api'
import { ModalShell } from './components'
import './help-center.css'

type Document = { filename: string; revision: string | null; updatedAt: number | null }
type Guide = { id: string; role: string; feature: string; title: string; category: string; summary: string; route: string; steps: { title: string; body: string; surface?: string; imageAvailable?: boolean }[]; note: string; capturedAt: string; document: Document }
type Catalog = { role: string; roleLabel: string; canManage: boolean; guides: Guide[] }
type Management = { roles: Record<string, string>; readOnly: boolean; guides: Pick<Guide, 'id' | 'role' | 'title' | 'category' | 'document'>[] }
const errorText = (e: unknown) => e instanceof Error ? e.message : '요청을 완료하지 못했습니다.'

export default function HelpCenter({ workspaceId, go, demo = false }: { workspaceId: string; go: (page: string) => void; demo?: boolean }) {
  const [data, setData] = useState<Catalog | null>(null), [error, setError] = useState('')
  const [query, setQuery] = useState(''), [category, setCategory] = useState('전체'), [selected, setSelected] = useState('')
  const [version, setVersion] = useState(0), [manage, setManage] = useState(false)
  const role = useRef('')
  useEffect(() => {
    if (demo) return
    const controller = new AbortController()
    const load = () => workspaceRequest(workspaceId, 'help', { signal: controller.signal }).then((value: Catalog) => {
      if (controller.signal.aborted) return
      if (role.current && role.current !== value.role) { setSelected(''); setQuery(''); setCategory('전체'); setManage(false) }
      role.current = value.role; setData(value); setError('')
    }).catch(e => { if (!controller.signal.aborted) { setData(null); setManage(false); setError(errorText(e)) } })
    void load()
    const timer = setInterval(() => void load(), 30000)
    window.addEventListener('focus', load)
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', load) }
  }, [workspaceId, version, demo])
  if (demo) return <section className="panel help-empty"><BookOpen /><h2>로그인 후 내 역할의 도움말을 확인하세요.</h2><p>도움말과 PDF는 실제 워크스페이스 권한을 확인한 뒤 제공합니다.</p></section>
  if (!data) return <section className="panel help-empty">{error ? <><p role="alert">{error}</p><button className="button secondary" onClick={() => setVersion(v => v + 1)}>다시 불러오기</button></> : <p role="status">내 역할의 가이드를 불러오는 중…</p>}</section>
  const categories = ['전체', ...new Set(data.guides.map(g => g.category))]
  const visible = data.guides.filter(g => (category === '전체' || g.category === category) && `${g.title} ${g.category} ${g.summary} ${g.steps.map(s => `${s.title} ${s.body}`).join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const guide = visible.find(g => g.id === selected) || visible[0]
  return <section className="help-center" aria-label="역할별 도움말">
    <header className="help-intro"><div><span className="help-role">{data.roleLabel} 전용</span><h2>필요한 기능부터 살펴보세요.</h2><p>현재 역할에서 사용할 수 있는 기능을 실제 화면으로 안내합니다.</p></div><BookOpen size={34} aria-hidden="true" /></header>
    {data.canManage && <div className="help-tabs" role="group" aria-label="도움말 메뉴"><button aria-pressed={!manage} onClick={() => setManage(false)}>내 기능 가이드</button><button aria-pressed={manage} onClick={() => setManage(true)}>PDF 등록·교체</button></div>}
    {manage && data.canManage ? <HelpManagement workspaceId={workspaceId} changed={() => setVersion(v => v + 1)} /> : <>
      <div className="help-toolbar"><label><Search size={17} /><input type="search" aria-label="기능 가이드 검색" placeholder="궁금한 기능 검색" value={query} onChange={e => setQuery(e.target.value)} /></label><span>가이드 {visible.length}개</span></div>
      <div className="help-categories" role="group" aria-label="기능 분류">{categories.map(c => <button key={c} aria-pressed={category === c} onClick={() => setCategory(c)}>{c}</button>)}</div>
      {guide ? <div className="help-layout"><nav className="help-topics" aria-label="기능별 가이드">{visible.map(g => <button key={g.id} aria-current={guide.id === g.id ? 'true' : undefined} onClick={() => setSelected(g.id)}><small>{g.category}</small><strong>{g.title}</strong><span>{g.document.revision ? '등록된 PDF' : '화면 가이드 · PDF'}</span></button>)}</nav><GuideDetail key={`${workspaceId}:${guide.id}:${guide.document.revision || ''}`} workspaceId={workspaceId} guide={guide} roleLabel={data.roleLabel} go={go} onDenied={() => { setData(null); setVersion(v => v + 1) }} /></div> : <div className="panel help-empty"><Search /><h3>검색 결과가 없습니다.</h3><p>다른 기능 이름으로 검색하거나 분류를 바꿔 보세요.</p><button className="button secondary" onClick={() => { setQuery(''); setCategory('전체') }}>검색 초기화</button></div>}
    </>}
  </section>
}

function GuideDetail({ workspaceId, guide, roleLabel, go, onDenied }: { workspaceId: string; guide: Guide; roleLabel: string; go: (page: string) => void; onDenied: () => void }) {
  const [imageState, setImageState] = useState({ path: '', url: '', error: '' }), [error, setError] = useState('')
  const [stepIndex, setStepIndex] = useState(0)
  const step = guide.steps[stepIndex]
  const [zoom, setZoom] = useState(false), [pdf, setPdf] = useState(''), [busy, setBusy] = useState(false)
  const live = useRef(true), locked = useRef(false), urls = useRef<string[]>([])
  const imageButton = useRef<HTMLButtonElement>(null), pdfButton = useRef<HTMLButtonElement>(null)
  function closeZoom() { setZoom(false); requestAnimationFrame(() => imageButton.current?.focus()) }
  function closePdf() { setPdf(''); requestAnimationFrame(() => pdfButton.current?.focus()) }
  const denied = useRef(onDenied)
  useEffect(() => { denied.current = onDenied }, [onDenied])
  const path = `workspaces/${encodeURIComponent(workspaceId)}/help/${encodeURIComponent(guide.id)}`
  const imagePath = `${path}/step-${stepIndex + 1}`
  const image = imageState.path === imagePath ? imageState.url : ''
  const imageError = imageState.path === imagePath ? imageState.error : ''
  const hasImage = step.imageAvailable !== false
  const surface = step.surface || 'LMS'
  const pendingScreens = guide.steps.filter(s => s.imageAvailable === false).length
  useEffect(() => {
    live.current = true
    let cancelled = false
    if (hasImage) void apiDownload(imagePath).then(blob => {
      if (cancelled) return
      const url = URL.createObjectURL(blob); urls.current.push(url); setImageState({ path: imagePath, url, error: '' })
    }).catch(e => { if (!cancelled) { setImageState({ path: imagePath, url: '', error: errorText(e) }); if ([401, 403].includes(e.status)) denied.current() } })
    return () => { cancelled = true; live.current = false; urls.current.forEach(URL.revokeObjectURL); urls.current = [] }
  }, [imagePath, hasImage])
  async function openPdf(download: boolean) {
    if (locked.current) return
    locked.current = true; setBusy(true); setError('')
    try {
      const blob = await apiDownload(`${path}/pdf`)
      if (!live.current) return
      const url = URL.createObjectURL(blob); urls.current.push(url)
      if (download) { const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${roleLabel}-${guide.title}.pdf`; anchor.click() }
      else setPdf(url)
    } catch (e) { if (live.current) { setError(errorText(e)); if ([401, 403].includes((e as { status?: number }).status || 0)) denied.current() } }
    finally { locked.current = false; if (live.current) setBusy(false) }
  }
  return <article className="panel help-detail" aria-label={guide.title}>
    <div className="help-detail-heading"><span>{guide.category}</span><h2>{guide.title}</h2><p>{guide.summary}</p><div className="help-actions"><button ref={pdfButton} className="button primary" disabled={busy} onClick={() => void openPdf(false)}><FileText size={16} />PDF 보기</button><button className="button secondary" disabled={busy} onClick={() => void openPdf(true)}><Download size={16} />다운로드</button><button className="text-button" onClick={() => go(guide.route)}>기능 화면 열기<ArrowUpRight size={15} /></button></div>{error && <p role="alert" className="error-text">{error}</p>}</div>
    <nav className="help-step-tabs" aria-label="사용 순서">{guide.steps.map((s, i) => <button key={s.title} disabled={busy} aria-current={stepIndex === i ? 'step' : undefined} onClick={() => setStepIndex(i)}><span>{i + 1}</span>{s.title}</button>)}</nav>
    <section className="help-current-step" aria-label={`${stepIndex + 1}단계 ${step.title}`}>
      <div className="help-step-heading"><span>STEP {String(stepIndex + 1).padStart(2, '0')} / {String(guide.steps.length).padStart(2, '0')}{step.surface && ` · ${step.surface}에서 진행`}</span><h3>{step.title}</h3></div>
      {hasImage ? <figure className="help-screen">{image ? <button ref={imageButton} onClick={() => setZoom(true)} aria-label={`${guide.title} ${stepIndex + 1}단계 화면 확대`}><img src={image} alt={`${roleLabel} ${stepIndex + 1}단계: ${step.title}. 실제 ${surface} 화면에서 조작·확인할 위치를 번호와 테두리로 강조했습니다.`} /><span><ZoomIn size={16} />화면 확대</span></button> : <p role={imageError ? 'alert' : 'status'}>{imageError || '단계 화면 불러오는 중…'}</p>}<figcaption>번호와 테두리로 표시된 위치를 확인하세요 · 실제 {surface} 화면{surface === 'LMS' ? ' · 예시 데이터' : ' · 채널명과 날짜는 서버에 따라 다릅니다'}</figcaption></figure> : <aside className="help-discord-screen"><strong>Discord에서 진행하는 단계입니다.</strong><p>아래에 안내된 채널과 버튼을 순서대로 사용하세요. 실제 Discord 화면 캡처는 아직 준비되지 않았습니다.</p></aside>}
      <div className="help-step-description" aria-live="polite"><span>{stepIndex + 1}</span><div><h3>{step.title}</h3><p>{step.body}</p></div></div>
      <div className="help-step-controls"><button className="button secondary" disabled={busy || stepIndex === 0} onClick={() => setStepIndex(i => i - 1)}><ChevronLeft size={16} />이전 단계</button><span>{stepIndex + 1} / {guide.steps.length}</span><button className="button primary" disabled={busy || stepIndex === guide.steps.length - 1} onClick={() => setStepIndex(i => i + 1)}>다음 단계<ChevronRight size={16} /></button></div>
    </section>
    {guide.note && <aside className="help-note">{guide.note}</aside>}
    <p className="help-document-info">{guide.document.revision ? `워크스페이스에서 등록한 PDF · ${new Date(guide.document.updatedAt!).toLocaleDateString('ko-KR')}` : pendingScreens ? `PDF에는 확보된 실제 화면과 단계별 사용 순서를 담았습니다. 미촬영 ${pendingScreens}단계는 글로 안내합니다.` : '단계별 실제 화면의 강조 이미지와 사용 순서를 담은 기본 PDF를 제공합니다.'}</p>
    {zoom && <ModalShell title={`${guide.title} 화면 확대`} close={closeZoom} className="help-image-modal"><p>확대된 화면을 좌우·위아래로 움직여 확인하세요.</p><div className="help-image-scroll" tabIndex={0} role="region" aria-label="확대 화면 스크롤"><img src={image} alt={`${stepIndex + 1}단계 ${step.title} 강조 화면 확대`} /></div></ModalShell>}
    {pdf && <ModalShell title={`${guide.title} PDF`} close={closePdf} className="help-pdf-modal"><p>PDF가 표시되지 않으면 다운로드해 확인하세요.</p><button className="button secondary" disabled={busy} onClick={() => void openPdf(true)}><Download size={16} />PDF 다운로드</button><iframe src={pdf} title={`${roleLabel} ${guide.title} PDF`} /></ModalShell>}
  </article>
}

function HelpManagement({ workspaceId, changed }: { workspaceId: string; changed: () => void }) {
  const [data, setData] = useState<Management | null>(null), [role, setRole] = useState('admin'), [guideId, setGuideId] = useState('')
  const [file, setFile] = useState<File | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('')
  const locked = useRef(false), input = useRef<HTMLInputElement>(null), live = useRef(true)
  useEffect(() => {
    live.current = true
    const controller = new AbortController()
    void workspaceRequest(workspaceId, 'help/manage', { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setData(value) }).catch(e => { if (!controller.signal.aborted) setError(errorText(e)) })
    return () => { live.current = false; controller.abort() }
  }, [workspaceId])
  const options = data?.guides.filter(g => g.role === role) || [], selected = options.find(g => g.id === guideId) || options[0]
  function clearFile() { setFile(null); if (input.current) input.current.value = '' }
  async function save(remove = false) {
    if (locked.current || !selected || (!remove && !file)) return
    if (remove && !window.confirm('등록한 PDF를 삭제하고 기본 화면 가이드 PDF로 되돌릴까요?')) return
    locked.current = true; setBusy(true); setError(''); setNotice('')
    try {
      let body: Record<string, unknown> = { revision: selected.document.revision }
      if (!remove) {
        if (file!.size > 5 * 1024 * 1024 || !/\.pdf$/i.test(file!.name)) throw new Error('5MB 이하의 PDF를 선택하세요.')
        const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('파일을 읽지 못했습니다.')); reader.readAsDataURL(file!) })
        body = { ...body, filename: file!.name, base64 }
      }
      const result = await workspaceRequest(workspaceId, `help/manage/${encodeURIComponent(selected.id)}`, { method: remove ? 'DELETE' : 'POST', body: JSON.stringify(body) })
      if (live.current) { setData(result); clearFile(); setNotice(remove ? '기본 PDF로 복원했습니다.' : `${data!.roles[role]} · ${selected.title} PDF를 등록했습니다.`); changed() }
    } catch (e) { if (live.current) setError(errorText(e)) }
    finally { locked.current = false; if (live.current) setBusy(false) }
  }
  return <section className="panel help-manager" aria-label="가이드 PDF 관리"><h2>기능별 PDF 등록·교체</h2><p>대상 역할과 기능을 선택해 이 워크스페이스에서 사용할 PDF를 등록하세요. 다른 역할의 가이드 내용과 파일은 열람할 수 없습니다.</p>
    {data ? <><div className="help-manager-fields"><label>대상 역할<select value={role} disabled={busy || data.readOnly} onChange={e => { setRole(e.target.value); setGuideId(''); clearFile(); setNotice('') }}>{Object.entries(data.roles).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>대상 기능<select value={selected?.id || ''} disabled={busy || data.readOnly} onChange={e => { setGuideId(e.target.value); clearFile(); setNotice('') }}>{options.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}</select></label></div>
      <div className="help-upload"><Upload size={25} /><label>가이드 PDF 선택<input ref={input} type="file" accept="application/pdf,.pdf" disabled={busy || data.readOnly} onChange={e => { setFile(e.target.files?.[0] || null); setError('') }} /></label><small>PDF · 최대 5MB · 등록한 파일은 선택한 역할에만 제공됩니다.</small></div>
      {selected && <p>현재 PDF: <strong>{selected.document.revision ? selected.document.filename : '기본 화면 가이드'}</strong></p>}
      <div className="help-actions"><button className="button primary" disabled={busy || data.readOnly || !file} onClick={() => void save()}><Upload size={16} />{busy ? '처리 중…' : 'PDF 등록'}</button>{selected?.document.revision && <button className="button secondary" disabled={busy || data.readOnly} onClick={() => void save(true)}><RotateCcw size={16} />기본 PDF로 복원</button>}<button className="text-button" disabled={busy} onClick={() => { workspaceRequest(workspaceId, 'help/manage').then(setData).catch(e => setError(errorText(e))) }}>등록 목록 새로고침</button></div>
      <p className="help-document-info">등록한 PDF는 기본 PDF를 대신합니다. 탭의 실제 화면 안내는 유지됩니다. 변경 내역은 운영 로그에 저장됩니다.</p>
    </> : !error && <p role="status">등록 목록을 불러오는 중…</p>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="error-text">{error}</p>}
  </section>
}

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { ArrowRight, ChevronLeft, ChevronRight, ImagePlus, Monitor, Pencil, Plus, RefreshCw, Smartphone, Trash2, X } from 'lucide-react'
import { Badge, ModalShell } from './components'
import { workspaceRequest } from './api'
import type { Announcements, Design, Layout, Placement, Position, Shown, Tab, Theme } from './useAnnouncements'
import './Announcements.css'

type Audience = 'student' | 'instructor' | 'admin'
type Fields = Design & { placement: Placement; pages: Tab[]; title: string; body: string; image: string; linkUrl: string; linkLabel: string; audience: Audience[]; startDate: string; endDate: string; enabled: boolean }
type Announcement = Fields & { id: string; revision: number; updatedAt: number }
type Management = { canEdit: boolean; today: string; announcements: Announcement[] }
const audienceNames: Record<Audience, string> = { student: '수강생', instructor: '멘토', admin: '관리자' }
const placementNames: Record<Placement, string> = { banner: '상단 배너', sidebar: '메뉴 배너', popup: '팝업' }
const tabNames: Record<Tab, string> = { all: '모든 탭', home: '첫 화면', assignments: '과제', attendance: '출결', scores: '성적', videos: '강의 영상', mentoring: '멘토링 일정', help: '도움말' }
const layouts: { id: Layout; name: string; hint: string }[] = [
  { id: 'text', name: '텍스트형', hint: '색 배경 위에 문구만' },
  { id: 'image', name: '이미지형', hint: '이미지 한 장을 그대로' },
  { id: 'split', name: '이미지 + 텍스트', hint: '이미지와 문구를 나란히' },
  { id: 'overlay', name: '텍스트 오버레이', hint: '이미지 위에 문구 배치' },
]
const positions: Position[] = ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right']
const positionNames: Record<Position, string> = { 'top-left': '왼쪽 위', 'top-center': '가운데 위', 'top-right': '오른쪽 위', 'middle-left': '왼쪽 가운데', 'middle-center': '정가운데', 'middle-right': '오른쪽 가운데', 'bottom-left': '왼쪽 아래', 'bottom-center': '가운데 아래', 'bottom-right': '오른쪽 아래' }
const themes: { id: Theme; name: string }[] = [{ id: 'forest', name: '포레스트' }, { id: 'mint', name: '민트' }, { id: 'sand', name: '샌드' }, { id: 'sky', name: '스카이' }, { id: 'lilac', name: '라일락' }, { id: 'ink', name: '잉크' }]
const message = (error: unknown) => error instanceof Error ? error.message : '요청을 처리하지 못했습니다. 다시 시도하세요.'
const kstDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' })
const maxImage = 1_500_000
const rotation = 7000

function status(v: Announcement, today: string): [string, string] {
  if (!v.enabled) return ['꺼짐', 'neutral']
  if (v.startDate && today < v.startDate) return ['예정', 'orange']
  if (v.endDate && v.endDate < today) return ['종료', 'neutral']
  return ['노출 중', 'green']
}
const period = (v: Fields) => v.startDate || v.endDate ? `${v.startDate || '시작일 없음'} ~ ${v.endDate || '종료일 없음'}` : '기간 제한 없음'

// Large photos are downsized in the browser so the stored data URL stays under the server limit.
async function readImage(file: File) {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('PNG, JPG, WEBP, GIF 이미지만 올릴 수 있습니다.')
  const original = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('이미지를 읽지 못했습니다.')); reader.readAsDataURL(file) })
  if (file.type === 'image/gif') { if (original.length > maxImage) throw new Error('GIF 이미지는 1MB 이하로 올려 주세요.'); return original }
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  for (const quality of [0.85, 0.7, 0.55]) {
    const webp = canvas.toDataURL('image/webp', quality)
    const result = webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', quality)
    if (result.length <= maxImage) return result
  }
  throw new Error('이미지가 너무 큽니다. 더 작은 이미지를 선택하세요.')
}

// One renderer for the live preview, the banner carousel and the popup, so the preview never drifts from what members see.
function AnnouncementView({ v, variant, preview = false }: { v: Omit<Shown, 'id' | 'revision' | 'placement' | 'pages'>; variant: Placement; preview?: boolean }) {
  const layout = v.layout === 'text' || v.image ? v.layout : 'text'
  const cta = v.linkUrl || preview && v.linkLabel ? <a className="ax-cta" href={v.linkUrl || undefined} target="_blank" rel="noopener noreferrer" tabIndex={preview ? -1 : undefined} onClick={preview ? e => e.preventDefault() : undefined}>{v.linkLabel || '자세히 보기'}<ArrowRight size={15} aria-hidden="true" /></a> : null
  const text = <div className="ax-copy">
    <h2>{v.title || '제목을 입력하세요'}</h2>
    {v.body && <p>{v.body}</p>}
    {cta}
  </div>
  const className = `ax-card ax-${variant} ax-layout-${layout} ax-theme-${v.theme} ax-pos-${v.textPosition} ax-image-${v.imageSide}`
  if (layout === 'image') {
    const image = <img src={v.image} alt={v.title} />
    return <div className={className}>{v.linkUrl && !preview ? <a className="ax-image-link" href={v.linkUrl} target="_blank" rel="noopener noreferrer" aria-label={`${v.title} 열기`}>{image}</a> : image}</div>
  }
  if (layout === 'overlay') return <div className={className}><img className="ax-backdrop" src={v.image} alt="" /><div className="ax-scrim" aria-hidden="true" />{text}</div>
  return <div className={className}>{layout === 'split' && <div className="ax-media"><img src={v.image} alt="" /></div>}{text}{layout === 'text' && <span className="ax-orb" aria-hidden="true" />}</div>
}

export default function AnnouncementManager({ workspaceId, demo = false }: { workspaceId: string; demo?: boolean }) {
  const [data, setData] = useState<Management | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(!demo), [editing, setEditing] = useState<Announcement | 'new' | null>(null)
  const requestNumber = useRef(0)
  async function load() {
    const number = ++requestNumber.current
    setLoading(true)
    try {
      const result = await workspaceRequest(workspaceId, 'announcements') as Management
      if (number === requestNumber.current) { setData(result); setError('') }
    } catch (failure) { if (number === requestNumber.current) setError(message(failure)) }
    finally { if (number === requestNumber.current) setLoading(false) }
  }
  useEffect(() => {
    if (demo) return
    const controller = new AbortController(), number = ++requestNumber.current
    workspaceRequest(workspaceId, 'announcements', { signal: controller.signal })
      .then((result: Management) => { if (number === requestNumber.current) { setData(result); setError('') } })
      .catch(failure => { if (number === requestNumber.current && !controller.signal.aborted) setError(message(failure)) })
      .finally(() => { if (number === requestNumber.current) setLoading(false) })
    return () => controller.abort()
  }, [workspaceId, demo])
  function saved(record: Announcement | null, id: string, text: string) {
    requestNumber.current++
    setData(previous => previous && { ...previous, announcements: record ? [record, ...previous.announcements.filter(v => v.id !== id)] : previous.announcements.filter(v => v.id !== id) })
    setNotice(text); setEditing(null)
  }
  if (demo) return <section className="panel announcement-manager"><p>실제 워크스페이스에서 메인 배너와 팝업을 등록할 수 있습니다.</p></section>
  const list = data?.announcements || []
  return <section className="panel announcement-manager" aria-label="메인 배너 · 팝업 목록">
    <div className="announcement-manager-heading">
      <div><h2>메인 배너 · 팝업</h2><p>워크스페이스 첫 화면에 보일 안내를 등록하세요. 배너는 첫 화면 상단에, 팝업은 접속할 때 창으로 표시됩니다.</p></div>
      <div className="announcement-manager-actions">
        <button className="button secondary" onClick={() => void load()} disabled={loading} aria-busy={loading}><RefreshCw size={16} aria-hidden="true" />{loading ? '확인 중…' : '새로고침'}</button>
        <button className="button primary" onClick={() => { setEditing('new'); setNotice('') }} disabled={!data?.canEdit}><Plus size={16} aria-hidden="true" />새로 만들기</button>
      </div>
    </div>
    {data && !data.canEdit && <p className="announcement-note" role="status">보관된 워크스페이스는 배너와 팝업을 변경할 수 없습니다.</p>}
    {notice && <p className="announcement-note" role="status">{notice}</p>}
    {error && <p className="announcement-error" role="alert">{error}</p>}
    <div className="announcement-list">
      {!list.length && <p className="announcement-empty">{data ? '등록된 배너와 팝업이 없습니다. 새로 만들기를 눌러 추가하세요.' : '목록을 불러오는 중입니다.'}</p>}
      {list.map(v => {
        const [label, tone] = status(v, data!.today)
        return <article key={v.id}>
          <div className="announcement-thumb" aria-hidden="true"><div><AnnouncementView v={v} variant="banner" preview /></div></div>
          <div className="announcement-summary">
            <div className="announcement-badges"><Badge tone="white">{placementNames[v.placement]}</Badge><Badge tone="white">{layouts.find(l => l.id === v.layout)?.name}</Badge><Badge tone={tone}>{label}</Badge></div>
            <h3>{v.title}</h3>
            <p>{v.audience.map(a => audienceNames[a]).join(' · ')}{v.placement === 'banner' && ` · ${v.pages.map(t => tabNames[t]).join(', ')}`} · {period(v)}</p>
          </div>
          {data!.canEdit && <button className="button secondary" aria-label={`${v.title} 수정`} onClick={() => { setEditing(v); setNotice('') }}><Pencil size={15} aria-hidden="true" />수정</button>}
        </article>
      })}
    </div>
    {editing && <AnnouncementForm key={editing === 'new' ? 'new' : editing.id} workspaceId={workspaceId} record={editing === 'new' ? null : editing} close={() => setEditing(null)} saved={saved} />}
  </section>
}

const placementHints: Record<Placement, string> = { banner: '고른 탭 화면 맨 위 · 여러 개면 자동으로 넘어가요', sidebar: '왼쪽 메뉴 안 작은 카드 · 모든 탭에서 보여요', popup: '접속하면 창으로 · 오늘 하루 닫기 가능' }
const imageHints: Record<Placement, string> = { banner: ' · 가로로 긴 이미지(약 3:1)를 권장해요', sidebar: ' · 가로 4:3 비율을 권장해요', popup: ' · 세로 4:5 비율을 권장해요' }

// A stand-in for the real sidebar so admins see the card at its actual width among menu items.
function MenuPreview({ children }: { children: ReactNode }) {
  return <div className="announcement-menu-preview" aria-hidden="true">
    <div className="announcement-menu-brand"><i />AX</div>
    {['나의 학습', '나의 출결', '과제', '멘토링 일정'].map((name, i) => <div key={name} className={`announcement-menu-item${i === 0 ? ' active' : ''}`}><i />{name}</div>)}
    <div className="announcement-menu-slot">{children}</div>
  </div>
}

function LayoutSketch({ layout }: { layout: Layout }) {
  return <span className={`layout-sketch sketch-${layout}`} aria-hidden="true"><i /><b /><b /></span>
}

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return <section className="announcement-step"><h3><span>{number}</span>{title}</h3>{children}</section>
}

function AnnouncementForm({ workspaceId, record, close, saved }: { workspaceId: string; record: Announcement | null; close: () => void; saved: (record: Announcement | null, id: string, notice: string) => void }) {
  const [fields, setFields] = useState<Fields>(() => record ? { placement: record.placement, pages: record.pages, layout: record.layout, textPosition: record.textPosition, imageSide: record.imageSide, theme: record.theme, title: record.title, body: record.body, image: record.image, linkUrl: record.linkUrl, linkLabel: record.linkLabel, audience: record.audience, startDate: record.startDate, endDate: record.endDate, enabled: record.enabled }
    : { placement: 'banner', pages: ['home'], layout: 'text', textPosition: 'middle-left', imageSide: 'right', theme: 'forest', title: '', body: '', image: '', linkUrl: '', linkLabel: '', audience: ['student', 'instructor'], startDate: kstDate(), endDate: '', enabled: true })
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirming, setConfirming] = useState(false)
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop')
  const requestId = useRef(crypto.randomUUID()), locked = useRef(false)
  const needsImage = fields.layout !== 'text', imageOnly = fields.layout === 'image'
  function field<K extends keyof Fields>(key: K, value: Fields[K]) { setFields(previous => ({ ...previous, [key]: value })); setError('') }
  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try { field('image', await readImage(file)) } catch (failure) { setError(message(failure)) }
  }
  async function send(path: string, init: RequestInit) {
    if (locked.current) return null
    locked.current = true; setBusy(true); setError('')
    try { return await workspaceRequest(workspaceId, path, init) }
    catch (failure) { setError(message(failure)); return null }
    finally { locked.current = false; setBusy(false) }
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!fields.title.trim()) { setError('제목을 입력하세요.'); return }
    if (needsImage && !fields.image) { setError('이 유형은 이미지가 필요합니다. 이미지를 넣거나 텍스트형을 선택하세요.'); return }
    if (!fields.audience.length) { setError('보여 줄 대상을 1개 이상 선택하세요.'); return }
    if (fields.placement === 'banner' && !fields.pages.length) { setError('배너를 보여 줄 탭을 1개 이상 선택하세요.'); return }
    if (fields.startDate && fields.endDate && fields.endDate < fields.startDate) { setError('종료일은 시작일 이후로 입력하세요.'); return }
    if (fields.linkLabel.trim() && !fields.linkUrl.trim()) { setError('버튼 문구를 쓰려면 링크 주소도 입력하세요.'); return }
    // Image-only cards show neither body nor button, so stale text is not kept around.
    const values = imageOnly ? { ...fields, body: '', linkLabel: '' } : fields
    const body = record ? { ...values, revision: record.revision } : { ...values, id: requestId.current }
    const result = await send(`announcements${record ? '/' + encodeURIComponent(record.id) : ''}`, { method: record ? 'PATCH' : 'POST', body: JSON.stringify(body) })
    if (result) saved(result, result.id, record ? '수정한 내용을 저장했습니다.' : `${placementNames[fields.placement]}를 등록했습니다.`)
  }
  async function remove() {
    if (!record) return
    const result = await send(`announcements/${encodeURIComponent(record.id)}`, { method: 'DELETE', body: JSON.stringify({ revision: record.revision }) })
    if (result) saved(null, record.id, '삭제했습니다.')
  }
  return <ModalShell title={record ? '배너 · 팝업 수정' : '배너 · 팝업 만들기'} close={close} busy={busy} className="announcement-modal">
    <form className="modal-form announcement-form" onSubmit={submit}>
      <div className="announcement-editor">
        <fieldset disabled={busy}>
          <Step number={1} title="어디에 보여 줄까요?">
            <div className="announcement-choice three" role="radiogroup" aria-label="표시 위치">
              {(Object.keys(placementNames) as Placement[]).map(p => <label key={p} className={fields.placement === p ? 'selected' : ''}><input type="radio" name="placement" checked={fields.placement === p} onChange={() => field('placement', p)} /><strong>{placementNames[p]}</strong><span>{placementHints[p]}</span></label>)}
            </div>
          </Step>
          <Step number={2} title="어떤 모양으로 만들까요?">
            <div className="announcement-choice layouts" role="radiogroup" aria-label="디자인 유형">
              {layouts.map(l => <label key={l.id} className={fields.layout === l.id ? 'selected' : ''}><input type="radio" name="layout" checked={fields.layout === l.id} onChange={() => field('layout', l.id)} /><LayoutSketch layout={l.id} /><strong>{l.name}</strong><span>{l.hint}</span></label>)}
            </div>
            {fields.layout === 'overlay' && <div className="announcement-inline"><span>문구 위치</span><div className="position-picker" role="radiogroup" aria-label="문구 위치">{positions.map(p => <label key={p} title={positionNames[p]} className={fields.textPosition === p ? 'selected' : ''}><input type="radio" name="textPosition" aria-label={positionNames[p]} checked={fields.textPosition === p} onChange={() => field('textPosition', p)} /><i /></label>)}</div><small>{positionNames[fields.textPosition]} · 글자가 잘 보이도록 그쪽에 그림자가 깔려요.</small></div>}
            {fields.layout === 'split' && <div className="announcement-inline"><span>이미지 위치</span><div className="announcement-pills" role="radiogroup" aria-label="이미지 위치">{(['left', 'right'] as const).map(side => <label key={side} className={fields.imageSide === side ? 'selected' : ''}><input type="radio" name="imageSide" checked={fields.imageSide === side} onChange={() => field('imageSide', side)} />{side === 'left' ? '이미지 왼쪽' : '이미지 오른쪽'}</label>)}</div>{fields.placement !== 'banner' && <small>{placementNames[fields.placement]}에서는 이미지가 위, 문구가 아래에 놓입니다.</small>}</div>}
            {(fields.layout === 'text' || fields.layout === 'split') && <div className="announcement-inline"><span>색상</span><div className="theme-picker" role="radiogroup" aria-label="색상">{themes.map(t => <label key={t.id} title={t.name} className={`ax-theme-${t.id}${fields.theme === t.id ? ' selected' : ''}`}><input type="radio" name="theme" aria-label={t.name} checked={fields.theme === t.id} onChange={() => field('theme', t.id)} /></label>)}</div><small>{themes.find(t => t.id === fields.theme)?.name}</small></div>}
          </Step>
          <Step number={3} title="내용을 채워 주세요">
            {needsImage && <div className="announcement-image-field">
              {fields.image ? <div className="announcement-image-preview"><img src={fields.image} alt="선택한 이미지" /><div><label className="button secondary compact">다른 이미지<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={e => void pick(e)} /></label><button type="button" className="button secondary compact" onClick={() => field('image', '')}><Trash2 size={14} aria-hidden="true" />빼기</button></div></div>
                : <label className="announcement-image-drop"><ImagePlus size={22} aria-hidden="true" /><strong>이미지 선택</strong><span>PNG · JPG · WEBP · GIF{imageHints[fields.placement]}</span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={e => void pick(e)} /></label>}
            </div>}
            <label>{imageOnly ? '제목 · 화면에는 보이지 않고 이미지 설명으로 쓰여요' : '제목'}<input data-modal-autofocus required maxLength={100} value={fields.title} onChange={e => field('title', e.target.value)} placeholder="예: 11월 특강 신청 안내" /></label>
            {!imageOnly && <label>내용 · 선택<textarea rows={3} maxLength={1000} value={fields.body} onChange={e => field('body', e.target.value)} placeholder="한두 문장으로 핵심만 적어 주세요." /></label>}
            <div className="announcement-grid"><label>링크 주소 · 선택<input type="url" maxLength={500} value={fields.linkUrl} onChange={e => field('linkUrl', e.target.value)} placeholder="https://" /></label>{imageOnly ? <p className="announcement-hint">링크를 넣으면 이미지 전체를 눌러 이동해요.</p> : <label>버튼 문구 · 선택<input maxLength={30} value={fields.linkLabel} onChange={e => field('linkLabel', e.target.value)} placeholder="자세히 보기" /></label>}</div>
          </Step>
          <Step number={4} title="누구에게, 언제 보여 줄까요?">
            {fields.placement === 'banner' && <div className="announcement-field"><span>보여 줄 탭</span><div className="announcement-pills" role="group" aria-label="보여 줄 탭">{(Object.keys(tabNames) as Tab[]).map(t => <label key={t} className={fields.pages.includes(t) ? 'selected' : ''}><input type="checkbox" checked={fields.pages.includes(t)} onChange={e => field('pages', t === 'all' ? (e.target.checked ? ['all'] : []) : e.target.checked ? [...fields.pages.filter(v => v !== 'all'), t] : fields.pages.filter(v => v !== t))} />{tabNames[t]}</label>)}</div><small>탭 화면 맨 위에 보입니다. 첫 화면은 수강생 '나의 학습', 멘토 '수업 현황', 관리자 '대시보드'예요.</small></div>}
            <div className="announcement-field"><span>보여 줄 대상</span><div className="announcement-pills" role="group" aria-label="보여 줄 대상">{(Object.keys(audienceNames) as Audience[]).map(a => <label key={a} className={fields.audience.includes(a) ? 'selected' : ''}><input type="checkbox" checked={fields.audience.includes(a)} onChange={e => field('audience', e.target.checked ? [...fields.audience, a] : fields.audience.filter(v => v !== a))} />{audienceNames[a]}</label>)}</div></div>
            <div className="announcement-grid"><label>시작일<input type="date" value={fields.startDate} max={fields.endDate || undefined} onChange={e => field('startDate', e.target.value)} /></label><label>종료일<input type="date" value={fields.endDate} min={fields.startDate || undefined} onChange={e => field('endDate', e.target.value)} /></label></div>
            <p className="announcement-hint">한국시간 기준, 종료일 당일까지 표시됩니다. 비워 두면 기간 제한 없이 표시돼요.</p>
            <label className="announcement-switch"><input type="checkbox" role="switch" checked={fields.enabled} onChange={e => field('enabled', e.target.checked)} /><span aria-hidden="true" /><strong>{fields.enabled ? '노출 켜짐' : '노출 꺼짐'}</strong><small>끄면 기간과 관계없이 숨겨집니다.</small></label>
          </Step>
        </fieldset>
        <aside className="announcement-preview" aria-label="미리보기">
          <div className="announcement-preview-bar"><strong>미리보기</strong><div hidden={fields.placement === 'sidebar'} className="announcement-device" role="radiogroup" aria-label="미리보기 화면">
            <label className={device === 'desktop' ? 'selected' : ''}><input type="radio" name="device" checked={device === 'desktop'} onChange={() => setDevice('desktop')} /><Monitor size={14} aria-hidden="true" />PC</label>
            <label className={device === 'mobile' ? 'selected' : ''}><input type="radio" name="device" checked={device === 'mobile'} onChange={() => setDevice('mobile')} /><Smartphone size={14} aria-hidden="true" />모바일</label>
          </div></div>
          <div className={`announcement-stage ${fields.placement === 'sidebar' ? 'desktop' : device} place-${fields.placement}`}>
            {fields.placement === 'sidebar' ? <MenuPreview><AnnouncementView v={fields} variant="sidebar" preview /></MenuPreview>
              : fields.placement === 'popup' ? <div className="ax-popup-frame"><button type="button" className="ax-popup-close" tabIndex={-1} aria-hidden="true"><X size={16} /></button><AnnouncementView v={fields} variant="popup" preview /><div className="ax-popup-foot"><span>오늘 하루 보지 않기</span><span>닫기</span></div></div>
              : <div className="announcement-frame"><AnnouncementView v={fields} variant="banner" preview /></div>}
            {needsImage && !fields.image && <p className="announcement-stage-note">이미지를 넣으면 선택한 모양으로 바뀌어요.</p>}
          </div>
        </aside>
      </div>
      {error && <p className="announcement-error" role="alert">{error}</p>}
      <div className="modal-actions">
        {record && (confirming ? <span className="announcement-confirm">정말 삭제할까요?<button type="button" className="button secondary" onClick={() => setConfirming(false)} disabled={busy}>아니요</button><button type="button" className="button danger" onClick={() => void remove()} disabled={busy}>삭제</button></span>
          : <button type="button" className="button secondary announcement-delete" onClick={() => setConfirming(true)} disabled={busy}><Trash2 size={15} aria-hidden="true" />삭제</button>)}
        <button type="button" className="button secondary" onClick={close} disabled={busy}>취소</button>
        <button type="submit" className="button primary" disabled={busy}>{busy ? '저장 중…' : '저장'}</button>
      </div>
    </form>
  </ModalShell>
}

function BannerCarousel({ banners, variant, hide }: { banners: Shown[]; variant: 'banner' | 'sidebar'; hide?: (v: Shown) => void }) {
  const [index, setIndex] = useState(0), [paused, setPaused] = useState(false)
  const [still] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const current = index % banners.length, many = banners.length > 1, shown = banners[current]
  useEffect(() => {
    if (!many || paused || still) return
    const timer = setTimeout(() => setIndex(i => (i + 1) % banners.length), rotation)
    return () => clearTimeout(timer)
  }, [current, many, paused, still, banners.length])
  const move = (step: number) => setIndex((current + step + banners.length) % banners.length)
  return <section className={`ax-carousel ax-carousel-${variant}`} aria-roledescription="캐러셀" aria-label={variant === 'sidebar' ? '메뉴 안내' : '워크스페이스 안내'} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setPaused(false) }}>
    <div className="ax-slide" key={shown.id} aria-roledescription="슬라이드" aria-label={`${current + 1} / ${banners.length}`}>
      <AnnouncementView v={shown} variant={variant} />
      {hide && <button type="button" className="ax-card-hide" aria-label={`${shown.title} 오늘 하루 숨기기`} title="오늘 하루 숨기기" onClick={() => hide(shown)}><X size={13} /></button>}
    </div>
    {many && <div className="ax-carousel-controls">
      {variant === 'banner' && <button type="button" aria-label="이전 배너" onClick={() => move(-1)}><ChevronLeft size={16} /></button>}
      <div className="ax-dots">{banners.map((v, i) => <button key={v.id} type="button" aria-label={`${i + 1}번째 배너`} aria-current={i === current || undefined} className={i === current ? `active${paused || still ? ' paused' : ''}` : ''} onClick={() => setIndex(i)}><span /></button>)}</div>
      {variant === 'banner' && <button type="button" aria-label="다음 배너" onClick={() => move(1)}><ChevronRight size={16} /></button>}
    </div>}
  </section>
}

function Popup({ v, rest, dismiss }: { v: Shown; rest: number; dismiss: (today: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { const node = dialog.current; node?.showModal(); node?.querySelector<HTMLElement>('.ax-popup-dismiss')?.focus(); return () => node?.close() }, [])
  return <dialog ref={dialog} className="ax-popup-dialog" aria-label={v.title} onCancel={e => { e.preventDefault(); dismiss(false) }} onClick={e => { if (e.target === e.currentTarget) dismiss(false) }}>
    <div className="ax-popup-frame">
      <button type="button" className="ax-popup-close" aria-label="닫기" onClick={() => dismiss(false)}><X size={16} /></button>
      <AnnouncementView v={v} variant="popup" />
      <div className="ax-popup-foot"><button type="button" onClick={() => dismiss(true)}>오늘 하루 보지 않기</button><button type="button" className="ax-popup-dismiss" onClick={() => dismiss(false)}>닫기{rest > 0 && <small>+{rest}</small>}</button></div>
    </div>
  </dialog>
}

export function AnnouncementBanners({ announcements, tab }: { announcements: Announcements; tab: string }) {
  const items = announcements.banners.filter(v => v.pages.includes('all') || v.pages.includes(tab as Tab))
  return items.length ? <BannerCarousel key={tab} banners={items} variant="banner" /> : null
}

export function MenuBanner({ announcements }: { announcements: Announcements }) {
  return announcements.sidebars.length ? <BannerCarousel banners={announcements.sidebars} variant="sidebar" hide={announcements.hideSidebar} /> : null
}

export function AnnouncementPopups({ announcements }: { announcements: Announcements }) {
  const [popup] = announcements.popups
  return popup ? <Popup key={popup.id} v={popup} rest={announcements.popups.length - 1} dismiss={announcements.dismissPopup} /> : null
}

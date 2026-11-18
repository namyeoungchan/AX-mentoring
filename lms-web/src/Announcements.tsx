import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink, ImagePlus, Megaphone, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Badge, ModalShell } from './components'
import { workspaceRequest } from './api'
import './Announcements.css'

type Audience = 'student' | 'instructor' | 'admin'
type Fields = { placement: 'banner' | 'popup'; title: string; body: string; image: string; linkUrl: string; linkLabel: string; audience: Audience[]; startDate: string; endDate: string; enabled: boolean }
type Announcement = Fields & { id: string; revision: number; updatedAt: number }
type Shown = Pick<Announcement, 'id' | 'placement' | 'title' | 'body' | 'image' | 'linkUrl' | 'linkLabel' | 'revision'>
type Management = { canEdit: boolean; today: string; announcements: Announcement[] }
const audienceNames: Record<Audience, string> = { student: '수강생', instructor: '멘토', admin: '관리자' }
const message = (error: unknown) => error instanceof Error ? error.message : '요청을 처리하지 못했습니다. 다시 시도하세요.'
const kstDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' })
const maxImage = 1_500_000

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
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
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
          <div className="announcement-thumb">{v.image ? <img src={v.image} alt="" /> : <Megaphone size={22} aria-hidden="true" />}</div>
          <div className="announcement-summary">
            <div className="announcement-badges"><Badge tone="white">{v.placement === 'banner' ? '배너' : '팝업'}</Badge><Badge tone={tone}>{label}</Badge></div>
            <h3>{v.title}</h3>
            <p>{v.audience.map(a => audienceNames[a]).join(' · ')} · {period(v)}</p>
          </div>
          {data!.canEdit && <button className="button secondary" aria-label={`${v.title} 수정`} onClick={() => { setEditing(v); setNotice('') }}><Pencil size={15} aria-hidden="true" />수정</button>}
        </article>
      })}
    </div>
    {editing && <AnnouncementForm key={editing === 'new' ? 'new' : editing.id} workspaceId={workspaceId} record={editing === 'new' ? null : editing} close={() => setEditing(null)} saved={saved} />}
  </section>
}

function AnnouncementForm({ workspaceId, record, close, saved }: { workspaceId: string; record: Announcement | null; close: () => void; saved: (record: Announcement | null, id: string, notice: string) => void }) {
  const [fields, setFields] = useState<Fields>(() => record ? { placement: record.placement, title: record.title, body: record.body, image: record.image, linkUrl: record.linkUrl, linkLabel: record.linkLabel, audience: record.audience, startDate: record.startDate, endDate: record.endDate, enabled: record.enabled }
    : { placement: 'banner', title: '', body: '', image: '', linkUrl: '', linkLabel: '', audience: ['student', 'instructor'], startDate: kstDate(), endDate: '', enabled: true })
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirming, setConfirming] = useState(false)
  const requestId = useRef(crypto.randomUUID()), locked = useRef(false)
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
    if (!fields.audience.length) { setError('보여 줄 대상을 1개 이상 선택하세요.'); return }
    if (fields.startDate && fields.endDate && fields.endDate < fields.startDate) { setError('종료일은 시작일 이후로 입력하세요.'); return }
    if (fields.linkLabel.trim() && !fields.linkUrl.trim()) { setError('버튼 문구를 쓰려면 링크 주소도 입력하세요.'); return }
    if (!fields.title.trim()) { setError('제목을 입력하세요.'); return }
    const body = record ? { ...fields, revision: record.revision } : { ...fields, id: requestId.current }
    const result = await send(`announcements${record ? '/' + encodeURIComponent(record.id) : ''}`, { method: record ? 'PATCH' : 'POST', body: JSON.stringify(body) })
    if (result) saved(result, result.id, record ? '수정한 내용을 저장했습니다.' : `${fields.placement === 'banner' ? '배너' : '팝업'}를 등록했습니다.`)
  }
  async function remove() {
    if (!record) return
    const result = await send(`announcements/${encodeURIComponent(record.id)}`, { method: 'DELETE', body: JSON.stringify({ revision: record.revision }) })
    if (result) saved(null, record.id, '삭제했습니다.')
  }
  return <ModalShell title={record ? '배너 · 팝업 수정' : '배너 · 팝업 만들기'} close={close} busy={busy} className="announcement-modal">
    <form className="modal-form" onSubmit={submit}>
      <fieldset disabled={busy}>
        <div className="announcement-segment" role="radiogroup" aria-label="표시 방식">
          {(['banner', 'popup'] as const).map(p => <label key={p} className={fields.placement === p ? 'selected' : ''}><input type="radio" name="placement" checked={fields.placement === p} onChange={() => field('placement', p)} /><strong>{p === 'banner' ? '메인 배너' : '메인 팝업'}</strong><span>{p === 'banner' ? '첫 화면 상단에 계속 표시' : '접속하면 창으로 표시 · 오늘 하루 닫기 가능'}</span></label>)}
        </div>
        <label>제목<input data-modal-autofocus required maxLength={100} value={fields.title} onChange={e => field('title', e.target.value)} placeholder="예: 11월 특강 신청 안내" /></label>
        <label>내용<textarea rows={4} maxLength={1000} value={fields.body} onChange={e => field('body', e.target.value)} placeholder="짧게 핵심만 적어 주세요. 비워 두면 제목과 이미지만 표시됩니다." /></label>
        <div className="announcement-image-field">
          <span>이미지 · 선택</span>
          {fields.image ? <div className="announcement-image-preview"><img src={fields.image} alt="선택한 이미지 미리보기" /><button type="button" className="button secondary compact" onClick={() => field('image', '')}><Trash2 size={14} aria-hidden="true" />이미지 빼기</button></div>
            : <label className="announcement-image-drop"><ImagePlus size={20} aria-hidden="true" /><span>이미지 선택 (PNG · JPG · WEBP · GIF)</span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={e => void pick(e)} /></label>}
        </div>
        <div className="announcement-grid"><label>링크 주소 · 선택<input type="url" maxLength={500} value={fields.linkUrl} onChange={e => field('linkUrl', e.target.value)} placeholder="https://" /></label><label>버튼 문구 · 선택<input maxLength={30} value={fields.linkLabel} onChange={e => field('linkLabel', e.target.value)} placeholder="자세히 보기" /></label></div>
        <div className="announcement-audience" role="group" aria-label="보여 줄 대상"><span>보여 줄 대상</span><div>{(Object.keys(audienceNames) as Audience[]).map(a => <label key={a}><input type="checkbox" checked={fields.audience.includes(a)} onChange={e => field('audience', e.target.checked ? [...fields.audience, a] : fields.audience.filter(v => v !== a))} />{audienceNames[a]}</label>)}</div></div>
        <div className="announcement-grid"><label>시작일<input type="date" value={fields.startDate} max={fields.endDate || undefined} onChange={e => field('startDate', e.target.value)} /></label><label>종료일<input type="date" value={fields.endDate} min={fields.startDate || undefined} onChange={e => field('endDate', e.target.value)} /></label></div>
        <p className="announcement-hint">날짜는 한국시간 기준이며 종료일 당일까지 표시됩니다. 비워 두면 기간 제한 없이 표시됩니다.</p>
        <label className="announcement-toggle"><input type="checkbox" checked={fields.enabled} onChange={e => field('enabled', e.target.checked)} />지금 노출하기<small>끄면 기간과 관계없이 숨겨집니다.</small></label>
      </fieldset>
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

const hideKey = (workspaceId: string, v: Shown) => `ax-announcement-hidden:${workspaceId}:${v.id}:${v.revision}`
function hiddenToday(workspaceId: string, v: Shown) { try { return localStorage.getItem(hideKey(workspaceId, v)) === kstDate() } catch { return false } }

function Action({ v }: { v: Shown }) {
  return v.linkUrl ? <a className="button primary announcement-link" href={v.linkUrl} target="_blank" rel="noopener noreferrer">{v.linkLabel || '자세히 보기'}<ExternalLink size={14} aria-hidden="true" /></a> : null
}

// Mounted once per workspace screen: popups open on entry, banners only render on the landing page.
export function HomeAnnouncements({ workspaceId, showBanners, demo = false }: { workspaceId: string; showBanners: boolean; demo?: boolean }) {
  const [banners, setBanners] = useState<Shown[]>([]), [popups, setPopups] = useState<Shown[]>([]), [index, setIndex] = useState(0)
  useEffect(() => {
    if (demo || !workspaceId) return
    const controller = new AbortController()
    workspaceRequest(workspaceId, 'announcements/active', { signal: controller.signal })
      .then((result: { banners: Shown[]; popups: Shown[] }) => { if (controller.signal.aborted) return; setBanners(result.banners); setPopups(result.popups.filter(v => !hiddenToday(workspaceId, v))) })
      .catch(() => {})
    return () => controller.abort()
  }, [workspaceId, demo])
  const popup = popups[0]
  function dismiss(today: boolean) {
    if (today) try { localStorage.setItem(hideKey(workspaceId, popup), kstDate()) } catch { /* the popup still closes for this visit */ }
    setPopups(previous => previous.slice(1))
  }
  const banner = banners[index % Math.max(banners.length, 1)]
  return <>
    {showBanners && banner && <section className={`announcement-banner${banner.image ? ' with-image' : ''}`} aria-roledescription="배너" aria-label="워크스페이스 안내">
      <div className="announcement-banner-text">
        <span className="eyebrow">NOTICE{banners.length > 1 && <span>{index % banners.length + 1} / {banners.length}</span>}</span>
        <h2>{banner.title}</h2>
        {banner.body && <p>{banner.body}</p>}
        <Action v={banner} />
      </div>
      {banner.image && <img src={banner.image} alt="" />}
      {banners.length > 1 && <div className="announcement-banner-nav">
        <button className="icon-button" aria-label="이전 배너" onClick={() => setIndex((index - 1 + banners.length) % banners.length)}><ChevronLeft size={18} /></button>
        <button className="icon-button" aria-label="다음 배너" onClick={() => setIndex((index + 1) % banners.length)}><ChevronRight size={18} /></button>
      </div>}
    </section>}
    {popup && <ModalShell key={popup.id} title={popup.title} close={() => dismiss(false)} className="announcement-popup">
      <div className="announcement-popup-body">
        {popup.image && <img src={popup.image} alt="" />}
        {popup.body && <p>{popup.body}</p>}
        <Action v={popup} />
      </div>
      <div className="announcement-popup-actions"><button className="text-button" onClick={() => dismiss(true)}>오늘 하루 보지 않기</button><button className="button secondary" data-modal-autofocus onClick={() => dismiss(false)}>닫기{popups.length > 1 && ` (${popups.length - 1}개 더 있음)`}</button></div>
    </ModalShell>}
  </>
}

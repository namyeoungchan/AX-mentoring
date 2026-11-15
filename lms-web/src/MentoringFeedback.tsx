import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ClipboardPen, MessageSquare, Pencil, RefreshCw } from 'lucide-react'
import { workspaceRequest } from './api'
import { ModalShell } from './components'
import { registerNavigationGuard } from './navigationGuard'
import type { Session } from './data'

type Response = { id: string; content: string; submittedAt: number; revision: number; updatedAt: number | null }
type Request = { id: string; role: 'mentor' | 'mentee'; name: string; state: string; error: string; sentAt: number | null; canEdit?: boolean; responses: Response[] }
type SessionRecord = { date: string; time: string; endTime: string; content: string; revision: number; updatedAt: number; updatedByName?: string }
type Feedback = { activatedAt: number; endAt: string | null; record?: SessionRecord | null; canRecord?: boolean; requests: Request[] }
const dateTime = (value: number) => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const deliveryLabel: Record<string, string> = { pending: 'DM 발송 대기', sending: 'DM 발송 중', sent: 'DM 발송 완료 · 응답 대기', failed: 'DM 발송 실패', uncertain: 'DM 발송 여부 확인 필요', reconcile: 'DM 발송 여부 확인 중', cancelled: '발송 취소' }
const errorLabel: Record<string, string> = { permissions: 'DM 수신 허용 여부를 확인해 주세요.', channel_missing: 'Discord 서버 참여 여부를 확인해 주세요.', timeout: 'Discord 응답이 지연되었습니다.', not_found: '기존 DM을 확인하지 못했습니다. 중복 발송 방지를 위해 자동 재발송하지 않습니다.' }

export default function MentoringFeedback({ workspaceId, session, demo }: { workspaceId?: string; session: Session; demo: boolean }) {
  const [open, setOpen] = useState(false), [data, setData] = useState<Feedback | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [version, setVersion] = useState(0)
  const [editing, setEditing] = useState<{ requestId: string; response: Response } | null>(null), [notice, setNotice] = useState('')
  const [recording, setRecording] = useState(false)
  useEffect(() => {
    if (!open || demo || !workspaceId || editing || recording) return
    const controller = new AbortController()
    workspaceRequest(workspaceId, `mentoring/${encodeURIComponent(session.id)}/feedback`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setData(value); setError('') } })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message || '기록을 불러오지 못했습니다.') })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [open, demo, workspaceId, session.id, version, editing, recording])
  useEffect(() => {
    if (!open || demo || editing || recording) return
    const timer = window.setInterval(() => { setBusy(true); setVersion(value => value + 1) }, 30000)
    return () => window.clearInterval(timer)
  }, [open, demo, editing, recording])
  async function retry(request: Request) {
    if (!workspaceId || busy) return
    setBusy(true); setError('')
    try { setData(await workspaceRequest(workspaceId, `mentoring/${encodeURIComponent(session.id)}/feedback/${request.id}/retry`, { method: 'POST' })) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '재시도 요청에 실패했습니다.') }
    finally { setBusy(false) }
  }
  const old = data?.endAt && Date.parse(data.endAt) < data.activatedAt
  const awaiting = session.status === '승인 대기' ? '예약 승인 후 종료 시간에 DM을 발송합니다.' : old ? '자동 요청 적용 전 종료된 일정입니다.' : '예약 종료 시간 이후 멘토와 멘티에게 각각 DM을 발송합니다.'
  return <><details className="mentoring-report" onToggle={event => { setOpen(event.currentTarget.open); if (event.currentTarget.open && !demo) setBusy(true) }}>
    <summary><MessageSquare size={15} /><span>멘토링 기록</span><small>{data?.requests.some(request => request.responses.length) ? `응답 ${data.requests.filter(request => request.responses.length).length}/2` : '멘토·멘티 응답 확인'}</small></summary>
    {open && <div className="mentoring-report-body">
      <div className="mentoring-report-heading"><p>{awaiting}</p>{!demo && <button type="button" className="text-button" disabled={busy || Boolean(editing) || recording} onClick={() => { setBusy(true); setVersion(value => value + 1) }}><RefreshCw size={14} />{busy ? '확인 중…' : '새로고침'}</button>}</div>
      {demo && <p>실제 운영에서는 Discord DM으로 제출한 내용이 이곳에 저장됩니다.</p>}
      {error && <p role="alert" className="error-note">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!data && !demo && busy && <p role="status">멘토링 기록을 불러오는 중입니다.</p>}
      {data && (data.record || data.canRecord) && <section className="mentoring-session-record" aria-label="실제 진행 기록">
        <header><div><strong>실제 진행 기록</strong><small>{data.record ? `${data.record.date} · ${data.record.time}–${data.record.endTime} (한국시간)` : '종료된 멘토링의 실제 진행 시간과 내용을 남길 수 있습니다.'}</small></div>
          {data.canRecord && <button type="button" className="button secondary" disabled={busy || Boolean(editing)} onClick={() => { setRecording(true); setNotice('') }}><ClipboardPen size={14} aria-hidden="true" />{data.record ? '수정' : '기록하기'}</button>}</header>
        {data.record && <><p>{data.record.content}</p><small>최종 수정: {dateTime(data.record.updatedAt)} · 한국시간{data.record.updatedByName && ` · ${data.record.updatedByName}`}</small></>}
      </section>}
      {(data || demo) && <div className="mentoring-report-grid">{(['mentor', 'mentee'] as const).map(role => {
        const request = data?.requests.find(row => row.role === role)
        return <section key={role} aria-label={`${role === 'mentor' ? '멘토' : '멘티'} 응답`}>
          <header><strong>{role === 'mentor' ? '멘토' : '멘티'}{request ? ` · ${request.name}` : role === 'mentor' ? ` · ${session.mentor}` : ''}</strong><span className={request?.responses.length ? 'has-response' : ''}>{request?.responses.length ? '응답 완료' : request ? deliveryLabel[request.state] || '발송 확인 필요' : '요청 전'}</span></header>
          {request?.responses.length ? request.responses.map(response => <article key={response.id}>
            <div className="mentoring-response-heading"><div><time dateTime={new Date(response.submittedAt).toISOString()}>{dateTime(response.submittedAt)} · 한국시간</time>{response.updatedAt && <small>수정: {dateTime(response.updatedAt)} · 한국시간</small>}</div>
              {!demo && role === 'mentor' && request.canEdit && <button type="button" className="button secondary" aria-label="멘토 응답 수정" disabled={busy || Boolean(editing)} onClick={() => { setEditing({ requestId: request.id, response }); setNotice('') }}><Pencil size={14} aria-hidden="true" />수정</button>}
            </div><p>{response.content}</p></article>) : <p className="mentoring-report-empty">아직 작성된 내용이 없습니다.</p>}
          {request?.error && !request.responses.length && <p className="error-note">{errorLabel[request.error] || '발송 상태를 확인해 주세요.'}</p>}
          {request && ['failed', 'uncertain'].includes(request.state) && !request.responses.length && <button className="button secondary" disabled={busy} onClick={() => void retry(request)}>{request.state === 'failed' ? 'DM 발송 재시도' : '기존 DM 확인'}</button>}
        </section>
      })}</div>}
    </div>}
  </details>{editing && workspaceId && <FeedbackEditor workspaceId={workspaceId} bookingId={session.id} requestId={editing.requestId} response={editing.response}
    close={() => setEditing(null)} saved={value => { setData(value); setEditing(null); setNotice('멘토 응답을 수정했습니다.') }} />}
  {recording && workspaceId && data && <SessionRecordEditor workspaceId={workspaceId} session={session} record={data.record || null}
    draft={data.requests.find(request => request.role === 'mentor')?.responses.map(response => response.content).join('\n\n') || ''}
    close={() => setRecording(false)} saved={value => { setData(value); setRecording(false); setNotice('실제 진행 기록을 저장했습니다.') }} />}</>
}

function SessionRecordEditor({ workspaceId, session, record, draft, close, saved }: { workspaceId: string; session: Session; record: SessionRecord | null; draft: string; close: () => void; saved: (value: Feedback) => void }) {
  const [initial] = useState(() => record ? { date: record.date, time: record.time, endTime: record.endTime, content: record.content } : { date: session.date, time: session.time, endTime: session.endTime || '', content: draft })
  const [fields, setFields] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const locked = useRef(false)
  const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const dirty = (Object.keys(initial) as (keyof typeof initial)[]).some(key => initial[key] !== fields[key])
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' })
  useEffect(() => registerNavigationGuard(() => !locked.current && (!dirty || window.confirm('저장하지 않은 진행 기록을 버리고 이동할까요?'))), [dirty])
  function field(key: keyof typeof initial, value: string) { setFields(previous => ({ ...previous, [key]: value })); setError('') }
  function restoreFocus() { requestAnimationFrame(() => { if (opener?.isConnected) opener.focus({ preventScroll: true }) }) }
  function dismiss() {
    if (locked.current || (dirty && !window.confirm('저장하지 않은 진행 기록을 버릴까요?'))) return
    close(); restoreFocus()
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (locked.current || !fields.content.trim()) return
    if (fields.endTime <= fields.time) { setError('종료 시간은 같은 날의 시작 시간 이후로 입력하세요.'); return }
    locked.current = true; setBusy(true); setError('')
    try {
      const value = await workspaceRequest(workspaceId, `mentoring/${encodeURIComponent(session.id)}/feedback/record`, {
        method: 'PUT', body: JSON.stringify({ ...fields, revision: record?.revision ?? 0 }),
      })
      saved(value); restoreFocus()
    } catch (failure) {
      const status = (failure as { status?: number })?.status
      setError(!status || status >= 500 ? '저장 결과를 확인하지 못했습니다. 작성 내용을 보관한 뒤 최신 기록을 확인해 주세요.' : failure instanceof Error ? failure.message : '진행 기록을 저장하지 못했습니다.')
    } finally { locked.current = false; setBusy(false) }
  }
  return <ModalShell title="실제 진행 기록" close={dismiss} busy={busy} className="mentoring-response-modal">
    <form className="modal-form" onSubmit={submit}>
      <p>예약 시간과 다르게 진행했다면 실제 시간을 입력하세요. 예약 일정은 그대로 두고, 관리자 엑셀 보고서에는 이 기록을 사용합니다.</p>
      <fieldset className="mentoring-record-fields" disabled={busy}>
        <label>진행일<input type="date" required max={today} value={fields.date} onChange={event => field('date', event.target.value)} /></label>
        <label>시작 시간<input type="time" required value={fields.time} onChange={event => field('time', event.target.value)} /></label>
        <label>종료 시간<input type="time" required value={fields.endTime} onChange={event => field('endTime', event.target.value)} /></label>
      </fieldset>
      <label>멘토링 내용<textarea data-modal-autofocus required rows={10} maxLength={4000} disabled={busy} value={fields.content} onChange={event => field('content', event.target.value)} placeholder="다룬 주제, 주요 피드백, 다음 할 일을 적어 주세요." /></label>
      <small>{fields.content.length.toLocaleString()} / 4,000자</small>
      {error && <p role="alert" className="error-note">{error}</p>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={dismiss}>취소</button><button type="submit" className="button primary" disabled={busy || !fields.content.trim() || (Boolean(record) && !dirty)}>{busy ? '저장 중…' : '저장'}</button></div>
    </form>
  </ModalShell>
}

function FeedbackEditor({ workspaceId, bookingId, requestId, response, close, saved }: { workspaceId: string; bookingId: string; requestId: string; response: Response; close: () => void; saved: (value: Feedback) => void }) {
  const [content, setContent] = useState(response.content), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const locked = useRef(false)
  const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const dirty = content !== response.content
  useEffect(() => registerNavigationGuard(() => !locked.current && (!dirty || window.confirm('저장하지 않은 멘토 응답 수정 내용을 버리고 이동할까요?'))), [dirty])
  useEffect(() => {
    if (!dirty && !busy) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, busy])
  function restoreFocus() { requestAnimationFrame(() => { if (opener?.isConnected) opener.focus({ preventScroll: true }) }) }
  function dismiss() {
    if (locked.current || (dirty && !window.confirm('저장하지 않은 멘토 응답 수정 내용을 버릴까요?'))) return
    close(); restoreFocus()
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (locked.current || !content.trim() || content.length > 4000) return
    locked.current = true; setBusy(true); setError('')
    try {
      const value = await workspaceRequest(workspaceId, `mentoring/${encodeURIComponent(bookingId)}/feedback/${encodeURIComponent(requestId)}/responses/${encodeURIComponent(response.id)}`, {
        method: 'PATCH', body: JSON.stringify({ content, revision: response.revision }),
      })
      saved(value); restoreFocus()
    } catch (failure) {
      const status = (failure as { status?: number })?.status
      setError(!status || status >= 500 ? '저장 결과를 확인하지 못했습니다. 작성 내용을 보관한 뒤 최신 기록을 확인해 주세요.' : failure instanceof Error ? failure.message : '수정 내용을 저장하지 못했습니다.')
    } finally { locked.current = false; setBusy(false) }
  }
  return <ModalShell title="멘토 응답 수정" close={dismiss} busy={busy} className="mentoring-response-modal">
    <form className="modal-form" onSubmit={submit}>
      <p>본인이 작성한 멘토 응답만 수정합니다. 학생 응답과 원래 제출 시각은 변경되지 않으며, Discord 메시지 원문은 그대로 유지됩니다.</p>
      <label>멘토링 내용<textarea data-modal-autofocus required rows={12} maxLength={4000} disabled={busy} value={content} onChange={event => { setContent(event.target.value); setError('') }} /></label>
      <small>{content.length.toLocaleString()} / 4,000자</small>
      {error && <p role="alert" className="error-note">{error}</p>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={dismiss}>취소</button><button type="submit" className="button primary" disabled={busy || !content.trim() || content.length > 4000 || !dirty}>{busy ? '저장 중…' : '저장'}</button></div>
    </form>
  </ModalShell>
}

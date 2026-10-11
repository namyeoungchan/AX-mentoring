import { useCallback, useEffect, useRef, useState } from 'react'
import { workspaceRequest } from './api'
import './MentoringCoordination.css'

type Action = 'propose' | 'accept' | 'reject' | 'withdraw' | 'cancel'
type Slot = { id: string; start: string; end: string }
type Proposal = { by: 'mentor' | 'student'; start: string; end: string; reason: string; expiresAt: number }
type Appointment = {
  id: string; title: string; mentor: string; student: string; start: string; end: string; role: 'mentor' | 'student';
  editable: boolean; version: number; status: string; unavailable: string[]; proposal: Proposal | null; slots: Slot[];
  history: { action: string; reason: string; at: number; proposal: Proposal | null; status: string }[];
  deliveries: { id: string; state: string; error: string }[];
}
const labels: Record<string, string> = { confirmed: '예약 확정', proposed: '변경 응답 대기', needs_coordination: '재조율 필요', cancelled: '취소' }
const actions: Record<string, string> = { propose: '다른 시간 제안', accept: '변경 수락', reject: '제안 거절', withdraw: '제안 철회', cancel: '예약 취소', expire: '제안 만료' }
const time = (start: string, end: string) => `${start.slice(0, 16).replace('T', ' ')} – ${end.slice(0, 10) === start.slice(0, 10) ? end.slice(11, 16) : end.slice(0, 16).replace('T', ' ')}`
const stamp = (value: number) => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false })

export default function MentoringCoordination({ workspaceId, onChanged }: { workspaceId: string; onChanged?: () => Promise<void> }) {
  const [sessions, setSessions] = useState<Appointment[]>([]), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [form, setForm] = useState<{ id: string; version: number; action: Action } | null>(null)
  const [slotId, setSlotId] = useState(''), [reason, setReason] = useState(''), [available, setAvailable] = useState('')
  const locked = useRef(false)
  const refresh = useCallback(async () => {
    const data = await workspaceRequest(workspaceId, 'mentoring/coordination')
    setSessions(data.sessions)
  }, [workspaceId])
  useEffect(() => {
    const controller = new AbortController()
    workspaceRequest(workspaceId, 'mentoring/coordination', { signal: controller.signal })
      .then(data => setSessions(data.sessions)).catch(e => { if (!controller.signal.aborted) setError(e.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [workspaceId])
  function open(session: Appointment, action: Action) {
    setForm({ id: session.id, version: session.version, action }); setSlotId(''); setReason(''); setAvailable(''); setError(''); setNotice('')
  }
  async function submit() {
    if (!form || locked.current) return
    locked.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const body = { eventId: crypto.randomUUID(), version: form.version, action: form.action,
        ...(form.action === 'propose' ? { slotId } : {}), ...(form.action !== 'accept' ? { reason } : {}),
        ...(['propose', 'reject', 'withdraw'].includes(form.action) ? { originalAvailable: available === 'yes' } : {}) }
      await workspaceRequest(workspaceId, `mentoring/${form.id}/coordination`, { method: 'POST', body: JSON.stringify(body) })
      setNotice(`${actions[form.action]} 처리가 저장되었습니다. 상대방에게 Discord DM을 발송합니다.`); setForm(null)
      await refresh(); await onChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : '처리하지 못했습니다. 최신 상태를 확인하세요.')
      await refresh().catch(() => {})
    } finally { locked.current = false; setBusy(false) }
  }
  async function retry(session: Appointment, deliveryId: string) {
    if (locked.current) return
    locked.current = true; setBusy(true); setError('')
    try {
      await workspaceRequest(workspaceId, `mentoring/${session.id}/coordination/${deliveryId}/retry`, { method: 'POST', body: '{}' })
      setNotice('알림 재시도를 요청했습니다.'); await refresh()
    } catch (e) { setError(e instanceof Error ? e.message : '알림을 재시도하지 못했습니다.') }
    finally { locked.current = false; setBusy(false) }
  }
  return <section className="mentoring-coordination panel" aria-label="멘토링 일정 재조율">
    <div className="coordination-heading"><div><h2>멘토링 일정 재조율</h2><p>조 담당 멘토와 수강생이 직접 협의합니다. 모든 시간은 한국시간입니다.</p></div>
      <button className="button secondary" disabled={busy || loading} onClick={() => { setError(''); void refresh().catch(e => setError(e.message)) }}>새로고침</button></div>
    <details className="coordination-help"><summary>일정 변경 방법</summary><ol>
      <li>승인된 예약에서 ‘다른 시간 제안’을 누르고, 멘토가 등록한 시간과 사유를 입력하세요.</li>
      <li>기존 시간에도 참석할 수 있는지 선택하세요. 기존 시간에 참석할 수 없다면 거절·철회·만료 후에도 ‘재조율 필요’로 남습니다.</li>
      <li>상대방은 수락·거절하거나 다른 시간을 제안합니다. 수락하면 새 일정으로 확정됩니다.</li>
      <li>응답 기한은 최대 24시간이며 기존 또는 제안 일정의 시작 전까지입니다. 응답이 없으면 제안만 만료됩니다.</li>
      <li>‘제안 철회’는 변경 제안을 거두는 기능입니다. 멘토링 자체를 취소하려면 ‘예약 취소’에서 사유를 입력하세요.</li>
    </ol><p>Discord에서는 <code>/reschedule</code> 또는 일정 조율 DM의 버튼을 이용하세요.</p></details>
    {error && <p className="error-text" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {loading ? <p role="status">예약을 불러오는 중입니다.</p> : !sessions.length && <p>재조율할 승인 예약이 없습니다.</p>}
    {sessions.map(session => <article key={session.id} className="coordination-appointment">
      <div className="coordination-heading"><h3>{session.mentor} · {session.student}</h3><strong>{labels[session.status] || session.status}</strong></div>
      <p>{session.title}</p><p><strong>기존/확정 일정</strong> {time(session.start, session.end)}</p>
      {session.unavailable.length > 0 && <p className="coordination-warning">{session.unavailable.map(role => role === 'mentor' ? '멘토' : '수강생').join(' · ')}가 기존 시간에 참석할 수 없습니다. 새 일정에 합의해야 합니다.</p>}
      {session.proposal && <div className="coordination-proposal"><strong>{session.proposal.by === session.role ? '내가 보낸 제안' : '상대방이 보낸 제안'}</strong>
        <p>{time(session.proposal.start, session.proposal.end)}</p><p className="coordination-reason">{session.proposal.reason}</p><small>응답 기한: {stamp(session.proposal.expiresAt)}</small></div>}
      {session.editable && <div className="coordination-actions">
        <button className="button secondary" disabled={busy} onClick={() => open(session, 'propose')}>{session.proposal ? '다른 시간으로 재제안' : '다른 시간 제안'}</button>
        {session.proposal && (session.proposal.by === session.role ? <button className="button secondary" disabled={busy} onClick={() => open(session, 'withdraw')}>제안 철회</button> : <>
          <button className="button primary" disabled={busy} onClick={() => open(session, 'accept')}>변경 수락</button><button className="button secondary" disabled={busy} onClick={() => open(session, 'reject')}>제안 거절</button></>)}
        <button className="button secondary" disabled={busy} onClick={() => open(session, 'cancel')}>예약 취소</button>
      </div>}
      {form?.id === session.id && <form className="coordination-form" onSubmit={e => { e.preventDefault(); void submit() }}><h4>{actions[form.action]}</h4>
        {session.version !== form.version ? <p role="alert">예약이 변경되었습니다. 입력을 닫고 최신 제안에서 다시 선택하세요.</p> : <>
          {form.action === 'propose' && <label>변경할 시간<select required value={slotId} disabled={busy} onChange={e => setSlotId(e.target.value)}><option value="">시간 선택</option>{session.slots.map(slot => <option key={slot.id} value={slot.id}>{time(slot.start, slot.end)}{slot.start === session.start ? ' · 기존 시간으로 다시 합의' : ''}</option>)}</select>{!session.slots.length && <small>선택 가능한 시간이 없습니다. 조 담당 멘토가 Discord 시간 설정 패널에서 가능 시간을 추가해 주세요.</small>}</label>}
          {['propose', 'reject', 'withdraw'].includes(form.action) && <label>기존 일정 참석 가능 여부<select required disabled={busy} value={available} onChange={e => setAvailable(e.target.value)}><option value="">선택하세요</option><option value="yes">기존 시간에도 참석할 수 있음</option><option value="no">기존 시간에는 참석할 수 없음</option></select></label>}
          {form.action !== 'accept' && <label>사유<textarea required maxLength={1000} value={reason} disabled={busy} onChange={e => setReason(e.target.value)} /></label>}
          {form.action === 'accept' && session.proposal && <p><strong>{time(session.proposal.start, session.proposal.end)}</strong>으로 예약을 변경합니다.</p>}
          {form.action === 'cancel' && <p>멘토링 예약 자체를 취소하고 상대방에게 사유를 알립니다.</p>}
          <button type="submit" className="button primary" disabled={busy}>{busy ? '저장 중…' : `${actions[form.action]} 저장`}</button>
        </>}<button type="button" className="button secondary" disabled={busy} onClick={() => setForm(null)}>입력 닫기</button></form>}
      {session.deliveries.map(delivery => <p key={delivery.id}>Discord 알림 {delivery.state === 'failed' ? '발송 실패' : '결과 확인 필요'} · LMS에 저장된 상태는 유지됩니다. <button className="text-button" disabled={busy} onClick={() => void retry(session, delivery.id)}>알림 재시도</button></p>)}
      {!!session.history.length && <details><summary>조율 이력 ({session.history.length})</summary><ol>{session.history.map((event, index) => <li key={`${event.at}-${index}`}><strong>{actions[event.action]}</strong> · {stamp(event.at)}{event.proposal && <p>{time(event.proposal.start, event.proposal.end)}</p>}{event.reason && <p className="coordination-reason">{event.reason}</p>}</li>)}</ol></details>}
    </article>)}
  </section>
}

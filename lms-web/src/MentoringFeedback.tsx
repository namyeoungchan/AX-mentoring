import { useEffect, useState } from 'react'
import { MessageSquare, RefreshCw } from 'lucide-react'
import { workspaceRequest } from './api'
import type { Session } from './data'

type Request = { id: string; role: 'mentor' | 'mentee'; name: string; state: string; error: string; sentAt: number | null; responses: { id: string; content: string; submittedAt: number }[] }
type Feedback = { activatedAt: number; endAt: string | null; requests: Request[] }
const dateTime = (value: number) => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const deliveryLabel: Record<string, string> = { pending: 'DM 발송 대기', sending: 'DM 발송 중', sent: 'DM 발송 완료 · 응답 대기', failed: 'DM 발송 실패', uncertain: 'DM 발송 여부 확인 필요', reconcile: 'DM 발송 여부 확인 중', cancelled: '발송 취소' }
const errorLabel: Record<string, string> = { permissions: 'DM 수신 허용 여부를 확인해 주세요.', channel_missing: 'Discord 서버 참여 여부를 확인해 주세요.', timeout: 'Discord 응답이 지연되었습니다.', not_found: '기존 DM을 확인하지 못했습니다. 중복 발송 방지를 위해 자동 재발송하지 않습니다.' }

export default function MentoringFeedback({ workspaceId, session, demo }: { workspaceId?: string; session: Session; demo: boolean }) {
  const [open, setOpen] = useState(false), [data, setData] = useState<Feedback | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [version, setVersion] = useState(0)
  useEffect(() => {
    if (!open || demo || !workspaceId) return
    const controller = new AbortController()
    workspaceRequest(workspaceId, `mentoring/${encodeURIComponent(session.id)}/feedback`, { signal: controller.signal })
      .then(value => { setData(value); setError('') })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message || '기록을 불러오지 못했습니다.') })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [open, demo, workspaceId, session.id, version])
  useEffect(() => {
    if (!open || demo) return
    const timer = window.setInterval(() => { setBusy(true); setVersion(value => value + 1) }, 30000)
    return () => window.clearInterval(timer)
  }, [open, demo])
  async function retry(request: Request) {
    if (!workspaceId || busy) return
    setBusy(true); setError('')
    try { setData(await workspaceRequest(workspaceId, `mentoring/${encodeURIComponent(session.id)}/feedback/${request.id}/retry`, { method: 'POST' })) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '재시도 요청에 실패했습니다.') }
    finally { setBusy(false) }
  }
  const old = data?.endAt && Date.parse(data.endAt) < data.activatedAt
  const awaiting = session.status === '승인 대기' ? '예약 승인 후 종료 시간에 DM을 발송합니다.' : old ? '자동 요청 적용 전 종료된 일정입니다.' : '예약 종료 시간 이후 멘토와 멘티에게 각각 DM을 발송합니다.'
  return <details className="mentoring-report" onToggle={event => { setOpen(event.currentTarget.open); if (event.currentTarget.open && !demo) setBusy(true) }}>
    <summary><MessageSquare size={15} /><span>멘토링 기록</span><small>{data?.requests.some(request => request.responses.length) ? `응답 ${data.requests.filter(request => request.responses.length).length}/2` : '멘토·멘티 응답 확인'}</small></summary>
    {open && <div className="mentoring-report-body">
      <div className="mentoring-report-heading"><p>{awaiting}</p>{!demo && <button type="button" className="text-button" disabled={busy} onClick={() => { setBusy(true); setVersion(value => value + 1) }}><RefreshCw size={14} />{busy ? '확인 중…' : '새로고침'}</button>}</div>
      {demo && <p>실제 운영에서는 Discord DM으로 제출한 내용이 이곳에 저장됩니다.</p>}
      {error && <p role="alert" className="error-note">{error}</p>}
      {!data && !demo && busy && <p role="status">멘토링 기록을 불러오는 중입니다.</p>}
      {(data || demo) && <div className="mentoring-report-grid">{(['mentor', 'mentee'] as const).map(role => {
        const request = data?.requests.find(row => row.role === role)
        return <section key={role} aria-label={`${role === 'mentor' ? '멘토' : '멘티'} 응답`}>
          <header><strong>{role === 'mentor' ? '멘토' : '멘티'}{request ? ` · ${request.name}` : role === 'mentor' ? ` · ${session.mentor}` : ''}</strong><span className={request?.responses.length ? 'has-response' : ''}>{request?.responses.length ? '응답 완료' : request ? deliveryLabel[request.state] || '발송 확인 필요' : '요청 전'}</span></header>
          {request?.responses.length ? request.responses.map(response => <article key={response.id}><time dateTime={new Date(response.submittedAt).toISOString()}>{dateTime(response.submittedAt)} · 한국시간</time><p>{response.content}</p></article>) : <p className="mentoring-report-empty">아직 작성된 내용이 없습니다.</p>}
          {request?.error && !request.responses.length && <p className="error-note">{errorLabel[request.error] || '발송 상태를 확인해 주세요.'}</p>}
          {request && ['failed', 'uncertain'].includes(request.state) && !request.responses.length && <button className="button secondary" disabled={busy} onClick={() => void retry(request)}>{request.state === 'failed' ? 'DM 발송 재시도' : '기존 DM 확인'}</button>}
        </section>
      })}</div>}
    </div>}
  </details>
}

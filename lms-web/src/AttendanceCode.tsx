import { useEffect, useRef, useState } from 'react'
import { workspaceRequest } from './api'

type Session = { startTime: string; endTime: string; startedAt: number; endedAt: number | null }
const timeLabel = (at: number) => new Date(at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul' })
type State = { enabled: boolean; botConfigured: boolean; guildConnected: boolean; scope: string; canManage: boolean; session: Session | null; active: { id: string; expiresAt: number; phase: 'in' | 'out' } | null }
type Issued = State & { code: string }
export default function AttendanceCode({ workspaceId, courseId, date, period, roundState, disabled, onUpdated, suggestedStart = '', suggestedEnd = '' }: { workspaceId: string; courseId: string; date: string; period: number; roundState: string; disabled: boolean; onUpdated: () => Promise<void>; suggestedStart?: string; suggestedEnd?: string }) {
  const [expanded, setExpanded] = useState(roundState === '진행 전')
  const [status, setStatus] = useState<State | null>(null), [issued, setIssued] = useState<Issued | null>(null)
  const [startTime, setStartTime] = useState(suggestedStart), [endTime, setEndTime] = useState(suggestedEnd)
  const [minutes, setMinutes] = useState(5), [time, setTime] = useState(() => Date.now())
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const locked = useRef(false)
  const mutation = useRef(0)
  const selected = { courseId, date, period }
  useEffect(() => {
    const controller = new AbortController()
    const load = () => {
      if (locked.current) return
      const version = mutation.current
      workspaceRequest(workspaceId, `attendance/code?${new URLSearchParams({ courseId, date, period: String(period) })}`, { signal: controller.signal })
        .then((value: State) => { if (!controller.signal.aborted && !locked.current && version === mutation.current) setStatus(value) })
        .catch((e: Error) => { if (!controller.signal.aborted) setError(e.message) })
    }
    load()
    const poll = setInterval(load, 7000), clock = setInterval(() => setTime(Date.now()), 1000)
    return () => { controller.abort(); clearInterval(poll); clearInterval(clock) }
  }, [workspaceId, courseId, date, period, roundState])
  async function act(phase: 'in' | 'out' | 'revoke') {
    if (locked.current) return
    if (phase === 'out' && !status?.session?.endedAt && !window.confirm('종료 코드를 생성하고 강의를 종료할까요? 이후 시작 코드는 사용할 수 없습니다.')) return
    const revoke = phase === 'revoke'
    locked.current = true; mutation.current++; setBusy(true); setError(''); setNotice('')
    try {
      const value = await workspaceRequest(workspaceId, `attendance/code${revoke ? '/revoke' : ''}`, { method: 'POST', body: JSON.stringify(revoke ? selected : { ...selected, minutes, phase, ...(!status?.session ? { startTime, endTime } : {}) }) })
      setStatus(value); setIssued(revoke ? null : value); setTime(Date.now()); if (!revoke) setExpanded(false)
      setNotice(revoke ? '코드를 폐기했습니다.' : phase === 'in' ? '시작 코드를 생성했습니다. 학생이 이 코드로 입실합니다.' : '강의가 종료됐습니다. 학생이 종료 코드로 퇴실하도록 안내하세요.'); await onUpdated()
    } catch (e) { setError((e as Error).message) } finally { locked.current = false; setBusy(false) }
  }
  const active = roundState === '진행 중' && status?.active && status.active.expiresAt > time ? status.active : null
  const code = active && issued?.active?.id === active.id ? issued.code : ''
  const remaining = active ? Math.max(0, Math.ceil((active.expiresAt - time) / 1000)) : 0
  const session = status?.session
  return <section className="attendance-code" aria-label="강의 시작·종료 코드">
    <details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary>강의 시작·종료 코드 <small>{session ? `${session.startTime}–${session.endTime} · ${session.endedAt ? '종료' : '진행 중'}` : '강의 시간 설정'} · {expanded ? '접기' : '코드 관리'}</small></summary>
    <p>학생에게 코드를 안내하세요. Discord 또는 웹에서 입력하면 명단에 자동 반영됩니다.</p>
    <div className="attendance-code-times">
      {session ? <><div><small>강의 예정 시간 · 한국시간</small><strong>{date} · {session.startTime}–{session.endTime}</strong></div><div><small>실제 강의 진행</small><strong>시작 {timeLabel(session.startedAt)} · {session.endedAt ? `종료 ${timeLabel(session.endedAt)}` : '진행 중'}</strong></div></> : <><label>강의 시작 예정 시각<input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} disabled={busy || disabled || !status?.canManage} required /></label><label>강의 종료 예정 시각<input type="time" value={endTime} onChange={e => setEndTime(e.target.value)} disabled={busy || disabled || !status?.canManage} required /></label><span>한국시간 · {date}</span></>}
    </div>
    {!status?.guildConnected && status && <p>Discord 서버 하나를 연결한 뒤 사용할 수 있습니다.</p>}
    {status && !status.botConfigured && <p>Discord 인증 봇 연결을 설정하세요.</p>}
    {!session && status && !status.canManage && <p>관리자 또는 메인 강사가 강의 시간대를 입력하고 시작 코드를 생성해야 합니다.</p>}
    <div className="attendance-code-controls">
      <label>코드 입력 유효시간<select value={minutes} disabled={busy || disabled} onChange={e => setMinutes(Number(e.target.value))}>{[1, 3, 5, 10].map(n => <option key={n} value={n}>{n}분</option>)}</select></label>
      {!session?.endedAt && <button className="button primary" disabled={busy || disabled || !status?.enabled || (!session && (!status?.canManage || !startTime || !endTime || startTime >= endTime))} onClick={() => void act('in')}>{session ? '시작 코드 재발급' : '시작 코드 생성 · 강의 시작'}</button>}
      {session && status?.canManage && <button className="button primary" disabled={busy || disabled || !status?.enabled} onClick={() => void act('out')}>{session.endedAt ? '종료 코드 재발급' : '종료 코드 생성 · 강의 종료'}</button>}
      {active && <button className="button secondary" disabled={busy || disabled} onClick={() => void act('revoke')}>현재 코드 폐기</button>}
    </div>
    <small>{session?.endedAt ? '종료 코드 유효시간까지 퇴실을 받습니다. 누락·예외를 확인한 뒤 출결을 확정하세요.' : '시작 코드는 입실, 종료 코드는 퇴실에만 사용합니다. 코드 유효시간이 끝나도 강의 진행 상태는 유지됩니다.'} 이미 기록한 시각과 멘토 정정은 유지합니다.</small>
    </details>
    {active && <div className="attendance-code-display"><strong>{active.phase === 'in' ? '입실용 시작 코드' : '퇴실용 종료 코드'}</strong>
      {code ? <><output aria-label="발급된 출석 코드">{code}</output><button className="button secondary" onClick={() => { navigator.clipboard.writeText(code).then(() => setNotice('코드를 복사했습니다.')).catch(() => setError('코드를 직접 선택해 복사하세요.')) }}>코드 복사</button></> : <span>발급된 코드가 있습니다. 코드를 잊었다면 재발급하세요.</span>}
      <span>남은 시간 {Math.floor(remaining / 60)}분 {remaining % 60}초</span>
    </div>}
    {issued && !active && <p>코드 입력 시간이 끝났거나 코드가 폐기됐습니다.</p>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="error-text">{error}</p>}

  </section>
}

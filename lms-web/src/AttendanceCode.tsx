import { useEffect, useRef, useState } from 'react'
import { workspaceRequest } from './api'

type State = { enabled: boolean; botConfigured: boolean; guildConnected: boolean; scope: string; active: { id: string; expiresAt: number } | null }
type Issued = State & { code: string }
export default function AttendanceCode({ workspaceId, courseId, date, period, roundState, disabled }: { workspaceId: string; courseId: string; date: string; period: number; roundState: string; disabled: boolean }) {
  const [status, setStatus] = useState<State | null>(null), [issued, setIssued] = useState<Issued | null>(null)
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
  async function act(revoke = false) {
    if (locked.current) return
    locked.current = true; mutation.current++; setBusy(true); setError(''); setNotice('')
    try {
      const value = await workspaceRequest(workspaceId, `attendance/code${revoke ? '/revoke' : ''}`, { method: 'POST', body: JSON.stringify(revoke ? selected : { ...selected, minutes }) })
      setStatus(value); setIssued(revoke ? null : value); setTime(Date.now())
      setNotice(revoke ? '출석 코드를 종료했습니다.' : '학생에게 코드를 안내하세요. 기존에 발급한 이 회차의 내 코드는 종료됐습니다.')
    } catch (e) { setError((e as Error).message) } finally { locked.current = false; setBusy(false) }
  }
  const active = roundState === '진행 중' && status?.active && status.active.expiresAt > time ? status.active : null
  const code = active && issued?.active?.id === active.id ? issued.code : ''
  const remaining = active ? Math.max(0, Math.ceil((active.expiresAt - time) / 1000)) : 0
  return <section className="attendance-code" aria-label="Discord 코드 출석">
    <div><h3>Discord 코드 출석</h3><p>학생이 수업 서버에서 <strong>/출석 코드:123456</strong>을 입력하면 이 회차에 출석합니다. {status?.scope} 기준입니다.</p></div>
    {!status?.guildConnected && status && <p>Discord 서버 하나를 연결한 뒤 사용할 수 있습니다.</p>}
    {status && !status.botConfigured && <p>Discord 인증 봇 연결을 설정하세요.</p>}
    {roundState !== '진행 중' && <p>회차를 시작하면 코드를 발급할 수 있으며, 회차 마감 시 등록이 종료됩니다.</p>}
    <div className="attendance-code-controls">
      <label>출석 코드 유효시간<select value={minutes} disabled={busy || disabled} onChange={e => setMinutes(Number(e.target.value))}>{[1, 3, 5, 10].map(n => <option key={n} value={n}>{n}분</option>)}</select></label>
      <button className="button primary" disabled={busy || disabled || !status?.enabled || roundState !== '진행 중'} onClick={() => void act()}>{active ? '출석 코드 재발급' : '출석 코드 발급'}</button>
      {active && <button className="button secondary" disabled={busy || disabled} onClick={() => void act(true)}>코드 종료</button>}
    </div>
    {active && <div className="attendance-code-display">
      {code ? <><output aria-label="발급된 출석 코드">{code}</output><button className="button secondary" onClick={() => { navigator.clipboard.writeText(code).then(() => setNotice('코드를 복사했습니다.')).catch(() => setError('코드를 직접 선택해 복사하세요.')) }}>코드 복사</button></> : <span>발급된 코드가 있습니다. 코드를 잊었다면 재발급하세요.</span>}
      <span>남은 시간 {Math.floor(remaining / 60)}분 {remaining % 60}초</span>
    </div>}
    {issued && !active && <p>코드가 만료되었거나 종료됐습니다.</p>}
    {notice && <p>{notice}</p>}{error && <p role="alert" className="error-text">{error}</p>}
    <small>학생 계정의 Discord 인증이 필요합니다. 중복 등록으로 기존 출결을 바꾸지 않습니다. 명단은 5초마다 갱신되며 수기 입력 중에는 자동 갱신을 멈춥니다.</small>
  </section>
}

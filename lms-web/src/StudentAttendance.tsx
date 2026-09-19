import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Badge, CardHeading } from './components'
import { workspaceRequest } from './api'

type Session = { startTime: string; endTime: string; startedAt: number; endedAt: number | null }
type Presence = { session?: Session | null; status?: string; id?: string; courseId: string; date: string; period: number; checkInAt?: number | null; checkOutAt?: number | null }
type Data = { today: string; course: { id: string; title: string }; rounds: (Presence & { state: string })[]; history: Presence[] }
type Record = { id: string; date: string; period: number; status: string }
const time = (value?: number | null) => value ? new Date(value).toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul', hour12: false }) : '—'
export default function StudentAttendance({ workspaceId, verified, attendance }: { workspaceId: string; verified: boolean; attendance: Record[] }) {
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [reload, setReload] = useState(0)
  const [code, setCode] = useState('')
  const locked = useRef(false)
  useEffect(() => {
    if (!verified) return
    const controller = new AbortController()
    workspaceRequest(workspaceId, 'me/attendance', { signal: controller.signal }).then(setData).catch((e: Error) => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [workspaceId, verified, reload])
  useEffect(() => { if (!verified) return; const id = window.setInterval(() => { if (!document.hidden && !locked.current) setReload(n => n + 1) }, 30000); return () => window.clearInterval(id) }, [verified])
  async function mark() {
    if (locked.current) return
    locked.current = true; setBusy(true); setError(''); setMessage('')
    try {
      const result = await workspaceRequest(workspaceId, 'me/attendance', { method: 'POST', body: JSON.stringify({ code }) })
      const action = result.action
      setCode('')
      const label = action === 'in' ? '입실' : '퇴실'
      setMessage(`${result.alreadyRecorded ? '이미 기록된' : '기록한'} ${label} 시각: ${time(action === 'in' ? result.checkInAt : result.checkOutAt)} (한국시간)`)
      setData(await workspaceRequest(workspaceId, 'me/attendance'))
    } catch (e) { setError((e as Error).message); setReload(n => n + 1) }
    finally { locked.current = false; setBusy(false) }
  }
  const history = new Map<string, Presence & { status?: string }>()
  for (const row of data?.history || []) history.set(`${row.date}:${row.period}`, row)
  for (const row of attendance) history.set(`${row.date}:${row.period}`, { courseId: data?.course.id || '', ...row, ...history.get(`${row.date}:${row.period}`) })
  return <>
    <section className="panel student-attendance-panel">
      <CardHeading title="오늘의 강의 출석" subtitle="강사가 안내한 시작·종료 코드를 입력하세요. Discord 패널에서도 같은 코드로 출석할 수 있습니다."><button className="button secondary" disabled={busy || !verified} onClick={() => { setError(''); setReload(n => n + 1) }}><RefreshCw size={15} />출석 새로고침</button></CardHeading>
      <div className="student-attendance-body">
        {!verified && <p className="inline-note">워크스페이스 참여 메뉴에서 Discord 인증과 수강 등록을 완료하세요.</p>}
        {error && <p role="alert" className="inline-note error-note">{error}</p>}{message && <p role="status" className="inline-note">{message}</p>}
        {verified && !data && !error && <p role="status">오늘의 수업을 불러오는 중…</p>}
        {verified && <form className="student-attendance-code-form" onSubmit={e => { e.preventDefault(); void mark() }}><label>시작·종료 코드<input aria-describedby="student-code-help" inputMode="numeric" autoComplete="off" pattern="[0-9]{6}" maxLength={6} placeholder="6자리 코드" value={code} disabled={busy} required onChange={e => setCode(e.target.value.replace(/[^0-9]/g, ''))} /></label><button className="button primary" disabled={busy || code.length !== 6}>{busy ? '출석 기록 중…' : '코드로 출석하기'}</button><p id="student-code-help">시작 코드는 입실, 종료 코드는 퇴실로 자동 구분합니다.</p></form>}
        {data && <><p className="student-attendance-date">{data.today} · {data.course.title}</p>{!data.rounds.length && <p className="calendar-empty">오늘 시작된 회차가 없습니다. 강사가 시작 코드를 생성하면 강의가 표시됩니다.</p>}
          <div className="student-attendance-rounds">{data.rounds.map(row => <article className="student-attendance-round" key={`${row.courseId}:${row.period}`} aria-label={`${row.period}차시 입퇴실`}>
            <div className="student-attendance-title"><h3>{row.period}차시</h3><Badge tone={row.state === '마감' ? 'neutral' : row.checkOutAt ? 'green' : 'orange'}>{row.state === '마감' ? '회차 마감' : row.checkOutAt ? '출석 기록 완료' : row.session?.endedAt ? '강의 종료 · 퇴실 확인' : row.checkInAt ? '수강 중' : '입실 전'}</Badge></div>
            <dl className="student-attendance-times"><div><dt>입실 시각</dt><dd>{time(row.checkInAt)}</dd></div><div><dt>퇴실 시각</dt><dd>{time(row.checkOutAt)}</dd></div></dl>
            {row.session && <p className="student-attendance-schedule">강의 예정 {row.session.startTime}–{row.session.endTime} (한국시간)<br />실제 시작 {time(row.session.startedAt)} · {row.session.endedAt ? `종료 ${time(row.session.endedAt)}` : '진행 중'}</p>}
            {row.checkInAt && !row.checkOutAt && <p className="student-attendance-hint">{row.state === '마감' ? '퇴실 기록이 없습니다. 멘토에게 확인을 요청하세요.' : '수업이 끝나면 강사가 안내한 종료 코드를 입력하세요.'}</p>}
          </article>)}</div></>}
        <p className="student-attendance-help">시작 코드와 종료 코드를 등록하면 입실·퇴실 출석이 완료됩니다. 멘토가 정정한 출결은 유지되며, 누락·지각·결석 정정은 멘토에게 요청하세요. 같은 코드를 다시 입력해도 최초 시각을 유지합니다.</p>
      </div>
    </section>
    <section className="panel"><CardHeading title="나의 출결 기록" subtitle="입퇴실 시각은 바로 확인할 수 있고, 최종 출결은 회차 마감 후 표시됩니다." /><div className="table-scroll"><table><thead><tr><th>날짜 · 차시</th><th>입실</th><th>퇴실</th><th>출결</th></tr></thead><tbody>{[...history.values()].sort((a, b) => b.date.localeCompare(a.date) || b.period - a.period).map(row => <tr key={`${row.date}:${row.period}`}><td><strong>{row.date}</strong><small>{row.period}차시</small></td><td>{time(row.checkInAt)}</td><td>{time(row.checkOutAt)}</td><td><Badge tone={row.status ? 'green' : 'neutral'}>{row.status || (row.checkOutAt ? '확정 대기' : '퇴실 확인 필요')}</Badge></td></tr>)}</tbody></table></div>{!history.size && <p className="calendar-empty">아직 출결 기록이 없습니다.</p>}</section>
  </>
}

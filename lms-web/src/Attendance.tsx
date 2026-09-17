import { useEffect, useRef, useState } from 'react'
import { workspaceRequest } from './api'
import { CardHeading, Badge } from './components'
import type { Workspace } from './data'
import { exportAttendance, importAttendance } from '../shared/attendance-csv.mjs'

const states = ['미처리', '출석', '지각', '결석', '공결']
type Row = { studentId: string; name: string; team: string; enrollment: string; status: string; reason: string }
type History = { actor: string; time: string; before: Row | null; after: Row }
type Roster = { courseId: string; date: string; period: number; state: string; revision: string; canManage: boolean; rows: Row[]; counts: Record<string, number>; history: History[] }
type Draft = Record<string, { status: string; reason: string }>

export default function Attendance({ data, refresh }: { data: Workspace; refresh?: () => Promise<void> }) {
  const [courseId, setCourseId] = useState(data.courses[0]?.id || '')
  const [date, setDate] = useState(new Date().toLocaleDateString('en-CA'))
  const [period, setPeriod] = useState(1)
  const [roster, setRoster] = useState<Roster | null>(null)
  const [draft, setDraft] = useState<Draft>({})
  const [error, setError] = useState(''), [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false), [bulk, setBulk] = useState('출석'), [reason, setReason] = useState('')
  const [reload, setReload] = useState(0)
  const generation = useRef(0), locked = useRef(false)
  const pending = useRef<{ signature: string; requestId: string } | null>(null)
  const workspaceId = data.workspaceId || ''
  useEffect(() => {
    const version = ++generation.current, controller = new AbortController()
    // eslint-disable-next-line react/set-state-in-effect -- Reset the editor when fetching a different persisted roster.
    setRoster(null); setDraft({}); setError(''); setMessage(''); setReason(''); pending.current = null
    if (!courseId || !date || period < 1 || period > 100) return
    workspaceRequest(workspaceId, `attendance?${new URLSearchParams({ courseId, date, period: String(period) })}`, { signal: controller.signal })
      .then((value: Roster) => { if (generation.current === version) setRoster(value) })
      .catch((e: Error) => { if (!controller.signal.aborted && generation.current === version) setError(e.message) })
    return () => { controller.abort(); generation.current = version + 1 }
  }, [workspaceId, courseId, date, period, reload])
  const rows = roster?.rows.map(row => ({ ...row, ...draft[row.studentId] })) || []
  const dirty = Object.keys(draft).length > 0
  function discard() { return !dirty || window.confirm('저장하지 않은 입력을 버리고 명단을 변경할까요?') }
  async function save(action: 'start' | 'save' | 'close') {
    if (!roster || locked.current) return
    if (action === 'close' && !window.confirm('전체 과정의 출결을 마감하고 수강생에게 확정 기록을 공개할까요?')) return
    const entries = action === 'save' ? rows.filter(row => draft[row.studentId] && row.status !== '미처리').map(row => ({ studentId: row.studentId, status: row.status, reason: reason.trim() || row.reason })) : []
    // A correction needs a freshly entered reason, not the original registration note.
    if (action === 'save' && roster.state === '마감' && !reason.trim()) { setError('마감 후 정정 사유를 입력하세요.'); return }
    const body = { courseId, date, period, revision: roster.revision, action, entries }
    const signature = JSON.stringify(body)
    if (pending.current?.signature !== signature) pending.current = { signature, requestId: crypto.randomUUID() }
    const version = generation.current
    locked.current = true; setBusy(true); setError(''); setMessage('')
    try {
      const result: Roster = await workspaceRequest(workspaceId, 'attendance', { method: 'POST', body: JSON.stringify({ ...body, requestId: pending.current.requestId }) })
      if (version === generation.current) { setRoster(result); setDraft({}); setReason(''); pending.current = null; setMessage(action === 'save' ? '명단 출결을 저장했습니다.' : action === 'start' ? '회차를 시작했습니다.' : '회차를 마감했습니다.') }
      if (version === generation.current) await refresh?.()
    } catch (e) { if (version === generation.current) setError((e as Error).message) }
    finally { locked.current = false; setBusy(false) }
  }
  function download() {
    if (!roster) return
    const url = URL.createObjectURL(new Blob([exportAttendance(roster, rows)], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = `출결-${date}-${period}.csv`; link.click(); URL.revokeObjectURL(url)
  }
  async function upload(file?: File) {
    if (!file || !roster) return
    const version = generation.current
    try {
      if (file.size > 2_000_000) throw new Error('CSV는 2MB 이하로 가져오세요.')
      const imported = importAttendance(await file.text(), roster, roster.rows.map(row => row.studentId))
      if (version !== generation.current) return
      setDraft(previous => ({ ...previous, ...Object.fromEntries(imported.filter(row => row.status !== '미처리').map(row => [row.studentId, { status: row.status, reason: row.reason }])) }))
      setError(''); setMessage('CSV를 불러왔습니다. 명단을 확인하고 일괄 저장하세요. 미처리 행은 기존 기록을 유지합니다.')
    } catch (e) { if (version === generation.current) setError((e as Error).message) }
  }
  return <section className="panel attendance-panel">
    <CardHeading title="명단 출결" subtitle="과정·날짜·차시별 입력 · 미처리 상태는 결석으로 자동 처리하지 않습니다." />
    <fieldset disabled={busy} className="attendance-controls">
      <label>출결 과정<select value={courseId} onChange={e => { if (discard()) setCourseId(e.target.value) }}>{!data.courses.length && <option value="">등록된 과정 없음</option>}{data.courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>
      <label>출결 날짜<input type="date" value={date} onChange={e => { if (discard()) setDate(e.target.value) }} /></label>
      <label>출결 차시<input type="number" min={1} max={100} value={period} onChange={e => { if (discard()) setPeriod(Number(e.target.value)) }} /></label>
      <button className="button secondary" onClick={() => { if (discard()) setReload(n => n + 1) }}>명단 새로고침</button>
    </fieldset>
    {error && <p role="alert" className="inline-note error-note">{error}</p>}
    {message && <p role="status" className="inline-note">{message}</p>}
    {roster && <>
      <div className="attendance-summary"><Badge>{roster.state}</Badge>{states.map(status => <span key={status}>{status} <strong>{rows.filter(row => row.status === status).length}명</strong></span>)}{dirty && <span>저장 전 변경 있음</span>}</div>
      <fieldset disabled={busy} className="attendance-controls">
        <button className="button secondary" onClick={download}>출결 CSV 내보내기</button>
        <label>출결 CSV 가져오기<input type="file" accept=".csv,text/csv" disabled={roster.state === '진행 전'} onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }} /></label>
        {roster.canManage && roster.state === '진행 전' && <button className="button primary" onClick={() => void save('start')}>회차 시작</button>}
        {roster.canManage && roster.state === '진행 중' && <button className="button secondary" disabled={dirty || !!roster.counts['미처리'] || !rows.length} onClick={() => void save('close')}>회차 마감</button>}
      </fieldset>
      {roster.state === '진행 전' && <p className="inline-note">관리자가 회차를 시작하면 입력할 수 있습니다. 장애 대비 명단 CSV는 미리 내려받을 수 있습니다.</p>}
      <fieldset disabled={busy || roster.state === '진행 전'}>
        <div className="attendance-controls"><label>일괄 출결 상태<select value={bulk} onChange={e => setBulk(e.target.value)}>{states.slice(1).map(status => <option key={status}>{status}</option>)}</select></label><button className="button secondary" onClick={() => setDraft(Object.fromEntries(rows.map(row => [row.studentId, { status: bulk, reason: row.reason }])))}>전체 명단에 적용</button><label>등록·정정 사유<input maxLength={200} value={reason} placeholder={roster.state === '마감' ? '마감 후 정정 시 필수' : '선택 입력'} onChange={e => setReason(e.target.value)} /></label><button className="button primary" disabled={!dirty} onClick={() => void save('save')}>{busy ? '저장 중…' : '출결 일괄 저장'}</button></div>
        <div className="table-scroll"><table><thead><tr><th>수강생</th><th>팀</th><th>재적 상태</th><th>출결 상태</th><th>입력 사유</th></tr></thead><tbody>{rows.map(row => <tr key={row.studentId}><td>{row.name}</td><td>{row.team || '미배정'}</td><td>{row.enrollment}</td><td><select aria-label={`${row.name} 출결 상태`} value={row.status} onChange={e => setDraft(previous => ({ ...previous, [row.studentId]: { status: e.target.value, reason: row.reason } }))}><option disabled>미처리</option>{states.slice(1).map(status => <option key={status}>{status}</option>)}</select></td><td>{row.reason || '—'}</td></tr>)}</tbody></table></div>
      </fieldset>
      {!rows.length && <p className="calendar-empty">해당 과정에 담당 수강생이 없습니다.</p>}
      <details className="attendance-history"><summary>출결 변경 이력 · 최근 200건</summary><div className="table-scroll"><table><thead><tr><th>일시</th><th>작업자</th><th>수강생</th><th>변경 전</th><th>변경 후</th><th>사유</th></tr></thead><tbody>{roster.history.map((h, i) => <tr key={i}><td>{h.time}</td><td>{h.actor}</td><td>{rows.find(r => r.studentId === h.after.studentId)?.name}</td><td>{h.before?.status || '미처리'}</td><td>{h.after.status}</td><td>{h.after.reason}</td></tr>)}</tbody></table></div></details>
    </>}
  </section>
}

import { useEffect, useRef, useState } from 'react'
import { workspaceRequest } from './api'
import AttendanceDiscord from './AttendanceDiscord'
import AttendanceCode from './AttendanceCode'
import { CardHeading, Badge } from './components'
import type { Workspace } from './data'
import { exportAttendance, importAttendance } from '../shared/attendance-csv.mjs'

const states = ['미처리', '출석', '지각', '결석', '공결']
type Row = { checkInAt?: number | null; checkOutAt?: number | null; checkInSource?: string; checkOutSource?: string; studentId: string; name: string; team: string; enrollment: string; status: string; reason: string }
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
  const [busy, setBusy] = useState(false), [reason, setReason] = useState('')
  const [search, setSearch] = useState(''), [team, setTeam] = useState(''), [status, setStatus] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [reload, setReload] = useState(0)
  const generation = useRef(0), locked = useRef(false)
  const pending = useRef<{ signature: string; requestId: string } | null>(null)
  const workspaceId = data.workspaceId || ''
  useEffect(() => {
    const version = ++generation.current, controller = new AbortController()
    // eslint-disable-next-line react/set-state-in-effect -- Reset the editor when fetching a different persisted roster.
    setRoster(null); setDraft({}); setSelected([]); setSearch(''); setTeam(''); setStatus(''); setError(''); setMessage(''); setReason(''); pending.current = null
    if (!courseId || !date || period < 1 || period > 100) return
    workspaceRequest(workspaceId, `attendance?${new URLSearchParams({ courseId, date, period: String(period) })}`, { signal: controller.signal })
      .then((value: Roster) => { if (generation.current === version) setRoster(value) })
      .catch((e: Error) => { if (!controller.signal.aborted && generation.current === version) setError(e.message) })
    return () => { controller.abort(); generation.current = version + 1 }
  }, [workspaceId, courseId, date, period, reload])
  const rows = roster?.rows.map(row => ({ ...row, ...draft[row.studentId] })) || []
  const dirty = Object.keys(draft).length > 0
  const roundState = roster?.state
  useEffect(() => {
    if (roundState !== '진행 중' || dirty || busy) return
    const controller = new AbortController(), version = generation.current
    const timer = setInterval(() => {
      workspaceRequest(workspaceId, `attendance?${new URLSearchParams({ courseId, date, period: String(period) })}`, { signal: controller.signal })
        .then((value: Roster) => { if (!controller.signal.aborted && version === generation.current) setRoster(value) })
        .catch(() => { /* Manual refresh remains available after transient polling failures. */ })
    }, 5000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [workspaceId, courseId, date, period, roundState, dirty, busy])
  const visible = rows.filter(row => (!search.trim() || row.name.toLowerCase().includes(search.trim().toLowerCase())) && (!team || (row.team || '미배정') === team) && (!status || row.status === status))
  const selectedRows = visible.filter(row => selected.includes(row.studentId))
  const pendingRows = visible.filter(row => row.status === '미처리' && row.enrollment === '정상')
  const editable = !busy && roster?.state !== '진행 전'
  function mark(targets: Row[], status: string) {
    setDraft(previous => {
      const next = { ...previous }
      for (const row of targets) {
        const original = roster?.rows.find(item => item.studentId === row.studentId)
        if (original?.status === status && original.reason === row.reason) delete next[row.studentId]
        else next[row.studentId] = { status, reason: row.reason }
      }
      return next
    })
    setSelected([]); setMessage(''); setError('')
  }
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
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
      if (version === generation.current) { setRoster(result); setDraft({}); setSelected([]); setReason(''); pending.current = null; setMessage(action === 'save' ? '명단 출결을 저장했습니다.' : action === 'start' ? '회차를 시작했습니다.' : '회차를 마감했습니다.') }
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
      if (version !== generation.current || locked.current) return
      setDraft(previous => ({ ...previous, ...Object.fromEntries(imported.filter(row => row.status !== '미처리').map(row => [row.studentId, { status: row.status, reason: row.reason }])) }))
      setError(''); setMessage('CSV를 불러왔습니다. 명단을 확인하고 일괄 저장하세요. 미처리 행은 기존 기록을 유지합니다.')
    } catch (e) { if (version === generation.current) setError((e as Error).message) }
  }
  return <section className="panel attendance-panel">
    <CardHeading title="명단 출결" subtitle="회차를 시작하면 학생이 Discord 패널 또는 웹에서 입실·퇴실을 기록합니다. 누락·정정은 명단에서 확인하세요." />
    <fieldset disabled={busy} className="attendance-controls">
      <label>출결 과정<select value={courseId} onChange={e => { if (discard()) setCourseId(e.target.value) }}>{!data.courses.length && <option value="">등록된 과정 없음</option>}{data.courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>
      <label>출결 날짜<input type="date" value={date} onChange={e => { if (discard()) setDate(e.target.value) }} /></label>
      <label>출결 차시<input type="number" min={1} max={100} value={period} onChange={e => { if (discard()) setPeriod(Number(e.target.value)) }} /></label>
      <button className="button secondary" onClick={() => { if (discard()) setReload(n => n + 1) }}>명단 새로고침</button>
    </fieldset>
    {error && <p role="alert" className="inline-note error-note">{error}</p>}
    {message && <p role="status" className="inline-note">{message}</p>}
    {roster && <>
      <div className="attendance-summary"><Badge>{roster.state}</Badge><span>전체 <strong>{rows.length}명</strong></span>{states.map(value => <button key={value} className={`attendance-count ${status === value ? 'selected' : ''}`} aria-pressed={status === value} onClick={() => { setStatus(status === value ? '' : value); setSelected([]) }}>{value} <strong>{rows.filter(row => row.status === value).length}명</strong></button>)}</div>
      <div className="attendance-round-actions">
        <p>{roster.state === '진행 전' ? '회차를 시작한 뒤 명단에서 출결을 체크하세요.' : roster.state === '마감' ? '확정된 회차입니다. 정정할 때는 사유를 입력하세요.' : '학생은 시작하기 패널 또는 웹 나의 출결에서 입실·퇴실합니다. 퇴실 누락과 정정할 학생을 확인하세요.'}</p>
        {roster.canManage && roster.state === '진행 전' && <button className="button primary" disabled={busy} onClick={() => void save('start')}>회차 시작</button>}
        {roster.canManage && roster.state === '진행 중' && <button className="button secondary" disabled={busy || dirty || !!roster.counts['미처리'] || !rows.length} onClick={() => void save('close')}>회차 마감</button>}
        {!roster.canManage && roster.state === '진행 전' && <span>관리자 또는 메인 강사가 회차를 시작하면 입력할 수 있습니다.</span>}
      </div>
      <details className="attendance-history"><summary>보조 기능 · 기존 코드 출석</summary><p className="inline-note">코드 방식은 멘토가 현장 출석을 확인하는 보조 수단입니다. 입실·퇴실 시각은 별도로 기록되지 않습니다.</p><AttendanceCode key={`${workspaceId}/${courseId}/${date}/${period}`} workspaceId={workspaceId} courseId={courseId} date={date} period={period} roundState={roster.state} disabled={busy || dirty} /></details>
      <fieldset disabled={busy} className="attendance-controls attendance-filters">
        <label>수강생 검색<input type="search" value={search} placeholder="이름으로 검색" onChange={e => { setSearch(e.target.value); setSelected([]) }} /></label>
        <label>출결 조 필터<select value={team} onChange={e => { setTeam(e.target.value); setSelected([]) }}><option value="">전체 조</option>{[...new Set(rows.map(row => row.team || '미배정'))].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true })).map(value => <option key={value}>{value}</option>)}</select></label>
        <label>출결 상태 필터<select value={status} onChange={e => { setStatus(e.target.value); setSelected([]) }}><option value="">전체 상태</option>{states.map(value => <option key={value}>{value}</option>)}</select></label>
        <span className="attendance-filter-count">{visible.length}명 표시 · {selectedRows.length}명 선택</span>
      </fieldset>
      <fieldset disabled={!editable} className="attendance-bulk">
        <div><strong>선택한 {selectedRows.length}명</strong><div className="attendance-status-buttons" role="group" aria-label="선택 학생 일괄 출결">{states.slice(1).map(value => <button key={value} className={`attendance-state attendance-state-${states.indexOf(value)}`} disabled={!selectedRows.length} onClick={() => mark(selectedRows, value)}>{value}</button>)}</div></div>
        <button className="button secondary" disabled={!pendingRows.length} onClick={() => mark(pendingRows, '출석')}>미처리 {pendingRows.length}명 출석</button>
        <small>현재 표시된 정상 수강생 중 미처리만 적용합니다. 기존 지각·결석은 유지합니다.</small>
      </fieldset>
      <div className="table-scroll attendance-roster"><table><thead><tr>
        <th><input type="checkbox" aria-label="표시된 수강생 전체 선택" disabled={!editable || !visible.length} checked={visible.length > 0 && selectedRows.length === visible.length} ref={element => { if (element) element.indeterminate = selectedRows.length > 0 && selectedRows.length < visible.length }} onChange={e => setSelected(e.target.checked ? visible.map(row => row.studentId) : [])} /></th>
        <th>수강생 · 조</th><th>입실 · 퇴실 (한국시간)</th><th>출결 체크</th><th>입력 사유</th>
      </tr></thead><tbody>{visible.map(row => <tr key={row.studentId} className={draft[row.studentId] ? 'attendance-row-dirty' : ''}>
        <td><input type="checkbox" aria-label={`${row.name} 선택`} checked={selected.includes(row.studentId)} disabled={!editable} onChange={e => setSelected(previous => e.target.checked ? [...previous, row.studentId] : previous.filter(id => id !== row.studentId))} /></td>
        <td className="attendance-person"><strong>{row.name}</strong><span>{row.team || '미배정'} · {row.enrollment}{draft[row.studentId] && ' · 저장 전'}</span></td>
        <td><strong>{row.checkInAt ? new Date(row.checkInAt).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }) : '입실 전'}</strong><small>{row.checkOutAt ? new Date(row.checkOutAt).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }) : row.checkInAt ? '퇴실 미등록' : '—'}</small></td><td><div className="attendance-status-buttons" role="group" aria-label={`${row.name} 출결 상태`}>{states.slice(1).map(value => <button key={value} className={`attendance-state attendance-state-${states.indexOf(value)}`} disabled={!editable} aria-pressed={row.status === value} onClick={() => mark([row], value)}>{value}</button>)}</div>{row.status === '미처리' && <small className="attendance-pending">아직 체크하지 않음</small>}</td>
        <td className="attendance-row-reason">{row.reason || '—'}</td>
      </tr>)}</tbody></table></div>
      {!visible.length && <p className="calendar-empty">{rows.length ? '조건에 맞는 수강생이 없습니다. 검색이나 필터를 변경하세요.' : '해당 과정에 담당 수강생이 없습니다.'}</p>}
      <fieldset disabled={!editable} className="attendance-savebar">
        <div><strong>{dirty ? `저장 전 변경 ${Object.keys(draft).length}명` : '저장 전 변경 없음'}</strong><small>선택 여부와 관계없이 변경한 학생의 출결을 저장합니다.</small></div>
        <label>등록·정정 사유<input maxLength={200} value={reason} placeholder={roster.state === '마감' ? '마감 후 정정 시 필수' : '선택 입력'} onChange={e => setReason(e.target.value)} /></label>
        <button className="button secondary" disabled={!dirty} onClick={() => { if (discard()) { setDraft({}); setReason(''); setSelected([]) } }}>입력 되돌리기</button>
        <button className="button primary" disabled={!dirty} onClick={() => void save('save')}>{busy ? '저장 중…' : '출결 일괄 저장'}</button>
      </fieldset>
      <AttendanceDiscord key={`${courseId}:${date}:${period}`} workspaceId={workspaceId} courseId={courseId} date={date} period={period} revision={roster.revision} dirty={dirty} />
      <details className="attendance-history"><summary>CSV 내보내기 · 복구 입력</summary><p className="inline-note">입퇴실 시각은 조회용으로 내보냅니다. CSV 가져오기는 출결 상태와 사유만 반영합니다.</p><fieldset disabled={busy} className="attendance-controls"><button className="button secondary" onClick={download}>출결 CSV 내보내기</button><label>출결 CSV 가져오기<input type="file" accept=".csv,text/csv" disabled={roster.state === '진행 전'} onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }} /></label></fieldset></details>
      <details className="attendance-history attendance-audit"><summary>출결 변경 이력 · 최근 200건</summary><div className="table-scroll"><table><thead><tr><th>일시</th><th>작업자</th><th>수강생</th><th>변경 전</th><th>변경 후</th><th>사유</th></tr></thead><tbody>{roster.history.map((h, i) => <tr key={i}><td>{h.time}</td><td>{h.actor}</td><td>{rows.find(r => r.studentId === h.after.studentId)?.name}</td><td>{h.before?.status || '미처리'}</td><td>{h.after.status}</td><td>{h.after.reason}</td></tr>)}</tbody></table></div></details>
    </>}
  </section>
}

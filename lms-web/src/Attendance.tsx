import { useEffect, useRef, useState } from 'react'
import { workspaceRequest } from './api'
import AttendanceDiscord from './AttendanceDiscord'
import AttendanceCode from './AttendanceCode'
import { Badge } from './components'
import './Attendance.css'
import { confirmNavigation, registerNavigationGuard } from './navigationGuard'
import { editorKey, readEditor, rememberEditor, readAttendanceSelection, rememberAttendanceSelection, reconcileDraft, type Row, type Roster, type Draft, type Conflict } from './attendanceEditor'
import type { Workspace } from './data'
import { exportAttendance, importAttendance } from '../shared/attendance-csv.mjs'

const states = ['미처리', '출석', '지각', '결석', '공결']

export default function Attendance({ data, refresh }: { data: Workspace; refresh?: () => Promise<void> }) {
  const workspaceId = data.workspaceId || ''
  const remembered = readAttendanceSelection(workspaceId)
  const [courseId, setCourseId] = useState(data.courses.some(c => c.id === remembered?.courseId) ? remembered!.courseId : data.courses[0]?.id || '')
  const [date, setDate] = useState(remembered?.date || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }))
  const [period, setPeriod] = useState(remembered?.period || 1)
  const [roster, setRoster] = useState<Roster | null>(null)
  const [draft, setDraft] = useState<Draft>({})
  const [error, setError] = useState(''), [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false), [reason, setReason] = useState('')
  const [search, setSearch] = useState(''), [team, setTeam] = useState(''), [status, setStatus] = useState('')
  const [reviewOnly, setReviewOnly] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [conflicts, setConflicts] = useState<Record<string, Conflict>>({})
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(0)
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 640px)').matches)
  const saveArea = useRef<HTMLFieldSetElement>(null)
  const generation = useRef(0), locked = useRef(false)
  const pending = useRef<{ signature: string; requestId: string } | null>(null)
  const key = editorKey(workspaceId, courseId, date, period)
  const rosterPath = `attendance?${new URLSearchParams({ courseId, date, period: String(period) })}`
  useEffect(() => {
    const version = ++generation.current, controller = new AbortController()
    // eslint-disable-next-line react/set-state-in-effect -- Reset the editor when fetching a different persisted roster.
    setRoster(null); setLoading(false); setDraft({}); setConflicts({}); setSelected([]); setSearch(''); setTeam(''); setStatus(''); setReviewOnly(false); setPage(0); setError(''); setMessage(''); setReason(''); pending.current = null
    if (!courseId || !date || period < 1 || period > 100) return
    setLoading(true)
    rememberAttendanceSelection(workspaceId, { courseId, date, period })
    const saved = readEditor(editorKey(workspaceId, courseId, date, period))
    workspaceRequest(workspaceId, `attendance?${new URLSearchParams({ courseId, date, period: String(period) })}`, { signal: controller.signal })
      .then((value: Roster) => {
        if (generation.current !== version) return
        setRoster(value)
        if (saved) {
          const restored = reconcileDraft(saved.roster, value, saved.draft, saved.conflicts)
          setDraft(restored.draft); setConflicts(restored.conflicts); setReason(saved.reason)
          setMessage('이 탭에서 임시 보관한 입력을 복구했습니다. 확인 후 저장하세요.')
        }
      })
      .catch((e: Error) => { if (!controller.signal.aborted && generation.current === version) setError(e.message) })
      .finally(() => { if (generation.current === version) setLoading(false) })
    return () => { controller.abort(); generation.current = version + 1 }
  }, [workspaceId, courseId, date, period])
  const rows = roster?.rows.map(row => ({ ...row, ...draft[row.studentId] })) || []
  const dirty = Object.keys(draft).length > 0
  useEffect(() => {
    if (roster && roster.courseId === courseId && roster.date === date && roster.period === period) rememberEditor(key, { roster, draft, reason, conflicts })
  }, [key, roster, draft, reason, conflicts, courseId, date, period])
  useEffect(() => {
    if (error || Object.keys(conflicts).length) saveArea.current?.scrollIntoView({ block: 'nearest' })
  }, [error, conflicts])
  useEffect(() => registerNavigationGuard(() => {
    if (locked.current) { window.alert('출결을 저장하거나 불러오는 중입니다. 완료 후 이동하세요.'); return false }
    return !(dirty || reason) || window.confirm('저장하지 않은 출결 입력이 있습니다. 임시 보관하고 이동할까요? 이 탭에서 돌아오면 복구됩니다. 로그아웃하거나 새로고침하면 임시 입력은 사라집니다.')
  }), [dirty, reason])
  useEffect(() => {
    const media = window.matchMedia('(max-width: 640px)')
    const changed = () => { setCompact(media.matches); setPage(0) }
    media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [])
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
  const missingCheckout = (row: Row) => !!roster?.session?.endedAt && !!row.checkInAt && !row.checkOutAt && ['출석', '지각'].includes(row.status)
  const needsReview = (row: Row) => row.status === '미처리' || missingCheckout(row)
  const reviewCount = rows.filter(needsReview).length
  const visible = rows.filter(row => (!search.trim() || row.name.toLowerCase().includes(search.trim().toLowerCase())) && (!team || (row.team || '미배정') === team) && (!!draft[row.studentId] || ((!status || row.status === status) && (!reviewOnly || needsReview(row)))))
  const pageSize = compact ? 5 : 10
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize)), currentPage = Math.min(page, pageCount - 1)
  const pageRows = visible.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
  const selectedRows = visible.filter(row => selected.includes(row.studentId))
  const pendingRows = visible.filter(row => row.status === '미처리' && row.enrollment === '정상')
  const editable = !busy && roster?.state !== '진행 전'
  const closeBlocker = Object.keys(conflicts).length ? '변경된 기록을 비교하고 선택하세요.' : dirty ? `변경한 ${Object.keys(draft).length}명의 출결을 먼저 저장하세요.`
    : roster?.session && !roster.session.endedAt ? '종료 코드를 생성해 강의를 종료하세요.'
    : roster?.counts['미처리'] ? `미처리 ${roster.counts['미처리']}명의 출결을 입력하세요.`
    : !rows.length ? '확정할 수강생이 없습니다.' : ''
  function mark(targets: Row[], status: string) {
    const bulkFocused = document.activeElement?.closest('.attendance-bulk')
    const next = { ...draft }
    for (const row of targets) {
      const original = roster?.rows.find(item => item.studentId === row.studentId)
      if (original?.status === status && original.reason === row.reason) delete next[row.studentId]
      else next[row.studentId] = { status, reason: row.reason }
    }
    setDraft(next)
    setConflicts(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => next[id])))
    setSelected([]); setMessage(''); setError('')
    if (bulkFocused) requestAnimationFrame(() => document.querySelector<HTMLElement>('.attendance-roster')?.focus({ preventScroll: true }))
  }
  useEffect(() => {
    if (!dirty && !reason) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, reason])
  function discard() { return (!dirty && !reason) || window.confirm('저장하지 않은 입력을 버릴까요?') }
  function resetFilters() { setSearch(''); setTeam(''); setStatus(''); setReviewOnly(false); setSelected([]); setPage(0) }
  function undo(id: string) {
    setDraft(previous => { const next = { ...previous }; delete next[id]; return next })
    setConflicts(previous => { const next = { ...previous }; delete next[id]; return next })
    requestAnimationFrame(() => (document.querySelector<HTMLElement>(`[data-student-id="${CSS.escape(id)}"] .attendance-status-buttons button`) || document.querySelector<HTMLElement>('.attendance-roster'))?.focus({ preventScroll: true }))
  }
  function resolve(id: string, keepMine: boolean) {
    if (!keepMine) undo(id)
    else setConflicts(previous => { const next = { ...previous }; delete next[id]; return next })
  }
  async function reloadRoster() {
    if (locked.current || loading || !courseId || !date || period < 1 || period > 100) return
    locked.current = true; setBusy(true); setError('')
    try {
      if (roster) await reconcileLatest(roster)
      else {
        const version = generation.current
        const latest: Roster = await workspaceRequest(workspaceId, rosterPath)
        if (version !== generation.current) return
        const saved = readEditor(key)
        setRoster(latest)
        if (saved) {
          const restored = reconcileDraft(saved.roster, latest, saved.draft, saved.conflicts)
          setDraft(restored.draft); setConflicts(restored.conflicts); setReason(saved.reason)
          setMessage('이 탭에서 임시 보관한 입력을 복구했습니다. 확인 후 저장하세요.')
        }
      }
    }
    catch (e) { setError((e as Error).message) }
    finally { locked.current = false; setBusy(false) }
  }
  async function reconcileLatest(before: Roster) {
    const version = generation.current
    const latest: Roster = await workspaceRequest(workspaceId, rosterPath)
    if (version !== generation.current) return
    const result = reconcileDraft(before, latest, draft, conflicts)
    setRoster(latest); setDraft(result.draft); setConflicts(result.conflicts); pending.current = null
    setMessage(Object.keys(result.conflicts).length ? '같은 학생의 기록이 변경됐습니다. 저장 영역에서 비교 후 선택하세요.' : dirty ? '최신 명단을 불러왔습니다. 내 입력은 유지했습니다. 확인 후 다시 저장하세요.' : '최신 명단을 불러왔습니다.')
  }
  async function save(action: 'start' | 'save' | 'close') {
    if (!roster || locked.current || Object.keys(conflicts).length) return
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
      if (version === generation.current) { setRoster(result); setDraft({}); setConflicts({}); setSelected([]); setReason(''); pending.current = null; setMessage(action === 'save' ? '명단 출결을 저장했습니다.' : action === 'start' ? '회차를 시작했습니다.' : '회차를 마감했습니다.') }
      if (version === generation.current) await refresh?.()
    } catch (e) {
      if (version === generation.current) {
        if ((e as Error & { status?: number }).status === 409) {
          try { await reconcileLatest(roster) }
          catch (reloadError) { setError(`저장하지 못했습니다. 입력은 유지됩니다. ${(reloadError as Error).message}`) }
        } else setError((e as Error).message)
      }
    }
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
    <fieldset disabled={busy} className="attendance-controls attendance-context">
      <label>출결 과정<select value={courseId} onChange={e => { if (confirmNavigation()) setCourseId(e.target.value) }}>{!data.courses.length && <option value="">등록된 과정 없음</option>}{data.courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>
      <label>출결 날짜<input type="date" value={date} onChange={e => { if (confirmNavigation()) setDate(e.target.value) }} /></label>
      <label>출결 차시<input type="number" min={1} max={100} value={period} onChange={e => { if (confirmNavigation()) setPeriod(Number(e.target.value)) }} /></label>
      <button className="button secondary" onClick={() => void reloadRoster()}>명단 새로고침</button>
    </fieldset>
    {!roster && error && <p role="alert" className="inline-note error-note">{error}</p>}
    {loading && <p role="status" className="inline-note">명단을 불러오는 중…</p>}
    {roster && <>
      <div className="attendance-workspace">
      {roster.state !== '마감' && <AttendanceCode key={`${workspaceId}/${courseId}/${date}/${period}`} workspaceId={workspaceId} courseId={courseId} date={date} period={period} roundState={roster.state} disabled={busy || dirty} suggestedStart={data.courses.find(c => c.id === courseId)?.schedule?.filter(s => s.date === date)[period - 1]?.startTime} suggestedEnd={data.courses.find(c => c.id === courseId)?.schedule?.filter(s => s.date === date)[period - 1]?.endTime} onUpdated={async () => { setRoster(await workspaceRequest(workspaceId, `attendance?${new URLSearchParams({ courseId, date, period: String(period) })}`)) }} />}
      <section className="attendance-main" aria-label="출결 입력">
      <div className="attendance-summary">
        <div className="attendance-list-heading"><h2>수강생 명단</h2><Badge>{roster.state === '마감' ? '출결 확정' : roster.session?.endedAt ? '강의 종료 · 출결 확인' : roster.state}</Badge></div>
        <div className="attendance-metrics"><button className="attendance-count" aria-pressed={!status && !reviewOnly} onClick={() => { setStatus(''); setReviewOnly(false); setSelected([]); setPage(0) }}><span>전체</span> <strong>{rows.length}<small>명</small></strong></button>{states.map(value => <button key={value} className={`attendance-count attendance-metric-${states.indexOf(value)}`} aria-pressed={status === value} onClick={() => { setStatus(status === value ? '' : value); setReviewOnly(false); setSelected([]); setPage(0) }}><span>{value}</span> <strong>{rows.filter(row => row.status === value).length}<small>명</small></strong></button>)}</div>
      </div>
      <div className="attendance-toolbar">
      <div className="attendance-review">
        <div role="group" aria-label="명단 보기"><button className="attendance-count" aria-pressed={!reviewOnly && !search && !team && !status} onClick={resetFilters}>전체 명단</button><button className="attendance-count" title="미처리 또는 퇴실 기록이 없는 수강생" aria-pressed={reviewOnly} onClick={() => { setReviewOnly(true); setStatus(''); setSelected([]); setPage(0) }}>확인 필요 <strong>{reviewCount}명</strong></button></div>
      </div>
      <fieldset disabled={busy} className="attendance-controls attendance-filters">
        <label><span>수강생 검색</span><input type="search" value={search} placeholder="이름으로 검색" onChange={e => { setSearch(e.target.value); setSelected([]); setPage(0) }} /></label>
        <label><span>출결 조 필터</span><select value={team} onChange={e => { setTeam(e.target.value); setSelected([]); setPage(0) }}><option value="">전체 조</option>{[...new Set(rows.map(row => row.team || '미배정'))].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true })).map(value => <option key={value}>{value}</option>)}</select></label>
      </fieldset>
      </div>
      {(selectedRows.length > 0 || pendingRows.length > 0) && roster.state !== '진행 전' && <fieldset disabled={!editable} className="attendance-bulk" aria-describedby="attendance-bulk-hint">
        {selectedRows.length > 0 && <div><strong>선택한 {selectedRows.length}명</strong><div className="attendance-status-buttons" role="group" aria-label="선택 학생 일괄 출결">{states.slice(1).map(value => <button key={value} className={`attendance-state attendance-state-${states.indexOf(value)}`} disabled={!selectedRows.length} onClick={() => mark(selectedRows, value)}>{value}</button>)}</div></div>}
        <button className="button secondary" disabled={!pendingRows.length} onClick={() => mark(pendingRows, '출석')}>미처리 {pendingRows.length}명 출석</button>
        <button className="button secondary" disabled={!pendingRows.length} onClick={() => mark(pendingRows, '결석')}>미처리 {pendingRows.length}명 결석</button>
        <small id="attendance-bulk-hint">검색 결과 전체 페이지의 미처리 학생에게 적용 · 정상 수강생만</small>
      </fieldset>}
      <div className="attendance-list-meta"><span className="attendance-filter-count">검색 결과 <strong>{visible.length}명</strong> · {selectedRows.length}명 선택</span><div className="attendance-list-links">{(search || team || status || reviewOnly) && <button className="text-button" onClick={resetFilters}>필터 초기화</button>}{dirty && <button className="text-button" onClick={() => saveArea.current?.scrollIntoView({ block: 'center' })}>저장 대기 {Object.keys(draft).length}명 · 저장으로 이동</button>}</div>
      {pageCount > 1 && <nav className="attendance-pagination" aria-label="명단 페이지"><button className="button secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>이전 명단</button><span>{currentPage + 1} / {pageCount}쪽 · {visible.length}명</span><button className="button secondary" disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>다음 명단</button></nav>}
      </div>
      <div className="table-scroll attendance-roster" role="region" aria-label="출결 명단" tabIndex={0}><table><thead><tr>
        <th><input type="checkbox" aria-label="검색 결과 전체 선택" disabled={!editable || !visible.length} checked={visible.length > 0 && selectedRows.length === visible.length} ref={element => { if (element) element.indeterminate = selectedRows.length > 0 && selectedRows.length < visible.length }} onChange={e => setSelected(e.target.checked ? visible.map(row => row.studentId) : [])} /></th>
        <th>수강생 · 조</th><th>입퇴실 · 한국시간</th><th>출결 체크</th><th>사유</th>
      </tr></thead><tbody>{pageRows.map(row => <tr key={row.studentId} data-student-id={row.studentId} className={draft[row.studentId] ? 'attendance-row-dirty' : ''}>
        <td><input type="checkbox" aria-label={`${row.name} 선택`} checked={selected.includes(row.studentId)} disabled={!editable} onChange={e => setSelected(previous => e.target.checked ? [...previous, row.studentId] : previous.filter(id => id !== row.studentId))} /></td>
        <td className="attendance-person"><strong>{row.name}{row.status === '미처리' && <small className="attendance-pending">미처리</small>}</strong><span>{row.team || '미배정'} · {row.enrollment}{draft[row.studentId] && ' · 저장 전'}</span></td>
        <td className="attendance-times"><div><span>입실</span> <strong>{row.checkInAt ? new Date(row.checkInAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul' }) : '미등록'}</strong></div><div className={missingCheckout(row) ? 'attendance-missing' : ''}><span>퇴실</span> <strong>{row.checkOutAt ? new Date(row.checkOutAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul' }) : '미등록'}</strong></div></td><td><div className="attendance-status-buttons" role="group" aria-label={`${row.name} 출결 상태`}>{states.slice(1).map(value => <button key={value} className={`attendance-state attendance-state-${states.indexOf(value)}`} disabled={!editable} aria-pressed={row.status === value} onClick={() => mark([row], value)}>{value}</button>)}</div></td>
        <td className={`attendance-row-reason ${!row.reason && !draft[row.studentId] ? 'attendance-reason-empty' : ''}`}><span>{row.reason || '—'}</span>{draft[row.studentId] && <button className="text-button" disabled={!editable} aria-label={`${row.name} 입력 되돌리기`} onClick={() => undo(row.studentId)}>되돌리기</button>}</td>
      </tr>)}</tbody></table></div>
      {compact && pageCount > 1 && <nav className="attendance-pagination" aria-label="명단 아래 페이지 이동"><button className="button secondary" aria-label="이전 페이지" disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); requestAnimationFrame(() => document.querySelector<HTMLElement>('.attendance-roster')?.scrollIntoView({ block: 'start' })) }}>이전</button><span>{currentPage + 1} / {pageCount}쪽</span><button className="button secondary" aria-label="다음 페이지" disabled={currentPage === pageCount - 1} onClick={() => { setPage(currentPage + 1); requestAnimationFrame(() => document.querySelector<HTMLElement>('.attendance-roster')?.scrollIntoView({ block: 'start' })) }}>다음</button></nav>}
      {!visible.length && <p className="calendar-empty">{rows.length ? '조건에 맞는 수강생이 없습니다. 검색이나 필터를 변경하세요.' : '해당 과정에 담당 수강생이 없습니다.'}</p>}
      </section>
      <fieldset ref={saveArea} disabled={!editable} className="attendance-savebar">
        <div className="attendance-feedback">{error && <><p role="alert" className="error-note">{error}</p><button className="text-button" onClick={() => void reloadRoster()}>입력 유지하고 새로고침</button></>}{message && <p role="status">{message}</p>}</div>
        {Object.keys(conflicts).length > 0 && <div className="attendance-conflicts" role="region" aria-label="출결 충돌 해결"><strong>변경된 기록 {Object.keys(conflicts).length}명 · 선택 후 저장하세요</strong>{Object.entries(conflicts).map(([id, conflict]) => <div key={id}><strong>{conflict.latest?.name || conflict.before?.name || '명단에서 제외된 학생'}</strong><p>기존: {conflict.before?.status || '미처리'} → 최신: {conflict.latest?.status || '현재 명단에 없음'} · 내 입력: {draft[id]?.status}</p><p>최신 사유: {conflict.latest?.reason || '없음'} · 내 사유: {reason.trim() || draft[id]?.reason || '없음'}</p>{conflict.latest && <small>입실 {conflict.latest.checkInAt ? new Date(conflict.latest.checkInAt).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' }) : '미등록'} · 퇴실 {conflict.latest.checkOutAt ? new Date(conflict.latest.checkOutAt).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' }) : '미등록'}</small>}<div><button className="button secondary" onClick={() => resolve(id, false)}>최신 기록 사용</button>{conflict.latest && <button className="button secondary" onClick={() => resolve(id, true)}>내 입력 유지</button>}</div></div>)}</div>}
        <div className="attendance-save-heading"><h2>출결 저장</h2><strong>{dirty ? `저장 전 변경 ${Object.keys(draft).length}명` : '저장 전 변경 없음'}</strong><small>{dirty ? '필터로 숨겨진 학생을 포함해 변경한 출결을 모두 저장합니다.' : '출결을 선택하거나 미처리 학생을 일괄 처리하세요.'}</small></div>
        <label>등록·정정 사유<input maxLength={200} value={reason} placeholder={roster.state === '마감' ? '마감 후 정정 시 필수' : '선택 입력'} onChange={e => setReason(e.target.value)} /></label>
        <div className="attendance-save-actions"><button className="button secondary" disabled={!dirty && !reason} onClick={() => { if (discard()) { setDraft({}); setConflicts({}); setReason(''); setSelected([]) } }}>입력 되돌리기</button>
        <button className="button primary" disabled={!dirty || !!Object.keys(conflicts).length} onClick={() => void save('save')}>{busy ? '저장 중…' : '출결 일괄 저장'}</button></div>
        {roster.canManage && roster.state === '진행 중' && <div className="attendance-finalize"><p id="attendance-close-hint">{closeBlocker || (reviewCount ? `퇴실 누락 ${reviewCount}명을 확인한 뒤 확정하세요.` : '모든 출결이 저장됐습니다. 확정하면 수강생에게 공개됩니다.')}</p><button className="button secondary" aria-describedby="attendance-close-hint" disabled={busy || !!closeBlocker} onClick={() => void save('close')}>출결 확정</button></div>}
      </fieldset>
      </div>
      <section className="attendance-tools" aria-label="출결 보조 도구">
      <AttendanceDiscord key={`${courseId}:${date}:${period}`} workspaceId={workspaceId} courseId={courseId} date={date} period={period} revision={roster.revision} dirty={dirty} />
      <details className="attendance-history"><summary>CSV 내보내기 · 복구 입력</summary><p className="inline-note">입퇴실 시각은 조회용으로 내보냅니다. CSV 가져오기는 출결 상태와 사유만 반영합니다.</p><fieldset disabled={busy} className="attendance-controls"><button className="button secondary" onClick={download}>출결 CSV 내보내기</button><label>출결 CSV 가져오기<input type="file" accept=".csv,text/csv" disabled={roster.state === '진행 전'} onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }} /></label></fieldset></details>
      <details className="attendance-history attendance-audit"><summary>출결 변경 이력 · 최근 200건</summary><div className="table-scroll"><table><thead><tr><th>일시</th><th>작업자</th><th>수강생</th><th>변경 전</th><th>변경 후</th><th>사유</th></tr></thead><tbody>{roster.history.map((h, i) => <tr key={i}><td>{h.time}</td><td>{h.actor}</td><td>{rows.find(r => r.studentId === h.after.studentId)?.name}</td><td>{h.before?.status || '미처리'}</td><td>{h.after.status}</td><td>{h.after.reason}</td></tr>)}</tbody></table></div></details>
      </section>
    </>}
  </section>
}

import { useRef, useState } from 'react'
import { CalendarDays, Check, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import type { Session, Workspace } from './data'
import type { Change } from './Management'
import './MentoringManagement.css'
import MentoringFeedback from './MentoringFeedback'

const statuses = ['전체', '승인 대기', '예약 확정', '완료', '취소']
const dateValue = (value: string) => new Date(value + 'T00:00:00Z')
function shiftDate(value: string, days: number) { const date = dateValue(value); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10) }
function monday(value: string) { return shiftDate(value, -((dateValue(value).getUTCDay() + 6) % 7)) }
const dateLabel = (value: string, weekday = false) => dateValue(value).toLocaleDateString('ko-KR', { timeZone: 'UTC', month: 'long', day: 'numeric', ...(weekday ? { weekday: 'short' as const } : {}) })
type View = 'week' | 'pending' | 'all'

export default function MentoringManagement({ data, query = '', setQuery, filter, setFilter, change, saving = false, error = '', initialDate }: { data: Workspace; initialDate?: string; query?: string; setQuery?: (value: string) => void; filter: string; setFilter: (filter: string) => void; change: Change; saving?: boolean; error?: string }) {
  const [today] = useState(() => data.mode === 'demo' ? '2026-09-15' : new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }))
  const [view, setView] = useState<View>('week')
  const [week, setWeek] = useState(() => monday(initialDate || today))
  const [selectedDate, setSelectedDate] = useState(initialDate || '')
  const [localSearch, setLocalSearch] = useState(''), [mentor, setMentor] = useState('')
  const [limit, setLimit] = useState(10)
  const [notice, setNotice] = useState(''), [failed, setFailed] = useState(false)
  const [pendingId, setPendingId] = useState(''), [cancelId, setCancelId] = useState('')
  const locked = useRef(false)
  const search = setQuery ? query : localSearch
  const busy = saving || !!pendingId
  const days = Array.from({ length: 7 }, (_, index) => shiftDate(week, index))
  const studentName = (session: Session) => data.learners.find(student => student.id === session.studentId)?.name || ''
  const mentorKey = (session: Session) => session.mentorId || session.mentor
  const mentors = [...new Map(data.sessions.map(session => [mentorKey(session), session.mentor])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'ko'))
  const filtered = data.sessions.filter(session => (!search.trim() || `${session.title} ${session.mentor} ${session.team} ${studentName(session)}`.toLowerCase().includes(search.trim().toLowerCase())) && (!mentor || mentorKey(session) === mentor) && (filter === '전체' || session.status === filter))
  const visible = filtered.filter(session => view === 'pending' ? session.status === '승인 대기' : view === 'all' ? (!selectedDate || session.date === selectedDate) : selectedDate ? session.date === selectedDate : session.date >= week && session.date <= days[6])
    .sort((a, b) => (view === 'all' ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date)) || a.time.localeCompare(b.time) || a.id.localeCompare(b.id))
  const shown = visible.slice(0, limit)
  const grouped = [...new Set(shown.map(session => session.date))].map(date => ({ date, sessions: shown.filter(session => session.date === date) }))
  const tabs: { id: View; label: string; count: number }[] = [
    { id: 'week', label: '주간 일정', count: data.sessions.filter(session => session.date >= week && session.date <= days[6]).length },
    { id: 'pending', label: '승인 대기', count: data.sessions.filter(session => session.status === '승인 대기').length },
    { id: 'all', label: '전체 일정', count: data.sessions.length },
  ]
  function changeView(next: View) { setView(next); setSelectedDate(''); setFilter(next === 'pending' ? '승인 대기' : '전체'); setLimit(10); setCancelId('') }
  function searchFor(value: string) { if (setQuery) setQuery(value); else setLocalSearch(value); setLimit(10) }
  function resetFilters() { searchFor(''); setMentor(''); setSelectedDate(''); setFilter(view === 'pending' ? '승인 대기' : '전체'); setLimit(10) }
  function moveWeek(value: string) { setWeek(monday(value)); setSelectedDate(''); setLimit(10) }
  async function update(session: Session, status: Session['status']) {
    if (locked.current || saving) return
    locked.current = true; setPendingId(session.id); setNotice(''); setFailed(false)
    const message = status === '예약 확정' ? '예약을 승인했습니다.' : status === '완료' ? '멘토링을 완료 처리했습니다.' : '예약을 취소했습니다.'
    try {
      const ok = await change(current => ({ ...current, sessions: current.sessions.map(row => row.id === session.id ? { ...row, status } : row) }), message)
      if (ok) { setNotice(`${session.title} · ${message}`); setCancelId('') }
      else setFailed(true)
    } catch { setFailed(true) }
    finally {
      locked.current = false; setPendingId('')
      requestAnimationFrame(() => {
        const row = document.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(session.id)}"]`)
        const target = row?.querySelector<HTMLButtonElement>('button:not(:disabled)') || document.querySelector<HTMLElement>('#mentoring-list-title')
        target?.focus({ preventScroll: true })
      })
    }
  }
  const hasFilters = !!(search || mentor || selectedDate || (filter !== '전체' && view !== 'pending'))
  return <section className="mentoring-workspace" aria-label="멘토링 일정 관리">
    <nav className="mentoring-views" aria-label="일정 보기">{tabs.map(tab => <button key={tab.id} aria-pressed={view === tab.id} onClick={() => changeView(tab.id)}><span>{tab.label}</span><strong>{tab.count}<small>건</small></strong></button>)}</nav>
    <section className="mentoring-planner">
      {view === 'week' && <div className="mentoring-week">
        <div className="mentoring-week-heading"><div><h2>{dateLabel(week)} – {dateLabel(days[6])}</h2><p>{week.slice(0, 4)}년 · 한국시간</p></div><div className="mentoring-week-actions"><button className="button secondary" onClick={() => { setWeek(monday(today)); setSelectedDate(today); setLimit(10) }}>오늘</button><button className="mentoring-icon-button" aria-label="이전 주 일정" onClick={() => moveWeek(shiftDate(week, -7))}><ChevronLeft size={18} /></button><button className="mentoring-icon-button" aria-label="다음 주 일정" onClick={() => moveWeek(shiftDate(week, 7))}><ChevronRight size={18} /></button><label className="mentoring-date-jump"><span>날짜 이동</span><input type="date" aria-label="주간 일정 날짜 이동" value={selectedDate || week} onChange={event => { if (event.target.value) { moveWeek(event.target.value); setSelectedDate(event.target.value) } }} /></label></div></div>
        <div className="mentoring-week-days" role="group" aria-label="요일별 일정">{days.map((date, index) => <button key={date} aria-label={`${date} 일정`} aria-pressed={selectedDate === date} aria-current={date === today ? 'date' : undefined} onClick={() => { setSelectedDate(selectedDate === date ? '' : date); setLimit(10) }}><span>{['월', '화', '수', '목', '금', '토', '일'][index]}</span><strong>{Number(date.slice(-2))}</strong><small>{filtered.filter(session => session.date === date).length}건</small></button>)}</div>
      </div>}
      <div className="mentoring-toolbar">
        <label className="mentoring-search"><span>일정 검색</span><div><Search size={17} aria-hidden="true" /><input type="search" value={search} placeholder="주제, 멘토, 참여자 검색" onChange={event => searchFor(event.target.value)} /></div></label>
        <label><span>담당 멘토</span><select aria-label="담당 멘토 필터" value={mentor} onChange={event => { setMentor(event.target.value); setLimit(10) }}><option value="">전체 멘토</option>{mentors.map(([id, name]) => <option key={id} value={id}>{name || '미지정'}</option>)}</select></label>
        <label><span>예약 상태</span><select aria-label="예약 상태 필터" value={filter} disabled={view === 'pending'} onChange={event => { setFilter(event.target.value); setLimit(10) }}>{statuses.map(status => <option key={status} value={status}>{status === '전체' ? '전체 상태' : status}</option>)}</select></label>
        {view === 'all' && <label><span>예약 날짜</span><input type="date" value={selectedDate} onChange={event => { setSelectedDate(event.target.value); setLimit(10) }} /></label>}
      </div>
      <div className="mentoring-list-heading"><div><h2 id="mentoring-list-title" tabIndex={-1}>{view === 'pending' ? '승인할 예약' : selectedDate ? dateLabel(selectedDate, true) : view === 'all' ? '전체 예약 이력' : '주간 예약'} <span>{visible.length}건</span></h2>{view !== 'week' && <p>{view === 'pending' ? '날짜에 관계없이 승인 대기 중인 예약을 모았습니다.' : '최근 날짜순 · 같은 날은 시간순으로 표시합니다.'}</p>}</div>{hasFilters && <button className="mentoring-reset" onClick={resetFilters}>{selectedDate && !search && !mentor && filter === '전체' && view === 'week' ? '주 전체 보기' : '필터 초기화'}</button>}</div>
      {notice && <p className="mentoring-feedback" role="status">{notice}</p>}
      {failed && <p className="mentoring-feedback mentoring-error" role="alert">{error || '변경하지 못했습니다. 잠시 후 다시 시도하세요.'}</p>}
      <div className="mentoring-agenda">{grouped.map(group => <section className="mentoring-day-group" key={group.date} aria-label={`${group.date} 예약`}><h3><time dateTime={group.date}>{(view === 'all' || group.date.slice(0, 4) !== today.slice(0, 4)) && `${group.date.slice(0, 4)}년 `}{dateLabel(group.date, true)}</time>{group.date === today && <span>오늘</span>}<small>{visible.filter(session => session.date === group.date).length}건</small></h3><ul>{group.sessions.map(session => <li key={session.id} data-session-id={session.id} className={session.status === '취소' ? 'mentoring-session is-cancelled' : 'mentoring-session'}>
        <div className="mentoring-session-time"><time dateTime={`${session.date}T${session.time}:00+09:00`}>{session.time}</time><small>{session.date < today && !['완료', '취소'].includes(session.status) ? '지난 일정' : session.endTime ? `${session.endDate && session.endDate !== session.date ? '다음날 ' : ''}${session.endTime} 종료` : '시작'}</small></div>
        <div className="mentoring-session-details"><div><h4>{session.title}</h4><span className={`mentoring-status status-${statuses.indexOf(session.status)}`}>{session.status}</span></div><p>{studentName(session) || session.team || '참여자 미지정'}{studentName(session) && session.team && session.team !== studentName(session) ? ` · ${session.team}` : ''}</p></div>
        <div className="mentoring-session-mentor"><span>담당 멘토</span><strong>{session.mentor || '미지정'}</strong></div>
        <div className="mentoring-session-actions">{!['완료', '취소'].includes(session.status) ? <><button className={`button ${session.status === '승인 대기' ? 'primary' : 'secondary'}`} disabled={busy} onClick={() => void update(session, session.status === '승인 대기' ? '예약 확정' : '완료')}><Check size={15} />{pendingId === session.id ? '처리 중…' : session.status === '승인 대기' ? '승인' : '완료 처리'}</button><button className="mentoring-cancel" disabled={busy} aria-expanded={cancelId === session.id} onClick={() => setCancelId(cancelId === session.id ? '' : session.id)}>취소</button></> : <span className="mentoring-finished">{session.status === '완료' ? '진행 완료' : '취소된 예약'}</span>}</div>
        {cancelId === session.id && <div className="mentoring-cancel-confirm"><p>이 예약을 취소할까요?</p><div><button className="button secondary" disabled={busy} onClick={() => setCancelId('')}>돌아가기</button><button className="button secondary" disabled={busy} onClick={() => void update(session, '취소')}>예약 취소</button></div></div>}
        {session.status !== '취소' && <MentoringFeedback workspaceId={data.workspaceId} session={session} demo={data.mode === 'demo'} />}
      </li>)}</ul></section>)}</div>
      {!visible.length && <div className="mentoring-empty"><CalendarDays size={28} /><h3>{hasFilters ? '조건에 맞는 일정이 없습니다.' : view === 'pending' ? '승인 대기 중인 예약이 없습니다.' : view === 'all' ? '등록된 멘토링이 없습니다.' : '선택한 주에 등록된 일정이 없습니다.'}</h3><p>{hasFilters ? '검색어나 필터를 변경해 다시 확인하세요.' : view === 'week' ? '다른 주를 선택하거나 전체 일정에서 예약을 찾아보세요.' : '새 예약이 등록되면 이곳에서 확인할 수 있습니다.'}</p>{!hasFilters && view !== 'all' && <button className="button secondary" onClick={() => changeView('all')}>전체 일정 보기</button>}</div>}
      {visible.length > shown.length && <div className="mentoring-more"><span>{visible.length}건 중 {shown.length}건 표시</span><button className="button secondary" onClick={() => setLimit(limit + 10)}>일정 더 보기</button></div>}
    </section>
  </section>
}

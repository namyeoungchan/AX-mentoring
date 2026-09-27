import { useState } from 'react'
import { ArrowUpRight, BookOpen, Check, ChevronDown, Clock3, RefreshCw, Search } from 'lucide-react'
import type { Learning } from './StudentHome'
import './student-assignments.css'

export type StudentAssignment = {
  id: number; title: string; dueDate: string; active: number;
  week: number; description: string; fields: string[]; type: string; courseTitle: string;
  teamSubmitted: boolean;
  submission: { content: string; link: string; submittedAt: string; team: string } | null;
}
type Filter = 'todo' | 'done' | 'closed' | 'all'
const filters: { id: Filter; label: string }[] = [
  { id: 'todo', label: '해야 할 과제' }, { id: 'done', label: '제출 완료' }, { id: 'closed', label: '종료' }, { id: 'all', label: '전체' },
]
const done = (a: StudentAssignment) => !!a.submission || a.teamSubmitted
const todayKST = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)
function daysLeft(dueDate: string, today: string) {
  return Math.round((Date.parse(dueDate.slice(0, 10) + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000)
}
function dueLabel(days: number) {
  return !Number.isFinite(days) ? '마감일 확인 필요' : days < 0 ? `${-days}일 경과` : days === 0 ? '오늘 마감' : days === 1 ? '내일 마감' : `D-${days}`
}
function submissionText(raw: string) {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return Object.entries(parsed).map(([label, value]) => `${label}\n${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n\n')
  } catch { /* Plain-text submissions remain readable. */ }
  return raw
}
function submittedAt(raw: string) {
  const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? raw.replace(' ', 'T') + 'Z' : raw)
  return Number.isNaN(date.getTime()) ? raw : new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export default function StudentAssignments({ learning, verified, readOnly, error, refresh, participate }: {
  learning: Learning | null; verified: boolean; readOnly: boolean; error: string; refresh: () => Promise<void>; participate: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('todo'), [query, setQuery] = useState(''), [sort, setSort] = useState('due')
  const [expanded, setExpanded] = useState<number | null>(null), [busy, setBusy] = useState(false)
  const assignments = learning?.assignments || [], today = todayKST()
  const matches = (a: StudentAssignment, value: Filter) => value === 'all' || (value === 'todo' ? !!a.active && !done(a) : value === 'done' ? done(a) : !a.active && !done(a))
  const counts = Object.fromEntries(filters.map(f => [f.id, assignments.filter(a => matches(a, f.id)).length]))
  const visible = assignments.filter(a => matches(a, filter) && `${a.title} ${a.courseTitle} ${a.week}주차`.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => sort === 'newest' ? b.id - a.id : a.dueDate.localeCompare(b.dueDate) || b.id - a.id)
  const urgent = assignments.filter(a => matches(a, 'todo') && daysLeft(a.dueDate, today) >= 0 && daysLeft(a.dueDate, today) <= 3).length
  const overdue = assignments.filter(a => matches(a, 'todo') && daysLeft(a.dueDate, today) < 0).length
  const discordUrl = /^https:\/\/discord\.com\/channels\/\d{17,20}(\/\d{17,20})?$/.test(learning?.assignmentDiscordUrl || '') ? learning!.assignmentDiscordUrl! : ''
  async function reload() { if (busy) return; setBusy(true); try { await refresh() } finally { setBusy(false) } }

  if (!verified) return <section className="panel sa-empty"><BookOpen size={28} /><h2>Discord 인증 후 과제를 확인할 수 있습니다.</h2><p>내 과정의 과제와 제출 내역을 연결하려면 워크스페이스 참여를 완료해 주세요.</p><button className="button primary" onClick={participate}>워크스페이스 참여로 이동</button></section>
  if (!learning) return <section className="panel sa-empty" aria-busy={!error}><h2>{error ? '과제를 불러오지 못했습니다.' : '과제를 불러오는 중입니다.'}</h2>{error ? <button className="button secondary" onClick={() => void reload()} disabled={busy}>다시 불러오기</button> : <p role="status">내 과정과 제출 기록을 확인하고 있습니다.</p>}</section>

  return <div className="student-assignments">
    <section className="sa-context" aria-label="과제 안내">
      <div><p className="sa-course">{learning.courses.map(c => c.title).join(' · ') || '등록된 과정 없음'}{learning.enrollment?.team && <span> / {learning.enrollment.team}</span>}</p><h2>{counts.todo ? `제출할 과제 ${counts.todo}개` : assignments.length ? '현재 제출할 과제가 없습니다.' : '새 과제가 등록되면 여기에 표시됩니다.'}</h2><p className="sa-context-note">{urgent > 0 && <span><Clock3 size={15} />3일 이내 마감 {urgent}개</span>}{overdue > 0 && <span className="sa-warning">기한 경과 {overdue}개</span>}{!urgent && !overdue && <span>과제 내용을 확인하고 Discord에서 제출하세요.</span>}</p></div>
      <button className="button secondary" onClick={() => void reload()} disabled={busy}><RefreshCw size={16} />{busy ? '확인 중…' : '제출 상태 새로고침'}</button>
    </section>
    <section className="panel sa-panel" aria-label="나의 과제 목록" aria-busy={busy}>
      <div className="sa-filters" role="group" aria-label="과제 제출 상태">{filters.map(f => <button key={f.id} aria-pressed={filter === f.id} onClick={() => { setFilter(f.id); setExpanded(null) }}>{f.label}<span>{counts[f.id]}</span></button>)}</div>
      <div className="sa-toolbar"><label className="sa-search"><Search size={17} /><input aria-label="과제 검색" placeholder="과제명 또는 주차 검색" value={query} onChange={e => setQuery(e.target.value)} /></label><label className="sa-sort">정렬<select value={sort} onChange={e => setSort(e.target.value)}><option value="due">마감일 빠른 순</option><option value="newest">최근 등록순</option></select></label></div>
      {visible.length > 0 && <div className="sa-column-head" aria-hidden="true"><span>과제</span><span>마감일</span><span>제출 상태</span><span>내용 확인</span></div>}
      <div className="sa-list">{visible.map(a => {
        const days = daysLeft(a.dueDate, today), complete = done(a), open = expanded === a.id
        const state = a.submission ? '내 제출 완료' : a.teamSubmitted ? '팀 제출 완료' : !a.active ? '미제출 · 종료' : '미제출'
        const unavailable = readOnly ? '보관된 워크스페이스에서는 제출할 수 없습니다.' : learning.enrollment?.status !== '정상' ? '현재 수강 상태에서는 제출할 수 없습니다. 운영자에게 확인해 주세요.' : a.type === 'team' && !learning.enrollment.team ? '팀 배정 후 제출할 수 있습니다. 운영자에게 조 배정을 요청하세요.' : ''
        return <article key={a.id} className={`sa-assignment${open ? ' is-open' : ''}`} aria-label={a.title}>
          <div className="sa-row"><div className="sa-title"><p>{a.week}주차 <span>·</span> {a.type === 'individual' ? '개인 과제' : '팀 과제'}</p><h3><button aria-expanded={open} aria-controls={`sa-detail-${a.id}`} onClick={() => setExpanded(open ? null : a.id)}>{a.title}</button></h3></div>
            <div className="sa-due"><time dateTime={a.dueDate}>{a.dueDate.slice(0, 10).replaceAll('-', '.')}</time><span className={!complete && a.active && days <= 3 ? 'sa-warning' : ''}>{!a.active ? '접수 종료' : complete ? '마감일' : dueLabel(days)}</span></div>
            <span className={`sa-status ${complete ? 'is-done' : !a.active ? 'is-closed' : 'is-todo'}`}>{complete && <Check size={14} />}{state}</span>
            <button className="sa-open" aria-label={`${a.title} ${open ? '내용 닫기' : '내용 보기'}`} aria-expanded={open} aria-controls={`sa-detail-${a.id}`} onClick={() => setExpanded(open ? null : a.id)}>{open ? '닫기' : '내용 보기'}<ChevronDown size={16} /></button>
          </div>
          {open && <div id={`sa-detail-${a.id}`} className="sa-detail">
            <div className="sa-instructions"><h4>과제 안내</h4><p className="sa-description">{a.description || '별도 설명이 없습니다. 수업에서 안내받은 내용을 확인해 주세요.'}</p>{a.fields?.length > 0 && <><h4>준비할 제출 항목</h4><ul>{a.fields.map((field, i) => <li key={i}>{field}</li>)}</ul></>}
              {a.submission && <div className="sa-my-submission"><h4>내 제출 내용</h4><p className="sa-submitted-time">{submittedAt(a.submission.submittedAt)} (한국시간){a.submission.team && ` · 제출 당시 ${a.submission.team}`}</p><p className="sa-description">{submissionText(a.submission.content) || '저장된 본문이 없습니다.'}</p>{/^https?:\/\//i.test(a.submission.link) && <a className="sa-link" href={a.submission.link} target="_blank" rel="noreferrer">내 제출 링크 열기<ArrowUpRight size={16} /></a>}</div>}
            </div>
            <aside className="sa-submit"><h4>{a.submission ? '제출이 기록되었습니다.' : a.teamSubmitted ? '우리 팀의 제출이 기록되었습니다.' : !a.active ? '접수가 종료된 과제입니다.' : 'Discord에서 제출하기'}</h4>
              <p>{a.submission ? '같은 과제는 개인별로 한 번 제출할 수 있습니다. 수정이 필요하면 담당 멘토에게 요청하세요.' : a.teamSubmitted ? '팀 과제는 팀원 한 명 이상이 제출하면 완료됩니다. 추가 제출 여부는 팀원과 확인하세요.' : !a.active ? '제출이 필요하면 담당 멘토에게 과제명과 함께 문의하세요.' : a.type === 'team' ? '팀원과 제출 담당자를 정한 뒤 과제 제출 패널에서 이 과제를 선택하세요.' : '과제 제출 패널에서 이 과제를 선택하고 준비한 내용을 입력하세요.'}</p>
              {!!a.active && !a.submission && (unavailable ? <p className="sa-late-note">{unavailable}</p> : <>{days < 0 && <p className="sa-late-note">마감일이 지났습니다. 현재 접수는 열려 있으며, 지각 제출 인정 여부는 멘토에게 확인하세요.</p>}{discordUrl ? <a className="button primary" href={discordUrl} target="_blank" rel="noreferrer">Discord로 이동<ArrowUpRight size={16} /></a> : <p className="sa-late-note">수업 Discord 서버의 과제 제출 패널을 이용하세요. 채널이 보이지 않으면 운영자에게 문의하세요.</p>}<small>제출 후 위의 ‘제출 상태 새로고침’을 누르면 결과를 확인할 수 있습니다.</small></>)}
            </aside>
          </div>}
        </article>
      })}</div>
      {!visible.length && <div className="sa-empty"><BookOpen size={26} /><h3>{query ? '검색 결과가 없습니다.' : filter === 'todo' && assignments.length ? '남아 있는 제출 과제가 없습니다.' : filter === 'done' ? '아직 제출한 과제가 없습니다.' : filter === 'closed' ? '미제출 상태로 종료된 과제가 없습니다.' : '등록된 과제가 없습니다.'}</h3><p>{query ? '과제명이나 주차를 바꿔 검색해 보세요.' : filter === 'todo' && counts.done ? '제출 완료 탭에서 저장된 내역을 확인할 수 있습니다.' : '과제가 등록되거나 제출하면 이곳에서 확인할 수 있습니다.'}</p>{query && <button className="text-button" onClick={() => setQuery('')}>검색어 지우기</button>}</div>}
      <div className="sa-footnote"><span>마감일은 한국시간 기준입니다.</span><span>팀 과제는 팀원 한 명 이상 제출 시 완료로 표시됩니다.</span></div>
    </section>
  </div>
}

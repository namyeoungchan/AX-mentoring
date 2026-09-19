import { Fragment, useState } from 'react'
import AssignmentAlerts from './AssignmentAlerts'
import AssignmentDelete from './AssignmentDelete'
import { useAssignmentAlerts } from './useAssignmentAlerts'
import { ArrowDownToLine, ChevronRight, ExternalLink, FileText } from 'lucide-react'
import { Badge, CardHeading, Empty } from './components'
import type { Assignment, RecordData, Workspace } from './data'
import type { Change } from './Management'

function submissionText(value: string | number | undefined): string {
  const raw = String(value ?? '')
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.entries(parsed).map(([label, answer]) => `${label}: ${typeof answer === 'string' ? answer : JSON.stringify(answer)}`).join('\n')
    }
  } catch { /* Older submissions store plain text. */ }
  return raw
}

function submittedAt(value: string | number | undefined): string {
  const raw = String(value ?? '')
  if (!raw) return '—'
  const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? raw.replace(' ', 'T') + 'Z' : raw)
  return Number.isNaN(date.getTime()) ? raw : new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date)
}

function downloadSubmissions(data: Workspace, assignment?: Assignment) {
  const submissions = assignment ? data.submissions.filter(s => String(s.assignmentId) === assignment.id) : data.submissions
  const assignments = new Map(data.assignments.map(a => [a.id, a]))
  const rows = [['과제 ID', '과제명', '과정', '마감일', '과제 상태', '제출 ID', '제출자', '팀', '제출 내용', '제출 링크', '제출 시각 (한국시간)'], ...submissions.map(s => {
    const a = assignments.get(String(s.assignmentId))
    return [s.assignmentId, a?.title || '', a?.course || '', a?.due || '', a?.status || '', s.id, s.name, s.team, submissionText(s.content), s.link, submittedAt(s.submittedAt)]
  })]
  const cell = (value: string | number | undefined) => {
    let text = String(value ?? '')
    // User-provided names, answers and links must not become spreadsheet formulas.
    if (/^\s*[=+@-]|^[\t\r\n]/.test(text)) text = "'" + text
    return `"${text.replaceAll('"', '""')}"`
  }
  const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  const title = Array.from(assignment?.title || data.name, character => character.charCodeAt(0) < 32 ? '_' : character).join('')
  link.download = `${title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}_${assignment ? '제출내역' : '전체제출내역'}.csv`
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function AssignmentManagement({ data, query, change, refresh }: { data: Workspace; query: string; change: Change; refresh: () => Promise<void> }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null), [message, setMessage] = useState('')
  const [status, setStatus] = useState('전체'), [courseId, setCourseId] = useState(''), [type, setType] = useState('')
  const alerts = useAssignmentAlerts(data.workspaceId || '', data.revision, data.mode === 'api')
  const targets = new Map(alerts.data?.assignments.map(a => [a.id, a]) || [])
  const assignments = data.assignments.filter(a => `${a.title} ${a.course}`.toLowerCase().includes(query.toLowerCase()) && (status === '전체' || a.status === status) && (!courseId || (targets.get(a.id)?.courseId || a.courseId) === courseId) && (!type || (a.type || 'team') === type))
  async function reload() { if (busy) return; setBusy(true); try { await refresh(); alerts.refresh() } finally { setBusy(false) } }
  const byAssignment = new Map<string, RecordData[]>()
  for (const submission of data.submissions) {
    const id = String(submission.assignmentId)
    const rows = byAssignment.get(id) || []
    rows.push(submission)
    byAssignment.set(id, rows)
  }
  function toggle(id: string) {
    setExpanded(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  async function changeStatus(assignment: Assignment) {
    if (busy) return
    setBusy(true)
    try {
      await change(d => ({ ...d, assignments: d.assignments.map(row => row.id === assignment.id ? { ...row, status: assignment.status === '마감' ? '진행 중' : '마감' } : row) }), assignment.status === '마감' ? '과제를 다시 열었습니다.' : '과제를 마감했습니다.')
    } finally { setBusy(false) }
  }
  return <>
    {deleting && <AssignmentDelete workspaceId={data.workspaceId!} assignmentId={deleting} close={() => setDeleting(null)} removed={deleted => { setDeleting(null); setMessage(deleted ? '과제와 제출 내역을 삭제했습니다.' : '이미 삭제된 과제입니다.'); void refresh().then(() => alerts.refresh()).catch(() => setMessage('삭제 처리가 완료되었습니다. 목록을 새로고침해 주세요.')) }} />}
    {message && <p className="inline-note" role="status">{message}</p>}
    <div className="filter-row assignment-filters"><div className="tabs" aria-label="과제 상태 필터">{['전체', '진행 중', '마감'].map(value => <button key={value} className={status === value ? 'selected' : ''} aria-pressed={status === value} onClick={() => setStatus(value)}>{value}<span>{value === '전체' ? data.assignments.length : data.assignments.filter(a => a.status === value).length}</span></button>)}</div><div className="assignment-action-group"><select className="select-control" aria-label="과제 과정 필터" value={courseId} onChange={e => setCourseId(e.target.value)}><option value="">전체 과정</option>{data.courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select><select className="select-control" aria-label="과제 유형 필터" value={type} onChange={e => setType(e.target.value)}><option value="">전체 유형</option><option value="team">팀 과제</option><option value="individual">개인 과제</option></select></div></div>
    <section className="panel assignment-management">
      <CardHeading title="과제 목록" subtitle="과제를 열어 제출 내역과 대상·알림을 함께 확인하세요."><div className="assignment-action-group"><button className="button secondary" disabled={busy || alerts.busy} onClick={() => void reload()}>과제 새로고침</button><button className="button secondary" disabled={!data.submissions.length} onClick={() => downloadSubmissions(data)}><ArrowDownToLine size={16} />전체 내역 다운로드</button></div></CardHeading>
      <div className="assignment-overview"><span>표시 <strong>{assignments.length}</strong>개</span><span>전체 제출 <strong>{data.submissions.length}</strong>건</span><small>생성한 과제는 선택한 과정의 제출 대상에 자동 연결됩니다.</small></div>
      {alerts.error && <p className="inline-note error-note" role="alert">{alerts.error}</p>}{alerts.message && <p className="inline-note" role="status">{alerts.message}</p>}
      <div className="table-scroll assignment-table-wrap"><table className="assignment-table"><thead><tr><th>과제 · 과정</th><th>유형</th><th>마감일</th><th>제출 현황</th><th>상태</th><th>관리</th></tr></thead><tbody>{assignments.map(a => {
        const open = expanded.has(a.id), submissions = byAssignment.get(a.id) || [], target = targets.get(a.id)
        const detailsId = `assignment-submissions-${a.id}`, total = target?.total ?? a.total, submitted = target?.submitted ?? a.submitted
        const course = data.courses.find(c => c.id === (target?.courseId || a.courseId))?.title || a.course
        return <Fragment key={a.id}><tr className={`assignment-item${open ? ' is-open' : ''}`}>
          <td data-label="과제"><button className="assignment-expand" aria-label={`${a.title} 제출 현황`} aria-expanded={open} aria-controls={detailsId} onClick={() => toggle(a.id)}><ChevronRight className="assignment-caret" size={18} /><span className="assignment-title"><strong>{a.title}</strong><small>{course}</small></span></button></td>
          <td data-label="유형"><Badge tone="neutral">{a.type === 'individual' ? '개인' : '팀'}</Badge></td><td data-label="마감일">{a.due}</td>
          <td data-label="제출 현황">{target?.courseId || a.courseId ? <><strong>{submitted} / {total}</strong><small>{a.type === 'individual' ? '명' : '팀'} 제출 완료</small></> : <><strong>{submissions.length}건 접수</strong><small>대상 과정 확인 필요</small></>}</td>
          <td data-label="상태"><Badge tone={a.status === '마감' ? 'neutral' : 'green'}>{a.status}</Badge></td><td data-label="관리"><button className="button secondary compact" disabled={busy || alerts.busy} aria-label={`${a.title} ${a.status === '마감' ? '다시 열기' : '마감하기'}`} onClick={() => void changeStatus(a)}>{a.status === '마감' ? '다시 열기' : '마감하기'}</button>{data.mode === 'api' && <button className="text-button assignment-delete-button" disabled={busy || alerts.busy} aria-label={`${a.title} 삭제`} onClick={() => setDeleting(a.id)}>삭제</button>}</td>
        </tr><tr className="assignment-detail-row" hidden={!open}><td colSpan={6}><div id={detailsId} className="assignment-details" role="region" aria-label={`${a.title} 제출 내역`}>
          <div className="assignment-details-heading"><span><FileText size={16} />제출 내역 <strong>{submissions.length}건</strong></span><button className="button secondary compact" disabled={!submissions.length} onClick={() => downloadSubmissions(data, a)}><ArrowDownToLine size={14} />이 과제 다운로드</button></div>
          {submissions.length ? <div className="table-scroll"><table><thead><tr><th>제출자 / 팀</th><th>제출 내용</th><th>제출 링크</th><th>제출 시각 (한국시간)</th></tr></thead><tbody>{submissions.map(s => <tr key={s.id}><td><strong>{s.name}</strong><small>{s.team || '개인'}</small></td><td className="submission-content">{submissionText(s.content) || '—'}</td><td>{/^https?:\/\//i.test(String(s.link)) ? <a className="text-button" href={String(s.link)} target="_blank" rel="noreferrer">제출물 열기 <ExternalLink size={13} /></a> : '—'}</td><td>{submittedAt(s.submittedAt)}</td></tr>)}</tbody></table></div> : <p className="assignment-no-submissions">아직 제출된 내역이 없습니다.</p>}
          {data.mode === 'api' && open && <AssignmentAlerts state={alerts} assignmentId={a.id} />}
        </div></td></tr></Fragment>
      })}</tbody></table></div>
      {!assignments.length && <Empty />}<p className="assignment-download-note">전체 내역 다운로드는 검색·필터와 관계없이 모든 제출물을 CSV로 저장합니다.</p>
    </section>
  </>
}

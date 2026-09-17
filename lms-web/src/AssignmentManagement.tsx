import { useState } from 'react'
import AssignmentAlerts from './AssignmentAlerts'
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

export default function AssignmentManagement({ data, query, change }: { data: Workspace; query: string; change: Change }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const assignments = data.assignments.filter(a => `${a.title} ${a.course}`.toLowerCase().includes(query.toLowerCase()))
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
  return <>{data.mode === 'api' && <AssignmentAlerts key={data.workspaceId} workspaceId={data.workspaceId || ''} revision={data.revision} />}<section className="panel assignment-management">
    <CardHeading title="과제 및 제출 현황" subtitle="과제 왼쪽의 화살표를 눌러 제출 내역을 확인하세요.">
      <button className="button secondary" disabled={!data.submissions.length} onClick={() => downloadSubmissions(data)}><ArrowDownToLine size={16} />전체 내역 다운로드</button>
    </CardHeading>
    <div className="assignment-overview"><span>과제 <strong>{data.assignments.length}</strong>개</span><span>전체 제출 <strong>{data.submissions.length}</strong>건</span><small>CSV · 전체 다운로드에는 검색 결과와 관계없이 모든 제출 내역이 포함됩니다.</small></div>
    <div className="assignment-list">{assignments.map(a => {
      const open = expanded.has(a.id), submissions = byAssignment.get(a.id) || []
      const detailsId = `assignment-submissions-${a.id}`
      return <article className={`assignment-item${open ? ' is-open' : ''}`} key={a.id}>
        <div className="assignment-summary">
          <button className="assignment-expand" aria-label={`${a.title} 제출 현황`} aria-expanded={open} aria-controls={detailsId} onClick={() => toggle(a.id)}>
            <ChevronRight className="assignment-caret" size={20} />
            <span className="assignment-title"><strong>{a.title}</strong><small>{a.course} · {a.due} 마감</small></span>
            <span className="assignment-count"><strong>{a.submitted}건 제출</strong><small>{a.total > 0 ? `대상 ${a.total}` : '대상 미집계'}</small></span>
          </button>
          <div className="assignment-controls"><Badge tone={a.status === '마감' ? 'neutral' : 'green'}>{a.status}</Badge><button className="button secondary compact" disabled={busy} aria-label={`${a.title} ${a.status === '마감' ? '다시 열기' : '마감하기'}`} onClick={() => void changeStatus(a)}>{a.status === '마감' ? '다시 열기' : '마감하기'}</button></div>
        </div>
        <div id={detailsId} hidden={!open} className="assignment-details" role="region" aria-label={`${a.title} 제출 내역`}>
          <div className="assignment-details-heading"><span><FileText size={16} />제출 내역 <strong>{submissions.length}건</strong></span><button className="button secondary compact" disabled={!submissions.length} onClick={() => downloadSubmissions(data, a)}><ArrowDownToLine size={14} />이 과제 다운로드</button></div>
          {submissions.length ? <div className="table-scroll"><table><thead><tr><th>제출자 / 팀</th><th>제출 내용</th><th>제출 링크</th><th>제출 시각 (한국시간)</th></tr></thead><tbody>{submissions.map(s => <tr key={s.id}>
            <td><strong>{s.name}</strong><small>{s.team || '개인'}</small></td><td className="submission-content">{submissionText(s.content) || '—'}</td>
            <td>{/^https?:\/\//i.test(String(s.link)) ? <a className="text-button" href={String(s.link)} target="_blank" rel="noreferrer">제출물 열기 <ExternalLink size={13} /></a> : '—'}</td><td>{submittedAt(s.submittedAt)}</td>
          </tr>)}</tbody></table></div> : <p className="assignment-no-submissions">아직 제출된 내역이 없습니다.</p>}
        </div>
      </article>
    })}</div>
    {!assignments.length && <Empty />}
  </section></>
}

import { useState, type FormEvent } from 'react'
import { ArrowDownToLine, ExternalLink, FileBox, Pencil, Plus } from 'lucide-react'
import { Badge, CardHeading, Empty, ModalShell } from './components'
import type { RecordData, Workspace } from './data'
import type { Change } from './Management'
import Attendance from './Attendance'

type Field = { key: string; label: string; type?: string; options?: string[]; optional?: boolean }
type Definition = { title: string; description: string; fields: Field[] }
const definitions: Record<string, Definition> = {
  learners: { title: '수강생', description: '이메일 및 Discord ID 중복 검증 · 과정 및 팀 배정', fields: [{ key: 'name', label: '이름' }, { key: 'email', label: '이메일', type: 'email', optional: true }, { key: 'discordId', label: 'Discord ID', optional: true }, { key: 'courseId', label: '과정', type: 'course' }, { key: 'team', label: '팀', type: 'team', optional: true }, { key: 'status', label: '상태', options: ['대기', '정상', '중도탈락', '수료', '비활성'] }] },
  teams: { title: '팀', description: '과정별 팀 코드 관리 · 멘토 배정은 구성원 · 초대에서 변경합니다.', fields: [{ key: 'name', label: '팀 이름' }, { key: 'code', label: '팀 코드' }, { key: 'courseId', label: '과정', type: 'course' }] },
  attendance: { title: '출결', description: '수강생·날짜·차시별 출결 · 수정 사유 및 변경 이력 저장', fields: [{ key: 'courseId', label: '과정', type: 'course' }, { key: 'studentId', label: '수강생', type: 'student' }, { key: 'date', label: '수업 일자', type: 'date' }, { key: 'period', label: '차시', type: 'number' }, { key: 'status', label: '출결 상태', options: ['출석', '지각', '결석', '공결'] }, { key: 'reason', label: '등록·수정 사유' }] },
  scores: { title: '성적', description: '평가항목별 점수 · 배점 검증 · 종합점수 자동 합산', fields: [{ key: 'courseId', label: '과정', type: 'course' }, { key: 'studentId', label: '수강생', type: 'student' }, { key: 'item', label: '평가항목' }, { key: 'score', label: '점수', type: 'number' }, { key: 'maximum', label: '최대 배점', type: 'number' }] },
  notices: { title: '공지', description: '공지 초안 저장 · Discord 발송은 아직 연결되지 않았습니다.', fields: [{ key: 'title', label: '제목' }, { key: 'courseId', label: '과정', type: 'course' }, { key: 'target', label: '대상', options: ['과정 전체', '운영자', '멘토', '수강생'] }, { key: 'content', label: '내용', type: 'textarea' }] },
}
function exportRows(title: string, fields: Field[], rows: RecordData[], display: (field: Field, row: RecordData) => string) {
  const csv = '\uFEFF' + [fields.map(f => f.label), ...rows.map(r => fields.map(f => display(f, r)))].map(row => row.map(v => `"${v.replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `${title}.csv`; link.click(); URL.revokeObjectURL(url)
}
export default function Operations({ page, data, query, change, saving, error, refresh }: { page: string; data: Workspace; query: string; change: Change; saving: boolean; error: string; refresh?: () => Promise<void> }) {
  const [editing, setEditing] = useState<RecordData | null>(null)
  const [courseId, setCourseId] = useState('')
  const [courseFilter, setCourseFilter] = useState('')
  const definition = definitions[page]
  if (page === 'attendance' && data.mode === 'api') return <Attendance key={data.workspaceId} data={data} refresh={refresh} />
  if (page === 'submissions') return <div className="panel"><CardHeading title="과제 제출 내역" subtitle="기존 봇 submissions 테이블 · 최근 제출 순" /><div className="table-scroll"><table><thead><tr><th>과제</th><th>제출자 / 팀</th><th>제출 내용</th><th>링크</th><th>제출일시</th></tr></thead><tbody>{data.submissions.filter(s => Object.values(s).join(' ').includes(query)).map(s => <tr key={s.id}><td>{data.assignments.find(a => a.id === String(s.assignmentId))?.title || s.assignmentId}</td><td>{s.name}<small>{s.team}</small></td><td className="submission-content">{s.content}</td><td>{/^https?:\/\//.test(String(s.link)) ? <a className="text-button" href={String(s.link)} target="_blank" rel="noreferrer">제출물 <ExternalLink size={13} /></a> : '—'}</td><td>{s.submittedAt}</td></tr>)}</tbody></table></div>{!data.submissions.length && <Empty />}</div>
  if (page === 'files') return <div className="panel"><CardHeading title="통합 파일함" subtitle="AWS S3 Private Bucket 연동 예정" /><div className="integration-empty"><FileBox size={40} /><h2>S3 저장소 미연결</h2><p>파일 업로드·다운로드를 사용하려면 S3 버킷과 서버 측 권한 설정이 필요합니다.</p><ul><li>과정·팀별 접근권한 확인 후 URL 발급</li><li>파일 원본은 S3, 메타데이터는 DB에 저장</li><li>브라우저에 AWS 자격증명을 저장하지 않음</li></ul><Badge tone="neutral">미구현 · 업로드 불가</Badge></div></div>
  const allRows = data[page as keyof Workspace] as RecordData[]
  const rows = allRows.filter(r => (!courseFilter || r.courseId === courseFilter) && Object.values(r).join(' ').toLowerCase().includes(query.toLowerCase()))
  function display(field: Field, row: RecordData) {
    const value = String(row[field.key] ?? '')
    if (field.type === 'course') return data.courses.find(c => c.id === value)?.title || '미배정'
    if (field.type === 'student') return data.learners.find(l => l.id === value)?.name || value
    if (field.type === 'mentor') return data.mentors.find(m => m.id === value)?.name || '미배정'
    return value || '—'
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fields = new FormData(e.currentTarget)
    const value: RecordData = { ...editing!, id: editing?.id || crypto.randomUUID() }
    for (const field of definition.fields) value[field.key] = field.type === 'number' ? Number(fields.get(field.key)) : String(fields.get(field.key) || '').trim()
    if (page === 'learners') { value.progress ??= 0; value.color ??= 'sage' }
    if (page === 'teams') value.mentorId ??= ''
    if (page === 'notices') value.status = '초안'
    const ok = await change(d => ({ ...d, [page]: editing?.id ? (d[page as keyof Workspace] as RecordData[]).map(r => r.id === editing.id ? value : r) : [...(d[page as keyof Workspace] as RecordData[]), value] }), `${definition.title} 데이터를 저장했습니다.`)
    if (ok) setEditing(null)
  }
  return <><div className="operations-toolbar"><select className="select-control" aria-label="과정 필터" value={courseFilter} onChange={e => setCourseFilter(e.target.value)}><option value="">전체 과정</option>{data.courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select><div className="flex gap-2"><button className="button secondary" onClick={() => exportRows(definition.title, definition.fields, rows, display)}><ArrowDownToLine size={15} /> CSV 내보내기</button><button className="button primary" onClick={() => { setCourseId(data.courses[0]?.id || ''); setEditing({ id: '' }) }}><Plus size={15} /> {definition.title} 등록</button></div></div>
    {page === 'scores' && <div className="score-summary">{data.learners.filter(l => !courseFilter || l.courseId === courseFilter).map(l => { const scores = data.scores.filter(s => s.studentId === l.id); return <div key={l.id}><span>{l.name}</span><strong>{scores.reduce((sum, s) => sum + Number(s.score), 0)}<small> / {scores.reduce((sum, s) => sum + Number(s.maximum), 0)}</small></strong></div> })}</div>}
    <div className="panel"><CardHeading title={`${definition.title} 목록`} subtitle={definition.description}><Badge tone="neutral">{rows.length}건</Badge></CardHeading><div className="table-scroll"><table><thead><tr>{definition.fields.filter(f => f.key !== 'content').map(f => <th key={f.key}>{f.label}</th>)}<th>관리</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}>{definition.fields.filter(f => f.key !== 'content').map(f => <td key={f.key}>{f.key === 'status' ? <Badge>{display(f, row)}</Badge> : display(f, row)}</td>)}<td><button className="button compact secondary" onClick={() => { setCourseId(String(row.courseId || '')); setEditing(row) }}><Pencil size={13} /> 수정</button></td></tr>)}</tbody></table></div>{!rows.length && <Empty />}</div>
    {editing && <ModalShell title={`${definition.title} ${editing.id ? '수정' : '등록'}`} close={() => setEditing(null)}><form className="modal-form" onSubmit={submit}><fieldset disabled={saving}>{error && <div role="alert" className="inline-note error-note">{error}</div>}{definition.fields.map(field => <label key={field.key}>{field.label}{field.optional && <span className="muted">선택</span>}{field.type === 'textarea' ? <textarea aria-label={field.label} name={field.key} defaultValue={editing[field.key]} required={!field.optional} maxLength={4000} /> : field.options ? <select aria-label={field.label} name={field.key} defaultValue={editing[field.key]}>{field.options.map(o => <option key={o}>{o}</option>)}</select> : ['course', 'student', 'mentor', 'team'].includes(field.type || '') ? <select aria-label={field.label} key={field.key === 'team' || field.key === 'student' ? courseId : field.key} name={field.key} required={!field.optional} defaultValue={String(editing[field.key] || (field.type === 'course' ? courseId : ''))} onChange={field.type === 'course' ? e => setCourseId(e.target.value) : undefined}><option value="">선택하세요</option>{(field.type === 'course' ? data.courses : field.type === 'student' ? data.learners.filter(l => l.courseId === courseId) : field.type === 'team' ? data.teams.filter(t => t.courseId === courseId) : data.mentors).map(item => <option key={item.id} value={field.type === 'team' ? String('name' in item ? item.name : '') : item.id}>{'title' in item ? String(item.title) : String(item.name)}</option>)}</select> : <input aria-label={field.label} name={field.key} type={field.type || 'text'} defaultValue={editing[field.key] ?? (field.type === 'date' ? new Date().toLocaleDateString('en-CA') : field.type === 'number' ? (field.key === 'maximum' ? 100 : field.key === 'period' ? 1 : 0) : '')} required={!field.optional} min={field.key === 'score' ? 0 : 1} step={field.key === 'score' || field.key === 'maximum' ? '0.1' : '1'} maxLength={200} />}</label>)}<div className="modal-actions"><button type="button" className="button secondary" onClick={() => setEditing(null)}>취소</button><button type="submit" className="button primary">{saving ? '저장 중…' : '저장'}</button></div></fieldset></form></ModalShell>}
  </>
}

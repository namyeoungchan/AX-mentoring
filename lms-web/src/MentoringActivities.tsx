import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Pencil, Plus, RefreshCw } from 'lucide-react'
import { ModalShell } from './components'
import { workspaceRequest } from './api'
import './MentoringActivities.css'

type Fields = { mentorId: string; courseId: string; teamId: string; studentIds: string[]; title: string; date: string; time: string; endTime: string; content: string }
type Activity = Fields & { id: string; mentorName: string; courseTitle: string; teamName: string; students: { id: string; name: string }[]; revision: number; canEdit: boolean }
type Options = { admin: boolean; canCreate: boolean; mentors: { id: string; name: string; username: string }[]; courses: { id: string; title: string }[]; teams: { id: string; name: string; courseId: string }[]; students: { id: string; name: string; courseId: string; team: string }[]; records: Activity[] }
const message = (error: unknown) => error instanceof Error ? error.message : '기록을 처리하지 못했습니다. 다시 시도하세요.'

export function MentoringAddButton({ onClick, disabled = false }: { onClick: () => void; disabled?: boolean }) {
  return <button type="button" className="button primary mentoring-add-button" onClick={onClick} disabled={disabled} aria-label="멘토링 기록 추가" title="멘토링 기록 추가"><Plus size={20} aria-hidden="true" /></button>
}

export default function MentoringActivities({ workspaceId, open, close, demo = false }: { workspaceId: string; open: boolean; close: () => void; demo?: boolean }) {
  const [data, setData] = useState<Options | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(!demo)
  const [editing, setEditing] = useState<Activity | null>(null), [expanded, setExpanded] = useState(false), [limit, setLimit] = useState(10)
  const requestNumber = useRef(0)
  const refreshLocked = useRef(false)
  const section = useRef<HTMLElement>(null)
  const load = useCallback(async () => {
    if (refreshLocked.current) return
    refreshLocked.current = true; setLoading(true)
    const number = ++requestNumber.current
    try {
      const result = await workspaceRequest(workspaceId, 'mentoring/activities') as Options
      if (number === requestNumber.current) { setData(result); setError('') }
    } catch (failure) { if (number === requestNumber.current) setError(message(failure)) }
    finally { refreshLocked.current = false; setLoading(false) }
  }, [workspaceId])
  useEffect(() => {
    const controller = new AbortController(), number = ++requestNumber.current
    if (!demo) workspaceRequest(workspaceId, 'mentoring/activities', { signal: controller.signal })
      .then(result => { if (number === requestNumber.current && !controller.signal.aborted) { setData(result); setError('') } })
      .catch(failure => { if (number === requestNumber.current && !controller.signal.aborted) setError(message(failure)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [workspaceId, demo])
  function saved(record: Activity) {
    requestNumber.current++
    setData(previous => previous && { ...previous, records: [...previous.records.filter(v => v.id !== record.id), record].sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time)) })
    setNotice(editing ? '멘토링 기록을 수정했습니다.' : '멘토링 기록을 저장했습니다.')
    setExpanded(true); setEditing(null); close()
    requestAnimationFrame(() => section.current?.scrollIntoView({ block: 'nearest' }))
  }
  const shown = data?.records.slice(0, limit) || []
  return <section ref={section} className="mentoring-activities" aria-label="멘토링 기록">
    <div className="mentoring-activities-heading"><button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}><span>멘토링 기록</span><small>{data?.records.length || 0}건</small><span aria-hidden="true">{expanded ? '−' : '+'}</span></button>{!demo && <button className="button secondary" aria-label="멘토링 기록 새로고침" aria-busy={loading} disabled={loading} onClick={() => void load()}><RefreshCw size={16} aria-hidden="true" />{loading ? '확인 중…' : '새로고침'}</button>}</div>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    {expanded && <div className="mentoring-activity-list">
      {!shown.length && <p>{demo ? '실제 워크스페이스에서 기록을 추가할 수 있습니다.' : data ? '등록된 멘토링 기록이 없습니다.' : '기록을 불러오는 중입니다.'}</p>}
      {shown.map(record => <article key={record.id}>
        <div className="mentoring-activity-heading"><div><p>{record.date} · {record.time}–{record.endTime} · {record.mentorName}</p><h3>{record.title}</h3></div>{record.canEdit && <button className="button secondary" aria-label={`${record.title} 수정`} onClick={() => { setEditing(record); setNotice('') }}><Pencil size={15} />수정</button>}</div>
        <p>{record.courseTitle}{record.teamName && ` · ${record.teamName}`}{record.students.length > 0 && ` · ${record.students.map(v => v.name).join(', ')}`}</p>
        <p className="mentoring-activity-content">{record.content}</p>
      </article>)}
      {data && data.records.length > shown.length && <button className="button secondary" onClick={() => setLimit(limit + 10)}>기록 더 보기</button>}
    </div>}
    {(open || editing) && (data && !demo ? <ActivityForm key={editing?.id || 'new'} options={data} record={editing} workspaceId={workspaceId} close={() => { setEditing(null); close() }} saved={saved} /> : <ModalShell title="멘토링 기록" close={close}><p role={error ? 'alert' : 'status'}>{demo ? '실제 워크스페이스에서 기록을 추가할 수 있습니다.' : error || '입력 정보를 불러오는 중입니다.'}</p>{error && <button className="button secondary" onClick={() => void load()}>다시 불러오기</button>}</ModalShell>)}
  </section>
}

function ActivityForm({ options, record, workspaceId, close, saved }: { options: Options; record: Activity | null; workspaceId: string; close: () => void; saved: (record: Activity) => void }) {
  const [fields, setFields] = useState<Fields>(() => record ? { mentorId: record.mentorId, courseId: record.courseId, teamId: record.teamId, studentIds: record.studentIds, title: record.title, date: record.date, time: record.time, endTime: record.endTime, content: record.content } : { mentorId: options.mentors.length === 1 ? options.mentors[0].id : '', courseId: options.courses.length === 1 ? options.courses[0].id : '', teamId: '', studentIds: [], title: '', date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }), time: '', endTime: '', content: '' })
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const locked = useRef(false), requestId = useRef(crypto.randomUUID())
  const [uncertain, setUncertain] = useState(false)
  const submitted = useRef<Fields | null>(null)
  const team = options.teams.find(v => v.id === fields.teamId)
  const students = options.students.filter(v => v.courseId === fields.courseId && (!team || v.team === team.name))
  const canSave = record ? record.canEdit : options.canCreate
  function restoreFocus() { requestAnimationFrame(() => { if (opener?.isConnected) opener.focus({ preventScroll: true }) }) }
  function dismiss() { close(); restoreFocus() }
  function field<K extends keyof Fields>(key: K, value: Fields[K]) { setFields(previous => ({ ...previous, [key]: value })); setError('') }
  function selectTeam(teamId: string) {
    const selected = options.teams.find(v => v.id === teamId && v.courseId === fields.courseId)
    const studentIds = selected ? options.students.filter(v => v.courseId === fields.courseId && v.team === selected.name).map(v => v.id) : []
    setFields(previous => ({ ...previous, teamId, studentIds })); setError('')
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (locked.current || !canSave) return
    const values = uncertain && submitted.current ? submitted.current : fields
    if (!values.teamId && !values.studentIds.length) { setError('대상 팀 또는 참여 학생을 선택하세요.'); return }
    if (values.teamId && students.length > 0 && !values.studentIds.length) { setError('참여 학생을 1명 이상 선택하세요. 전원을 해제한 상태로는 저장할 수 없습니다.'); return }
    if (values.endTime <= values.time) { setError('종료 시간은 같은 날의 시작 시간 이후로 입력하세요.'); return }
    locked.current = true; setBusy(true); setError(''); submitted.current = values
    try {
      const body = record ? { ...values, revision: record.revision } : { ...values, id: requestId.current }
      const result = await workspaceRequest(workspaceId, `mentoring/activities${record ? '/' + encodeURIComponent(record.id) : ''}`, { method: record ? 'PATCH' : 'POST', body: JSON.stringify(body) })
      saved(result)
      restoreFocus()
    } catch (failure) {
      const status = (failure as { status?: number })?.status
      const unknown = !status || status >= 500
      setUncertain(unknown)
      setError(unknown ? '저장 결과를 확인하지 못했습니다. 같은 내용으로 다시 저장하거나, 닫고 목록을 새로고침해 확인하세요.' : message(failure))
    } finally { locked.current = false; setBusy(false) }
  }
  return <ModalShell title={record ? '멘토링 기록 수정' : '멘토링 기록'} close={dismiss} busy={busy} className="mentoring-activity-modal">
    <form className="modal-form" onSubmit={submit}>
      <p className="mentoring-activity-hint">진행한 멘토링 내용을 남겨 주세요. 시간은 한국시간 기준입니다.</p>
      <fieldset disabled={busy || uncertain || !canSave}>
        <label>멘토{options.admin ? <select required value={fields.mentorId} onChange={e => field('mentorId', e.target.value)}><option value="">멘토 선택</option>{options.mentors.map(v => <option key={v.id} value={v.id}>{v.name} ({v.username})</option>)}</select> : <input value={options.mentors[0]?.name || record?.mentorName || ''} readOnly />}</label>
        <label>제목<input data-modal-autofocus required maxLength={150} value={fields.title} onChange={e => field('title', e.target.value)} placeholder="예: 팀 프로젝트 서버 환경 설정" /></label>
        <div className="mentoring-activity-grid"><label>학습 과정<select required value={fields.courseId} onChange={e => { setFields(v => ({ ...v, courseId: e.target.value, teamId: '', studentIds: [] })); setError('') }}><option value="">과정 선택</option>{options.courses.map(v => <option key={v.id} value={v.id}>{v.title}</option>)}</select></label><label>대상 팀<select value={fields.teamId} onChange={e => selectTeam(e.target.value)}><option value="">팀 대신 학생 선택</option>{options.teams.filter(v => v.courseId === fields.courseId).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label></div>
        <details className="mentoring-activity-students"><summary>참여 학생 선택 · {fields.studentIds.length}명</summary><p>팀을 선택하면 소속 학생이 모두 선택됩니다. 참여하지 않은 학생은 체크를 해제하세요.</p><div>{students.map(v => <label key={v.id}><input type="checkbox" checked={fields.studentIds.includes(v.id)} onChange={e => field('studentIds', e.target.checked ? [...fields.studentIds, v.id] : fields.studentIds.filter(id => id !== v.id))} /><span>{v.name}{v.team && ` · ${v.team}`}</span></label>)}{!students.length && <p>{team ? '이 팀에 등록된 학생이 없습니다. 학생 명단 없이 팀 단위로만 기록됩니다.' : '선택 가능한 학생이 없습니다.'}</p>}</div></details>
        <label>진행일<input type="date" required value={fields.date} max={new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' })} onChange={e => field('date', e.target.value)} /></label>
        <div className="mentoring-activity-grid"><label>시작 시간<input type="time" required value={fields.time} onChange={e => field('time', e.target.value)} /></label><label>종료 시간<input type="time" required value={fields.endTime} onChange={e => field('endTime', e.target.value)} /></label></div>
        <label>진행 내용<textarea required rows={5} maxLength={4000} value={fields.content} onChange={e => field('content', e.target.value)} placeholder="요청받은 내용, 진행한 작업, 결과와 다음 할 일을 적어 주세요." /></label>
      </fieldset>
      {!canSave && <p role="alert">현재 기록을 등록하거나 수정할 수 없습니다. 워크스페이스 상태와 멘토 등록 여부를 확인하세요.</p>}
      {error && <p className="mentoring-activity-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="button secondary" onClick={dismiss} disabled={busy}>취소</button><button type="submit" className="button primary" disabled={busy || !canSave}>{busy ? '저장 중…' : uncertain ? '저장 다시 시도' : '저장'}</button></div>
    </form>
  </ModalShell>
}

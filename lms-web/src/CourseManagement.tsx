import { useEffect, useRef, useState } from 'react'
import { CalendarDays, Plus, Save, Trash2 } from 'lucide-react'
import { Badge, ModalShell } from './components'
import { workspaceRequest } from './api'
import CourseScheduleImport from './CourseScheduleImport'
import type { Course, CourseSession, Workspace } from './data'
import type { Change } from './Management'

type State = { course: Course; revision: string }
export default function CourseManagement({ course, data, close, refresh, change, assignments }: { course: Course; data: Workspace; close: () => void; refresh: () => Promise<void>; change: Change; assignments: () => void }) {
  const [saved, setSaved] = useState<State | null>(data.mode === 'api' ? null : { course, revision: '' })
  const [draft, setDraft] = useState(course), [tab, setTab] = useState('개요')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [conflict, setConflict] = useState(false), [discard, setDiscard] = useState(false)
  const [reload, setReload] = useState(0), [newSessionId, setNewSessionId] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)
  const showTop = () => bodyRef.current?.closest('dialog')?.scrollTo({ top: 0, behavior: 'smooth' })
  const path = `courses/${encodeURIComponent(course.id)}/manage`
  useEffect(() => {
    if (data.mode !== 'api') return
    const controller = new AbortController()
    workspaceRequest(data.workspaceId!, path, { signal: controller.signal }).then((result: State) => { setSaved(result); setDraft(result.course); setError(''); setConflict(false) }).catch((e: Error) => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [data.workspaceId, data.mode, path, reload])
  const dirty = saved && JSON.stringify(draft) !== JSON.stringify(saved.course)
  const rows = draft.schedule || [], weekInput = draft.weeks.match(/^(\d*)주/)?.[1] ?? '8', weeks = Number(weekInput)
  const patch = (id: string, value: Partial<CourseSession>) => setDraft(d => ({ ...d, schedule: (d.schedule || []).map(s => s.id === id ? { ...s, ...value } : s) }))
  function add(week = Math.min(weeks, (rows.at(-1)?.week || 0) + 1)) {
    const id = crypto.randomUUID(); setNewSessionId(id)
    setDraft(d => ({ ...d, schedule: [...(d.schedule || []), { id, week, title: `${week}주차 수업`, date: '', startTime: '', endTime: '', notes: '' }] }))
  }
  function generate() {
    const schedule = Array.from({ length: weeks }, (_, i) => {
      const day = new Date(`${draft.startDate}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + i * 7)
      const date = Number.isNaN(day.getTime()) ? '' : day.toISOString().slice(0, 10)
      return { id: crypto.randomUUID(), week: i + 1, title: `${i + 1}주차 수업`, date: date <= (draft.endDate || '') ? date : '', startTime: '', endTime: '', notes: '' }
    })
    setDraft(d => ({ ...d, schedule })); setNotice('시작일부터 7일 간격으로 채웠습니다. 수업 날짜를 확인한 뒤 저장하세요.')
  }
  async function save(changes: Partial<Course>) {
    if (busy || !saved) return
    setBusy(true); setError(''); setNotice(''); setConflict(false)
    try {
      let result: State
      if (data.mode === 'api') result = await workspaceRequest(data.workspaceId!, path, { method: 'PATCH', body: JSON.stringify({ revision: saved.revision, changes }) })
      else {
        const next = { ...saved.course, ...changes }
        if (!await change(d => ({ ...d, courses: d.courses.map(c => c.id === course.id ? next : c) }), '과정을 저장했습니다.')) return
        result = { course: next, revision: '' }
      }
      setSaved(result); setDraft(result.course); setNotice(changes.status ? '과정 운영 상태를 변경했습니다.' : '주차별 일정을 저장했습니다.')
      if (data.mode === 'api') await refresh()
    } catch (e) { setError((e as Error).message); setConflict((e as { status?: number }).status === 409); showTop() }
    finally { setBusy(false) }
  }
  function requestClose() { if (dirty) { setDiscard(true); showTop() } else close() }
  return <ModalShell title={course.title} close={requestClose} busy={busy} className="course-management-modal">
    <div className="course-management-body" ref={bodyRef}>
      {discard && <div className="inline-note" role="alert"><p>저장하지 않은 변경 사항을 취소하고 닫을까요?</p><div className="assignment-action-group"><button className="button secondary" onClick={() => setDiscard(false)}>계속 편집</button><button className="button primary" onClick={close}>변경 취소하고 닫기</button></div></div>}
      <div className="course-management-meta"><Badge>{saved?.course.status || course.status}</Badge><span>{course.mentor || '담당 멘토 미지정'} · {course.learners}명</span></div>
      <div className="tabs course-management-tabs" aria-label="과정 관리 탭">{['개요', '주차별 일정'].map(value => <button key={value} aria-pressed={tab === value} className={tab === value ? 'selected' : ''} onClick={() => setTab(value)}>{value}</button>)}</div>
      {error && <div className="inline-note error-note" role="alert"><p>{error}</p>{(conflict || !saved) && <button className="button secondary" disabled={busy} onClick={() => { setSaved(null); setReload(n => n + 1) }}>{conflict ? '입력 취소하고 최신 과정 불러오기' : '다시 불러오기'}</button>}</div>}
      {notice && <p className="inline-note" role="status">{notice}</p>}
      {!saved ? <p role="status">최신 과정 정보를 불러오는 중…</p> : <>
        {tab === '개요' ? <div className="course-overview">
          <p>{saved.course.description}</p>
          <dl className="course-summary"><div><dt>운영 기간</dt><dd>{saved.course.startDate || '미정'} ~ {saved.course.endDate || '미정'}</dd></div><div><dt>운영 주차</dt><dd>{saved.course.weeks}</dd></div><div><dt>수업 일정</dt><dd>{(saved.course.schedule || []).length}개 등록</dd></div></dl>
          <div className="course-status-actions"><button className="button primary" disabled={busy || !!dirty} onClick={() => void save({ status: saved.course.status === '진행 중' ? '종료' : '진행 중' })}>{saved.course.status === '진행 중' ? '과정 종료' : '운영 시작'}</button><button className="button secondary" onClick={() => setTab('주차별 일정')}><CalendarDays size={16} />일정 편집</button></div>
          {dirty && <p className="muted">편집 중인 일정을 저장하거나 취소한 뒤 운영 상태를 변경하세요.</p>}
          <h3>이 과정의 과제</h3>{data.assignments.filter(a => a.courseId === course.id || (!a.courseId && a.course === course.title)).map(a => <div className="detail-assignment" key={a.id}><span>{a.title}<small>{a.due} 마감</small></span><Badge tone={a.status === '마감' ? 'neutral' : 'green'}>{a.status}</Badge></div>)}
          <button className="text-button" disabled={!!dirty || busy} onClick={assignments}>과제 관리로 이동</button>
        </div> : <form className="modal-form course-schedule-form" onSubmit={e => { e.preventDefault(); void save({ startDate: draft.startDate, endDate: draft.endDate, weeks: `${weeks}주 과정`, schedule: rows }) }}>
          <fieldset disabled={busy || conflict}>
            <CourseScheduleImport course={draft} apply={changes => { setDraft(d => ({ ...d, ...changes })); setNotice('엑셀 일정을 편집에 반영했습니다. 날짜와 시간을 확인한 뒤 일정 저장을 눌러 주세요.') }} />
            <p className="muted">주차별 수업을 등록하세요. 같은 주차에 여러 수업을 추가할 수 있습니다. 시간은 한국시간 기준입니다.</p>
            <div className="course-period-fields"><label>과정 시작일<input type="date" required value={draft.startDate || ''} onChange={e => setDraft(d => ({ ...d, startDate: e.target.value }))} /></label><label>과정 종료일<input type="date" required min={draft.startDate} value={draft.endDate || ''} onChange={e => setDraft(d => ({ ...d, endDate: e.target.value }))} /></label><label>운영 주차<input type="number" min={1} max={52} required value={weekInput} onChange={e => setDraft(d => ({ ...d, weeks: `${e.target.value}주 과정` }))} /></label></div>
            <div className="course-schedule-heading"><h3>수업 일정 <span>{rows.length}개</span></h3>{!rows.length && <button type="button" className="button secondary compact" disabled={!draft.startDate || !draft.endDate || weeks < 1 || weeks > 52} onClick={generate}>주차 일정 자동 채우기</button>}</div>
            {!rows.length && <div className="course-schedule-empty"><CalendarDays size={24} /><p>등록된 일정이 없습니다.</p><small>주차별로 채우거나 수업을 하나씩 추가하세요.</small></div>}
            <div className="course-schedule-list">{rows.map((s, i) => <details className="course-session-editor" key={s.id} open={i === 0 || s.id === newSessionId}>
              <summary className="course-session-heading"><span><strong>{s.week === 0 ? 'OT' : `${s.week}주차`} · {s.title || '수업명 입력'}</strong><small>{s.date || '날짜 미정'}{s.startTime ? ` · ${s.startTime}–${s.endTime}` : ''}</small></span><button className="text-button" type="button" aria-label={`수업 ${i + 1} 삭제`} onClick={e => { e.preventDefault(); setDraft(d => ({ ...d, schedule: rows.filter(row => row.id !== s.id) })) }}><Trash2 size={15} />삭제</button></summary>
              <div className="course-session-title"><label>주차 (OT는 0)<input type="number" min={0} max={weeks} required value={s.week} onChange={e => patch(s.id, { week: Number(e.target.value) })} /></label><label>수업명<input required maxLength={120} value={s.title} onChange={e => patch(s.id, { title: e.target.value })} /></label></div>
              <div className="course-period-fields"><label>수업 날짜<input type="date" required min={draft.startDate} max={draft.endDate} value={s.date} onChange={e => patch(s.id, { date: e.target.value })} /></label><label>시작 시간<input type="time" required={!!s.endTime} value={s.startTime} onChange={e => patch(s.id, { startTime: e.target.value })} /></label><label>종료 시간<input type="time" required={!!s.startTime} min={s.startTime || undefined} value={s.endTime} onChange={e => patch(s.id, { endTime: e.target.value })} /></label></div>
              <label>메모 (선택)<textarea rows={2} maxLength={1000} placeholder="수업 내용, 준비물, 장소 등을 입력하세요" value={s.notes} onChange={e => patch(s.id, { notes: e.target.value })} /></label>
            </details>)}</div>
            <button type="button" className="button secondary" disabled={rows.length >= 104 || weeks < 1 || weeks > 52} onClick={() => add()}><Plus size={16} />수업 일정 추가</button>
            <div className="course-schedule-save"><span>{dirty ? '저장하지 않은 변경 사항이 있습니다.' : '저장된 일정입니다.'}</span><div className="assignment-action-group"><button type="button" className="button secondary" disabled={!dirty} onClick={() => { setDraft(saved.course); setError(''); setNotice('') }}>변경 취소</button><button className="button primary" disabled={!dirty}><Save size={16} />{busy ? '저장 중…' : '일정 저장'}</button></div></div>
          </fieldset>
        </form>}
      </>}
    </div>
  </ModalShell>
}

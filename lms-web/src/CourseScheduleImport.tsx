import { useRef, useState } from 'react'
import { ArrowDownToLine, Upload } from 'lucide-react'
import { parseCourseSchedule, scheduleYear, type ScheduleImport } from '../shared/course-schedule-import.mjs'
import type { Course } from './data'

export default function CourseScheduleImport({ course, apply }: { course: Course; apply: (changes: Partial<Course>) => void }) {
  const [sheet, setSheet] = useState<unknown[][] | null>(null), [plan, setPlan] = useState<ScheduleImport | null>(null)
  const [year, setYear] = useState(Number(course.startDate?.slice(0, 4)) || new Date().getFullYear()), [filename, setFilename] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  async function upload(file?: File) {
    if (!file || busy) return
    setBusy(true); setError(''); setPlan(null); setSheet(null); setFilename(file.name)
    try {
      if (!/\.xlsx$/i.test(file.name) || file.size > 2 * 1024 * 1024) throw new Error('2MB 이하의 .xlsx 파일을 선택하세요.')
      const { readSheet } = await import('read-excel-file/browser')
      const rows = await readSheet(file, '주차별 시간표')
      const detectedYear = scheduleYear(rows, year)
      setYear(detectedYear); setSheet(rows); setPlan(parseCourseSchedule(rows, detectedYear))
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  function changeYear(value: number) {
    setYear(value); setError(''); setPlan(null)
    if (sheet) try { setPlan(parseCourseSchedule(sheet, value)) } catch (e) { setError((e as Error).message) }
  }
  function confirm() {
    if (!plan || !plan.sessions.length || plan.entries.some(r => r.status === 'error')) return
    const schedule = plan.sessions.map(s => ({ ...s, id: course.schedule?.find(old => old.date === s.date && old.startTime === s.startTime && old.title === s.title)?.id || crypto.randomUUID() }))
    apply({ schedule, startDate: plan.startDate, endDate: plan.endDate, weeks: `${plan.weeks}주 과정` })
    setPlan(null); setSheet(null)
  }
  return <section className="schedule-import" aria-label="엑셀 일정 가져오기">
    <div className="course-schedule-heading"><div><h3>엑셀로 일정 가져오기</h3><p>‘주차별 시간표’ 시트의 날짜·시간대·세션명을 읽습니다. OT는 0주차로, 강사·세부 내용·산출물은 메모로 입력합니다.</p></div></div>
    <div className="assignment-action-group"><a className="button secondary" href={`${import.meta.env.BASE_URL}templates/course-schedule-template.xlsx`} download="과정-일정-샘플.xlsx"><ArrowDownToLine size={16} />일정 샘플 다운로드</a><button type="button" className="button secondary" disabled={busy} onClick={() => input.current?.click()}><Upload size={16} />{busy ? '파일 확인 중…' : '일정 엑셀 선택'}</button></div>
    <input ref={input} hidden type="file" accept=".xlsx" aria-label="일정 엑셀 파일" disabled={busy} onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }} />
    {busy && <p role="status">시간표를 확인하고 있습니다…</p>}
    {error && <p className="inline-note error-note" role="alert">{error}</p>}
    {sheet && <label className="schedule-import-year">연도 없는 날짜의 기준 연도<input type="number" min={2000} max={2099} value={year || ''} onChange={e => changeYear(Number(e.target.value))} /><small>파일 제목의 연도를 우선 인식합니다. 연도를 넘기는 일정은 날짜에 연도까지 입력하세요.</small></label>}
    {plan && <div className="schedule-import-preview">
      <h4>가져오기 미리보기 · {filename}</h4><p role="status">등록 가능 {plan.sessions.length}개 · 오류 {plan.entries.filter(r => r.status === 'error').length}개 · 제외 {plan.entries.filter(r => r.status === 'excluded').length}개</p>
      <div className="table-scroll"><table><thead><tr><th>엑셀 행</th><th>수업</th><th>날짜 · 시간 (한국시간)</th><th>확인 결과</th></tr></thead><tbody>{plan.entries.map(row => <tr key={row.row}><td>{row.row}</td><td>{row.session && <small>{row.session.week ? `${row.session.week}주차` : 'OT'}</small>}{row.title}</td><td>{row.session ? <>{row.session.date}<small>{row.session.startTime}–{row.session.endTime}</small></> : '—'}</td><td>{row.message || '등록 가능'}</td></tr>)}</tbody></table></div>
      <p className="inline-note">현재 편집 중인 일정 {(course.schedule || []).length}개를 위 일정으로 교체합니다. 운영 기간은 {plan.startDate || '—'} ~ {plan.endDate || '—'}, 운영 주차는 {plan.weeks}주로 맞춥니다. 편집에 반영한 뒤 ‘일정 저장’을 눌러야 최종 저장됩니다.</p>
      {plan.entries.some(r => r.status === 'error') && <p className="error-text">오류 행을 수정한 파일을 다시 선택하세요. 오류가 없을 때 전체 일정을 반영할 수 있습니다.</p>}
      <div className="assignment-action-group"><button type="button" className="button secondary" onClick={() => { setPlan(null); setSheet(null); setError('') }}>가져오기 취소</button><button type="button" className="button primary" disabled={!plan.sessions.length || plan.entries.some(r => r.status === 'error')} onClick={confirm}>확인 · 편집에 반영</button></div>
    </div>}
  </section>
}

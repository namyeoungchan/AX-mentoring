import { useEffect, useState } from 'react'
import { demoMode, workspaceRequest } from './api'
import { ModalShell } from './components'
import { rosterRows } from '../shared/student-roster.mjs'

type Row = { row: number; studentId: string; username: string; name: string; team: string; action?: string; result?: string; error?: string }
type Plan = { courseId: string; revision: string; rows: Row[]; failed: Row[]; excluded: Row[]; guildReady: boolean; teams: { name: string; count: number }[] }
type Result = { courseId: string; results: Row[]; excluded: number; teams: Plan['teams'] }
export default function StudentRosterImport({ workspaceId, mode, onSaved }: { workspaceId: string; mode: 'groups' | 'accounts'; onSaved?: () => void | Promise<void> }) {
  const [courses, setCourses] = useState<{ id: string; title: string }[]>([]), [courseId, setCourseId] = useState(''), [title, setTitle] = useState('천안형 인재육성사업')
  const [rows, setRows] = useState<unknown[]>([]), [plan, setPlan] = useState<Plan | null>(null), [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [filename, setFilename] = useState('')
  useEffect(() => {
    if (demoMode) return
    const controller = new AbortController()
    workspaceRequest(workspaceId, 'discord/groups', { signal: controller.signal }).then(data => { setCourses(data.courses); setCourseId(data.courseId) }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [workspaceId])
  async function upload(file?: File) {
    if (!file || busy) return
    setError(''); setBusy(true); setPlan(null); setResult(null); setFilename(file.name)
    try {
      if (!/\.xlsx$/i.test(file.name) || file.size > 2 * 1024 * 1024) throw new Error('2MB 이하의 .xlsx 파일을 선택하세요.')
      const { readSheet } = await import('read-excel-file/browser')
      const parsed = rosterRows(await readSheet(file, '명단'))
      setRows(parsed)
      const checked = await workspaceRequest(workspaceId, 'student-roster/preview', { method: 'POST', body: JSON.stringify({ rows: parsed, courseId, title }) })
      setPlan(checked)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function apply() {
    if (!plan || busy) return
    setBusy(true); setError('')
    try {
      const applied = await workspaceRequest(workspaceId, `student-roster/${mode}`, { method: 'POST', signal: AbortSignal.timeout(120000), body: JSON.stringify({ rows, courseId: plan.courseId, title, revision: plan.revision }) })
      setResult(applied); setPlan(null); setCourseId(applied.courseId)
      const groups = await workspaceRequest(workspaceId, 'discord/groups'); setCourses(groups.courses)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function finish() {
    setResult(null)
    try { await onSaved?.() } catch (e) { setError((e as Error).message) }
  }
  const failures = plan ? [...plan.failed, ...(mode === 'accounts' ? plan.rows.filter(r => r.action === 'conflict') : [])] : []
  const ready = plan?.rows.filter(r => mode === 'groups' || r.action === 'create') || []
  function table(data: Row[], status: (row: Row) => string) {
    return <div className="table-scroll roster-results"><table><thead><tr><th>엑셀 행</th><th>학생ID · 이름</th><th>팀</th><th>처리 결과</th></tr></thead><tbody>{data.map(row => <tr key={row.row}><td>{row.row}</td><td>{row.studentId}<small>{row.name}</small></td><td>{row.team || '—'}</td><td>{status(row)}</td></tr>)}</tbody></table></div>
  }
  return <section className="roster-import" aria-label="엑셀 수강생 명단 등록">
    <h3>{mode === 'groups' ? '엑셀 명단으로 조 준비' : '엑셀로 수강생 일괄 등록'}</h3>
    <p>참여자통합관리 양식의 ‘명단’ 시트를 사용합니다. 학생ID는 로그인 아이디가 되며 영문은 소문자로 저장됩니다. ‘제외’ 대상은 등록하지 않습니다.</p>
    <a className="button secondary" href={`${import.meta.env.BASE_URL}templates/student-roster-template.xlsx`} download="수강생-등록-양식.xlsx">엑셀 양식 다운로드</a>
    <fieldset disabled={busy || demoMode || !!plan || !!result}>
      <div className="form-row"><label>명단을 등록할 과정<select value={courseId} onChange={e => setCourseId(e.target.value)}><option value="">기본 과정 준비</option>{courses.map(c => <option value={c.id} key={c.id}>{c.title}</option>)}</select></label>{!courseId && <label>새 과정 이름<input value={title} onChange={e => setTitle(e.target.value)} maxLength={100} required /></label>}</div>
      <label>참여자 명단 엑셀<input type="file" accept=".xlsx" onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }} /></label>
    </fieldset>
    <p>{mode === 'groups' ? '명단의 팀 이름으로 조를 준비합니다. 서버 연결 후 조별 역할·대화·음성 채널이 생성됩니다. 계정은 학생 계정 발급에서 같은 파일로 등록하세요.' : '초기 비밀번호: bdaxuser1! · 첫 로그인 시 변경 필수 · 기존 계정과 배정은 유지됩니다.'}</p>
    {busy && <p role="status">{plan ? '계정을 순서대로 처리하고 있습니다. 결과가 나올 때까지 기다려 주세요.' : '명단을 확인하고 있습니다…'}</p>}
    {error && !plan && <p role="alert" className="error-text">{error}</p>}
    {plan && <ModalShell title="엑셀 등록 검증 결과" busy={busy} close={() => { if (!busy) { setPlan(null); setError('') } }}>
      <div className="modal-form"><p>{filename}</p><p role="status">등록 가능 {ready.length}명 · 기존 계정 {mode === 'accounts' ? plan.rows.filter(r => r.action === 'existing').length : 0}명 · 실패 {failures.length}명 · 제외 {plan.excluded.length}명</p>
        <p>아직 반영되지 않았습니다. 등록 가능한 행만 적용할까요?</p>
        <p>{plan.teams.map(t => `${t.name} ${t.count}명`).join(' · ')}</p>
        {table([...plan.rows, ...plan.failed, ...plan.excluded].sort((a,b) => a.row-b.row), row => row.error && (mode === 'accounts' || plan.failed.some(f => f.row === row.row)) ? `실패: ${row.error}` : plan.excluded.some(r => r.row === row.row) ? '제외: 엑셀 상태가 제외' : mode === 'accounts' && row.action === 'existing' ? '기존 계정 유지' : '등록 가능')}
        {mode === 'accounts' && !plan.guildReady && <p role="alert">Discord 빠른 설정에서 서버 연결을 먼저 완료하세요.</p>}
        {error && <p role="alert" className="error-text">{error}</p>}
        <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => { setPlan(null); setError('') }}>취소 · 적용하지 않기</button><button className="button primary" disabled={busy || !ready.length || mode === 'accounts' && !plan.guildReady} onClick={() => void apply()}>{busy ? '적용 중…' : mode === 'groups' ? `조 ${plan.teams.length}개 준비 적용` : `등록 가능 ${ready.length}명 적용`}</button></div>
      </div>
    </ModalShell>}
    {result && <ModalShell title="엑셀 등록 처리 결과" close={() => void finish()}><div className="modal-form">
      <p role="status">{mode === 'groups' ? `조 ${result.teams.length}개 준비 완료 · 실패 ${result.results.filter(r => r.result === 'failed').length}명` : `등록 성공 ${result.results.filter(r => r.result === 'created').length}명 · 기존 계정 ${result.results.filter(r => r.result === 'existing').length}명 · 실패 ${result.results.filter(r => r.result === 'failed').length}명`} · 제외 {result.excluded}명</p>
      {mode === 'accounts' && <p>새 계정의 초기 비밀번호는 bdaxuser1! 입니다. 실패한 행은 원인을 수정해 다시 등록하세요. 처리된 계정은 중복 생성하지 않습니다.</p>}
      {table(result.results, row => row.result === 'prepared' ? '조 준비 완료' : row.result === 'created' ? '등록 성공' : row.result === 'existing' ? '기존 계정 유지' : `등록 실패: ${row.error}`)}
      <button className="button primary" onClick={() => void finish()}>결과 확인</button>
    </div></ModalShell>}
  </section>
}

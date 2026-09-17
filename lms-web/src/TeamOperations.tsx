import { useEffect, useState } from 'react'
import { workspaceRequest } from './api'
import { CardHeading, ModalShell } from './components'
type Learner = { id: string; name: string; courseId: string; team: string; status: string; syncState: string; syncError: string }
type State = { revision: string; learners: Learner[]; teams: { id: string; name: string; courseId: string }[]; courses: { id: string; title: string }[]; history: { id: string; time: string; text: string; studentId: string; before: string; after: string }[] }
const causes: Record<string, string> = { permissions: '봇의 역할·채널 관리 권한을 확인하세요.', role_hierarchy: '봇 역할을 관리 대상 역할보다 위로 옮기세요.', member_missing: 'Discord 서버 참여 여부를 확인하세요.', conflict: '역할이 변경되어 다시 동기화합니다.', discord_error: 'Discord 연결을 확인하고 재시도하세요.', api_error: 'Web과 봇 연결을 확인하세요.', team_limit: '연결 팀 수를 50개 이하로 조정하세요.' }
export default function TeamOperations({ workspaceId, refresh, revision }: { workspaceId: string; revision?: string; refresh?: () => Promise<void> }) {
  const [data, setData] = useState<State | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string[]>([]), [teamId, setTeamId] = useState(''), [courseId, setCourseId] = useState(''), [filter, setFilter] = useState('전체'), [preview, setPreview] = useState(false)
  const [reload, setReload] = useState(0), [message, setMessage] = useState('')
  useEffect(() => { const c = new AbortController(); workspaceRequest(workspaceId, 'team-operations', { signal: c.signal }).then(setData).catch((e: Error) => { if (!c.signal.aborted) setError(e.message) }); return () => c.abort() }, [workspaceId, reload, revision])
  const team = data?.teams.find(t => t.id === teamId)
  const rows = data?.learners.filter(l => (!courseId || l.courseId === courseId) && (filter === '전체' || filter === '미배정' && !l.team || filter === '배정 완료' && !!l.team || filter === l.syncState)) || []
  async function submit(retry = false) {
    if (!data || busy) return
    setBusy(true); setError(''); setMessage('')
    try {
      setData(await workspaceRequest(workspaceId, 'team-operations' + (retry ? '/retry' : ''), { method: 'POST', body: JSON.stringify(retry ? { learnerIds: selected } : { learnerIds: selected, teamId, revision: data.revision }) }))
      setSelected([]); setPreview(false); setMessage(retry ? '선택한 실패 구성원의 재동기화를 요청했습니다.' : '팀 배정을 저장했습니다. Discord 반영 상태를 확인하세요.'); await refresh?.()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  function exportHistory() {
    if (!data) return
    const csv = '\uFEFF' + [['일시', '수강생 ID', '이전 팀', '신규 팀', '작업'], ...data.history.map(h => [h.time, h.studentId, h.before, h.after, h.text])].map(row => row.map(v => '"' + String(v || '').replace(/^[\s]*[=+@-]/, "'$&").replaceAll('"', '""') + '"').join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })), a = document.createElement('a'); a.href = url; a.download = '팀-변경-이력.csv'; a.click(); URL.revokeObjectURL(url)
  }
  return <section className="panel team-operations"><CardHeading title="수강생 팀 일괄 배정" subtitle="최대 100명 · Web 배정과 Discord 적용 상태를 따로 확인합니다." />
    {error && <p role="alert" className="inline-note error-note">{error}</p>}{message && <p role="status" className="inline-note">{message}</p>}
    {data && <><fieldset disabled={busy} className="team-controls"><label>배정 과정<select value={courseId} onChange={e => { setCourseId(e.target.value); setSelected([]); setTeamId('') }}><option value="">전체 과정</option>{data.courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label><label>팀 배정 상태<select value={filter} onChange={e => { setFilter(e.target.value); setSelected([]) }}>{['전체', '미배정', '배정 완료', 'Discord 미인증', '동기화 실패', '적용 대기', '자기소개 대기', '적용 완료', '연동 미설정'].map(v => <option key={v}>{v}</option>)}</select></label><label>배정할 팀<select value={teamId} onChange={e => setTeamId(e.target.value)}><option value="">팀 선택</option>{data.teams.filter(t => !courseId || t.courseId === courseId).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><button className="button primary" disabled={!team || !selected.length} onClick={() => setPreview(true)}>배정 미리보기</button><button className="button secondary" disabled={!selected.length || selected.some(id => data.learners.find(l => l.id === id)?.syncState !== '동기화 실패')} onClick={() => void submit(true)}>실패 구성원 재시도</button><button className="button secondary" onClick={() => { setSelected([]); setError(''); setReload(n => n + 1) }}>팀 상태 새로고침</button><button className="button secondary" onClick={exportHistory}>팀 변경 이력 CSV</button></fieldset>
      <p className="inline-note">미배정 {data.learners.filter(l => !l.team).length}명 · 미인증 {data.learners.filter(l => l.syncState === 'Discord 미인증').length}명 · 실패 {data.learners.filter(l => l.syncState === '동기화 실패').length}명 · 선택 {selected.length}명</p>
      <div className="table-scroll"><table><thead><tr><th>선택</th><th>이름</th><th>Web 팀</th><th>Discord 적용</th><th>확인 사항</th></tr></thead><tbody>{rows.map(l => <tr key={l.id}><td><input type="checkbox" aria-label={`${l.name} 배정 선택`} disabled={busy || l.status !== '정상' || !selected.includes(l.id) && selected.length >= 100} checked={selected.includes(l.id)} onChange={e => setSelected(s => e.target.checked ? [...s, l.id] : s.filter(id => id !== l.id))} /></td><td>{l.name}</td><td>{l.team || '미배정'}</td><td>{l.syncState}</td><td>{causes[l.syncError] || '—'}</td></tr>)}</tbody></table></div>
      {preview && <ModalShell title="팀 배정 미리보기" close={() => { if (!busy) setPreview(false) }}><p>{selected.length}명을 {team?.name}으로 이동합니다. 현재 팀원 {data.learners.filter(l => l.courseId === team?.courseId && l.team === team?.name).length}명입니다. 팀 정원은 운영자가 확인하세요.</p><ul>{selected.map(id => { const l = data.learners.find(l => l.id === id); return <li key={id}>{l?.name}: {l?.team || '미배정'} → {team?.name}</li> })}</ul><button disabled={busy} className="button primary" onClick={() => void submit()}>팀 배정 저장</button></ModalShell>}
    </>}
  </section>
}

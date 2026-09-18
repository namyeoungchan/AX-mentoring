import DiscordJoinGuide from './DiscordJoinGuide'
import type { WorkspaceMetadata } from './demoWorkspaces'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { apiRequest, workspaceRequest, demoMode } from './api'
import { Check, Search, Users, X } from 'lucide-react'
import { Badge, CardHeading, ModalShell } from './components'

type Application = { teamId: string; id: string; workspaceId: string; workspaceName: string; name: string; username: string; state: string; inviteState: string; inviteUrl: string | null; inviteExpires: number | null; reason: string }
const states: Record<string, string> = { pending: '승인 대기', approved: '승인 완료', rejected: '반려', joined: '참여 완료' }

type ReviewProps = { workspaceId: string; pendingOnly?: boolean; onReviewed?: () => Promise<void> }
type ReviewState = { applications: Application[]; guildIds: string[]; teams: { id: string; name: string; courseTitle: string }[] }
const canReview = (a: Application) => a.state === 'pending' || (['approved', 'joined'].includes(a.state) && !a.teamId)

export function AdmissionsReview(props: ReviewProps) {
  return <AdmissionsReviewContent key={props.workspaceId} {...props} />
}
function AdmissionsReviewContent({ workspaceId, pendingOnly = false, onReviewed }: ReviewProps) {
  const [state, setState] = useState<ReviewState>({ applications: [], guildIds: [], teams: [] })
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set()), [teamId, setTeamId] = useState(''), [guildId, setGuildId] = useState('')
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [notice, setNotice] = useState('')
  const [failures, setFailures] = useState<{ id: string; error: string }[]>([]), [editing, setEditing] = useState<Application | null>(null)
  const allCheckbox = useRef<HTMLInputElement>(null), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (demoMode) { setLoading(false); return }
    try {
      const next: ReviewState = await workspaceRequest(workspaceId, 'admissions', { signal })
      if (signal?.aborted || !mounted.current) return
      setState(next); setError('')
      setGuildId(current => next.guildIds.includes(current) ? current : next.guildIds[0] || '')
      setTeamId(current => next.teams.some(t => t.id === current) ? current : '')
      setSelected(current => new Set([...current].filter(id => next.applications.some(a => a.id === id && canReview(a)))))
    } catch (e) { if (!signal?.aborted && mounted.current) setError((e as Error).message) }
    finally { if (!signal?.aborted && mounted.current) setLoading(false) }
  }, [workspaceId])
  // eslint-disable-next-line react/set-state-in-effect -- Load workspace applications.
  useEffect(() => { const c = new AbortController(); void refresh(c.signal); return () => c.abort() }, [refresh])
  const applications = state.applications.filter(a => (!pendingOnly || canReview(a)) && (filter === 'all' || (filter === 'repair' ? a.state !== 'pending' && canReview(a) : a.state === filter)) && `${a.name} ${a.username}`.toLowerCase().includes(query.trim().toLowerCase()))
  const selectable = applications.filter(canReview), visibleSelected = selectable.filter(a => selected.has(a.id)).length
  const allChecked = selectable.length > 0 && visibleSelected === selectable.length
  useEffect(() => { if (allCheckbox.current) allCheckbox.current.indeterminate = visibleSelected > 0 && !allChecked }, [visibleSelected, allChecked])
  function toggle(id: string) { setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else if (next.size < 100) next.add(id); return next }) }
  function selectVisible() { setSelected(current => { const next = new Set(current); for (const a of selectable) { if (allChecked) next.delete(a.id); else if (next.size < 100) next.add(a.id) } return next }) }
  async function bulkApprove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !selected.size || !teamId || !guildId) return
    setBusy(true); setError(''); setNotice(''); setFailures([])
    try {
      const result: { succeeded: string[]; failed: { id: string; error: string }[] } = await workspaceRequest(workspaceId, 'admissions/bulk-review', { method: 'POST', body: JSON.stringify({ applicationIds: [...selected], guildId, teamId }) })
      if (!mounted.current) return
      setSelected(new Set(result.failed.map(f => f.id))); setFailures(result.failed)
      setNotice(`${result.succeeded.length}명 승인·조 배정 완료${result.failed.length ? ` · ${result.failed.length}명 처리하지 못함` : ''}`)
      await refresh(); if (result.succeeded.length) await onReviewed?.()
    } catch (e) { if (mounted.current) { await refresh(); setError((e as Error).message) } }
    finally { if (mounted.current) setBusy(false) }
  }
  async function review(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault(); if (busy) return
    const form = new FormData(event.currentTarget), button = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement
    setBusy(true); setError(''); setNotice(''); setFailures([])
    try {
      await workspaceRequest(workspaceId, `admissions/${id}/review`, { method: 'POST', body: JSON.stringify({ action: button.value, guildId: form.get('guildId') || '', reason: form.get('reason') || '', teamId: form.get('teamId') || '' }) })
      if (!mounted.current) return
      setEditing(null); setNotice(button.value === 'reject' ? '신청을 반려했습니다.' : '승인·조 배정을 저장했습니다.'); await refresh(); await onReviewed?.()
    } catch (e) { if (mounted.current) setError((e as Error).message) } finally { if (mounted.current) setBusy(false) }
  }
  const chosenTeam = state.teams.find(t => t.id === teamId), selectedPeople = state.applications.filter(a => selected.has(a.id))
  return <section className="admission-review" aria-label="수강생 가입 승인" aria-busy={busy || loading}>
    <div className="admission-review-heading"><div><h2>가입 승인 · 조 배정</h2><p>신청자를 선택하고 같은 조로 묶어 승인하세요. 승인 후 Discord 초대 링크가 발급됩니다.</p></div><button className="button secondary" disabled={busy || loading} onClick={() => void refresh()}>신청 새로고침</button></div>
    <div className="admission-summary"><span>승인 대기 <strong>{state.applications.filter(a => a.state === 'pending').length}</strong></span><span>조 배정 필요 <strong>{state.applications.filter(a => a.state !== 'pending' && canReview(a)).length}</strong></span><span>선택 인원 <strong>{selected.size}</strong></span></div>
    {notice && <p className="admission-result" role="status"><Check size={17} />{notice}</p>}
    {error && !editing && <p className="inline-note error-note" role="alert">{error}</p>}
    {failures.length > 0 && <div className="inline-note error-note" role="alert"><div><strong>처리하지 못한 신청</strong><ul>{failures.map(f => <li key={f.id}>{state.applications.find(a => a.id === f.id)?.name || '신청자'} · {f.error}</li>)}</ul></div></div>}
    {!loading && !state.guildIds.length && <p className="inline-note">Discord 서버를 먼저 연결해 주세요.</p>}
    {!loading && !state.teams.length && <p className="inline-note">배정할 조가 없습니다. Discord 구축 설정에서 조를 구성하거나 담당 조를 확인해 주세요.</p>}
    <form className={`admission-bulk panel${selected.size ? ' has-selection' : ''}`} onSubmit={e => void bulkApprove(e)}>
      <fieldset disabled={busy || loading || demoMode}>
        <div className="admission-bulk-title"><Users size={19} /><strong>{selected.size ? `${selected.size}명 선택됨` : '승인할 인원을 선택하세요'}</strong>{selected.size > 0 && <button type="button" className="text-button" onClick={() => setSelected(new Set())}><X size={14} />선택 해제</button>}</div>
        {selectedPeople.length > 0 && <div className="admission-selected" aria-label="선택한 신청자">{selectedPeople.slice(0, 8).map(a => <span key={a.id}>{a.name}</span>)}{selectedPeople.length > 8 && <span>외 {selectedPeople.length - 8}명</span>}</div>}
        <div className="admission-bulk-fields"><label>일괄 배정할 조<select required value={teamId} onChange={e => setTeamId(e.target.value)}><option value="">조를 선택하세요</option>{state.teams.map(t => <option key={t.id} value={t.id}>{t.courseTitle} · {t.name}</option>)}</select></label><label>초대할 서버<select aria-label="일괄 초대할 Discord 서버" required value={guildId} onChange={e => setGuildId(e.target.value)}><option value="" disabled>서버 선택</option>{state.guildIds.map(id => <option key={id}>{id}</option>)}</select></label><button className="button primary" type="submit" disabled={!selected.size || !teamId || !guildId}>{busy ? '처리 중…' : `선택 ${selected.size}명 승인 · 조 배정`}</button></div>
        <p className="admission-bulk-hint">{selected.size && chosenTeam ? `${selected.size}명을 ${chosenTeam.courseTitle} · ${chosenTeam.name}에 배정합니다.` : '한 번에 최대 100명까지 선택할 수 있습니다. 조별로 나누어 승인하세요.'}</p>
      </fieldset>
    </form>
    <div className="panel admission-list">
      <div className="admission-list-tools"><label className="admission-search"><Search size={17} /><input aria-label="가입 신청자 검색" placeholder="이름 또는 아이디 검색" value={query} disabled={busy} onChange={e => setQuery(e.target.value)} /></label><label>상태<select aria-label="가입 신청 상태" disabled={busy} value={filter} onChange={e => setFilter(e.target.value)}><option value="all">{pendingOnly ? '처리할 신청 전체' : '전체 신청'}</option><option value="pending">승인 대기</option><option value="repair">조 배정 필요</option>{!pendingOnly && <><option value="approved">승인 완료</option><option value="joined">참여 완료</option><option value="rejected">반려</option></>}</select></label></div>
      <div className="admission-select-all"><label><input ref={allCheckbox} type="checkbox" aria-label="현재 목록 전체 선택" checked={allChecked} disabled={busy || demoMode || !selectable.length} onChange={selectVisible} />현재 목록 전체 선택</label><span>{applications.length}명 표시{selected.size > visibleSelected ? ` · 목록 밖 ${selected.size - visibleSelected}명 선택됨` : ''}</span></div>
      {applications.map(a => <article key={a.id} className={`admission-review-row${selected.has(a.id) ? ' selected' : ''}`}>
        <input type="checkbox" aria-label={`${a.name} (${a.username}) 선택`} checked={selected.has(a.id)} disabled={busy || demoMode || !canReview(a) || (!selected.has(a.id) && selected.size >= 100)} onChange={() => toggle(a.id)} />
        <div className="admission-person"><h3>{a.name}</h3><span>{a.username}</span></div>
        <div className="admission-row-state"><Badge tone={a.state === 'pending' || canReview(a) ? 'orange' : a.state === 'rejected' ? 'neutral' : 'green'}>{a.state !== 'pending' && canReview(a) ? '조 배정 필요' : states[a.state]}</Badge><small>{state.teams.find(t => t.id === a.teamId)?.name || (canReview(a) ? '조 미배정' : '')}</small></div>
        {canReview(a) ? <button className="button secondary compact" disabled={busy || demoMode} onClick={() => { setEditing(a); setError('') }} aria-label={`${a.name} 개별 처리`}>개별 처리</button> : <span className="admission-row-note">{a.state === 'approved' ? a.inviteState === 'ready' ? '초대 발급 완료' : a.inviteState === 'failed' ? '초대 발급 실패' : '초대 발급 대기' : a.reason || '처리 완료'}</span>}
      </article>)}
      {!applications.length && <div className="admission-list-empty">{loading ? '신청 목록을 불러오는 중…' : query || filter !== 'all' ? '조건에 맞는 신청이 없습니다.' : '가입 신청이 없습니다.'}</div>}
    </div>
    {editing && <ModalShell title={`${editing.name} · 개별 처리`} close={() => { if (!busy) { setEditing(null); setError('') } }} busy={busy}><form className="modal-form" onSubmit={e => void review(e, editing.id)}><fieldset disabled={busy || demoMode}><p>{editing.username} · {states[editing.state]}</p>{error && <p className="inline-note error-note" role="alert">{error}</p>}<label>초대할 Discord 서버<select name="guildId" defaultValue={guildId}>{state.guildIds.map(id => <option key={id}>{id}</option>)}</select></label><label>배정 팀 (필수)<select name="teamId" required defaultValue=""><option value="" disabled>팀을 선택하세요</option>{state.teams.map(t => <option key={t.id} value={t.id}>{t.courseTitle} · {t.name}</option>)}</select></label><label>처리 사유<input name="reason" maxLength={300} placeholder="선택 입력" /></label><div className="modal-actions">{editing.state === 'pending' && <button type="submit" value="reject" formNoValidate className="button secondary">반려</button>}<button type="submit" value="approve" className="button primary" disabled={!state.guildIds.length || !state.teams.length}>{editing.state === 'pending' ? '가입 승인' : '팀 배정 저장'}</button></div></fieldset></form></ModalShell>}
  </section>
}

export function AdmissionStatus({ refreshWorkspace, workspace }: { refreshWorkspace: () => Promise<void>; workspace?: WorkspaceMetadata }) {
  const [applications, setApplications] = useState<Application[]>([])
  const [catalogue, setCatalogue] = useState<{ id: string; name: string }[]>([])
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const fetching = useRef<{ signal?: AbortSignal } | null>(null)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (fetching.current && !fetching.current.signal?.aborted) return
    const pending = { signal }
    fetching.current = pending
    try { const result = await apiRequest('me/admissions', { signal }); if (!signal?.aborted) { setApplications(result.applications); setLoaded(true); setError('') } } catch (e) { if (!signal?.aborted) setError((e as Error).message) } finally { if (fetching.current === pending) fetching.current = null }
  }, [])
  useEffect(() => {
    const c = new AbortController()
    // eslint-disable-next-line react/set-state-in-effect -- Poll approval and bot delivery status.
    void refresh(c.signal)
    apiRequest('auth/config', { signal: c.signal }).then(result => setCatalogue(result.studentRegistrationEnabled ? result.workspaces || [] : [])).catch(() => {})
    const timer = setInterval(() => { if (!document.hidden) void refresh(c.signal) }, 15000)
    return () => { c.abort(); clearInterval(timer) }
  }, [refresh])
  async function action(path: string, body = {}) {
    if (busy) return; setBusy(true); setError('')
    try { await apiRequest(path, { method: 'POST', body: JSON.stringify(body) }); await refresh() }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const visible = workspace ? applications.filter(a => a.workspaceId === workspace.id) : applications
  return <section className="admissions-status"><div className="operations-toolbar"><h2>워크스페이스 참여 현황</h2><button className="button secondary" disabled={busy} onClick={() => void refresh()}>참여 상태 확인</button></div>{error && <p className="inline-note error-note" role="alert">{error}</p>}
    {!loaded && !error && <p role="status">Discord 참여 정보를 불러오는 중…</p>}
    {visible.map(a => <section className="panel admission-card" key={a.id}><CardHeading title={a.workspaceName}><Badge>{states[a.state]}</Badge></CardHeading>
      {a.state === 'pending' && <p className="admission-detail">관리자 또는 강사가 신청을 확인하고 있습니다. 승인되면 이 화면에서 Discord 초대 링크를 확인할 수 있습니다.</p>}
      {a.state === 'rejected' && <p className="admission-detail">{a.reason || '가입 신청이 반려됐습니다. 운영자에게 문의하세요.'}</p>}
      {a.state === 'approved' && <DiscordJoinGuide workspaceName={a.workspaceName} verificationPath={`me/admissions/${a.id}/verification`} inviteUrl={a.inviteUrl} inviteState={a.inviteState} inviteExpires={a.inviteExpires} renewPath={`me/admissions/${a.id}/renew`} archived={workspace?.archivedAt != null} refreshInvitation={refresh} refreshWorkspace={refreshWorkspace} />}
      {a.state === 'joined' && <div className="admission-detail"><p>Discord 계정 인증이 완료되었습니다. 학습 화면에서 내 과정과 출결을 확인하세요.</p><button className="button primary" onClick={() => void refreshWorkspace()}>학습 화면 새로고침</button></div>}
    </section>)}
    {loaded && workspace && !workspace.discordVerified && !visible.length && <section className="panel"><DiscordJoinGuide workspaceName={workspace.name} verificationPath={`workspaces/${encodeURIComponent(workspace.id)}/me/verification`} archived={workspace.archivedAt != null} refreshInvitation={refresh} refreshWorkspace={refreshWorkspace} /></section>}
    {catalogue.length > 0 && <form className="admission-apply" onSubmit={e => { e.preventDefault(); const form = new FormData(e.currentTarget); void action('me/admissions', { workspaceId: form.get('workspaceId') }) }}><label>다른 워크스페이스 신청<select name="workspaceId" required defaultValue=""><option value="" disabled>워크스페이스 선택</option>{catalogue.filter(w => !applications.some(a => a.workspaceId === w.id)).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label><button className="button secondary" disabled={busy}>가입 신청</button></form>}
  </section>
}

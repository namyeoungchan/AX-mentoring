import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { apiRequest, workspaceRequest, demoMode } from './api'
import { Badge, CardHeading } from './components'

type Application = { teamId: string; id: string; workspaceId: string; workspaceName: string; name: string; username: string; state: string; inviteState: string; inviteUrl: string | null; inviteExpires: number | null; reason: string }
const states: Record<string, string> = { pending: '승인 대기', approved: '승인 완료', rejected: '반려', joined: '참여 완료' }

function DiscordInvitation({ application, busy, renew, step = false }: { application: Application; busy: boolean; renew: () => void; step?: boolean }) {
  if (application.inviteUrl) return <a className="button primary" href={application.inviteUrl} target="_blank" rel="noreferrer">{step ? '1 · Discord 서버 참여' : 'Discord 서버 참여'}</a>
  if (['queued', 'running'].includes(application.inviteState)) return <p role="status" aria-label="서버 초대 상태">서버 초대 링크를 발급하고 있습니다. 준비되면 여기에 참여 버튼이 표시됩니다.</p>
  return <><p>초대 링크가 만료됐거나 발급하지 못했습니다.</p><button className="button secondary" disabled={busy} onClick={renew}>초대 링크 재발급</button></>
}
export function AdmissionsReview({ workspaceId, pendingOnly = false, onReviewed }: { workspaceId: string; pendingOnly?: boolean; onReviewed?: () => Promise<void> }) {
  const [state, setState] = useState<{ applications: Application[]; guildIds: string[]; teams: { id: string; name: string; courseTitle: string }[] }>({ applications: [], guildIds: [], teams: [] })
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (demoMode) return
    try { setState(await workspaceRequest(workspaceId, 'admissions', { signal })); setError('') } catch (e) { if (!signal?.aborted) setError((e as Error).message) }
  }, [workspaceId])
  // eslint-disable-next-line react/set-state-in-effect -- Load pending applications.
  useEffect(() => { const c = new AbortController(); void refresh(c.signal); return () => c.abort() }, [refresh])
  async function review(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault(); if (busy) return
    const form = new FormData(event.currentTarget), button = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement
    setBusy(true)
    try { await workspaceRequest(workspaceId, `admissions/${id}/review`, { method: 'POST', body: JSON.stringify({ action: button.value, guildId: form.get('guildId') || '', reason: form.get('reason') || '', teamId: form.get('teamId') || '' }) }); await refresh(); await onReviewed?.() }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const applications = state.applications.filter(a => !pendingOnly || a.state === 'pending' || (['approved', 'joined'].includes(a.state) && !a.teamId))
  return <><div className="operations-toolbar"><p>수강생의 팀을 지정해 승인하면 시작하기 채널의 Discord 초대 링크를 발급합니다.</p><button className="button secondary" onClick={() => void refresh()}>신청 새로고침</button></div>{error && <p className="inline-note error-note" role="alert">{error}</p>}{!state.guildIds.length && <p className="inline-note">관리자가 Discord 채널 설정에서 서버를 연결하면 승인할 수 있습니다.</p>}
    {!state.teams.length && <p className="inline-note">승인할 팀이 없습니다. Discord 구축 설정에서 조를 먼저 구성해 주세요.</p>}{!applications.length && <section className="panel student-empty"><h2>가입 신청이 없습니다.</h2></section>}
    {applications.map(a => <section key={a.id} className="panel admission-card"><CardHeading title={`${a.name} · ${a.username}`}><Badge>{states[a.state]}</Badge></CardHeading>{(a.state === 'pending' || (['approved', 'joined'].includes(a.state) && !a.teamId)) ? <form className="modal-form" onSubmit={e => void review(e, a.id)}><fieldset disabled={busy || demoMode}><div className="form-row"><label>초대할 Discord 서버<select name="guildId">{state.guildIds.map(id => <option key={id}>{id}</option>)}</select></label><label>배정 팀 (필수)<select name="teamId" required defaultValue=""><option value="" disabled>팀을 선택하세요</option>{state.teams.map(t => <option key={t.id} value={t.id}>{t.courseTitle} · {t.name}</option>)}</select></label><label>처리 사유<input name="reason" maxLength={300} placeholder="선택 입력" /></label></div><div className="flex gap-2"><button type="submit" value="approve" className="button primary" disabled={!state.guildIds.length || !state.teams.length}>{a.state !== 'pending' ? '팀 배정 저장' : '가입 승인'}</button>{a.state === 'pending' && <button type="submit" value="reject" formNoValidate className="button secondary">반려</button>}</div></fieldset></form> : <p className="admission-detail">{state.teams.find(t => t.id === a.teamId)?.name && `배정 팀: ${state.teams.find(t => t.id === a.teamId)?.name} · `}{a.reason}{a.state === 'approved' && (a.inviteState === 'ready' ? ' · Discord 초대 발급 완료' : a.inviteState === 'failed' ? ' · 초대 발급 실패: 봇의 초대 생성 권한을 확인하세요.' : ' · 봇 초대 발급 대기')}</p>}</section>)}
  </>
}

export function AdmissionStatus({ refreshWorkspace }: { refreshWorkspace: () => Promise<void> }) {
  const [applications, setApplications] = useState<Application[]>([])
  const [catalogue, setCatalogue] = useState<{ id: string; name: string }[]>([])
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [challenge, setChallenge] = useState<{ code: string; expiresAt: number; applicationId: string } | null>(null)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try { const result = await apiRequest('me/admissions', { signal }); setApplications(result.applications); setError('') } catch (e) { if (!signal?.aborted) setError((e as Error).message) }
  }, [])
  useEffect(() => {
    const c = new AbortController()
    // eslint-disable-next-line react/set-state-in-effect -- Poll approval and bot delivery status.
    void refresh(c.signal)
    apiRequest('auth/config', { signal: c.signal }).then(result => setCatalogue(result.workspaces || [])).catch(() => {})
    const timer = setInterval(() => { if (!document.hidden) void refresh(c.signal) }, 15000)
    return () => { c.abort(); clearInterval(timer) }
  }, [refresh])
  async function action(path: string, body = {}, applicationId?: string) {
    if (busy) return; setBusy(true); setError('')
    try { const result = await apiRequest(path, { method: 'POST', body: JSON.stringify(body) }); if (result.code && applicationId) setChallenge({ ...result, applicationId }); await refresh() }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const challengeApplication = applications.find(a => a.id === challenge?.applicationId && a.state === 'approved')
  return <section className="admissions-status"><div className="operations-toolbar"><h2>가입 신청 현황</h2><button className="button secondary" onClick={() => void refresh()}>승인 상태 확인</button></div>{error && <p className="inline-note error-note" role="alert">{error}</p>}
    {applications.map(a => <section className="panel admission-card" key={a.id}><CardHeading title={a.workspaceName}><Badge>{states[a.state]}</Badge></CardHeading>{a.state === 'pending' && <p className="admission-detail">관리자 또는 강사가 신청을 확인하고 있습니다. 승인되면 이 화면에서 Discord 초대 링크를 확인할 수 있습니다.</p>}{a.state === 'rejected' && <p className="admission-detail">{a.reason || '가입 신청이 반려됐습니다. 운영자에게 문의하세요.'}</p>}{a.state === 'approved' && <div className="admission-detail"><DiscordInvitation application={a} busy={busy} renew={() => void action(`me/admissions/${a.id}/renew`)} /><p>서버 참여 후 본인 계정을 인증하세요.</p><button className="button secondary" disabled={busy} onClick={() => void action(`me/admissions/${a.id}/verification`, {}, a.id)}>Discord 인증 코드 받기</button></div>}{a.state === 'joined' && <div className="admission-detail"><button className="button secondary" onClick={() => void refreshWorkspace()}>학습 화면 새로고침</button></div>}</section>)}
    {challenge && challengeApplication && <section className="panel admission-detail" aria-label="Discord 계정 인증">
      <h3>Discord 계정 인증</h3><p>{challengeApplication.workspaceName} 서버에 참여한 뒤 인증을 진행하세요.</p>
      <DiscordInvitation application={challengeApplication} busy={busy} step renew={() => void action(`me/admissions/${challengeApplication.id}/renew`)} />
      <p><strong>2 · 시작하기 채널에서 LMS 인증</strong></p><p>서버의 ‘1 · LMS 인증’ 버튼을 누르고 아래 코드를 입력하세요.</p>
      <output aria-label="인증 코드">{challenge.code}</output><p>본인 계정을 확인하면 수강생 자기소개 단계로 이어집니다.</p><p>만료: {new Date(challenge.expiresAt).toLocaleTimeString('ko-KR')}</p>
      <button className="button secondary" onClick={() => void refreshWorkspace()}>인증 후 학습 화면 열기</button>
    </section>}
    <form className="admission-apply" onSubmit={e => { e.preventDefault(); const form = new FormData(e.currentTarget); void action('me/admissions', { workspaceId: form.get('workspaceId') }) }}><label>다른 워크스페이스 신청<select name="workspaceId" required defaultValue=""><option value="" disabled>워크스페이스 선택</option>{catalogue.filter(w => !applications.some(a => a.workspaceId === w.id)).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label><button className="button secondary" disabled={busy}>가입 신청</button></form>
  </section>
}

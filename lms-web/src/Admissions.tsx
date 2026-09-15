import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { apiRequest, workspaceRequest, demoMode } from './api'
import { Badge, CardHeading } from './components'

type Application = { id: string; workspaceId: string; workspaceName: string; name: string; username: string; state: string; inviteState: string; inviteUrl: string | null; inviteExpires: number | null; reason: string }
const states: Record<string, string> = { pending: '승인 대기', approved: '승인 완료', rejected: '반려', joined: '참여 완료' }
export function AdmissionsReview({ workspaceId }: { workspaceId: string }) {
  const [state, setState] = useState<{ applications: Application[]; guildIds: string[] }>({ applications: [], guildIds: [] })
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
    try { await workspaceRequest(workspaceId, `admissions/${id}/review`, { method: 'POST', body: JSON.stringify({ action: button.value, guildId: form.get('guildId') || '', reason: form.get('reason') || '' }) }); await refresh() }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <><div className="operations-toolbar"><p>승인 후 봇이 Discord 초대 링크를 발급합니다.</p><button className="button secondary" onClick={() => void refresh()}>신청 새로고침</button></div>{error && <p className="inline-note error-note" role="alert">{error}</p>}{!state.guildIds.length && <p className="inline-note">관리자가 Discord 채널 설정에서 서버를 연결하면 승인할 수 있습니다.</p>}
    {!state.applications.length && <section className="panel student-empty"><h2>가입 신청이 없습니다.</h2></section>}
    {state.applications.map(a => <section key={a.id} className="panel admission-card"><CardHeading title={`${a.name} · ${a.username}`}><Badge>{states[a.state]}</Badge></CardHeading>{a.state === 'pending' ? <form className="modal-form" onSubmit={e => void review(e, a.id)}><fieldset disabled={busy || demoMode}><div className="form-row"><label>초대할 Discord 서버<select name="guildId">{state.guildIds.map(id => <option key={id}>{id}</option>)}</select></label><label>처리 사유<input name="reason" maxLength={300} placeholder="선택 입력" /></label></div><div className="flex gap-2"><button type="submit" value="approve" className="button primary" disabled={!state.guildIds.length}>가입 승인</button><button type="submit" value="reject" className="button secondary">반려</button></div></fieldset></form> : <p className="admission-detail">{a.reason}{a.state === 'approved' && (a.inviteState === 'ready' ? ' · Discord 초대 발급 완료' : a.inviteState === 'failed' ? ' · 초대 발급 실패: 봇의 초대 생성 권한을 확인하세요.' : ' · 봇 초대 발급 대기')}</p>}</section>)}
  </>
}

export function AdmissionStatus({ refreshWorkspace }: { refreshWorkspace: () => Promise<void> }) {
  const [applications, setApplications] = useState<Application[]>([])
  const [catalogue, setCatalogue] = useState<{ id: string; name: string }[]>([])
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [challenge, setChallenge] = useState<{ code: string; expiresAt: number } | null>(null)
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
  async function action(path: string, body = {}) {
    if (busy) return; setBusy(true); setError('')
    try { const result = await apiRequest(path, { method: 'POST', body: JSON.stringify(body) }); if (result.code) setChallenge(result); await refresh() }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="admissions-status"><div className="operations-toolbar"><h2>가입 신청 현황</h2><button className="button secondary" onClick={() => void refresh()}>승인 상태 확인</button></div>{error && <p className="inline-note error-note" role="alert">{error}</p>}
    {applications.map(a => <section className="panel admission-card" key={a.id}><CardHeading title={a.workspaceName}><Badge>{states[a.state]}</Badge></CardHeading>{a.state === 'pending' && <p className="admission-detail">관리자 또는 강사가 신청을 확인하고 있습니다. 승인되면 이 화면에서 Discord 초대 링크를 확인할 수 있습니다.</p>}{a.state === 'rejected' && <p className="admission-detail">{a.reason || '가입 신청이 반려됐습니다. 운영자에게 문의하세요.'}</p>}{a.state === 'approved' && <div className="admission-detail">{a.inviteUrl ? <a className="button primary" href={a.inviteUrl} target="_blank" rel="noreferrer">Discord 서버 참여</a> : ['queued', 'running'].includes(a.inviteState) ? <p>승인됐습니다. 봇이 Discord 초대 링크를 발급하는 중입니다.</p> : <><p>초대 링크가 만료됐거나 발급하지 못했습니다.</p><button className="button secondary" disabled={busy} onClick={() => void action(`me/admissions/${a.id}/renew`)}>초대 링크 재발급</button></>}<p>서버 참여 후 본인 계정을 인증하세요.</p><button className="button secondary" disabled={busy} onClick={() => void action(`me/admissions/${a.id}/verification`)}>Discord 인증 코드 받기</button></div>}{a.state === 'joined' && <div className="admission-detail"><button className="button secondary" onClick={() => void refreshWorkspace()}>학습 화면 새로고침</button></div>}</section>)}
    {challenge && <section className="panel admission-detail"><h3>Discord 계정 인증</h3><p>참여한 Discord 서버에서 아래 명령어를 실행하세요.</p><output aria-label="인증 코드">{challenge.code}</output><p className="auth-command">/lms인증 코드:{challenge.code}</p><p>만료: {new Date(challenge.expiresAt).toLocaleTimeString('ko-KR')}</p><button className="button secondary" onClick={() => void refreshWorkspace()}>인증 후 학습 화면 열기</button></section>}
    <form className="admission-apply" onSubmit={e => { e.preventDefault(); const form = new FormData(e.currentTarget); void action('me/admissions', { workspaceId: form.get('workspaceId') }) }}><label>다른 워크스페이스 신청<select name="workspaceId" required defaultValue=""><option value="" disabled>워크스페이스 선택</option>{catalogue.filter(w => !applications.some(a => a.workspaceId === w.id)).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label><button className="button secondary" disabled={busy}>가입 신청</button></form>
  </section>
}

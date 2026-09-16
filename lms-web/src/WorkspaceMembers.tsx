import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Copy, Plus, RefreshCw } from 'lucide-react'
import { workspaceRequest, demoMode } from './api'
import { Badge, CardHeading } from './components'
import { roleNames, type WorkspaceRole } from './demoWorkspaces'

type Scope = { mentorType: 'main' | 'group'; teamIds: string[] }
type Team = { id: string; name: string }
type Member = Scope & { id: string; username: string; name: string; role: WorkspaceRole }
type Invitation = { id: string; username: string; role: WorkspaceRole; expiresAt: number; acceptedAt: number | null; revokedAt: number | null }
export default function WorkspaceMembers({ workspaceId, platformAdmin }: { workspaceId: string; platformAdmin: boolean }) {
  const [state, setState] = useState<{ members: Member[]; invitations: Invitation[]; teams: Team[] }>({ members: [], invitations: [], teams: [] })
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [link, setLink] = useState(''), [copied, setCopied] = useState(false)
  const [inviteRole, setInviteRole] = useState('instructor'), [scope, setScope] = useState<Scope>({ mentorType: 'main', teamIds: [] })
  const [editing, setEditing] = useState<Member | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 30000); return () => clearInterval(timer) }, [])
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (demoMode) return
    try { setState(await workspaceRequest(workspaceId, 'members', { signal })); setError('') } catch (e) { if (!signal?.aborted) setError((e as Error).message) }
  }, [workspaceId])
  // eslint-disable-next-line react/set-state-in-effect -- Load authorized membership records.
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort() }, [refresh])
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || demoMode) return
    const form = new FormData(event.currentTarget)
    setBusy(true); setError(''); setLink(''); setCopied(false)
    try {
      const result = await workspaceRequest(workspaceId, 'invitations', { method: 'POST', body: JSON.stringify({ username: form.get('username'), role: form.get('role'), ...(inviteRole === 'instructor' ? scope : {}) }) })
      const url = new URL(location.href); url.search = ''; url.hash = `invite=${result.token}`
      setLink(url.href); await refresh()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function revoke(id: string) {
    if (busy) return; setBusy(true)
    try { await workspaceRequest(workspaceId, `invitations/${id}/revoke`, { method: 'POST', body: '{}' }); setLink(''); await refresh() }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <>
    {demoMode && <p className="inline-note">데모에서는 초대를 발급할 수 없습니다.</p>}
    {error && <p className="inline-note error-note" role="alert">{error}</p>}
    <section className="panel membership-invite"><CardHeading title="구성원 초대" subtitle={platformAdmin ? '관리자 계정을 먼저 초대하면 해당 관리자가 강사를 초대하고 수강생 가입을 승인할 수 있습니다.' : '멘토는 LMS 가입과 초대 수락 후 기본 정보 입력·Discord 연결·업무 안내를 진행합니다.'} />
      <form className="modal-form" onSubmit={invite}><fieldset disabled={busy || demoMode}><div className="form-row"><label>초대할 아이디<input name="username" required pattern="[a-z0-9][a-z0-9_.-]{3,31}" placeholder="가입할 아이디 또는 기존 아이디" maxLength={32} /></label><label>참여 권한<select name="role" value={inviteRole} onChange={e => setInviteRole(e.target.value)}>{platformAdmin && <option value="admin">워크스페이스 관리자</option>}<option value="instructor">멘토</option></select></label></div>{inviteRole === 'instructor' && <ScopeFields scope={scope} teams={state.teams} change={setScope} />}<button className="button primary" type="submit"><Plus size={16} />초대 링크 만들기</button></fieldset></form>
      {link && <div className="invitation-link" role="status"><label>초대 링크<input readOnly value={link} onFocus={e => e.target.select()} /></label><button className="button secondary" onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true) } catch { setError('초대 링크를 선택해서 복사하세요.') } }}><Copy size={15} />{copied ? '복사됨' : '링크 복사'}</button><p>7일 동안 한 번 사용할 수 있습니다. 초대할 사람에게 링크를 전달하세요.</p></div>}
    </section>
    <section className="panel"><CardHeading title="구성원"><button className="text-button" onClick={() => void refresh()}><RefreshCw size={14} />새로고침</button></CardHeading><div className="table-scroll"><table><thead><tr><th>이름</th><th>아이디</th><th>권한 · 담당 조</th><th>관리</th></tr></thead><tbody>{state.members.map(m => <tr key={m.id}><td>{m.name}</td><td>{m.username}</td><td><Badge>{m.role === 'instructor' ? m.mentorType === 'main' ? '메인 강사 · 전체 조' : '조 담당 멘토' : roleNames[m.role]}</Badge>{m.mentorType === 'group' && <p>{state.teams.filter(t => m.teamIds.includes(t.id)).map(t => t.name).join(' · ')}</p>}</td><td>{m.role === 'instructor' && <button className="button secondary compact" onClick={() => setEditing({ ...m })}>담당 조 변경</button>}</td></tr>)}</tbody></table></div>{!state.members.length && <p className="calendar-empty">참여한 구성원이 없습니다.</p>}</section>
    {editing && <section className="panel membership-invite"><CardHeading title={`${editing.name} 담당 조 변경`} /><form className="modal-form" onSubmit={async e => {
      e.preventDefault(); if (busy) return; setBusy(true); setError('')
      try { setState(await workspaceRequest(workspaceId, `members/${editing.id}/assignment`, { method: 'PATCH', body: JSON.stringify({ mentorType: editing.mentorType, teamIds: editing.teamIds }) })); setEditing(null) }
      catch (e) { setError((e as Error).message) } finally { setBusy(false) }
    }}><fieldset disabled={busy}><ScopeFields scope={editing} teams={state.teams} change={scope => setEditing({ ...editing, ...scope })} /><button className="button primary">담당 조 저장</button><button className="button secondary" type="button" onClick={() => setEditing(null)}>취소</button></fieldset></form><p>저장하면 LMS 담당 범위가 바뀌고, 연결된 봇이 Discord 조별 접근 역할을 갱신합니다.</p></section>}
    <section className="panel membership-history"><CardHeading title="초대 내역" /><div className="table-scroll"><table><thead><tr><th>아이디</th><th>권한</th><th>만료일</th><th>상태</th><th>관리</th></tr></thead><tbody>{state.invitations.map(i => <tr key={i.id}><td>{i.username}</td><td>{roleNames[i.role]}</td><td>{new Date(i.expiresAt).toLocaleDateString('ko-KR')}</td><td>{i.acceptedAt ? '참여 완료' : i.revokedAt ? '취소됨' : i.expiresAt <= clock ? '만료됨' : '대기 중'}</td><td>{!i.acceptedAt && !i.revokedAt && i.expiresAt > clock && (platformAdmin || i.role !== 'admin') && <button className="button secondary compact" disabled={busy} onClick={() => void revoke(i.id)}>초대 취소</button>}</td></tr>)}</tbody></table></div>{!state.invitations.length && <p className="calendar-empty">발급한 초대가 없습니다.</p>}</section>
  </>
}

function ScopeFields({ scope, teams, change }: { scope: Scope; teams: Team[]; change: (scope: Scope) => void }) {
  return <><label>멘토 구분<select value={scope.mentorType} onChange={e => change({ mentorType: e.target.value as Scope['mentorType'], teamIds: [] })}><option value="main">메인 강사 · 전체 조</option><option value="group">조 담당 멘토</option></select></label>{scope.mentorType === 'group' && <fieldset className="mentor-team-picker"><legend>담당 조 (복수 선택 가능)</legend>{teams.map(team => <label key={team.id}><input type="checkbox" checked={scope.teamIds.includes(team.id)} onChange={e => change({ ...scope, teamIds: e.target.checked ? [...scope.teamIds, team.id] : scope.teamIds.filter(id => id !== team.id) })} />{team.name}</label>)}{!teams.length && <p>Discord 구축 화면에서 조를 먼저 설정하세요.</p>}</fieldset>}</>
}

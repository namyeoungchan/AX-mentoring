import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Copy, Plus, RefreshCw } from 'lucide-react'
import { workspaceRequest, demoMode } from './api'
import { Badge, CardHeading, ModalShell } from './components'
import { roleNames, type WorkspaceRole } from './demoWorkspaces'

type Scope = { mentorType: 'main' | 'group'; teamIds: string[] }
type Team = { id: string; name: string }
type Member = Scope & { id: string; username: string; name: string; expertise: string; role: WorkspaceRole }
type Invitation = Scope & { id: string; username: string; role: WorkspaceRole; expiresAt: number; acceptedAt: number | null; revokedAt: number | null }
type Members = { members: Member[]; invitations: Invitation[]; teams: Team[] }
type Edit = { kind: 'member'; value: Member } | { kind: 'invitation'; value: Invitation }
type Removal = { kind: 'member'; value: Member } | { kind: 'invitation'; value: Invitation }
export default function WorkspaceMembers({ workspaceId, platformAdmin }: { workspaceId: string; platformAdmin: boolean }) {
  const [state, setState] = useState<Members>({ members: [], invitations: [], teams: [] })
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [link, setLink] = useState(''), [copied, setCopied] = useState(false), [notice, setNotice] = useState('')
  const [inviteRole, setInviteRole] = useState('instructor'), [scope, setScope] = useState<Scope>({ mentorType: 'main', teamIds: [] })
  const [editing, setEditing] = useState<Edit | null>(null), [removing, setRemoving] = useState<Removal | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 30000); return () => clearInterval(timer) }, [])
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (demoMode) return
    try { setState(await workspaceRequest(workspaceId, 'members', { signal })); setError('') } catch (e) { if (!signal?.aborted) setError((e as Error).message) }
  }, [workspaceId])
  // eslint-disable-next-line react/set-state-in-effect -- Load authorized membership records.
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort() }, [refresh])
  const canManage = (role: WorkspaceRole) => role === 'instructor' || (platformAdmin && role === 'admin')
  const roleLabel = (person: Scope & { role: WorkspaceRole }) => person.role === 'instructor' ? person.mentorType === 'main' ? '메인 강사 · 전체 조' : '조 담당 멘토' : roleNames[person.role]
  const teamsLabel = (person: Scope & { role: WorkspaceRole }) => person.role === 'instructor' && person.mentorType === 'group' ? state.teams.filter(t => person.teamIds.includes(t.id)).map(t => t.name).join(' · ') : ''
  function editFields(fields: Partial<Scope & { role: WorkspaceRole }>) {
    setEditing(current => !current ? null : current.kind === 'member' ? { ...current, value: { ...current.value, ...fields } } : { ...current, value: { ...current.value, ...fields } })
  }
  function begin() { setBusy(true); setError(''); setNotice('') }
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || demoMode) return
    const form = new FormData(event.currentTarget)
    begin(); setLink(''); setCopied(false)
    try {
      const result = await workspaceRequest(workspaceId, 'invitations', { method: 'POST', body: JSON.stringify({ username: form.get('username'), role: inviteRole, ...(inviteRole === 'instructor' ? scope : {}) }) })
      const url = new URL(location.href); url.search = ''; url.hash = `invite=${result.token}`
      setLink(url.href); await refresh()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !editing) return
    begin()
    const { kind, value } = editing
    const body = { role: value.role, mentorType: value.role === 'instructor' ? value.mentorType : 'main', teamIds: value.role === 'instructor' ? value.teamIds : [], ...(kind === 'member' ? { name: value.name, expertise: value.expertise } : {}) }
    try {
      setState(await workspaceRequest(workspaceId, `${kind === 'member' ? 'members' : 'invitations'}/${value.id}`, { method: 'PATCH', body: JSON.stringify(body) }))
      setEditing(null); setNotice(kind === 'member' ? '구성원 정보를 저장했습니다.' : '초대를 수정했습니다. 기존 링크로 변경된 권한을 수락할 수 있습니다.')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function remove() {
    if (busy || !removing) return
    begin()
    try {
      if (removing.kind === 'member') setState(await workspaceRequest(workspaceId, `members/${removing.value.id}`, { method: 'DELETE', body: '{}' }))
      else { await workspaceRequest(workspaceId, `invitations/${removing.value.id}/revoke`, { method: 'POST', body: '{}' }); setLink(''); await refresh() }
      setNotice(removing.kind === 'member' ? '워크스페이스에서 구성원을 제외했습니다.' : '초대를 취소했습니다.')
      setRemoving(null)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <>
    {demoMode && <p className="inline-note">데모에서는 구성원을 변경하거나 초대를 발급할 수 없습니다.</p>}
    {error && !editing && !removing && <p className="inline-note error-note" role="alert">{error}</p>}
    {notice && <p className="inline-note" role="status">{notice}</p>}
    <section className="panel membership-invite"><CardHeading title="구성원 초대" subtitle={platformAdmin ? '워크스페이스 관리자와 멘토를 초대하고, 참여 권한과 담당 조를 관리합니다.' : '멘토 초대와 정보 수정, 담당 조 변경을 이 화면에서 관리합니다.'} />
      <form className="modal-form" onSubmit={invite}><fieldset disabled={busy || demoMode}>
        <div className="form-row"><label>초대할 아이디<input name="username" required pattern="[a-z0-9][a-z0-9_.-]{3,31}" placeholder="가입할 아이디 또는 기존 아이디" maxLength={32} /></label><RoleField value={inviteRole} platformAdmin={platformAdmin} change={setInviteRole} /></div>
        {inviteRole === 'instructor' && <ScopeFields scope={scope} teams={state.teams} change={setScope} />}<button className="button primary" type="submit"><Plus size={16} />초대 링크 만들기</button>
      </fieldset></form>
      {link && <div className="invitation-link" role="status"><label>초대 링크<input readOnly value={link} onFocus={e => e.target.select()} /></label><button className="button secondary" onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true) } catch { setError('초대 링크를 선택해서 복사하세요.') } }}><Copy size={15} />{copied ? '복사됨' : '링크 복사'}</button><p>7일 동안 한 번 사용할 수 있습니다. 초대할 사람에게 링크를 전달하세요.</p></div>}
    </section>
    <section className="panel"><CardHeading title="구성원" subtitle="수정한 활동명과 담당 조는 연결된 Discord 봇에도 반영됩니다."><button className="text-button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} />새로고침</button></CardHeading>
      <div className="table-scroll"><table><thead><tr><th>이름 · 담당 분야</th><th>아이디</th><th>권한 · 담당 조</th><th>관리</th></tr></thead><tbody>{state.members.map(m => <tr key={m.id}>
        <td>{m.name}{m.expertise && <small>{m.expertise}</small>}</td><td>{m.username}</td><td><Badge>{roleLabel(m)}</Badge>{teamsLabel(m) && <p>{teamsLabel(m)}</p>}</td>
        <td>{canManage(m.role) ? <div className="flex gap-2"><button className="button secondary compact" disabled={busy} onClick={() => { setError(''); setEditing({ kind: 'member', value: { ...m } }) }}>수정</button><button className="button secondary compact" disabled={busy} onClick={() => { setError(''); setRemoving({ kind: 'member', value: m }) }}>삭제</button></div> : m.role === 'admin' ? '총괄 관리자만 관리' : '—'}</td>
      </tr>)}</tbody></table></div>{!state.members.length && <p className="calendar-empty">참여한 구성원이 없습니다.</p>}
    </section>
    <section className="panel membership-history"><CardHeading title="초대 내역" /><div className="table-scroll"><table><thead><tr><th>아이디</th><th>권한 · 담당 조</th><th>만료일</th><th>상태</th><th>관리</th></tr></thead><tbody>{state.invitations.map(i => <tr key={i.id}>
      <td>{i.username}</td><td>{roleLabel(i)}{teamsLabel(i) && <p>{teamsLabel(i)}</p>}</td><td>{new Date(i.expiresAt).toLocaleDateString('ko-KR')}</td><td>{i.acceptedAt ? '수락 완료' : i.revokedAt ? '취소됨' : i.expiresAt <= clock ? '만료됨' : '대기 중'}</td>
      <td>{!i.acceptedAt && !i.revokedAt && i.expiresAt > clock && canManage(i.role) && <div className="flex gap-2"><button className="button secondary compact" disabled={busy} onClick={() => { setError(''); setEditing({ kind: 'invitation', value: { ...i } }) }}>초대 수정</button><button className="button secondary compact" disabled={busy} onClick={() => { setError(''); setRemoving({ kind: 'invitation', value: i }) }}>초대 취소</button></div>}</td>
    </tr>)}</tbody></table></div>{!state.invitations.length && <p className="calendar-empty">발급한 초대가 없습니다.</p>}</section>
    {editing && <ModalShell title={editing.kind === 'member' ? '구성원 수정' : '초대 수정'} close={() => { if (!busy) setEditing(null) }}><form className="modal-form" onSubmit={save}>
      {error && <p role="alert" className="inline-note error-note">{error}</p>}
      <p>{editing.value.username}{editing.kind === 'member' ? ' · 이 워크스페이스에서 사용할 정보입니다.' : ' · 아이디를 바꾸려면 초대를 취소하고 새로 발급하세요.'}</p>
      <fieldset disabled={busy}>
        {editing.kind === 'member' && <><label>활동명<input required maxLength={50} value={editing.value.name} onChange={e => setEditing({ ...editing, value: { ...editing.value, name: e.target.value } })} /></label><label>담당 분야<input maxLength={150} value={editing.value.expertise} onChange={e => setEditing({ ...editing, value: { ...editing.value, expertise: e.target.value } })} /></label></>}
        <RoleField value={editing.value.role} platformAdmin={platformAdmin} change={role => editFields({ role: role as WorkspaceRole })} />
        {editing.value.role === 'instructor' && <ScopeFields scope={editing.value} teams={state.teams} change={editFields} />}
        <div className="modal-actions"><button className="button secondary" type="button" onClick={() => setEditing(null)}>취소</button><button className="button primary">저장</button></div>
      </fieldset><p>LMS 담당 범위는 즉시 적용되며, Discord 역할은 봇의 다음 동기화 때 갱신됩니다.</p>
    </form></ModalShell>}
    {removing && <ModalShell title={removing.kind === 'member' ? '구성원 삭제' : '초대 취소'} close={() => { if (!busy) setRemoving(null) }}>
      {error && <p role="alert" className="inline-note error-note">{error}</p>}
      <p><strong>{removing.value.username}</strong>{removing.kind === 'member' ? ' 님을 이 워크스페이스에서 제외합니다.' : ' 님의 초대 링크를 취소합니다.'}</p>
      {removing.kind === 'member' ? <p>LMS 접근과 신규 멘토링 예약을 중단하고, 봇의 다음 동기화 때 Discord 역할을 회수합니다. 계정, 다른 워크스페이스와 기존 예약·멘토링 이력은 유지됩니다.</p> : <p>취소한 링크로는 가입할 수 없습니다. 필요하면 새 초대를 발급하세요.</p>}
      <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setRemoving(null)}>돌아가기</button><button className="button primary" disabled={busy} onClick={() => void remove()}>{removing.kind === 'member' ? '워크스페이스에서 제외' : '초대 취소 확인'}</button></div>
    </ModalShell>}
  </>
}
function RoleField({ value, platformAdmin, change }: { value: string; platformAdmin: boolean; change: (value: string) => void }) {
  return <label>참여 권한<select value={value} onChange={e => change(e.target.value)}>{platformAdmin && <option value="admin">워크스페이스 관리자</option>}<option value="instructor">멘토</option></select></label>
}
function ScopeFields({ scope, teams, change }: { scope: Scope; teams: Team[]; change: (scope: Scope) => void }) {
  return <><label>멘토 구분<select value={scope.mentorType} onChange={e => change({ mentorType: e.target.value as Scope['mentorType'], teamIds: [] })}><option value="main">메인 강사 · 전체 조</option><option value="group">조 담당 멘토</option></select></label>{scope.mentorType === 'group' && <fieldset className="mentor-team-picker"><legend>담당 조 (복수 선택 가능)</legend>{teams.map(team => <label key={team.id}><input type="checkbox" checked={scope.teamIds.includes(team.id)} onChange={e => change({ ...scope, teamIds: e.target.checked ? [...scope.teamIds, team.id] : scope.teamIds.filter(id => id !== team.id) })} />{team.name}</label>)}{!teams.length && <p>Discord 구축 화면에서 조를 먼저 설정하세요.</p>}</fieldset>}</>
}

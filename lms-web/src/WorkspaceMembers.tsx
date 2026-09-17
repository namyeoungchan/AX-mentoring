import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Copy, LoaderCircle, Plus, RefreshCw, ShieldCheck, UserMinus } from 'lucide-react'
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
  const [accountMode, setAccountMode] = useState('new'), [delivery, setDelivery] = useState('')
  const issueAccount = platformAdmin && inviteRole === 'admin' && accountMode === 'new'
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
    begin(); setLink(''); setDelivery(''); setCopied(false)
    try {
      const result = await workspaceRequest(workspaceId, issueAccount ? 'invitations/account' : 'invitations', { method: 'POST', body: JSON.stringify(issueAccount ? { username: form.get('username'), name: form.get('name') } : { username: form.get('username'), role: inviteRole, ...(inviteRole === 'instructor' ? scope : {}) }) })
      const url = new URL(location.href); url.search = ''; url.hash = `invite=${result.token}`
      setDelivery([
        `[${result.workspaceName}] ${roleNames[result.role as WorkspaceRole]} 초대`,
        ...(result.name ? [`이름: ${result.name}`] : []),
        `초대 링크: ${url.href}`, `아이디: ${result.username}`,
        ...(result.initialPassword ? [`초기 비밀번호: ${result.initialPassword}`] : []),
        `초대 만료: ${new Date(result.expiresAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (한국 시간)`,
        '', result.initialPassword ? '링크 접속 → 전달받은 계정으로 로그인 → 초기 비밀번호 변경 → 초대 수락 순서로 진행해 주세요.' : '링크에 접속해 위 아이디로 가입하거나 로그인한 뒤 초대를 수락해 주세요.',
        '초대 링크는 7일 동안 한 번 사용할 수 있습니다.',
      ].join('\n'))
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
      if (kind === 'invitation') { setLink(''); setDelivery(''); setCopied(false) }
      setEditing(null); setNotice(kind === 'member' ? '구성원 정보를 저장했습니다.' : '초대를 수정했습니다. 기존 링크로 변경된 권한을 수락할 수 있습니다.')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function remove() {
    if (busy || !removing) return
    begin()
    try {
      if (removing.kind === 'member') setState(await workspaceRequest(workspaceId, `members/${removing.value.id}`, { method: 'DELETE', body: '{}' }))
      else { await workspaceRequest(workspaceId, `invitations/${removing.value.id}/revoke`, { method: 'POST', body: '{}' }); setLink(''); setDelivery(''); await refresh() }
      setNotice(removing.kind === 'member' ? '워크스페이스에서 구성원을 제외했습니다.' : '초대를 취소했습니다.')
      setRemoving(null)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <>
    {demoMode && <p className="inline-note">데모에서는 구성원을 변경하거나 초대를 발급할 수 없습니다.</p>}
    {error && !editing && !removing && <p className="inline-note error-note" role="alert">{error}</p>}
    {notice && <p className="inline-note" role="status">{notice}</p>}
    <section className="panel membership-invite"><CardHeading title="구성원 초대" subtitle={platformAdmin ? '워크스페이스 관리자와 멘토를 초대하고, 참여 권한과 담당 조를 관리합니다.' : '멘토 초대와 정보 수정, 담당 조 변경을 이 화면에서 관리합니다.'} />
      <form className="modal-form membership-form" onSubmit={invite}><fieldset disabled={busy || demoMode}>
        <div className="form-row"><label>초대할 아이디<input name="username" required pattern="[a-z0-9][a-z0-9_.-]{3,31}" placeholder="예: mentor.kim" maxLength={32} aria-describedby="invite-username-hint" /><small id="invite-username-hint" className="membership-field-hint">영문 소문자·숫자와 _ . - 조합, 4~32자</small></label><RoleField value={inviteRole} platformAdmin={platformAdmin} change={setInviteRole} /></div>
        {platformAdmin && inviteRole === 'admin' && <><label>계정 발급 방식<select value={accountMode} onChange={e => setAccountMode(e.target.value)}><option value="new">새 계정과 초기 비밀번호 발급</option><option value="existing">초대 링크만 발급 (직접 가입·기존 계정)</option></select></label>{issueAccount && <label>관리자 이름<input name="name" required maxLength={50} autoComplete="off" placeholder="예: 김관리" /><small className="membership-field-hint">새 아이디로 계정을 만듭니다. 초기 비밀번호는 자동 발급되며 첫 로그인 시 변경합니다.</small></label>}</>}
        {inviteRole === 'instructor' && <ScopeFields scope={scope} teams={state.teams} change={setScope} />}<div className="membership-actions"><p>초대 링크는 발급 후 7일 동안 한 번 사용할 수 있습니다.</p><button className="button primary" type="submit">{busy ? <LoaderCircle size={16} className="membership-spinner" /> : <Plus size={16} />}{busy ? '발급 중…' : issueAccount ? '계정과 초대 링크 만들기' : '초대 링크 만들기'}</button></div>
      </fieldset></form>
      {link && <div className="invitation-link"><label>초대 링크<input readOnly value={link} onFocus={e => e.target.select()} /></label><label className="invitation-delivery">전달할 초대 안내문<textarea readOnly value={delivery} rows={10} onFocus={e => e.target.select()} /></label><button className="button secondary" onClick={async () => { try { await navigator.clipboard.writeText(delivery); setCopied(true) } catch { setError('전달할 초대 안내문을 선택해서 복사하세요.') } }}><Copy size={15} />{copied ? '복사됨' : '초대 안내문 복사'}</button><button className="button secondary" onClick={() => { setLink(''); setDelivery(''); setCopied(false) }}>안내문 닫기</button>{copied && <span role="status">초대 안내문을 복사했습니다.</span>}<p>초대할 사람에게 안내문을 전달하세요. 발급된 초기 비밀번호는 이 화면을 닫거나 새로고침하면 다시 확인할 수 없습니다.</p></div>}
    </section>
    <section className="panel"><CardHeading title="구성원" subtitle="수정한 활동명과 담당 조는 연결된 Discord 봇에도 반영됩니다."><button className="text-button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} />새로고침</button></CardHeading>
      <div className="table-scroll"><table><thead><tr><th>이름 · 담당 분야</th><th>아이디</th><th>권한 · 담당 조</th><th>관리</th></tr></thead><tbody>{state.members.map(m => <tr key={m.id}>
        <td>{m.name}{m.expertise && <small>{m.expertise}</small>}</td><td>{m.username}</td><td><Badge>{roleLabel(m)}</Badge>{teamsLabel(m) && <p>{teamsLabel(m)}</p>}</td>
        <td>{canManage(m.role) ? <div className="flex gap-2"><button className="button secondary compact" disabled={busy} onClick={() => { setError(''); setEditing({ kind: 'member', value: { ...m } }) }}>수정</button><button className="button secondary compact" disabled={busy} onClick={() => { setError(''); setRemoving({ kind: 'member', value: m }) }}>삭제</button></div> : m.role === 'admin' ? '총관리자만 관리' : '—'}</td>
      </tr>)}</tbody></table></div>{!state.members.length && <p className="calendar-empty">참여한 구성원이 없습니다.</p>}
    </section>
    <section className="panel membership-history"><CardHeading title="초대 내역" /><div className="table-scroll"><table><thead><tr><th>아이디</th><th>권한 · 담당 조</th><th>만료일</th><th>상태</th><th>관리</th></tr></thead><tbody>{state.invitations.map(i => <tr key={i.id}>
      <td>{i.username}</td><td>{roleLabel(i)}{teamsLabel(i) && <p>{teamsLabel(i)}</p>}</td><td>{new Date(i.expiresAt).toLocaleDateString('ko-KR')}</td><td>{i.acceptedAt ? '수락 완료' : i.revokedAt ? '취소됨' : i.expiresAt <= clock ? '만료됨' : '대기 중'}</td>
      <td>{!i.acceptedAt && !i.revokedAt && i.expiresAt > clock && canManage(i.role) && <div className="flex gap-2"><button className="button secondary compact" disabled={busy} onClick={() => { setError(''); setEditing({ kind: 'invitation', value: { ...i } }) }}>초대 수정</button><button className="button secondary compact" disabled={busy} onClick={() => { setError(''); setRemoving({ kind: 'invitation', value: i }) }}>초대 취소</button></div>}</td>
    </tr>)}</tbody></table></div>{!state.invitations.length && <p className="calendar-empty">발급한 초대가 없습니다.</p>}</section>
    {editing && <ModalShell title={editing.kind === 'member' ? '구성원 수정' : '초대 수정'} busy={busy} close={() => { if (!busy) setEditing(null) }}><form className="modal-form membership-form" onSubmit={save}>
      {error && <p role="alert" className="inline-note error-note">{error}</p>}
      <p>{editing.value.username}{editing.kind === 'member' ? ' · 이 워크스페이스에서 사용할 정보입니다.' : ' · 아이디를 바꾸려면 초대를 취소하고 새로 발급하세요.'}</p>
      <fieldset disabled={busy}>
        {editing.kind === 'member' && <><label>활동명<input required maxLength={50} value={editing.value.name} onChange={e => setEditing({ ...editing, value: { ...editing.value, name: e.target.value } })} /></label><label>담당 분야<input maxLength={150} value={editing.value.expertise} onChange={e => setEditing({ ...editing, value: { ...editing.value, expertise: e.target.value } })} /></label></>}
        <RoleField value={editing.value.role} platformAdmin={platformAdmin} change={role => editFields({ role: role as WorkspaceRole })} />
        {editing.value.role === 'instructor' && <ScopeFields scope={editing.value} teams={state.teams} change={editFields} />}
        <div className="modal-actions"><button className="button secondary" type="button" onClick={() => setEditing(null)}>취소</button><button className="button primary">저장</button></div>
      </fieldset><p>LMS 담당 범위는 즉시 적용되며, Discord 역할은 봇의 다음 동기화 때 갱신됩니다.</p>
    </form></ModalShell>}
    {removing && <ModalShell title={removing.kind === 'member' ? '구성원 삭제' : '초대 취소'} className="membership-remove-modal" busy={busy} close={() => setRemoving(null)}>
      <div className="membership-removal">
        {error && <p role="alert" className="inline-note error-note">{error}</p>}
        <div className="membership-removal-person"><span className="membership-removal-icon"><UserMinus size={21} aria-hidden="true" /></span><div><strong>{removing.kind === 'member' ? removing.value.name : removing.value.username}</strong><span>{removing.kind === 'member' ? `@${removing.value.username} · ${roleNames[removing.value.role]}` : roleNames[removing.value.role]}</span></div></div>
        <p className="membership-removal-question">{removing.kind === 'member' ? '이 구성원을 워크스페이스에서 제외할까요?' : '이 구성원에게 발급한 초대를 취소할까요?'}</p>
        {removing.kind === 'member' ? <><ul className="membership-removal-effects"><li>LMS 접근과 신규 멘토링 예약을 중단합니다.</li><li>Discord 역할은 봇의 다음 동기화 때 회수합니다.</li></ul><div className="membership-removal-preserved"><ShieldCheck size={18} aria-hidden="true" /><p>개인 계정과 다른 워크스페이스의 권한,<br />기존 예약·멘토링 이력은 그대로 유지됩니다.</p></div></> : <p className="membership-removal-effects">기존 초대 링크는 더 이상 사용할 수 없습니다. 다시 초대하려면 새 링크를 발급해 주세요.</p>}
        <div className="modal-actions"><button className="button secondary" data-modal-autofocus disabled={busy} onClick={() => setRemoving(null)}>돌아가기</button><button className="button danger" disabled={busy} onClick={() => void remove()}>{busy && <LoaderCircle size={16} className="membership-spinner" />}{busy ? '처리 중…' : removing.kind === 'member' ? '워크스페이스에서 제외' : '초대 취소 확인'}</button></div>
      </div>
    </ModalShell>}
  </>
}
function RoleField({ value, platformAdmin, change }: { value: string; platformAdmin: boolean; change: (value: string) => void }) {
  return <label>참여 권한<select value={value} onChange={e => change(e.target.value)}>{platformAdmin && <option value="admin">워크스페이스 관리자</option>}<option value="instructor">멘토</option></select></label>
}
function ScopeFields({ scope, teams, change }: { scope: Scope; teams: Team[]; change: (scope: Scope) => void }) {
  return <><label>멘토 구분<select value={scope.mentorType} onChange={e => change({ mentorType: e.target.value as Scope['mentorType'], teamIds: [] })}><option value="main">메인 강사 · 전체 조</option><option value="group">조 담당 멘토</option></select></label>{scope.mentorType === 'group' && <fieldset className="mentor-team-picker"><legend>담당 조 <span>복수 선택 가능</span></legend><div className="mentor-team-options">{teams.map(team => <label key={team.id}><input type="checkbox" checked={scope.teamIds.includes(team.id)} onChange={e => change({ ...scope, teamIds: e.target.checked ? [...scope.teamIds, team.id] : scope.teamIds.filter(id => id !== team.id) })} />{team.name}</label>)}{!teams.length && <p>Discord 구축 화면에서 조를 먼저 설정하세요.</p>}</div></fieldset>}</>
}

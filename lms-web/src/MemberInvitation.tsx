import { useState, type FormEvent } from 'react'
import { ArrowRight, Check, Copy, LoaderCircle, RefreshCw, UserRoundPlus } from 'lucide-react'
import { workspaceRequest, demoMode } from './api'
import { CardHeading } from './components'
import { invitationUrl, type RenewedInvitations } from './invitationLinks'

type Team = { id: string; name: string }
type Delivery = { id: string; url: string; text: string; username: string; role: string; name: string; expiresAt: number }
const suggestedUsername = () => `member.${crypto.randomUUID().slice(0, 8)}`
export default function MemberInvitation({ workspaceId, workspaceName, platformAdmin, teams, refreshed, openSetup, renewed = {} }: { workspaceId: string; workspaceName: string; platformAdmin: boolean; teams: Team[]; refreshed: () => Promise<void>; openSetup: () => void; renewed?: RenewedInvitations }) {
  const [mode, setMode] = useState('new'), [username, setUsername] = useState(suggestedUsername)
  const [role, setRole] = useState('instructor'), [mentorType, setMentorType] = useState('main'), [teamIds, setTeamIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false)
  const [originalDelivery, setDelivery] = useState<Delivery | null>(null), [copied, setCopied] = useState(false)
  const replacement = originalDelivery && renewed[originalDelivery.id]
  const delivery = originalDelivery && replacement ? { ...originalDelivery, url: invitationUrl(replacement.token), expiresAt: replacement.expiresAt, text: originalDelivery.text.replace(originalDelivery.url, invitationUrl(replacement.token)).replace(new Date(originalDelivery.expiresAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }), new Date(replacement.expiresAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })) } : originalDelivery
  const label = role === 'admin' ? '워크스페이스 관리자' : mentorType === 'group' ? '조 담당 멘토' : '메인 강사'
  function changeMode(value: string) { setMode(value); setUsername(value === 'new' ? suggestedUsername() : ''); setError(''); setConflict(false) }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || demoMode) return
    const form = new FormData(event.currentTarget)
    setBusy(true); setError(''); setConflict(false)
    try {
      const scope = role === 'instructor' ? { mentorType, teamIds: mentorType === 'group' ? teamIds : [] } : {}
      const input = { username: username.trim().toLowerCase(), ...(mode === 'new' ? { name: form.get('name') } : { role }), ...scope }
      const path = mode === 'existing' ? 'invitations' : role === 'instructor' ? 'mentor-accounts' : 'invitations/account'
      const result = await workspaceRequest(workspaceId, path, { method: 'POST', body: JSON.stringify(input) })
      const url = new URL(location.href); url.search = ''; url.hash = `invite=${result.token}`
      const expiry = new Date(result.expiresAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
      const text = [`[${result.workspaceName}] ${label} 초대`, ...(result.name ? [`이름: ${result.name}`] : []), `초대 링크: ${url.href}`, `아이디: ${result.username}`,
        ...(result.initialPassword ? [`초기 비밀번호: ${result.initialPassword}`] : []), `참여 역할: ${label}${mentorType === 'group' && role === 'instructor' ? ` (${teams.filter(team => teamIds.includes(team.id)).map(team => team.name).join(', ')})` : ''}`,
        '', '1. 위 초대 링크를 여세요. 아이디는 자동으로 입력됩니다.',
        result.initialPassword ? '2. 초기 비밀번호로 로그인한 뒤 본인 비밀번호로 변경하세요.' : '2. 기존 비밀번호로 로그인하세요. 아직 계정이 없다면 회원가입을 선택하세요.',
        '3. 초대 수락을 누르면 워크스페이스에 참여합니다.',
        ...(role === 'instructor' ? ['4. 참여 후 기본 정보를 저장하고 화면 안내에 따라 Discord를 연결하세요.'] : []),
        '', `초대 만료: ${expiry} (한국 시간)`, '이 초대는 본인 계정으로 한 번만 사용할 수 있습니다.'].join('\n')
      setDelivery({ id: result.id, url: url.href, text, username: result.username, role: label, name: result.workspaceName, expiresAt: result.expiresAt }); setCopied(false)
      await refreshed()
    } catch (e) { setError((e as Error).message); setConflict((e as Error & { status?: number }).status === 409) }
    finally { setBusy(false) }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(delivery!.text); setCopied(true) }
    catch { setError('복사가 허용되지 않았습니다. 아래 안내문을 직접 선택해 복사하세요.') }
  }
  return <section className="panel member-invitation">
    <CardHeading title={delivery ? '초대 안내문이 준비됐습니다' : '구성원 초대'} subtitle={delivery ? '아래 안내문을 복사해 초대할 사람에게 직접 전달하세요.' : `${workspaceName}에 함께할 멘토나 운영자를 초대하세요.`} />
    {delivery ? <div className="invite-delivery-layout">
      <div className="invite-delivery-main"><div className="invite-ready"><Check size={20} /><div><strong>{delivery.username}</strong><span>{delivery.name} · {delivery.role}</span></div></div>
        <label>전달할 초대 안내문<textarea readOnly value={delivery.text} rows={11} onFocus={event => event.target.select()} /></label>
        <div className="invite-delivery-actions"><button className="button primary" onClick={() => void copy()}><Copy size={16} />{copied ? '안내문 복사 완료' : '초대 안내문 복사'}</button><button className="button secondary" onClick={() => { setDelivery(null); setUsername(mode === 'new' ? suggestedUsername() : ''); setError('') }}>다른 사람 초대하기</button></div>
        {copied && <p role="status">복사했습니다. 카카오톡·메일·Discord 개인 메시지에 붙여넣어 전달하세요.</p>}
        {error && <p role="alert" className="error-text">{error}</p>}
      </div>
      <aside className="invite-next"><h3>이제 상대방에게 전달하세요</h3><p>자동으로 메시지가 발송되지는 않습니다. {mode === 'new' ? '아이디와 초기 비밀번호가' : '아이디와 참여 순서가'} 함께 담긴 안내문 전체를 전달하세요.</p><label>초대 링크<input readOnly value={delivery.url} onFocus={event => event.target.select()} /></label><p>만료: {new Date(delivery.expiresAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (한국 시간). 상대방이 수락하면 아래 구성원 목록에 표시됩니다.</p>{mode === 'new' && <p>초기 비밀번호는 화면을 닫으면 다시 볼 수 없습니다. 전달 전에 안내문을 복사해 두세요.</p>}</aside>
    </div> : <div className="invite-compose-layout"><form className="modal-form membership-form" onSubmit={submit}><fieldset disabled={busy || demoMode}>
      <fieldset className="invite-account-choice"><legend><span>1</span>초대할 분의 계정</legend><div className="invite-choice-options">
        <label><input type="radio" name="accountMode" checked={mode === 'new'} onChange={() => changeMode('new')} /><span><strong>새 계정 만들기</strong><small>처음 참여하는 분 · 아이디와 초기 비밀번호를 함께 준비합니다.</small></span></label>
        <label><input type="radio" name="accountMode" checked={mode === 'existing'} onChange={() => changeMode('existing')} /><span><strong>기존 계정 초대</strong><small>이미 쓰는 아이디로 초대 · 비밀번호는 바뀌지 않습니다.</small></span></label>
      </div></fieldset>
      <div className="form-row">{mode === 'new' && <label>{role === 'admin' ? '관리자 이름' : '멘토 이름'}<input name="name" required maxLength={50} autoComplete="off" placeholder="예: 김민서" /></label>}
        <label>초대할 아이디<div className="invite-username"><input name="username" value={username} onChange={event => setUsername(event.target.value.toLowerCase())} required pattern="[a-z0-9][a-z0-9_.-]{3,31}" minLength={4} maxLength={32} placeholder={mode === 'new' ? '새로 사용할 아이디' : '상대방이 사용하는 아이디'} autoCapitalize="none" spellCheck={false} aria-describedby="invite-username-hint" />{mode === 'new' && <button className="icon-button" type="button" aria-label="다른 아이디 추천" onClick={() => setUsername(suggestedUsername())}><RefreshCw size={16} /></button>}</div><small id="invite-username-hint" className="membership-field-hint">{mode === 'new' ? '추천 아이디를 그대로 쓰거나 바꿀 수 있습니다.' : '초대를 받을 사람에게 기존 아이디를 확인하세요.'}</small></label>
      </div>
      <div className="invite-role-section"><h3><span>2</span>함께할 역할</h3><div className="form-row">{platformAdmin && <label>참여 권한<select value={role} onChange={event => setRole(event.target.value)}><option value="instructor">멘토</option><option value="admin">워크스페이스 관리자</option></select></label>}{role === 'instructor' && <label>멘토 구분<select value={mentorType} onChange={event => { setMentorType(event.target.value); setTeamIds([]) }}><option value="main">메인 강사 · 전체 조</option><option value="group">조 담당 멘토</option></select></label>}</div><p className="membership-field-hint">{role === 'admin' ? '이 워크스페이스의 과정·구성원·운영 설정을 관리합니다.' : mentorType === 'main' ? '워크스페이스의 모든 조에서 출결·성적·과제를 관리합니다.' : '아래에서 선택한 조의 수강생만 담당합니다.'}</p></div>
      {role === 'instructor' && mentorType === 'group' && <fieldset className="mentor-team-picker"><legend>담당 조 <span>하나 이상 선택</span></legend><div className="mentor-team-options">{teams.map(team => <label key={team.id}><input type="checkbox" checked={teamIds.includes(team.id)} onChange={event => setTeamIds(ids => event.target.checked ? [...ids, team.id] : ids.filter(id => id !== team.id))} />{team.name}</label>)}</div>{!teams.length && <p className="inline-note">아직 만들어진 조가 없습니다. <button className="text-button" type="button" onClick={openSetup}>조 구성 화면 열기 <ArrowRight size={14} /></button></p>}</fieldset>}
      {error && <div role="alert" className="inline-note error-note">{error}{conflict && mode === 'new' && <button type="button" className="text-button" onClick={() => { setMode('existing'); setError(''); setConflict(false) }}>이 아이디로 기존 계정 초대하기</button>}</div>}
      <div className="membership-actions"><p>다음 화면에서 전달할 안내문을 확인합니다.</p><button className="button primary" disabled={role === 'instructor' && mentorType === 'group' && !teamIds.length}>{busy ? <LoaderCircle size={16} className="membership-spinner" /> : <UserRoundPlus size={16} />}{busy ? '준비 중…' : mode === 'new' ? '계정과 초대 링크 만들기' : '초대 링크 만들기'}</button></div>
    </fieldset></form><aside className="invite-next"><h3>초대는 이렇게 진행됩니다</h3><ol><li><strong>계정과 역할 준비</strong><p>이름과 아이디, 담당 범위를 정합니다.</p></li><li><strong>안내문 전달</strong><p>만들어진 안내문을 복사해 상대방에게 보내세요.</p></li><li><strong>상대방이 참여</strong><p>링크에서 로그인하고 초대를 수락합니다. Discord 연결은 참여 후 안내합니다.</p></li></ol><p className="invite-scope-note">초대는 현재 선택한 <strong>{workspaceName}</strong>에만 적용됩니다.</p></aside></div>}
  </section>
}

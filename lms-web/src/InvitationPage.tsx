import { useEffect, useState, type ReactNode } from 'react'
import { apiRequest, demoMode } from './api'
import { roleNames } from './demoWorkspaces'
import type { WorkspaceRole } from './demoWorkspaces'
import type { Account } from './StudentHome'
import { ArrowRight, BookOpen, Check } from 'lucide-react'

export default function InvitationPage({ token, account, auth, accepted, logout, leave }: { token: string; account: Account | null; auth: (accountExists: boolean, username: string) => ReactNode; accepted: (id: string) => Promise<void>; logout: () => Promise<void>; leave: () => void }) {
  const [invitation, setInvitation] = useState<{ workspaceName: string; username: string; role: WorkspaceRole; accountExists: boolean; mentorType?: string; teamIds?: string[] } | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (demoMode) return
    const controller = new AbortController()
    apiRequest('invitations/preview', { method: 'POST', body: JSON.stringify({ token }), signal: controller.signal }).then(setInvitation).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [token, retry])
  async function accept() {
    if (busy) return; setBusy(true); setError('')
    try { const workspace = await apiRequest('invitations/accept', { method: 'POST', body: JSON.stringify({ token }) }); await accepted(workspace.id) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const matches = invitation?.username === account?.username
  const role = invitation?.role === 'instructor' ? invitation.mentorType === 'group' ? `조 담당 멘토 · ${invitation.teamIds?.length || 0}개 조` : '메인 강사 · 전체 조' : invitation ? roleNames[invitation.role] : ''
  async function changeAccount() {
    await logout()
    const url = new URL(location.href); url.hash = `invite=${token}`; history.replaceState(null, '', url)
  }
  return <div className="invitation-page invitation-welcome">
    <header className="invitation-brand"><BookOpen size={23} /><strong>AX 학습관리시스템</strong><button className="text-button" onClick={leave}>로그인 화면으로</button></header>
    <main className="invitation-welcome-layout">
      <section className="invitation-overview"><span className="eyebrow">함께할 준비가 됐습니다</span><h1>워크스페이스에<br />초대받았어요.</h1>
        {invitation ? <><h2>{invitation.workspaceName}</h2><dl><div><dt>초대받은 아이디</dt><dd>{invitation.username}</dd></div><div><dt>참여 역할</dt><dd>{role}</dd></div></dl>
          <ol className="invitation-progress"><li className={account && matches ? 'complete' : 'current'}><span>{account && matches ? <Check size={15} /> : '1'}</span><div><strong>{invitation.accountExists ? '내 계정으로 로그인' : '내 계정 만들기'}</strong><p>{invitation.accountExists ? '전달받은 비밀번호 또는 기존 비밀번호를 입력하세요.' : '아이디는 준비되어 있습니다. 이름과 비밀번호만 정하세요.'}</p></div></li><li className={account && matches ? 'current' : ''}><span>2</span><div><strong>초대 수락</strong><p>참여할 공간과 역할을 확인합니다.</p></div></li><li><span>3</span><div><strong>{invitation.role === 'instructor' ? '멘토 활동 준비' : '워크스페이스 둘러보기'}</strong><p>Discord 연결은 참여 후 화면에서 안내합니다.</p></div></li></ol></> : !error && <p role="status">초대 정보를 확인하고 있습니다…</p>}
        {demoMode && <p>실제 초대 링크는 운영 서비스에서 열어주세요.</p>}
      </section>
      <section className="invitation-entry" aria-label="초대 참여">
        {error && <div className="invitation-error"><h2>초대를 확인해 주세요</h2><p role="alert">{error}</p><p>링크가 만료되거나 이미 사용됐다면 초대한 운영자에게 새 초대를 요청하세요.</p><button className="button secondary" disabled={busy} onClick={() => { setError(''); setRetry(n => n + 1) }}>다시 확인</button></div>}
        {!account && invitation && auth(invitation.accountExists, invitation.username)}
        {account && invitation && <div className="invitation-confirm"><h2>{matches ? '이 워크스페이스에 참여할까요?' : '초대받은 계정으로 로그인하세요'}</h2><p>현재 로그인: <strong>{account.username}</strong></p>{matches ? <><p><strong>{invitation.workspaceName}</strong>에 {role}로 참여합니다.</p><button className="button primary" disabled={busy} onClick={() => void accept()}>{busy ? '참여 중…' : '초대 수락'}<ArrowRight size={16} /></button></> : <p>이 링크는 <strong>{invitation.username}</strong> 계정에 보낸 초대입니다. 아래 버튼으로 계정을 바꾸면 이 초대 화면으로 돌아옵니다.</p>}<button className="button secondary" disabled={busy} onClick={() => void changeAccount()}>다른 계정으로 로그인</button></div>}
      </section>
    </main>
  </div>
}

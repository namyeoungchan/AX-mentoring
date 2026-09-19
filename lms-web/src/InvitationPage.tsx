import { useEffect, useState, type ReactNode } from 'react'
import { apiRequest, demoMode } from './api'
import { roleNames } from './demoWorkspaces'
import type { WorkspaceRole } from './demoWorkspaces'
import type { Account } from './StudentHome'

export default function InvitationPage({ token, account, auth, accepted, logout }: { token: string; account: Account | null; auth: (accountExists: boolean) => ReactNode; accepted: (id: string) => Promise<void>; logout: () => Promise<void> }) {
  const [invitation, setInvitation] = useState<{ workspaceName: string; username: string; role: WorkspaceRole; accountExists: boolean } | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => {
    if (demoMode) return
    const controller = new AbortController()
    apiRequest('invitations/preview', { method: 'POST', body: JSON.stringify({ token }), signal: controller.signal }).then(setInvitation).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [token])
  async function accept() {
    if (busy) return; setBusy(true); setError('')
    try { const workspace = await apiRequest('invitations/accept', { method: 'POST', body: JSON.stringify({ token }) }); await accepted(workspace.id) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <div className="invitation-page"><section className="panel invitation-banner"><h1>워크스페이스 초대</h1>{invitation && <><h2>{invitation.workspaceName}</h2><p><strong>{invitation.username}</strong> · {roleNames[invitation.role]}</p>{!account && <p>{invitation.accountExists ? '이미 계정이 준비되어 있습니다. 전달받은 아이디와 초기 비밀번호 또는 기존 비밀번호로 로그인하세요. 초기 비밀번호는 첫 로그인에서 변경합니다.' : '초대받은 아이디로 회원가입 후 초대를 수락하세요.'} Discord 연결은 참여 후 진행합니다.</p>}</>}{demoMode && <p>초대 수락은 운영 API가 연결된 웹에서 가능합니다.</p>}{error && <p className="inline-note error-note" role="alert">{error}</p>}{account && <><p>로그인한 계정: {account.username}</p><div className="flex gap-3"><button className="button primary" disabled={busy || !invitation || invitation.username !== account.username} onClick={() => void accept()}>초대 수락</button><button className="button secondary" onClick={() => void logout()}>다른 계정으로 로그인</button></div></>}</section>{!account && invitation && auth(invitation.accountExists)}</div>
}

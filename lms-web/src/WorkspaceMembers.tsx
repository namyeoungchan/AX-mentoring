import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Copy, Plus, RefreshCw } from 'lucide-react'
import { workspaceRequest, demoMode } from './api'
import { Badge, CardHeading } from './components'
import { roleNames, type WorkspaceRole } from './demoWorkspaces'

type Member = { id: string; username: string; name: string; role: WorkspaceRole }
type Invitation = { id: string; username: string; role: WorkspaceRole; expiresAt: number; acceptedAt: number | null; revokedAt: number | null }
export default function WorkspaceMembers({ workspaceId, platformAdmin }: { workspaceId: string; platformAdmin: boolean }) {
  const [state, setState] = useState<{ members: Member[]; invitations: Invitation[] }>({ members: [], invitations: [] })
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [link, setLink] = useState(''), [copied, setCopied] = useState(false)
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
      const result = await workspaceRequest(workspaceId, 'invitations', { method: 'POST', body: JSON.stringify({ username: form.get('username'), role: form.get('role') }) })
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
    <section className="panel membership-invite"><CardHeading title="구성원 초대" subtitle={platformAdmin ? '관리자 계정을 먼저 초대하면 해당 관리자가 강사를 초대하고 수강생 가입을 승인할 수 있습니다.' : '초대받은 사용자는 Discord 인증과 로그인 후 참여할 수 있습니다.'} />
      <form className="modal-form" onSubmit={invite}><fieldset disabled={busy || demoMode}><div className="form-row"><label>초대할 아이디<input name="username" required pattern="[a-z0-9][a-z0-9_.-]{3,31}" placeholder="가입할 아이디 또는 기존 아이디" maxLength={32} /></label><label>참여 권한<select name="role" defaultValue="instructor">{platformAdmin && <option value="admin">워크스페이스 관리자</option>}<option value="instructor">강사</option></select></label></div><button className="button primary" type="submit"><Plus size={16} />초대 링크 만들기</button></fieldset></form>
      {link && <div className="invitation-link" role="status"><label>초대 링크<input readOnly value={link} onFocus={e => e.target.select()} /></label><button className="button secondary" onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true) } catch { setError('초대 링크를 선택해서 복사하세요.') } }}><Copy size={15} />{copied ? '복사됨' : '링크 복사'}</button><p>7일 동안 한 번 사용할 수 있습니다. 초대할 사람에게 링크를 전달하세요.</p></div>}
    </section>
    <section className="panel"><CardHeading title="구성원"><button className="text-button" onClick={() => void refresh()}><RefreshCw size={14} />새로고침</button></CardHeading><div className="table-scroll"><table><thead><tr><th>이름</th><th>아이디</th><th>권한</th></tr></thead><tbody>{state.members.map(m => <tr key={m.id}><td>{m.name}</td><td>{m.username}</td><td><Badge>{roleNames[m.role]}</Badge></td></tr>)}</tbody></table></div>{!state.members.length && <p className="calendar-empty">참여한 구성원이 없습니다.</p>}</section>
    <section className="panel membership-history"><CardHeading title="초대 내역" /><div className="table-scroll"><table><thead><tr><th>아이디</th><th>권한</th><th>만료일</th><th>상태</th><th>관리</th></tr></thead><tbody>{state.invitations.map(i => <tr key={i.id}><td>{i.username}</td><td>{roleNames[i.role]}</td><td>{new Date(i.expiresAt).toLocaleDateString('ko-KR')}</td><td>{i.acceptedAt ? '참여 완료' : i.revokedAt ? '취소됨' : i.expiresAt <= clock ? '만료됨' : '대기 중'}</td><td>{!i.acceptedAt && !i.revokedAt && i.expiresAt > clock && (platformAdmin || i.role !== 'admin') && <button className="button secondary compact" disabled={busy} onClick={() => void revoke(i.id)}>초대 취소</button>}</td></tr>)}</tbody></table></div>{!state.invitations.length && <p className="calendar-empty">발급한 초대가 없습니다.</p>}</section>
  </>
}

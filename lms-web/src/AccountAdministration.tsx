import { useEffect, useState } from 'react'
import { apiRequest } from './api'
import { CardHeading, ModalShell } from './components'

type Account = { id: string; username: string; name: string; role: string; mustChangePassword: boolean; canDelete: boolean; memberships: { role: string; name: string }[] }
const roles: Record<string, string> = { admin: '관리자', instructor: '강사', student: '수강생' }
export default function AccountAdministration({ currentId, logout }: { currentId: string; logout: () => Promise<void> }) {
  const [accounts, setAccounts] = useState<Account[]>([]), [query, setQuery] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [reload, setReload] = useState(0)
  const [action, setAction] = useState<{ account: Account; kind: 'reset' | 'delete' } | null>(null)
  const [confirmation, setConfirmation] = useState(''), [initialPassword, setInitialPassword] = useState(''), [copied, setCopied] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    apiRequest('admin/accounts', { signal: controller.signal }).then(result => { setAccounts(result.accounts); setLoading(false) }).catch(e => { if (!controller.signal.aborted) { setError(e.message); setLoading(false) } })
    return () => controller.abort()
  }, [reload])
  async function submit() {
    if (!action || busy || confirmation !== action.account.username) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await apiRequest(`admin/accounts/${encodeURIComponent(action.account.id)}${action.kind === 'reset' ? '/reset-password' : ''}`, { method: action.kind === 'reset' ? 'POST' : 'DELETE', body: JSON.stringify({ username: confirmation }) })
      if (action.kind === 'reset') {
        setInitialPassword(result.initialPassword)
        if (action.account.id !== currentId) setReload(n => n + 1)
      } else {
        setAction(null); setNotice('계정을 삭제하고 기존 로그인과 소속을 해제했습니다.')
        if (result.signedOut) await logout()
        else setReload(n => n + 1)
      }
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  function close() {
    if (busy) return
    if (initialPassword && action?.account.id === currentId) { void logout(); return }
    setAction(null); setInitialPassword(''); setConfirmation(''); setCopied(false); setError('')
  }
  const filtered = accounts.filter(a => `${a.name} ${a.username}`.toLowerCase().includes(query.trim().toLowerCase()))
  return <section className="panel account-admin-panel">
    <CardHeading title="전체 계정 관리" subtitle="총관리자 전용 · 모든 워크스페이스의 로그인 계정을 관리합니다." />
    <div className="account-admin-controls"><label>계정 검색<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="이름 또는 아이디" /></label><span>전체 {accounts.length}명 · 검색 {filtered.length}명</span><button className="button secondary" disabled={busy} onClick={() => { setError(''); setReload(n => n + 1) }}>계정 목록 새로고침</button></div>
    {!action && error && <p role="alert" className="inline-note error-note">{error}</p>}{notice && <p role="status" className="inline-note">{notice}</p>}
    {loading ? <p className="inline-note">계정을 불러오는 중…</p> : <div className="table-scroll"><table><thead><tr><th>이름 · 아이디</th><th>권한 · 소속</th><th>비밀번호</th><th>관리</th></tr></thead><tbody>{filtered.map(account => <tr key={account.id}>
      <td><strong>{account.name}</strong><div>{account.username}{account.id === currentId && ' · 내 계정'}</div></td>
      <td>{account.role === 'admin' ? '총관리자' : account.memberships.length ? account.memberships.map((m, i) => <div key={i}>{m.name} · {roles[m.role]}</div>) : '소속 없음'}</td>
      <td>{account.mustChangePassword ? '초기 비밀번호 변경 대기' : '본인 비밀번호 사용'}</td>
      <td><div className="account-admin-actions"><button className="button secondary" disabled={busy} onClick={() => { setAction({ account, kind: 'reset' }); setConfirmation(''); setInitialPassword(''); setCopied(false); setError('') }}>초기 비밀번호 재설정</button><button className="button danger" disabled={busy || !account.canDelete} title={!account.canDelete ? '마지막 총관리자는 삭제할 수 없습니다.' : undefined} onClick={() => { setAction({ account, kind: 'delete' }); setConfirmation(''); setError('') }}>계정 삭제</button></div>{!account.canDelete && <small>마지막 총관리자 보호</small>}</td>
    </tr>)}</tbody></table>{!filtered.length && <p className="calendar-empty">표시할 계정이 없습니다.</p>}</div>}
    {action && <ModalShell title={action.kind === 'reset' ? '초기 비밀번호 재설정' : '계정 삭제'} busy={busy} close={close}>
      {initialPassword ? <div className="modal-form"><p role="status">새 초기 비밀번호를 발급했습니다. 다음 로그인에서 비밀번호를 변경해야 합니다.</p><p>이 화면을 닫으면 발급한 비밀번호를 다시 볼 수 없습니다.</p><label>전달할 계정 정보<textarea readOnly rows={3} value={`아이디: ${action.account.username}\n초기 비밀번호: ${initialPassword}\n로그인 후 본인 비밀번호로 변경하세요.`} /></label><button className="button secondary" onClick={() => { void navigator.clipboard.writeText(`아이디: ${action.account.username}\n초기 비밀번호: ${initialPassword}\n로그인 후 본인 비밀번호로 변경하세요.`).then(() => setCopied(true)).catch(() => setError('계정 정보를 직접 선택해 복사하세요.')) }}>{copied ? '복사 완료' : '계정 정보 복사'}</button>{error && <p role="alert">{error}</p>}<button className="button primary" onClick={close}>{action.account.id === currentId ? '초기 비밀번호 확인 후 다시 로그인' : '확인'}</button></div> : <form className="modal-form" onSubmit={e => { e.preventDefault(); void submit() }}><p><strong>{action.account.name} · {action.account.username}</strong></p><p>{action.kind === 'reset' ? '새 초기 비밀번호를 발급하고 기존 로그인을 모두 해제합니다. 발급한 비밀번호를 계정 소유자에게 전달하세요.' : '로그인 계정과 모든 워크스페이스 소속·가입 신청·인증을 삭제합니다. 출결·과제 운영 이력은 보존됩니다. 이 작업은 되돌릴 수 없습니다.'}</p>{action.account.id === currentId && <p>현재 로그인한 본인 계정입니다. 처리 후 다시 로그인해야 합니다.</p>}<label>확인할 계정 아이디<input required autoComplete="off" value={confirmation} disabled={busy} onChange={e => setConfirmation(e.target.value)} placeholder={action.account.username} /></label>{error && <p role="alert" className="error-text">{error}</p>}<div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={close}>취소</button><button className={`button ${action.kind === 'delete' ? 'danger' : 'primary'}`} disabled={busy || confirmation !== action.account.username}>{busy ? '처리 중…' : action.kind === 'reset' ? '새 초기 비밀번호 발급' : '계정 영구 삭제'}</button></div></form>}
    </ModalShell>}
  </section>
}

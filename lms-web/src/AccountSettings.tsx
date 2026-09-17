import { useState, type FormEvent } from 'react'
import { KeyRound } from 'lucide-react'
import { ModalShell } from './components'
import { apiRequest, setSessionToken } from './api'

export default function AccountSettings({ requiredChange = false, changed }: { requiredChange?: boolean; changed?: () => Promise<void> } = {}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const form = event.currentTarget, data = new FormData(form)
    const newPassword = String(data.get('newPassword'))
    setError('')
    if (newPassword !== data.get('confirmPassword')) { setError('비밀번호가 일치하지 않습니다.'); return }
    setBusy(true)
    try {
      const result = await apiRequest('auth/password', { method: 'POST', body: JSON.stringify({ currentPassword: data.get('currentPassword'), newPassword }) })
      setSessionToken(result.token || ''); form.reset(); setDone(true)
      await changed?.()
    } catch (failure) { setError((failure as Error).message) }
    finally { setBusy(false) }
  }
  const content = done ? <div className="modal-form"><p role="status">비밀번호를 변경했습니다. 다른 기기의 로그인은 해제되었습니다.</p>{requiredChange ? <button className="button primary" onClick={() => void changed?.()}>계속하기</button> : <button className="button primary" onClick={() => setOpen(false)}>닫기</button>}</div> : <form className="modal-form" onSubmit={submit}>
        <fieldset disabled={busy}>
          <label>{requiredChange ? '초기 비밀번호' : '현재 비밀번호'}<input name="currentPassword" type="password" autoComplete="current-password" required maxLength={128} /></label>
          <label>새 비밀번호<input name="newPassword" type="password" autoComplete="new-password" required minLength={8} maxLength={128} placeholder="8자 이상" /></label>
          <label>새 비밀번호 확인<input name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} maxLength={128} /></label>
          {error && <p role="alert" className="error-text">{error}</p>}
          <p>변경하면 다른 기기의 로그인이 해제됩니다.</p>
          <button className="button primary" type="submit">{busy ? '변경 중…' : '변경하기'}</button>
        </fieldset>
      </form>
  if (requiredChange) return <section className="panel initial-password-panel"><h1>초기 비밀번호 변경</h1><p>전달받은 초기 비밀번호를 본인만 아는 비밀번호로 변경하세요. 변경 후 서비스를 이용할 수 있습니다.</p>{content}</section>
  return <>
    <button className="text-button" onClick={() => { setOpen(true); setError(''); setDone(false) }}><KeyRound size={14} />비밀번호 변경</button>
    {open && <ModalShell title="비밀번호 변경" close={() => { if (!busy) setOpen(false) }}>{content}</ModalShell>}
  </>
}

import { useState, type FormEvent } from 'react'
import { workspaceRequest } from './api'
import { ModalShell } from './components'

type Student = { id: string; name: string; username: string; setupPending: number }

export default function StudentPasswordReset({ workspaceId, account, close, onReset }: {
  workspaceId: string
  account: Student
  close: () => void
  onReset: () => void
}) {
  const [confirmation, setConfirmation] = useState('')
  const [initialPassword, setInitialPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const credentials = [
    `아이디: ${account.username}`,
    `임시 비밀번호: ${initialPassword}`,
    account.setupPending ? '로그인 후 본인 이름과 새 비밀번호를 설정하세요.' : '로그인 후 본인 비밀번호로 변경하세요.',
  ].join('\n')

  async function reset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || confirmation !== account.username) return
    setBusy(true)
    setError('')
    try {
      const result = await workspaceRequest(workspaceId, `student-accounts/${encodeURIComponent(account.id)}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ username: confirmation }),
      })
      setInitialPassword(result.initialPassword)
      onReset()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function copyCredentials() {
    try {
      await navigator.clipboard.writeText(credentials)
      setCopied(true)
      setError('')
    } catch {
      setError('계정 정보를 직접 선택해 복사하세요.')
    }
  }

  return <ModalShell title={initialPassword ? '학생 비밀번호 재발급 완료' : '학생 비밀번호 초기화'} busy={busy} close={close}>
    {initialPassword ? <div className="modal-form">
      <p role="status">새 임시 비밀번호를 발급했습니다. 학생은 다시 로그인한 뒤 비밀번호를 변경해야 합니다.</p>
      <p>이 화면에서 비밀번호를 확인해 학생 본인에게 전달하세요. 화면을 닫으면 다시 확인할 수 없습니다.</p>
      <label>학생에게 전달할 계정 정보<textarea readOnly rows={4} value={credentials} /></label>
      <button className="button secondary" onClick={() => void copyCredentials()}>{copied ? '복사 완료' : '계정 정보 복사'}</button>
      {error && <p role="alert" className="error-text">{error}</p>}
      <button className="button primary" onClick={close}>전달 정보 확인 완료</button>
    </div> : <form className="modal-form" onSubmit={reset}>
      <fieldset disabled={busy}>
        <p><strong>{account.name}</strong> · {account.username}</p>
        <p>새 임시 비밀번호를 발급하고 이 학생의 기존 로그인을 모두 해제합니다. 다음 로그인에서 비밀번호를 변경해야 합니다.</p>
        <p>학생의 계정과 조 배정, Discord 인증, 출결·과제·멘토링 기록은 유지됩니다.</p>
        <label>확인할 학생 아이디<input required autoComplete="off" autoCapitalize="none" value={confirmation} onChange={event => setConfirmation(event.target.value)} placeholder={account.username} /></label>
        {error && <p role="alert" className="error-text">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={close}>취소</button>
          <button type="submit" className="button primary" disabled={confirmation !== account.username}>{busy ? '발급 중…' : '임시 비밀번호 발급'}</button>
        </div>
      </fieldset>
    </form>}
  </ModalShell>
}

import { useState, type FormEvent } from 'react'
import { apiRequest, setSessionToken } from './api'

export default function FirstLoginSetup({ name, username, changed }: { name: string; username: string; changed: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return
    const form = new FormData(event.currentTarget)
    if (form.get('newPassword') !== form.get('confirmation')) { setError('새 비밀번호가 일치하지 않습니다.'); return }
    setBusy(true); setError('')
    try {
      const result = await apiRequest('auth/first-login', { method: 'POST', body: JSON.stringify({ name: form.get('name'), currentPassword: form.get('currentPassword'), newPassword: form.get('newPassword') }) })
      setSessionToken(result.token || '')
      await changed()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="panel initial-password-panel first-login-panel">
    <span className="eyebrow">처음 시작하기</span><h1>내 정보와 비밀번호 설정</h1>
    <p>관리자가 발급한 계정입니다. 본인 이름을 입력하고 초기 비밀번호를 변경하면 학습 준비를 시작할 수 있습니다.</p>
    <ol className="first-login-steps"><li aria-current="step"><b>1</b>내 정보·비밀번호</li><li><b>2</b>Discord 참여·인증</li><li><b>3</b>학습 시작</li></ol>
    <form className="modal-form" onSubmit={submit}><fieldset disabled={busy}>
      <label>아이디<input readOnly value={username} autoComplete="username" /></label>
      <label>이름<input name="name" required maxLength={50} autoComplete="name" defaultValue={name === username ? '' : name} placeholder="수업에서 사용할 본인 이름" /></label>
      <label>초기 비밀번호<input name="currentPassword" required type="password" maxLength={128} autoComplete="current-password" /></label>
      <label>새 비밀번호<input name="newPassword" required type="password" minLength={8} maxLength={128} autoComplete="new-password" placeholder="8자 이상, 초기 비밀번호와 다르게" /></label>
      <label>새 비밀번호 확인<input name="confirmation" required type="password" minLength={8} maxLength={128} autoComplete="new-password" /></label>
      <p>과정과 조는 관리자가 미리 배정합니다. 설정을 완료하면 기존 로그인은 해제됩니다.</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      <button className="button primary" type="submit">{busy ? '저장 중…' : '설정 완료하고 시작하기'}</button>
    </fieldset></form>
  </section>
}

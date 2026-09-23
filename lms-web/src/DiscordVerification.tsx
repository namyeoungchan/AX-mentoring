import { useEffect, useRef, useState } from 'react'
import { workspaceRequest } from './api'

export default function DiscordVerification({ workspaceId, channelUrl, onVerified, verificationPath = 'me/verification' }: { workspaceId: string; channelUrl: string; onVerified: () => void; verificationPath?: string }) {
  const [challenge, setChallenge] = useState<{ code: string; expiresAt: number } | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [now, setNow] = useState(Date.now), [verified, setVerified] = useState(false)
  const done = useRef(onVerified)
  useEffect(() => { done.current = onVerified }, [onVerified])
  useEffect(() => {
    if (!challenge || verified) return
    const controller = new AbortController()
    const check = async () => {
      if (document.hidden) return
      setNow(Date.now())
      try {
        const result = await workspaceRequest(workspaceId, '', { signal: controller.signal })
        if (!controller.signal.aborted && result.discordVerified) { setVerified(true); done.current() }
      } catch (e) { if (!controller.signal.aborted) setError((e as Error).message) }
    }
    const timer = setInterval(() => void check(), 3000)
    window.addEventListener('focus', check)
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', check) }
  }, [workspaceId, challenge, verified])
  async function issue() {
    setBusy(true); setError(''); setNotice('')
    try { setChallenge(await workspaceRequest(workspaceId, verificationPath, { method: 'POST', body: '{}' })); setNow(Date.now()) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setNotice('복사했습니다. Discord에서 붙여넣으세요.'); setError('') }
    catch { setError('자동 복사를 사용할 수 없습니다. 표시된 코드를 선택해 복사하세요.') }
  }
  const expired = challenge && now >= challenge.expiresAt
  if (verified) return <p className="inline-note" role="status">이 워크스페이스의 LMS 인증을 완료했습니다.</p>
  return <div className="quick-verification">
    <p>본인의 Discord 계정을 연결합니다. Discord에서 LMS 아이디를 확인하고 승인하면 이 화면에 자동으로 반영됩니다.</p>
    {!challenge || expired ? <button className="button primary" disabled={busy} onClick={() => void issue()}>{busy ? '코드 준비 중…' : expired ? '인증 코드 다시 받기' : 'LMS 인증 시작'}</button> : <>
      <ol><li><strong>코드를 복사하세요.</strong><output aria-label="인증 코드">{challenge.code}</output><button className="button secondary" onClick={() => void copy(challenge.code)}>인증 코드 복사</button></li>
        <li><strong>Discord의 ‘1 · LMS 인증’을 누르고 코드를 붙여넣으세요.</strong><a className="button primary" href={channelUrl} target="_blank" rel="noreferrer">Discord에서 인증하기</a></li></ol>
      <details><summary>인증 버튼이 보이지 않나요?</summary><p>연결한 서버에서 아래 명령어를 실행하세요.</p><code>/lms인증 코드:{challenge.code}</code><button className="button secondary" onClick={() => void copy(`/lms인증 코드:${challenge.code}`)}>인증 명령어 복사</button></details>
      <p>인증 완료를 자동 확인하고 있습니다. 코드 만료: {new Date(challenge.expiresAt).toLocaleTimeString('ko-KR')}</p>
    </>}
    {expired && <p>코드가 만료되었습니다. 새 코드를 받아 주세요.</p>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="error-note">{error}</p>}
  </div>
}

import { useEffect, useState, type FormEvent } from 'react'
import { ArrowRight, BookOpen, Check, Copy, Eye, EyeOff, KeyRound, ShieldCheck } from 'lucide-react'
import { apiRequest, demoMode } from './api'

type Mode = 'login' | 'signup' | 'admin'
type Challenge = { ticket: string; code: string; expiresAt: number; state: 'pending' | 'verified' | 'expired' }
export default function AuthScreen({ login, error, enterDemo }: { login: (username: string, password: string, admin?: boolean) => Promise<void>; error: string; enterDemo: () => void }) {
  const [mode, setMode] = useState<Mode>(location.hash === '#signup' ? 'signup' : 'login')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [checking, setChecking] = useState(!demoMode)
  const [challenge, setChallenge] = useState<Challenge | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (demoMode) return
    const controller = new AbortController()
    apiRequest('auth/config', { signal: controller.signal }).then(result => setConfigured(result.registrationEnabled)).catch(() => {
      if (!controller.signal.aborted) setFailure('서비스에 연결하지 못했습니다. 잠시 후 새로고침해 주세요.')
    }).finally(() => { if (!controller.signal.aborted) setChecking(false) })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    if (!challenge || challenge.state !== 'pending') return
    const controller = new AbortController()
    let polling = false
    const timer = setInterval(() => setClock(Date.now()), 1000)
    const poll = setInterval(async () => {
      if (document.hidden || polling) return
      polling = true
      try {
        const result = await apiRequest('auth/registration/status', { method: 'POST', body: JSON.stringify({ ticket: challenge.ticket }), signal: controller.signal })
        if (!controller.signal.aborted) { setChallenge(current => current?.ticket === challenge.ticket ? { ...current, ...result } : current); setFailure('') }
      } catch { if (!controller.signal.aborted) setFailure('인증 상태를 확인하지 못했습니다. 아래 버튼으로 다시 확인해 주세요.') }
      finally { polling = false }
    }, 10000)
    return () => { controller.abort(); clearInterval(timer); clearInterval(poll) }
  }, [challenge])

  function changeMode(next: Mode) { setMode(next); setFailure(''); setShowPassword(false); setChallenge(null) }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || demoMode) return
    const form = event.currentTarget
    const fields = new FormData(form)
    const value = (key: string) => String(fields.get(key) || '')
    setFailure('')
    if (mode === 'signup' && value('password') !== value('confirmPassword')) { setFailure('비밀번호가 일치하지 않습니다.'); return }
    setBusy(true)
    try {
      if (mode === 'signup') {
        const result = await apiRequest('auth/register', { method: 'POST', body: JSON.stringify({ username: value('username'), name: value('name'), discordId: value('discordId'), password: value('password') }) })
        form.reset(); setClock(Date.now()); setChallenge({ ...result, state: 'pending' })
      } else await login(value('username'), value('password'), mode === 'admin')
    } catch (e) { setFailure((e as Error).message) }
    finally { setBusy(false) }
  }
  async function checkStatus(renew = false) {
    if (!challenge || busy) return
    setBusy(true); setFailure('')
    try {
      const result = await apiRequest(`auth/registration/${renew ? 'renew' : 'status'}`, { method: 'POST', body: JSON.stringify({ ticket: challenge.ticket }) })
      setChallenge({ ...challenge, ...result, state: renew ? 'pending' : result.state }); setClock(Date.now()); setCopied(false)
    } catch (e) { setFailure((e as Error).message) }
    finally { setBusy(false) }
  }
  const remaining = challenge ? Math.max(0, Math.ceil((challenge.expiresAt - clock) / 1000)) : 0
  const expired = challenge?.state === 'expired' || (challenge?.state === 'pending' && remaining === 0)
  return <div className="auth-page">
    <header className="auth-header"><a href="#login" onClick={() => changeMode('login')} className="auth-brand"><span><BookOpen size={21} /></span>AX <b>LearningOps</b></a><span>학습 관리 시스템</span></header>
    <main className="auth-layout">
      <section className="auth-intro"><span className="eyebrow">LEARNING MANAGEMENT</span><h1>학습 계정으로<br />로그인하세요.</h1><p>과정과 과제를 확인하고<br />나의 출결과 성적을 조회합니다.</p><div className="auth-discord"><ShieldCheck size={24} /><div><h2>Discord로 가입 인증</h2><p>교육 서버에 참여한 본인의 Discord 계정을 연결합니다.</p></div></div><ol className="auth-steps"><li><span>01</span>가입 정보 입력</li><li><span>02</span>Discord 봇에 인증 코드 제출</li><li><span>03</span>LMS 로그인</li></ol></section>
      <section className="auth-card" aria-label="계정 인증">
        {challenge ? <>
          <div className={`auth-status-icon ${challenge.state === 'verified' ? 'verified' : ''}`}>{challenge.state === 'verified' ? <Check size={28} /> : <ShieldCheck size={28} />}</div>
          <h2>{challenge.state === 'verified' ? '가입 인증 완료' : 'Discord 계정 인증'}</h2>
          {challenge.state === 'verified' ? <><p className="auth-description">가입한 아이디와 비밀번호로 로그인하세요.</p><button className="button primary auth-submit" onClick={() => changeMode('login')}>로그인으로 이동 <ArrowRight size={16} /></button></> : <>
            <p className="auth-description">교육 Discord 서버에서 아래 명령어를 실행하세요. 가입 시 입력한 계정으로 인증해야 합니다.</p>
            <div className="auth-code"><span>일회용 인증 코드</span><output aria-label="인증 코드">{challenge.code}</output><button className="text-button" onClick={async () => { try { await navigator.clipboard.writeText(`/lms인증 코드:${challenge.code}`); setCopied(true) } catch { setFailure('코드를 직접 복사해 주세요.') } }}><Copy size={14} />{copied ? '복사됨' : '명령어 복사'}</button></div>
            <p className="auth-command">/lms인증 코드:{challenge.code}</p><p className={`auth-expiry ${expired ? 'error-text' : ''}`} role="status">{expired ? '코드가 만료됐습니다. 새 코드를 발급받아 주세요.' : `남은 시간 ${Math.floor(remaining / 60)}분 ${remaining % 60}초`}</p>
            <button className="button primary auth-submit" disabled={busy} onClick={() => void checkStatus()}>인증 상태 확인 <ArrowRight size={16} /></button><button className="text-button auth-renew" disabled={busy} onClick={() => void checkStatus(true)}>코드 재발급</button>
          </>}
          {failure && <p className="auth-error" role="alert">{failure}</p>}
          <button className="auth-back" onClick={() => changeMode('login')}>로그인으로 돌아가기</button>
        </> : <>
          {mode !== 'admin' && <div className="auth-tabs" aria-label="계정 메뉴"><button className={mode === 'login' ? 'selected' : ''} aria-pressed={mode === 'login'} onClick={() => changeMode('login')}>로그인</button><button className={mode === 'signup' ? 'selected' : ''} aria-pressed={mode === 'signup'} onClick={() => changeMode('signup')}>회원가입</button></div>}
          <h2>{mode === 'signup' ? 'LMS 회원가입' : mode === 'admin' ? '관리자 로그인' : 'LMS 로그인'}</h2><p className="auth-description">{mode === 'signup' ? '계정을 만들고 Discord에서 가입을 인증하세요.' : mode === 'admin' ? '운영자 전용 계정으로 접속합니다.' : 'Discord 인증을 마친 계정으로 접속하세요.'}</p>
          {demoMode && <p className="auth-demo-note">현재 데모 사이트입니다. 실제 로그인과 가입 인증은 서비스 연결 후 사용할 수 있습니다.</p>}
          {!demoMode && mode === 'signup' && !configured && <p className="auth-demo-note">{checking ? '가입 가능 여부 확인 중…' : 'Discord 가입 인증을 준비 중입니다. 운영자에게 문의해 주세요.'}</p>}
          <form onSubmit={submit} key={mode}>
            <fieldset disabled={busy}>
              {mode === 'signup' && <label>이름<input name="name" autoComplete="name" required maxLength={50} placeholder="이름" /></label>}
              {mode !== 'admin' && <label>아이디<input name="username" autoComplete="username" required minLength={4} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{3,31}" placeholder="영문·숫자 4~32자" autoCapitalize="none" spellCheck={false} /></label>}
              {mode === 'signup' && <label>Discord 사용자 ID<input name="discordId" aria-label="Discord 사용자 ID" inputMode="numeric" required pattern="[0-9]{17,20}" placeholder="17~20자리 숫자" /><small>Discord 설정 → 고급 → 개발자 모드 활성화 후, 내 프로필에서 사용자 ID를 복사하세요.</small></label>}
              <label>{mode === 'admin' ? '관리자 비밀번호' : '비밀번호'}<span className="auth-password"><input name="password" aria-label={mode === 'admin' ? '관리자 비밀번호' : '비밀번호'} type={showPassword ? 'text' : 'password'} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required minLength={mode === 'signup' ? 12 : 1} maxLength={128} placeholder={mode === 'signup' ? '12자 이상' : '비밀번호 입력'} /><button type="button" aria-label={showPassword ? '비밀번호 숨기기' : '비밀번호 표시'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></span></label>
              {mode === 'signup' && <label>비밀번호 확인<input name="confirmPassword" type={showPassword ? 'text' : 'password'} autoComplete="new-password" required minLength={12} maxLength={128} placeholder="비밀번호 다시 입력" /></label>}
              {(failure || error) && <p className="auth-error" role="alert">{failure || error}</p>}
              <button className="button primary auth-submit" type="submit" disabled={demoMode || busy || (mode === 'signup' && !configured)}>{busy ? '처리 중…' : mode === 'signup' ? '인증 코드 받기' : '로그인'}<ArrowRight size={16} /></button>
            </fieldset>
          </form>
          {mode === 'admin' ? <button className="auth-back" onClick={() => changeMode('login')}>수강생 로그인으로 돌아가기</button> : <button className="auth-back" onClick={() => changeMode('admin')}><KeyRound size={13} />관리자 로그인</button>}
          {demoMode && <button className="button secondary auth-submit" onClick={enterDemo}>데모 둘러보기 <ArrowRight size={15} /></button>}
        </>}
      </section>
    </main><footer className="auth-footer">AX LearningOps</footer>
  </div>
}

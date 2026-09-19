import { useEffect, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, ShieldCheck } from 'lucide-react'
import { apiRequest } from './api'

type Props = { workspaceName: string; verificationPath: string; inviteUrl?: string | null; inviteState?: string; inviteExpires?: number | null; renewPath?: string; archived?: boolean; refreshInvitation: () => Promise<void>; refreshWorkspace: () => Promise<void> }
type Code = { ticket: string; code: string; expiresAt: number }

export default function DiscordJoinGuide({ workspaceName, verificationPath, inviteUrl, inviteState, inviteExpires, renewPath, archived, refreshInvitation, refreshWorkspace }: Props) {
  const [code, setCode] = useState<Code | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [copied, setCopied] = useState(false), [clock, setClock] = useState(Date.now), [retryAt, setRetryAt] = useState(0)
  const codeOutput = useRef<HTMLOutputElement>(null)
  useEffect(() => { if (code) codeOutput.current?.focus() }, [code])
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer) }, [])
  const remaining = code ? Math.max(0, Math.ceil((code.expiresAt - clock) / 1000)) : 0
  const retry = Math.max(0, Math.ceil((retryAt - clock) / 1000)), disabled = busy || retry > 0 || archived
  const usableInvite = inviteUrl && (!inviteExpires || inviteExpires > clock)
  async function run(action: () => Promise<void>) {
    if (busy || retry > 0) return
    setBusy(true); setError(''); setNotice('')
    try { await action() }
    catch (e) { const failure = e as Error & { retryAfter?: number }; setError(failure.message); if (failure.retryAfter) setRetryAt(Date.now() + failure.retryAfter * 1000) }
    finally { setBusy(false) }
  }
  async function issue() {
    await run(async () => { setCode(await apiRequest(verificationPath, { method: 'POST', body: '{}' })); setCopied(false); setClock(Date.now()) })
  }
  async function copy() {
    if (!code || !remaining) return
    try { await navigator.clipboard.writeText(code.code); setCopied(true); setError('') }
    catch { setError('복사 버튼을 사용할 수 없습니다. 표시된 인증 코드를 직접 선택해 복사하세요.') }
  }
  async function check() {
    await run(async () => {
      if (code) {
        const status = await apiRequest('auth/registration/status', { method: 'POST', body: JSON.stringify({ ticket: code.ticket }) })
        if (status.state !== 'verified') { setNotice(status.state === 'expired' ? '인증을 아직 완료하지 않았다면 새 코드를 받아 주세요. 이미 완료했다면 Discord 시작하기의 공용 버튼으로 자기소개를 이어가세요.' : '아직 인증이 확인되지 않았습니다. Discord에서 코드 입력 후 본인 계정 확인까지 완료하세요.'); return }
      }
      await refreshWorkspace()
    })
  }
  return <section className="discord-join-guide" aria-label="Discord 계정 인증">
    <header className="discord-guide-heading"><ShieldCheck size={24} /><div><h3>Discord 연결하고 학습 시작하기</h3><p>{workspaceName} · 이 웹 화면을 열어 둔 채 순서대로 진행하세요.</p></div></header>
    <div className="discord-guide-required"><strong>자기소개 제출까지 완료해 주세요</strong><p>수강생은 LMS 인증 후 자기소개까지 제출해야 Discord 역할과 별명이 적용되고, 배정된 조의 학습 채널이 열립니다.</p></div>
    {archived && <p className="error-note">보관된 워크스페이스입니다. 운영자에게 문의하세요.</p>}
    <ol className="discord-guide-steps">
      <li><span className="discord-step-number">1</span><div><h4>초대 링크로 수업 서버에 참여하세요</h4><p>본인이 사용할 Discord 계정으로 로그인한 뒤 초대를 수락하세요.</p>
        {usableInvite ? <a className="button primary" href={inviteUrl!} target="_blank" rel="noreferrer">1 · Discord 서버 참여 <ExternalLink size={15} /></a> : ['queued','running'].includes(inviteState || '') ? <p className="discord-invite-pending" role="status" aria-label="서버 초대 상태">서버 초대 링크를 발급하고 있습니다. 준비되면 여기에 참여 버튼이 표시됩니다.</p> : renewPath ? <><p>초대 링크가 만료됐거나 발급하지 못했습니다.</p><button className="button secondary" disabled={disabled} onClick={() => void run(async () => { await apiRequest(renewPath, { method: 'POST', body: '{}' }); await refreshInvitation() })}>초대 링크 재발급</button></> : <p>서버에 이미 참여했다면 다음 단계로 진행하세요. 초대 링크가 필요하면 운영자에게 요청하세요.</p>}
      </div></li>
      <li><span className="discord-step-number">2</span><div><h4>이 웹페이지에서 인증 코드를 복사하세요</h4><p>코드는 본인 계정 연결용입니다. 다른 사람에게 공유하지 마세요.</p>
        {code && <div className="discord-code-box"><output ref={codeOutput} tabIndex={-1} aria-label="인증 코드">{code.code}</output><button className="button secondary" disabled={!remaining || busy} onClick={() => void copy()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? '복사됨' : '인증 코드 복사'}</button></div>}
        {code && <p className="discord-code-expiry">{remaining ? `유효시간 ${Math.floor(remaining / 60)}분 ${remaining % 60}초 · 이 코드를 그대로 입력하세요.` : '코드의 유효시간이 지났습니다. 인증을 이미 완료했다면 다시 발급할 필요가 없습니다.'}</p>}
        {(!code || !remaining) && <button className="button primary" disabled={disabled} onClick={() => void issue()}>{busy ? '코드 준비 중…' : code ? '만료된 코드 다시 받기' : 'Discord 인증 코드 받기'}</button>}
      </div></li>
      <li><span className="discord-step-number">3</span><div><h4>Discord 인증 패널에 코드를 입력하세요</h4><p>Discord로 이동해 <strong>시작하기</strong> 채널의 <strong>1 · LMS 인증</strong>을 누르세요. <strong>본인에게만 보이는 인증 안내</strong>가 열리면 그 안의 <strong>1 · LMS 인증</strong> 버튼에 코드를 입력하세요.</p>
        <div className="discord-panel-example" aria-label="Discord 패널 이용 안내"><span className="discord-panel-caption">Discord 화면에서 진행</span><strong># 시작하기</strong><span className="discord-example-button">1 · LMS 인증</span><span>본인 전용 안내 → 1 · LMS 인증 → 코드 붙여넣기 → 제출</span></div>
        <p>표시된 계정이 본인인지 확인하고 <strong>내 계정 가입 인증</strong>을 누르세요. 인증을 마치면 다음 단계의 자기소개를 작성하세요.</p>
      </div></li>
      <li><span className="discord-step-number">4</span><div><h4>자기소개를 작성하고 제출하세요 · 필수</h4><p>같은 <strong>시작하기</strong> 채널에서 공용 버튼을 눌러 개인 안내를 열고, <strong>2 · 자기소개 작성</strong>에서 이름과 자기소개를 입력한 뒤 <strong>제출</strong>하세요.</p><p>완료된 LMS 인증은 코드가 만료돼도 유지됩니다. 개인 안내 버튼이 만료됐다면 공용 버튼을 다시 누르세요. 코드를 재발급할 필요가 없습니다.</p><p>제출 후 Discord 역할·별명과 배정된 조의 학습 채널을 확인하세요. 이미 제출했다면 잠시 기다려 주세요. 계속 반영되지 않으면 운영자에게 문의하세요.</p>
      </div></li>
    </ol>
    <footer className="discord-guide-footer"><div><strong>인증과 자기소개 제출을 모두 마쳤나요?</strong><p>Discord에서 역할·별명 적용을 확인한 뒤 학습 화면으로 이동하세요.</p></div><button className="button primary" disabled={disabled} onClick={() => void check()}>인증 후 학습 화면 열기</button></footer>
    {error && <p className="error-note" role="alert">{error}</p>}{retry > 0 && <p role="status">{retry}초 후 다시 시도할 수 있습니다.</p>}{notice && <p className="inline-note" role="status">{notice}</p>}
  </section>
}

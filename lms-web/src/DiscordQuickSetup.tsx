import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { workspaceRequest, apiRequest, demoMode } from './api'
import { Badge, CardHeading } from './components'
import GroupSetup from './GroupSetup'
import DiscordVerification from './DiscordVerification'

type Provision = {
  enabled: boolean; worker: { id: string; connected: boolean } | null
  template: { revision: string } | null; boundGuildIds: string[]
  plans: { guildId: string; revision: string }[]
  guilds: { id: string; name: string; connected: boolean }[]
  jobs: { id: string; guildId: string; state: string; errorCode: string | null; results: { id: string; discordId: string }[] }[]
}
type State = { provision: Provision; groups: { courseId: string; teams: { courseId: string }[] }; workspace: { name: string; discordVerified: boolean; archivedAt: number | null }; personal: boolean }
const steps = ['조 구성', '서버 연결', '앱 초대·구축', '내 LMS 인증']
const failures: Record<string, string> = { forbidden: 'Discord에서 앱의 채널·역할 관리 권한과 역할 순서를 확인하세요.', missing_guild: '선택한 서버에 앱을 초대하세요.', conflict: '같은 이름의 채널이 중복됐는지 확인하세요.', timeout: '응답 시간이 초과됐습니다. Discord의 생성 결과를 확인한 뒤 다시 시도하세요.', api_error: 'Discord 연결 오류입니다. 잠시 후 다시 시도하세요.' }
function serverId(value: string) {
  const input = value.trim()
  if (/^\d{17,20}$/.test(input)) return input
  try {
    const url = new URL(input)
    if (url.protocol === 'https:' && ['discord.com', 'ptb.discord.com', 'canary.discord.com'].includes(url.hostname) && !url.username && !url.password && !url.port) {
      const match = url.pathname.match(/^\/channels\/(\d{17,20})\/(\d{17,20})(?:\/\d{17,20})?\/?$/)
      if (match) return match[1]
    }
  } catch { /* Show the same actionable validation for every unsupported input. */ }
  throw new Error('Discord 채널 링크(https://discord.com/channels/…) 또는 17~20자리 서버 ID를 입력하세요. 초대 링크는 사용할 수 없습니다.')
}
export default function DiscordQuickSetup({ workspaceId, advanced }: { workspaceId: string; advanced: () => void }) {
  const [state, setState] = useState<State | null>(null), [selected, setSelected] = useState<number | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (demoMode) return
    try {
      const [provision, groups, workspace, account] = await Promise.all([workspaceRequest(workspaceId, 'discord/provision', { signal }), workspaceRequest(workspaceId, 'discord/groups', { signal }), workspaceRequest(workspaceId, '', { signal }), apiRequest('auth/me', { signal })])
      if (!signal?.aborted) setState({ provision, groups, workspace, personal: account.user.id !== 'admin' })
    } catch (e) { if (!signal?.aborted) setError((e as Error).message) }
  }, [workspaceId])
  useEffect(() => {
    const controller = new AbortController()
    // eslint-disable-next-line react/set-state-in-effect -- Read persisted setup progress from the API on mount.
    void refresh(controller.signal)
    const check = () => { if (!document.hidden) void refresh(controller.signal) }
    const timer = setInterval(check, 5000)
    window.addEventListener('focus', check)
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', check) }
  }, [refresh])
  const p = state?.provision, guildId = p?.boundGuildIds[0] || ''
  const groupsReady = !!state?.groups.courseId && state.groups.teams.some(t => t.courseId === state.groups.courseId)
  const guild = p?.guilds.find(g => g.id === guildId), job = p?.jobs.find(j => j.guildId === guildId)
  const built = job?.state === 'succeeded' && !!guild?.connected
  const complete = [groupsReady, !!guildId, built, !!state?.workspace.discordVerified]
  const next = complete.findIndex(value => !value), step = selected ?? (next < 0 ? 3 : next)
  const channel = job?.state === 'succeeded' ? job.results.find(r => r.id === 'start')?.discordId : ''
  const channelUrl = `https://discord.com/channels/${guildId}${channel ? `/${channel}` : ''}`
  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!p?.template || busy) return
    const form = new FormData(event.currentTarget)
    setBusy(true); setError(''); setNotice('')
    try {
      await workspaceRequest(workspaceId, 'discord/provision/servers', { method: 'POST', body: JSON.stringify({ guildId: serverId(String(form.get('server'))), templateRevision: p.template.revision }) })
      await refresh(); setSelected(null); setNotice('서버를 연결했습니다. 다음으로 이 서버에 앱을 초대하세요.')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function retry() {
    const plan = p?.plans.find(plan => plan.guildId === guildId)
    if (!plan || busy) return
    setBusy(true); setError('')
    try { await workspaceRequest(workspaceId, 'discord/provision/jobs', { method: 'POST', body: JSON.stringify({ guildId, revision: plan.revision }) }); await refresh() }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="discord-quick" aria-label="Discord 빠른 설정">
    <section className="panel quick-overview"><CardHeading title="Discord 빠른 설정" subtitle={`${state?.workspace.name || '선택한 워크스페이스'} · 기본 채널과 역할을 자동으로 준비합니다.`}><button className="button secondary" onClick={advanced}>상세 설정 열기</button></CardHeading>
      <ol className="quick-steps">{steps.map((label, index) => <li key={label}><button aria-current={step === index ? 'step' : undefined} disabled={busy || index > Math.max(0, next < 0 ? 3 : next)} onClick={() => setSelected(index)}><span>{complete[index] ? '✓' : index + 1}</span>{label}<small>{complete[index] ? '완료' : step === index ? '진행할 단계' : '대기'}</small></button></li>)}</ol>
      <p>완료한 단계는 저장됩니다. 화면을 다시 열면 이어서 진행할 수 있습니다.</p>
      {demoMode && <p>데모에서는 연결할 수 없습니다. 실제 워크스페이스로 로그인하세요.</p>}
      {error && <p role="alert" className="inline-note error-note">{error}</p>}{notice && <p role="status" className="inline-note">{notice}</p>}
    </section>
    <fieldset className="quick-stage" disabled={busy || demoMode || state?.workspace.archivedAt != null}>
      {step === 0 && <><GroupSetup workspaceId={workspaceId} onSaved={() => { void refresh(); setNotice('조 구성을 저장했습니다. 서버 연결로 이어서 진행하세요.'); setSelected(null) }} />{groupsReady && <button className="button primary" onClick={() => setSelected(null)}>다음 단계</button>}</>}
      {step === 1 && <section className="panel quick-stage-content"><h2>2. Discord 서버 연결</h2><p>사용할 서버가 있다면 그대로 연결하세요. 새 서버는 Discord의 왼쪽 <strong>+ → 직접 만들기</strong>에서 준비하세요.</p><a className="button secondary" href="https://discord.com/app" target="_blank" rel="noreferrer">Discord 열기</a><form className="modal-form" onSubmit={connect}><label>Discord 채널 링크 또는 서버 ID<input name="server" required maxLength={250} placeholder="https://discord.com/channels/서버/채널" disabled={!!guildId} /></label><p>브라우저에서 서버의 채널을 열고 주소를 복사하거나, Discord에서 채널을 우클릭해 ‘링크 복사’를 선택하세요.</p><button className="button primary" disabled={!p?.template || !!guildId}>서버 연결하고 계속</button></form><details><summary>서버 ID로 연결하려면</summary><p>Discord 사용자 설정 → 고급 → 개발자 모드를 켜고, 서버 아이콘을 우클릭해 서버 ID를 복사하세요.</p></details>{guildId && <><p>연결된 서버: {guildId}</p><button className="button primary" onClick={() => setSelected(null)}>다음 단계</button></>}</section>}
      {step === 2 && <section className="panel quick-stage-content"><h2>3. 앱 초대 및 자동 구축</h2><p>연결된 서버: {guildId}</p><p>Discord에서 서버 관리 권한이 있는 계정으로 설치를 승인하세요. 승인 후 이 화면으로 돌아오면 연결 상태를 자동 확인합니다.</p>
        {p?.worker?.id ? <a className="button primary" href={`https://discord.com/oauth2/authorize?client_id=${p.worker.id}&scope=bot%20applications.commands&permissions=2251800216456273&guild_id=${guildId}&disable_guild_select=true`} target="_blank" rel="noreferrer">이 서버에 앱 초대</a> : <p className="inline-note">앱 정보를 기다리고 있습니다. 운영자에게 봇 실행 및 LMS 연결 상태 확인을 요청하세요.</p>}
        <p><Badge tone={guild?.connected ? 'green' : 'orange'}>{guild?.connected ? `${guild.name} · 앱 연결 확인` : '앱 연결 대기'}</Badge></p>
        {job?.state === 'failed' ? <><p role="alert" className="error-note">{failures[job.errorCode || ''] || '구축에 실패했습니다. 상세 설정에서 결과를 확인하세요.'}</p><button className="button secondary" disabled={!p?.enabled} onClick={() => void retry()}>구축 다시 시도</button></> : <p>{job?.state === 'running' ? '채널과 역할을 만들고 있습니다.' : job?.state === 'succeeded' ? '채널 구축 완료 · 앱 연결을 확인하고 있습니다.' : '앱이 참여하면 기본 채널과 역할을 자동으로 만듭니다.'}</p>}
        <button className="button secondary" onClick={() => void refresh()}>연결 상태 확인</button>{built && <button className="button primary" onClick={() => setSelected(null)}>LMS 인증으로 계속</button>}
      </section>}
      {step === 3 && <section className="panel quick-stage-content"><h2>4. 내 LMS 인증</h2>{state?.workspace.discordVerified ? <><p role="status" className="inline-note">Discord 연결과 LMS 인증을 완료했습니다.</p><a className="button primary" href={channelUrl} target="_blank" rel="noreferrer">학습 서버 열기</a><p>이제 구성원 · 초대에서 멘토를 초대하고 가입 승인에서 수강생을 배정하세요.</p></> : state?.personal ? <DiscordVerification workspaceId={workspaceId} channelUrl={channelUrl} onVerified={() => void refresh()} /> : <p>공용 개발 관리자 계정은 개인 Discord 계정과 연결하지 않습니다. 초대받은 개인 관리자 계정으로 로그인해 인증하세요.</p>}</section>}
    </fieldset>
  </section>
}

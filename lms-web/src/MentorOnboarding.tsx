import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { demoMode, workspaceRequest } from './api'
import type { useWorkspace } from './useWorkspace'
import DiscordVerification from './DiscordVerification'
import { ArrowRight, Check, CheckCircle2, ChevronDown, ExternalLink, LoaderCircle, RefreshCw, Users } from 'lucide-react'

type State = { profile: { name: string; expertise: string; bio: string; steps: string[] } | null; guildId: string; verified: boolean; mentorType: string; teamIds: string[]; teams: { id: string; name: string }[]; invitation: { inviteUrl: string | null; inviteState: string; inviteExpires: number | null } | null; guides: { id: string; title: string; text: string }[] }
const stages = ['기본 정보', 'Discord 연결', '업무 안내']

function ProfileForm({ initial, name, busy, save }: { initial: State['profile']; name: string; busy: boolean; save: (body: object) => Promise<boolean> }) {
  const [draft, setDraft] = useState({ name: initial?.name || name, expertise: initial?.expertise || '' })
  const [saved, setSaved] = useState(initial ? { name: initial.name, expertise: initial.expertise } : null)
  const dirty = !saved || draft.name !== saved.name || draft.expertise !== saved.expertise
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (await save(draft)) setSaved({ ...draft })
  }
  return <form className="mentor-profile-form" onSubmit={submit}>
    <fieldset disabled={busy || demoMode}>
      <label>활동 이름<input name="name" required maxLength={50} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} autoComplete="name" /><small>Discord에서 멘토_{draft.name.trim() || '활동이름'}으로 표시됩니다.</small></label>
      <label>전문 분야<input name="expertise" required maxLength={150} value={draft.expertise} onChange={e => setDraft({ ...draft, expertise: e.target.value })} placeholder="예: AI 활용, 데이터 분석" /><small>수강생이 멘토링을 신청할 때 참고하는 정보입니다.</small></label>
      <div className="mentor-form-footer"><span>{dirty ? '저장하면 다음 단계로 이어집니다.' : '저장된 정보입니다. 언제든 수정할 수 있어요.'}</span><button className="button primary" disabled={!draft.name.trim() || !draft.expertise.trim()} aria-busy={busy}>{busy ? <LoaderCircle size={16} className="membership-spinner" /> : <ArrowRight size={16} />}{busy ? '저장 중…' : '기본 정보 저장'}</button></div>
    </fieldset>
  </form>
}

export default function MentorOnboarding({ workspace }: { workspace: ReturnType<typeof useWorkspace> }) {
  const { activeId, account, data, refreshQuietly } = workspace
  const [state, setState] = useState<State | null>(null), [error, setError] = useState(''), [loadError, setLoadError] = useState(''), [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(''), [selected, setSelected] = useState<number | null>(null), [openGuide, setOpenGuide] = useState<string | null>(null)
  const [inviteBusy, setInviteBusy] = useState(false), [checking, setChecking] = useState(false), [clock, setClock] = useState(Date.now)
  const pending = useRef<{ id: object; signal?: AbortSignal; promise: Promise<State | undefined> } | null>(null)
  const attempted = useRef(false), mutation = useRef(0), acting = useRef(false), panel = useRef<HTMLDivElement>(null)
  const verifiedPreviously = useRef<boolean | null>(null)
  const refresh = useCallback((signal?: AbortSignal): Promise<State | undefined> => {
    if (demoMode) return Promise.resolve(undefined)
    if (pending.current && !pending.current.signal?.aborted) return pending.current.promise
    const version = mutation.current
    const id = {}
    const requestSignal = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
    const promise: Promise<State | undefined> = (async () => {
    try {
      const result: State = await workspaceRequest(activeId, 'staff/onboarding', { signal: requestSignal() })
      if (signal?.aborted || version !== mutation.current || acting.current) return
      if (result.verified && verifiedPreviously.current === false) {
        setSelected(current => current === 1 ? null : current)
        setNotice('Discord 인증을 완료했습니다. 이제 멘토 업무 안내를 확인하세요.')
      }
      verifiedPreviously.current = result.verified
      setState(result); setClock(Date.now()); setLoadError('')
      if (result.guildId && !result.verified && !result.invitation && !attempted.current) {
        attempted.current = true; setInviteBusy(true)
        try {
          const next = await workspaceRequest(activeId, 'staff/invite', { method: 'POST', body: '{}', signal: requestSignal() })
          if (!signal?.aborted && version === mutation.current && !acting.current) setState(next)
        } finally { if (!signal?.aborted) setInviteBusy(false) }
      }
      return result
    } catch (e) { if (!signal?.aborted) setLoadError((e as Error).message) }
    finally { if (pending.current?.id === id) pending.current = null }
    })()
    pending.current = { id, signal, promise }
    return promise
  }, [activeId])
  useEffect(() => {
    const controller = new AbortController(), check = () => { if (!document.hidden) void refresh(controller.signal) }
    // eslint-disable-next-line react/set-state-in-effect -- Load persisted onboarding and invitation progress.
    void refresh(controller.signal)
    const timer = setInterval(check, 3000)
    window.addEventListener('focus', check)
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', check) }
  }, [refresh])

  const profileReady = !!state?.profile, verified = !!state?.verified
  const reviewed = state?.profile?.steps || [], guides = state?.guides || []
  const finished = profileReady && verified && guides.length > 0 && guides.every(g => reviewed.includes(g.id))
  const complete = [profileReady, verified, finished], completed = complete.filter(Boolean).length
  const stage = selected ?? (!profileReady ? 0 : !verified ? 1 : 2)
  const nextGuide = guides.find(g => !reviewed.includes(g.id))?.id
  const expandedGuide = openGuide ?? nextGuide
  const usableInvite = !!state?.invitation?.inviteUrl && (!state.invitation.inviteExpires || state.invitation.inviteExpires > clock)
  const inviting = inviteBusy || busy === 'invite' || ['queued', 'running'].includes(state?.invitation?.inviteState || '')
  const previousStage = useRef(stage)
  useEffect(() => {
    if (previousStage.current === stage) return
    previousStage.current = stage
    panel.current?.focus({ preventScroll: true })
    panel.current?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }, [stage])
  async function action(path: string, body: object = {}) {
    if (acting.current || demoMode) return false
    acting.current = true; mutation.current++; setBusy(path); setError(''); setNotice('')
    try {
      const result: State = await workspaceRequest(activeId, `staff/${path}`, { method: 'POST', body: JSON.stringify(body) })
      setState(result); setClock(Date.now())
      if (path === 'profile') { setNotice('기본 정보를 저장했습니다. Discord 연결을 이어서 진행하세요.'); setSelected(null) }
      if (path === 'invite') setNotice('초대 링크를 요청했습니다. 준비되면 참여 버튼이 표시됩니다.')
      if (path === 'step') { setNotice(`${result.profile?.steps.length || 0} / ${result.guides.length} 안내를 확인했습니다.`); setOpenGuide(null) }
      return true
    } catch (e) { setError((e as Error).message); return false }
    finally { mutation.current++; acting.current = false; setBusy('') }
  }
  async function check() {
    if (checking) return
    setChecking(true)
    try { const result = await refresh(); if (result) setNotice(result.verified ? 'Discord 인증 완료를 확인했습니다.' : '현재 상태를 확인했습니다. Discord에서 인증을 완료하면 자동으로 반영됩니다.') }
    finally { setChecking(false) }
  }
  async function assignment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (acting.current) return
    const element = event.currentTarget, form = new FormData(element), course = data.courses.find(c => c.id === form.get('courseId'))
    if (!course) return
    acting.current = true; mutation.current++; setBusy('assignment'); setError(''); setNotice('')
    try {
      // Verification can change the workspace revision while onboarding is open.
      // Fetch the current revision and submit only this new assignment.
      const current = await workspaceRequest(activeId, 'teaching')
      await workspaceRequest(activeId, 'teaching', { method: 'PATCH', body: JSON.stringify({ revision: current.revision, changes: [{ kind: 'assignments', value: { id: crypto.randomUUID(), title: String(form.get('title')).trim(), course: course.title, courseId: course.id, due: String(form.get('due')), submitted: 0, total: course.learners, status: '진행 중' } }] }) })
      element.reset(); setNotice('과제를 생성했습니다. 수업 현황에서 확인할 수 있습니다.')
      await refreshQuietly()
    } catch (e) { setError((e as Error).message) }
    finally { mutation.current++; acting.current = false; setBusy('') }
  }
  return <section className="mentor-onboarding" aria-label="멘토 온보딩">
    <header className="mentor-welcome"><div><span className="mentor-kicker">MENTOR SETUP</span><h2>{finished ? '멘토 활동 준비를 마쳤어요' : `${account?.name || '멘토'}님, 활동을 준비해 볼까요`}</h2><p>{finished ? '저장한 정보와 업무 안내는 이곳에서 다시 확인할 수 있습니다.' : '기본 정보와 Discord를 연결하고, 멘토 업무를 확인하세요.'}</p></div><div className="mentor-progress"><span><strong>{completed}</strong> / 3 단계 완료</span><progress value={completed} max={3} aria-label="멘토 온보딩 진행률" /></div></header>
    <nav className="mentor-stage-nav" aria-label="온보딩 단계">{stages.map((title, index) => <button key={title} disabled={!!busy || !state || (index === 2 && (!profileReady || !verified))} aria-current={stage === index ? 'step' : undefined} onClick={() => { setSelected(index); setNotice(''); setError('') }}><span className={complete[index] ? 'is-complete' : ''}>{complete[index] ? <Check size={17} /> : `0${index + 1}`}</span><div><strong>{title}</strong><small>{complete[index] ? '완료 · 다시 보기' : stage === index ? '진행 중' : index === 2 && !verified ? '인증 후 진행' : '이어서 진행'}</small></div><ArrowRight size={17} /></button>)}</nav>
    {!state ? <div className="mentor-loading" aria-busy={!loadError}>{loadError ? <><p role="alert">{loadError}</p><button className="button secondary" onClick={() => void refresh()}>다시 불러오기</button></> : <><div className="mentor-skeleton" /><div className="mentor-skeleton" /><p role="status">저장된 정보와 서버 연결 상태를 불러오고 있습니다.</p></>}</div> : <div className="mentor-setup-grid">
      <div className="mentor-stage-body" ref={panel} tabIndex={-1} aria-label={`${stages[stage]} 단계`}>
        {loadError && <p className="mentor-feedback is-error" role="alert">상태를 갱신하지 못했습니다. {loadError}</p>}
        {error && <p className="mentor-feedback is-error" role="alert">{error}</p>}
        {notice && <p className="mentor-feedback" role="status"><CheckCircle2 size={17} />{notice}</p>}
        <section hidden={stage !== 0} className="mentor-stage-section"><span className="mentor-kicker">STEP 01</span><h3>멘토로 사용할 정보를 알려주세요</h3><p className="mentor-stage-description">활동 이름과 전문 분야만 입력하면 됩니다. 멘토는 Discord 자기소개를 작성하지 않습니다.</p><ProfileForm initial={state.profile} name={account?.name || ''} busy={!!busy} save={body => action('profile', body)} /></section>
        <section hidden={stage !== 1} className="mentor-stage-section"><span className="mentor-kicker">STEP 02</span><h3>Discord와 내 계정을 연결하세요</h3><p className="mentor-stage-description">서버 참여 버튼으로 먼저 입장하세요. 이미 참여했다면 바로 인증을 진행하면 됩니다.</p>
          {verified ? <div className="mentor-verified"><CheckCircle2 size={28} /><h4>Discord 인증 완료</h4><p>멘토 역할과 서버 별명은 봇이 자동으로 적용합니다.</p><button className="button primary" onClick={() => setSelected(2)}>업무 안내로 계속<ArrowRight size={16} /></button></div> : !state.guildId ? <p className="mentor-feedback">관리자가 Discord 서버를 연결하면 인증을 시작할 수 있습니다.</p> : !profileReady ? <div className="mentor-feedback"><p>서버에는 먼저 참여할 수 있습니다. 인증 코드를 받으려면 기본 정보를 저장해 주세요.</p><button className="button secondary" onClick={() => setSelected(0)}>기본 정보 입력하기</button></div> : <DiscordVerification workspaceId={activeId} verificationPath="staff/verification" channelUrl={`https://discord.com/channels/${state.guildId}`} onVerified={() => { void refresh(); setSelected(null) }} />}
        </section>
        <section hidden={stage !== 2} className="mentor-stage-section"><span className="mentor-kicker">STEP 03 · {reviewed.length} / {guides.length}</span><h3>첫 활동 전에 확인해 주세요</h3><p className="mentor-stage-description">안내를 읽고 확인 버튼을 누르면 다음 안내가 열립니다.</p>
          <div className="mentor-guide-list">{guides.map((guide, index) => { const done = reviewed.includes(guide.id), expanded = expandedGuide === guide.id; return <article key={guide.id} className={done ? 'is-complete' : ''}><h4><button aria-expanded={expanded} aria-controls={`mentor-guide-${guide.id}`} onClick={() => setOpenGuide(expanded ? '' : guide.id)}><span>{done ? <CheckCircle2 size={19} /> : `0${index + 1}`}</span>{guide.title}<small>{done ? '확인 완료' : nextGuide === guide.id ? '지금 확인' : '대기'}</small><ChevronDown size={17} /></button></h4><div id={`mentor-guide-${guide.id}`} hidden={!expanded}><p>{guide.text}</p>{!done && <button className="button primary" disabled={!!busy || !verified || !profileReady || nextGuide !== guide.id || demoMode} aria-busy={busy === 'step'} onClick={() => void action('step', { step: guide.id })}>{busy === 'step' ? <LoaderCircle size={16} className="membership-spinner" /> : <Check size={16} />}{busy === 'step' ? '확인 내용 저장 중…' : '안내 확인했어요'}</button>}</div></article> })}</div>
          {finished && <div className="mentor-completion" role="status"><CheckCircle2 size={27} /><div><h4>멘토 온보딩을 완료했습니다</h4><p>담당 조에서 활동을 시작하세요. 아래에서 첫 과제도 만들 수 있습니다.</p></div>{state.guildId && <a className="button primary" href={`https://discord.com/channels/${state.guildId}`} target="_blank" rel="noreferrer">학습 서버 열기<ExternalLink size={15} /></a>}</div>}
        </section>
        {verified && <details className="mentor-assignment"><summary>과제 만들기<ChevronDown size={17} /></summary><p>선택한 과정 전체에 공개됩니다. Discord 알림 배포는 관리자에게 요청하세요.</p><form className="mentor-profile-form" onSubmit={assignment}><fieldset disabled={!!busy || !data.courses.length || demoMode}><label>과정<select name="courseId" required>{data.courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label><label>과제 제목<input name="title" required maxLength={200} /></label><label>마감일<input name="due" type="date" required /></label><button className="button primary" aria-busy={busy === 'assignment'}>{busy === 'assignment' ? '과제 생성 중…' : '과제 생성'}</button></fieldset></form>{!data.courses.length && <p>관리자가 과정을 등록하면 과제를 만들 수 있습니다.</p>}</details>}
      </div>
      <aside className="mentor-context" aria-label="내 활동과 Discord 참여"><div className="mentor-context-title"><Users size={18} /><h3>나의 활동 공간</h3></div><strong className="mentor-workspace-name">{data.name}</strong><dl><div><dt>참여 역할</dt><dd>{state.mentorType === 'group' ? '조 담당 멘토' : '메인 강사'}</dd></div><div><dt>담당 조</dt><dd>{state.mentorType === 'group' ? state.teams.filter(t => state.teamIds.includes(t.id)).map(t => t.name).join(' · ') || '미배정' : '전체 조'}</dd></div></dl><p>담당 조 변경은 관리자에게 요청하세요.</p>
        <div className="mentor-server"><h3>{verified ? 'Discord 인증 완료' : 'Discord 서버 참여'}</h3>{!state.guildId ? <p>관리자가 서버를 연결하면 참여 버튼이 나타납니다.</p> : verified ? <><p>내 계정 인증을 확인했습니다.</p><a className="button secondary" href={`https://discord.com/channels/${state.guildId}`} target="_blank" rel="noreferrer">Discord 열기<ExternalLink size={15} /></a></> : usableInvite ? <><p>초대 링크가 준비됐습니다. 본인 Discord 계정으로 참여하세요.</p><a className="button primary" href={state.invitation!.inviteUrl!} target="_blank" rel="noreferrer" onClick={() => setNotice('Discord에서 서버 참여를 완료한 뒤 LMS 인증을 이어서 진행하세요.')}>Discord 서버 참여<ExternalLink size={15} /></a><small>서버 참여 후에도 LMS 인증을 완료해 주세요.</small></> : inviting ? <div className="mentor-invite-progress" role="status"><LoaderCircle size={20} className="membership-spinner" /><strong>서버 초대 링크를 준비하고 있습니다</strong><p>발급되면 여기에 참여 버튼이 자동으로 표시됩니다.</p></div> : <><p>{state.invitation?.inviteState === 'failed' ? '초대를 발급하지 못했습니다. 다시 요청해 주세요. 계속 실패하면 관리자에게 봇의 초대 만들기 권한을 확인해 달라고 요청하세요.' : '초대 링크가 없거나 만료됐습니다. 새 링크를 요청하세요.'}</p><button className="button secondary" disabled={!!busy || demoMode} onClick={() => void action('invite')}>초대 링크 발급 · 재발급</button></>}
          <button className="text-button mentor-refresh" disabled={checking || !!busy || demoMode} aria-busy={checking} onClick={() => void check()}><RefreshCw size={14} className={checking ? 'membership-spinner' : ''} />{checking ? '상태 확인 중…' : '연결 상태 확인'}</button>
        </div><div className="mentor-autosave"><CheckCircle2 size={15} /><span>완료한 단계는 저장됩니다.<br />다시 방문해도 이어서 진행할 수 있어요.</span></div>
      </aside>
    </div>}
  </section>
}

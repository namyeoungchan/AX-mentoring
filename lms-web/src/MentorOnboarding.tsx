import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { demoMode, workspaceRequest } from './api'
import { Badge, CardHeading } from './components'
import type { useWorkspace } from './useWorkspace'
import DiscordVerification from './DiscordVerification'
import { LoaderCircle } from 'lucide-react'

type State = { profile: { name: string; expertise: string; bio: string; steps: string[] } | null; guildId: string; verified: boolean; mentorType: string; teamIds: string[]; teams: { id: string; name: string }[]; invitation: { inviteUrl: string | null; inviteState: string; inviteExpires: number | null } | null; guides: { id: string; title: string; text: string }[] }
export default function MentorOnboarding({ workspace }: { workspace: ReturnType<typeof useWorkspace> }) {
  const { activeId, account, data, update } = workspace
  const [state, setState] = useState<State | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const preparing = useRef(false), attempted = useRef(false), fetching = useRef(false)
  const [inviteBusy, setInviteBusy] = useState(false)
  const [clock, setClock] = useState(Date.now)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (demoMode || fetching.current) return
    fetching.current = true
    try {
      const result: State = await workspaceRequest(activeId, 'staff/onboarding', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) })
      if (signal?.aborted) return
      setState(result); setClock(Date.now()); setError('')
      if (result.guildId && !result.verified && !result.invitation && !attempted.current && !preparing.current) {
        attempted.current = true; preparing.current = true; setInviteBusy(true)
        try {
          const next = await workspaceRequest(activeId, 'staff/invite', { method: 'POST', body: '{}', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) })
          if (!signal?.aborted) setState(next)
        } finally { preparing.current = false; if (!signal?.aborted) setInviteBusy(false) }
      }
    } catch (e) { if (!signal?.aborted) setError((e as Error).message) }
    finally { fetching.current = false }
  }, [activeId])
  // eslint-disable-next-line react/set-state-in-effect -- Poll persisted onboarding and Discord invite state.
  useEffect(() => { const controller = new AbortController(); const check = () => { if (!document.hidden) void refresh(controller.signal) }; void refresh(controller.signal); const timer = setInterval(check, 3000); window.addEventListener('focus', check); return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', check) } }, [refresh])
  async function action(path: string, body: object = {}) {
    if (busy || demoMode) return
    setBusy(true); setError(''); setNotice('')
    try { const result = await workspaceRequest(activeId, `staff/${path}`, { method: 'POST', body: JSON.stringify(body) }); setState(result); setNotice(path === 'invite' ? '서버 초대 링크를 요청했습니다. 준비되면 참여 버튼이 자동으로 표시됩니다.' : '저장했습니다.') }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function profile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    await action('profile', { name: form.get('name'), expertise: form.get('expertise') })
  }
  async function assignment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return
    const element = event.currentTarget, form = new FormData(element), course = data.courses.find(c => c.id === form.get('courseId'))
    if (!course) return
    setBusy(true); setNotice('')
    try {
      const ok = await update(current => ({ ...current, assignments: [...current.assignments, { id: crypto.randomUUID(), title: String(form.get('title')), course: course.title, courseId: course.id, due: String(form.get('due')), submitted: 0, total: course.learners, status: '진행 중' }] }))
      if (ok) { element.reset(); setNotice('과제를 생성했습니다.') }
    } finally { setBusy(false) }
  }
  return <>
    <section className="panel membership-invite mentor-panel"><CardHeading title="멘토 온보딩" subtitle="기본 정보 → Discord 참여·인증 → 업무 안내" /><Badge>{state?.mentorType === 'group' ? '조 담당 멘토' : '메인 강사'}</Badge><p>담당 조: {state?.mentorType === 'group' ? state.teams.filter(t => state.teamIds.includes(t.id)).map(t => t.name).join(' · ') || '미배정' : '전체 조'}</p><p>담당 조 변경은 워크스페이스 관리자에게 요청하세요.</p>{error && <p role="alert" className="inline-note error-note">{error}</p>}{notice && <p role="status" className="inline-note">{notice}</p>}
      <h2>1. 기본 정보</h2><p>멘토는 자기소개를 작성하지 않습니다. Discord 인증 후 서버 별명은 멘토_활동이름으로 설정됩니다.</p>{state && <form className="modal-form" key={state.profile ? 'saved' : 'new'} onSubmit={profile}><fieldset disabled={busy || demoMode}><label>활동 이름<input name="name" required maxLength={50} defaultValue={state.profile?.name || account?.name} /></label><label>전문 분야<input name="expertise" required maxLength={150} defaultValue={state.profile?.expertise || ''} placeholder="예: AI 활용, 데이터 분석" /></label><button className="button primary">기본 정보 저장</button></fieldset></form>}
    </section>
    <section className="panel membership-invite mentor-panel"><CardHeading title="2. Discord 참여 및 인증" subtitle={`${data.name}에서 사용할 인증입니다. 다른 워크스페이스에서는 별도로 인증해야 합니다.`} />{!state ? <p role="status">서버 참여 정보를 확인하고 있습니다…</p> : !state.guildId ? <p>관리자가 Discord 서버를 연결하면 이곳에서 초대 링크를 받을 수 있습니다.</p> : <>
      {state.verified ? <Badge tone="green">Discord 인증 완료</Badge> : <>
        <h3>먼저 Discord 서버에 참여하세요</h3><p>본인의 Discord 계정으로 초대를 수락하세요. 이미 참여했다면 아래 LMS 인증으로 진행하세요.</p>
        {state.invitation?.inviteUrl && (!state.invitation.inviteExpires || state.invitation.inviteExpires > clock) ? <a className="button primary" href={state.invitation.inviteUrl} target="_blank" rel="noreferrer">Discord 서버 참여</a> : inviteBusy || ['queued', 'running'].includes(state.invitation?.inviteState || '') ? <p className="discord-invite-pending" role="status"><LoaderCircle size={16} className="membership-spinner" aria-hidden="true" /> 서버 초대 링크를 준비하고 있습니다. 발급되면 여기에 참여 버튼이 자동으로 표시됩니다.</p> : <><p>{state.invitation?.inviteState === 'failed' ? '초대를 발급하지 못했습니다. 다시 요청해 주세요. 계속 실패하면 관리자에게 봇의 초대 만들기 권한을 확인해 달라고 요청하세요.' : '초대 링크가 없거나 만료됐습니다. 새 링크를 받아 참여하세요.'}</p><button className="button secondary" disabled={busy} onClick={() => void action('invite')}>초대 링크 발급 · 재발급</button></>}
        {state.profile ? <DiscordVerification workspaceId={activeId} verificationPath="staff/verification" channelUrl={`https://discord.com/channels/${state.guildId}`} onVerified={() => void refresh()} /> : <p>서버 참여 후 위 기본 정보를 저장하면 LMS 인증 코드를 받을 수 있습니다.</p>}
      </>}
    </>}</section>
    <section className="panel membership-invite mentor-panel"><CardHeading title="3. 멘토 업무 안내" subtitle={`안내 확인 ${state?.profile?.steps.length || 0} / 3`} />{state?.guides.map((guide, index) => <article key={guide.id} className="mentor-guide"><h3>{index + 1}. {guide.title}</h3><p>{guide.text}</p><button className="button secondary" disabled={busy || !state.verified || !state.profile || state.profile.steps.includes(guide.id) || state.guides.slice(0, index).some(g => !state.profile?.steps.includes(g.id))} onClick={() => void action('step', { step: guide.id })}>{state.profile?.steps.includes(guide.id) ? '확인 완료' : '안내 확인했어요'}</button></article>)}{state?.profile?.steps.length === 3 && <p className="inline-note" role="status">멘토 온보딩을 완료했습니다. 담당 조에서 활동을 시작하세요.</p>}</section>
    <section className="panel membership-invite mentor-panel"><CardHeading title="과제 만들기" subtitle="선택한 과정의 팀 과제를 만듭니다. Discord 알림 배포는 워크스페이스 관리자에게 요청하세요." /><form className="modal-form" onSubmit={assignment}><fieldset disabled={busy || !state?.verified || !data.courses.length || demoMode}><label>과정<select name="courseId" required>{data.courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label><label>과제 제목<input name="title" required maxLength={200} /></label><label>마감일<input name="due" type="date" required /></label><button className="button primary">과제 생성</button></fieldset></form></section>
  </>
}

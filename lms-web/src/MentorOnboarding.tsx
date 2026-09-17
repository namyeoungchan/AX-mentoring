import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { demoMode, workspaceRequest } from './api'
import { Badge, CardHeading } from './components'
import type { useWorkspace } from './useWorkspace'

type State = { profile: { name: string; expertise: string; bio: string; steps: string[] } | null; guildId: string; verified: boolean; mentorType: string; teamIds: string[]; teams: { id: string; name: string }[]; invitation: { inviteUrl: string | null; inviteState: string } | null; guides: { id: string; title: string; text: string }[] }
export default function MentorOnboarding({ workspace }: { workspace: ReturnType<typeof useWorkspace> }) {
  const { activeId, account, data, update } = workspace
  const [state, setState] = useState<State | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (demoMode) return
    try { setState(await workspaceRequest(activeId, 'staff/onboarding', { signal })) } catch (e) { if (!signal?.aborted) setError((e as Error).message) }
  }, [activeId])
  // eslint-disable-next-line react/set-state-in-effect -- Poll persisted onboarding and Discord invite state.
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); const timer = setInterval(() => { if (!document.hidden) void refresh(controller.signal) }, 10000); return () => { controller.abort(); clearInterval(timer) } }, [refresh])
  async function action(path: string, body: object = {}) {
    if (busy || demoMode) return
    setBusy(true); setError(''); setNotice('')
    try { const result = await workspaceRequest(activeId, `staff/${path}`, { method: 'POST', body: JSON.stringify(body) }); if (path === 'verification') setCode(result); else { setState(result); setNotice('저장했습니다.') } }
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
    <section className="panel membership-invite mentor-panel"><CardHeading title="2. Discord 참여 및 인증" subtitle={`${data.name}에서 사용할 인증입니다. 다른 워크스페이스에서는 별도로 인증해야 합니다.`} />{!state?.guildId ? <p>관리자가 Discord 서버를 연결하면 이곳에서 초대 링크를 받을 수 있습니다.</p> : !state.profile ? <p>기본 정보를 저장하면 봇이 초대 링크를 발급합니다.</p> : <>
      {state.verified ? <Badge tone="green">Discord 인증 완료</Badge> : <><p>{state.invitation?.inviteUrl ? '초대 링크로 서버에 참여한 뒤 인증 코드를 발급하세요.' : ['queued', 'running'].includes(state.invitation?.inviteState || '') ? '봇이 초대 링크를 발급하고 있습니다. 잠시 기다려 주세요.' : '초대 링크를 발급하거나 재발급할 수 있습니다.'}</p>
        {state.invitation?.inviteUrl && <a className="button primary" href={state.invitation.inviteUrl} target="_blank" rel="noreferrer">Discord 서버 참여</a>}<button className="button secondary" disabled={busy || ['queued', 'running'].includes(state.invitation?.inviteState || '')} onClick={() => void action('invite')}>초대 링크 발급 · 재발급</button><button className="button secondary" disabled={busy} onClick={() => void action('verification')}>인증 코드 받기</button>
        {code && <div className="inline-note"><p>서버에서 아래 명령어를 실행하세요. 만료: {new Date(code.expiresAt).toLocaleTimeString('ko-KR')}</p><code>/lms인증 코드:{code.code}</code></div>}</>}
    </>}</section>
    <section className="panel membership-invite mentor-panel"><CardHeading title="3. 멘토 업무 안내" subtitle={`안내 확인 ${state?.profile?.steps.length || 0} / 3`} />{state?.guides.map((guide, index) => <article key={guide.id} className="mentor-guide"><h3>{index + 1}. {guide.title}</h3><p>{guide.text}</p><button className="button secondary" disabled={busy || !state.verified || !state.profile || state.profile.steps.includes(guide.id) || state.guides.slice(0, index).some(g => !state.profile?.steps.includes(g.id))} onClick={() => void action('step', { step: guide.id })}>{state.profile?.steps.includes(guide.id) ? '확인 완료' : '안내 확인했어요'}</button></article>)}{state?.profile?.steps.length === 3 && <p className="inline-note" role="status">멘토 온보딩을 완료했습니다. 담당 조에서 활동을 시작하세요.</p>}</section>
    <section className="panel membership-invite mentor-panel"><CardHeading title="과제 만들기" subtitle="선택한 과정의 팀 과제를 만듭니다. Discord 알림 배포는 워크스페이스 관리자에게 요청하세요." /><form className="modal-form" onSubmit={assignment}><fieldset disabled={busy || !state?.verified || !data.courses.length || demoMode}><label>과정<select name="courseId" required>{data.courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label><label>과제 제목<input name="title" required maxLength={200} /></label><label>마감일<input name="due" type="date" required /></label><button className="button primary">과제 생성</button></fieldset></form></section>
  </>
}

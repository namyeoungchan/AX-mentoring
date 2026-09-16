import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, Save } from 'lucide-react'
import { Badge, CardHeading } from './components'
import { demoMode, workspaceRequest } from './api'

type Config = { guildId: string; enabled: boolean; courseIds: string[]; welcomeText: string; onboardingChannel: string; introChannel: string; revision: string }
type Report = { state: string; error: string; updatedAt: number }
type State = { guildIds: string[]; courses: { id: string; title: string }[]; teams: { id: string; name: string; courseId: string; members: number }[]; configs: (Config & { report: Report | null; progress: { discordId: string; introDone: number }[] })[] }
const errors: Record<string, string> = { team_limit: '서버당 최대 50개 팀을 연결할 수 있습니다. 연결할 과정을 줄여 주세요.', permissions: '봇의 채널 관리·역할 관리·별명 관리·메시지 고정·채널 보기·메시지 보내기·기록 보기·링크 삽입 권한을 확인하세요.', role_hierarchy: '봇 역할을 LMS 역할과 대상 멘토의 최상위 역할보다 위로 이동하세요. 서버 소유자의 별명은 직접 변경해야 합니다. LMS 역할에는 서버 관리 권한을 추가하지 마세요.', discord_error: 'Discord 요청에 실패했습니다. 봇 로그를 확인하세요.', api_error: '봇과 웹의 연결 설정을 확인하세요.', conflict: '중복된 채널이나 삭제된 역할을 확인하세요.' }
const pick = (row: Config): Config => ({ guildId: row.guildId, enabled: row.enabled, courseIds: [...row.courseIds], welcomeText: row.welcomeText, onboardingChannel: row.onboardingChannel, introChannel: row.introChannel, revision: row.revision })

export default function OnboardingSetup({ workspaceId }: { workspaceId: string }) {
  const [state, setState] = useState<State>({ guildIds: [], courses: [], teams: [], configs: [] })
  const [draft, setDraft] = useState<Config | null>(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [clock, setClock] = useState(() => Date.now())
  const initialized = useRef(false)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (demoMode) return
    try {
      const result: State = await workspaceRequest(workspaceId, 'discord/onboarding', { signal })
      if (signal?.aborted) return
      setState(result); setClock(Date.now())
      if (!initialized.current && result.configs.length) { initialized.current = true; setDraft(pick(result.configs[0])) }
      setError('')
    } catch (failure) { if (!signal?.aborted) setError((failure as Error).message) }
  }, [workspaceId])
  useEffect(() => {
    const controller = new AbortController()
    // eslint-disable-next-line react/set-state-in-effect -- Load saved server configuration.
    void refresh(controller.signal)
    const interval = setInterval(() => { if (!document.hidden) void refresh(controller.signal) }, 15000)
    return () => { controller.abort(); clearInterval(interval) }
  }, [refresh])
  async function save() {
    if (!draft || busy || demoMode) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result: State = await workspaceRequest(workspaceId, 'discord/onboarding', { method: 'POST', body: JSON.stringify(draft) })
      setState(result); setDraft(pick(result.configs.find(c => c.guildId === draft.guildId)!)); setNotice(draft.enabled ? '저장했습니다. 봇이 온보딩·역할·팀 채널을 적용합니다.' : '자동 온보딩을 중지했습니다. 기존 역할과 채널은 유지됩니다.')
    } catch (failure) { setError((failure as Error).message) }
    finally { setBusy(false) }
  }
  const selected = state.configs.find(c => c.guildId === draft?.guildId)
  const report = selected?.report
  const teams = state.teams.filter(t => draft?.courseIds.includes(t.courseId))
  const status = !selected?.enabled ? '사용 안 함' : !report ? '적용 대기' : clock - report.updatedAt > 90000 ? '봇 응답 지연' : report.state === 'ready' ? '적용 완료' : '적용 실패'
  return <>
    <div className="operations-toolbar"><p>서버 참여 안내 · 자기소개 · 웹 팀 배정</p><button className="button secondary" onClick={() => void refresh()}><RefreshCw size={15} />새로고침</button></div>
    {error && <p className="inline-note error-note" role="alert">{error}</p>}{notice && <p className="inline-note" role="status">{notice}</p>}
    {!draft ? <section className="panel modal-form"><p>{demoMode ? '운영 서비스에서 사용할 수 있습니다.' : 'Discord 채널 설정에서 서버 ID를 먼저 등록하세요.'}</p><a href="#discord" className="button secondary">Discord 채널 설정</a></section> : <div className="onboarding-grid">
      <section className="panel"><CardHeading title="서버 온보딩"><Badge tone={status === '적용 완료' ? 'green' : 'orange'}>{status}</Badge></CardHeading>
        <form className="modal-form" onSubmit={event => { event.preventDefault(); void save() }}><fieldset disabled={busy}>
          <label>대상 Discord 서버<select value={draft.guildId} onChange={event => { setDraft(pick(state.configs.find(c => c.guildId === event.target.value)!)); setNotice('') }}>{state.guildIds.map(id => <option key={id}>{id}</option>)}</select></label>
          <label className="onboarding-check"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />서버 참여 시 자동 온보딩</label>
          <div className="form-row"><label>시작 안내 채널<input value={draft.onboardingChannel} required maxLength={70} onChange={event => setDraft({ ...draft, onboardingChannel: event.target.value })} /></label><label>자기소개 채널<input value={draft.introChannel} required maxLength={70} onChange={event => setDraft({ ...draft, introChannel: event.target.value })} /></label></div>
          <label>시작 안내 고정글<textarea aria-label="시작 안내 고정글" value={draft.welcomeText} required maxLength={1500} rows={6} onChange={event => setDraft({ ...draft, welcomeText: event.target.value })} /></label>
          <div className="onboarding-courses"><strong>이 서버에 연결할 과정</strong>{state.courses.map(course => <label className="onboarding-check" key={course.id}><input type="checkbox" checked={draft.courseIds.includes(course.id)} onChange={event => setDraft({ ...draft, courseIds: event.target.checked ? [...draft.courseIds, course.id] : draft.courseIds.filter(id => id !== course.id) })} />{course.title}</label>)}{!state.courses.length && <p>학습 과정에서 과정을 먼저 등록하세요.</p>}</div>
          <button className="button primary" type="submit"><Save size={15} />온보딩 저장 및 적용</button>
        </fieldset></form>
        {report?.error && <p className="inline-note error-note">{errors[report.error] || '봇 로그를 확인하세요.'}</p>}
      </section>
      <aside className="panel modal-form"><h2>팀 배정 · {teams.length}개 팀</h2><p>팀 관리에서 팀을 만들고 수강생 관리에서 팀원을 배정합니다. 저장한 배정은 봇에 자동 반영됩니다.</p>
        <div className="flex gap-2"><a className="button secondary" href="#teams">팀 관리</a><a className="button secondary" href="#learners">수강생 배정</a></div>
        <div className="table-scroll"><table><thead><tr><th>팀</th><th>배정 인원</th></tr></thead><tbody>{teams.map(t => <tr key={t.id}><td>{t.name}</td><td>{t.members}명</td></tr>)}</tbody></table></div>
        <h3>참여 순서</h3><ol><li>서버 참여 → 안내 DM, 대기 역할 부여</li><li>DM이 막혀 있으면 시작 안내 채널에서 진행</li><li>웹 가입 승인·Discord 인증·과정 등록 확인</li><li>자기소개 완료 → 수강생·완료·배정 팀 역할 부여</li></ol>
        <p>팀별 대화·음성 채널은 팀원·워크스페이스 관리자·메인 강사·해당 조 담당 멘토에게 공개됩니다. 팀 변경 시 이전 팀 역할을 회수합니다.</p>
        <p>자기소개 완료: {selected?.progress.filter(p => p.introDone).length || 0}명</p>
        <p>봇에 역할 관리·채널 관리·메시지 고정 권한이 필요합니다. 봇 역할을 LMS 역할보다 위에 두고 Server Members Intent를 켜 주세요.</p>
      </aside>
    </div>}
  </>
}

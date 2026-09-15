import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, Hash, Plus, RefreshCw, Save, Send, Trash2, Volume2 } from 'lucide-react'
import { workspaceRequest, demoMode } from './api'
import { Badge, CardHeading } from './components'

type Channel = { id: string; name: string; type: 'category' | 'text' | 'voice'; parentId: string }
type Plan = { guildId: string; name: string; autoApply: boolean; channels: Channel[]; revision: string }
type State = { enabled: boolean; plans: Plan[]; guilds: { id: string; name: string; connected: boolean; manageChannels: number; seenAt: number }[]; jobs: { id: string; guildId: string; state: string; errorCode: string | null; createdAt: number; results: { id: string; discordId: string; action: string }[] }[] }
const starter: Channel[] = [
  { id: 'info', name: '운영 안내', type: 'category', parentId: '' },
  { id: 'notice', name: '공지사항', type: 'text', parentId: 'info' },
  { id: 'questions', name: '질문답변', type: 'text', parentId: 'info' },
  { id: 'learning', name: '학습 활동', type: 'category', parentId: '' },
  { id: 'assignments', name: '과제제출', type: 'text', parentId: 'learning' },
  { id: 'mentoring', name: '멘토링예약', type: 'text', parentId: 'learning' },
  { id: 'teams', name: '팀 활동', type: 'category', parentId: '' },
  { id: 'team-text', name: '팀1-채팅', type: 'text', parentId: 'teams' },
  { id: 'team-voice', name: '팀1 음성', type: 'voice', parentId: 'teams' },
]
const initial = (): Plan => ({ guildId: '', name: 'AX 교육 서버', autoApply: true, channels: structuredClone(starter), revision: '' })
const jobNames: Record<string, string> = { queued: '봇 연결 대기', running: '적용 중', succeeded: '적용 완료', failed: '적용 실패' }
const errorNames: Record<string, string> = { forbidden: '봇의 채널 관리 권한을 확인하세요.', missing_guild: '봇이 서버에 참여하고 있는지 확인하세요.', conflict: '중복된 채널 이름을 확인하세요.', timeout: '작업 시간이 초과됐습니다. 생성된 채널을 확인한 후 다시 요청하세요.', api_error: 'Discord 연결 오류입니다. 잠시 후 다시 요청하세요.' }

export default function DiscordSetup({ workspaceId }: { workspaceId: string }) {
  const [state, setState] = useState<State>({ enabled: false, plans: [], guilds: [], jobs: [] })
  const [draft, setDraft] = useState<Plan>(initial)
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (demoMode) return
    try { setState(await workspaceRequest(workspaceId, 'discord/provision', { signal })); setError('') }
    catch (e) { if (!signal?.aborted) setError((e as Error).message) }
  }, [workspaceId])
  useEffect(() => {
    const controller = new AbortController()
    // eslint-disable-next-line react/set-state-in-effect -- Load external configuration on mount.
    void refresh(controller.signal)
    const timer = setInterval(() => { if (!document.hidden) void refresh(controller.signal) }, 15000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [refresh])
  const categories = draft.channels.filter(row => row.type === 'category')
  const guild = state.guilds.find(row => row.id === draft.guildId)
  const dirty = JSON.stringify(draft) !== saved
  function load(guildId: string) {
    const existing = state.plans.find(row => row.guildId === guildId)
    setDraft(existing ? structuredClone(existing) : initial()); setSaved(existing ? JSON.stringify(existing) : ''); setNotice(''); setError('')
  }
  function update(id: string, change: Partial<Channel>) { setDraft(value => ({ ...value, channels: value.channels.map(row => row.id === id ? { ...row, ...change } : row) })) }
  async function save() {
    if (busy || demoMode) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await workspaceRequest(workspaceId, 'discord/provision/plans', { method: 'POST', body: JSON.stringify(draft) })
      setDraft(result); setSaved(JSON.stringify(result)); await refresh()
      setNotice(result.autoApply ? '설정을 저장했습니다. 봇이 연결되면 자동 적용합니다.' : '설정을 저장했습니다.')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function apply() {
    if (busy || dirty || demoMode) return
    setBusy(true); setError(''); setNotice('')
    try { await workspaceRequest(workspaceId, 'discord/provision/jobs', { method: 'POST', body: JSON.stringify({ guildId: draft.guildId, revision: draft.revision }) }); await refresh(); setNotice('적용을 요청했습니다. 봇이 작업을 가져가면 상태가 바뀝니다.') }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  function channelPreview(row: Channel) { return <div className="discord-preview-channel" key={row.id}>{row.type === 'voice' ? <Volume2 size={16} /> : <Hash size={16} />}<span>{row.name || '채널 이름'}</span></div> }
  return <>
    <div className="operations-toolbar"><Badge tone={state.enabled ? 'green' : 'orange'}>{demoMode ? '데모 · 적용 불가' : state.enabled ? '채널 설정 연결 준비됨' : '봇 연결 설정 필요'}</Badge><button className="button secondary" onClick={() => void refresh()} disabled={demoMode}><RefreshCw size={15} />새로고침</button></div>
    {error && <div className="inline-note error-note" role="alert">{error}</div>}{notice && <div className="inline-note" role="status">{notice}</div>}
    <div className="discord-setup-grid"><section className="panel discord-editor"><CardHeading title="서버 채널 구성" subtitle="서버 ID에 맞춰 봇이 채널을 생성합니다." />
      <label>저장된 구성<select aria-label="저장된 구성" onChange={event => load(event.target.value)} value={state.plans.some(row => row.guildId === draft.guildId) ? draft.guildId : ''}><option value="">새 구성</option>{state.plans.map(row => <option value={row.guildId} key={row.guildId}>{row.name} · {row.guildId}</option>)}</select></label>
      <fieldset disabled={busy}><div className="discord-fields"><label>설정 이름<input aria-label="설정 이름" value={draft.name} maxLength={80} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label><label>Discord 서버 ID<input aria-label="Discord 서버 ID" value={draft.guildId} inputMode="numeric" maxLength={20} disabled={Boolean(draft.revision)} placeholder="서버 ID 17~20자리" onChange={event => setDraft({ ...draft, guildId: event.target.value })} /></label></div>
        <div className="discord-guild-status">{guild ? `${guild.name} · ${guild.connected ? '봇 연결 확인됨' : '봇 응답 지연'} · ${guild.manageChannels ? '채널 관리 권한 있음' : '채널 관리 권한 필요'}` : '서버에 봇을 초대하면 연결 상태가 표시됩니다.'}</div>
        <label className="discord-auto"><input type="checkbox" checked={draft.autoApply} onChange={event => setDraft({ ...draft, autoApply: event.target.checked })} />봇 연결 시 자동 적용</label>
        <p className="discord-hint">자동 적용을 켜고 저장하면, 이미 연결된 봇에도 적용됩니다. 새로운 채널은 서버·카테고리의 기본 접근 권한을 따릅니다.</p>
        <div className="discord-channel-list">{draft.channels.map((row, index) => <div className="discord-channel-row" key={row.id}>
          <select aria-label={`채널 ${index + 1} 유형`} value={row.type} onChange={event => update(row.id, { type: event.target.value as Channel['type'], parentId: '' })}><option value="category">카테고리</option><option value="text">텍스트</option><option value="voice">음성</option></select>
          <input aria-label={`채널 ${index + 1} 이름`} value={row.name} maxLength={80} onChange={event => update(row.id, { name: event.target.value })} />
          <select aria-label={`채널 ${index + 1} 카테고리`} value={row.parentId} disabled={row.type === 'category'} onChange={event => update(row.id, { parentId: event.target.value })}><option value="">최상위</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select>
          <button className="icon-button" aria-label={`채널 ${index + 1} 제거`} onClick={() => setDraft({ ...draft, channels: draft.channels.filter(item => item.id !== row.id).map(item => item.parentId === row.id ? { ...item, parentId: '' } : item) })}><Trash2 size={16} /></button>
        </div>)}</div>
        <button className="button secondary" disabled={draft.channels.length >= 30} onClick={() => setDraft({ ...draft, channels: [...draft.channels, { id: crypto.randomUUID(), type: 'text', name: '새-채널', parentId: '' }] })}><Plus size={15} />채널 추가</button>
        <div className="discord-save-actions"><button className="button primary" disabled={demoMode || busy} onClick={() => void save()}><Save size={15} />{draft.autoApply ? '저장하고 자동 적용' : '설정 저장'}</button><button className="button secondary" disabled={demoMode || !state.enabled || dirty || busy} onClick={() => void apply()}><Send size={15} />적용 요청</button></div>
      </fieldset><p className="discord-hint">같은 이름·유형·카테고리의 채널은 재사용합니다. 기존 채널의 삭제·이동과 역할 권한 변경은 지원하지 않습니다.</p>
    </section><aside className="discord-preview" aria-label="Discord 채널 미리보기"><h2>{draft.name || 'Discord 서버'}</h2><span className="discord-preview-caption">채널 미리보기 · {draft.channels.length}/30</span>{draft.channels.filter(row => row.type !== 'category' && !row.parentId).map(channelPreview)}{categories.map(category => <div className="discord-preview-category" key={category.id}><h3><ChevronDown size={13} />{category.name || '카테고리'}</h3>{draft.channels.filter(row => row.parentId === category.id).map(channelPreview)}</div>)}</aside></div>
    <section className="panel discord-jobs"><CardHeading title="적용 이력" subtitle="봇에서 받은 처리 결과입니다." /><div className="table-scroll"><table><thead><tr><th>요청 시각</th><th>서버 ID</th><th>상태</th><th>처리 결과</th></tr></thead><tbody>{state.jobs.map(job => <tr key={job.id}><td>{new Date(job.createdAt).toLocaleString('ko-KR')}</td><td>{job.guildId}</td><td><Badge tone={job.state === 'succeeded' ? 'green' : 'orange'}>{jobNames[job.state]}</Badge></td><td>{job.errorCode ? errorNames[job.errorCode] : `생성 ${job.results.filter(row => row.action === 'created').length} · 재사용 ${job.results.filter(row => row.action === 'reused').length}`}</td></tr>)}</tbody></table></div>{!state.jobs.length && <p className="calendar-empty">적용 이력이 없습니다.</p>}</section>
  </>
}

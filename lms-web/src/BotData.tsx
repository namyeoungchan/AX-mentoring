import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Download, RefreshCw, Save } from 'lucide-react'
import { Badge, CardHeading } from './components'
import { demoMode, workspaceRequest } from './api'
import actions from '../shared/bot-operations.json'

type Settings = { guildId: string; revision: string; channels: Record<string, string>; teams: { name: string; channelId: string }[]; qaUnansweredHours: number; qaNotifyRoleIds?: string[] }
type State = { courses: { id: string; title: string }[]; revision: string; guildIds: string[]; tables: { key: string; label: string; count: number }[]; imports: { checksum: string; guildId: string; state: string; error: string; createdAt: string }[]; settings: Settings[] }
type Table = { name: string; label: string; page: number; total: number; rows: Record<string, unknown>[] }
const channelLabels: Record<string, string> = { ASSIGNMENT_DASHBOARD_CHANNEL_ID: '과제·참여도·비밀평가 대시보드', ASSIGNMENT_SUBMIT_CHANNEL_ID: '과제 제출', MENTORING_CHANNEL_ID: '멘토링 예약', ONBOARDING_CHANNEL_ID: '기존 온보딩', INTRO_CHANNEL_ID: '자기소개', QA_FORUM_CHANNEL_ID: '질문 포럼', ADMIN_ROLE_ID: '운영자 역할', STUDENT_ROLE_ID: '기존 수강생 역할', ONBOARDING_COMPLETE_ROLE_ID: '기존 온보딩 완료 역할' }
const labels: Record<string, string> = { evaluation_count: '평가 인원', id: '번호', name: '이름', discord_id: 'Discord ID', bio: '소개', mentor_id: '멘토 번호', start_time: '시작', end_time: '종료', label: '이름', is_active: '진행 여부', slot_id: '예약 시간 번호', user_id: '사용자 ID', user_name: '이름', booked_at: '예약 시각', status: '상태', rejection_reason: '반려 사유', week: '주차', title: '제목', description: '설명', due_date: '마감', type: '유형', created_at: '생성 시각', fields: '제출 항목', assignment_id: '과제 번호', team: '팀', content: '내용', link: '링크', submitted_at: '제출 시각', channel_id: '채널 ID', message_id: '메시지 ID', guild_id: '서버 ID', panel_type: '패널 종류', date: '날짜', weekday: '요일', start_hour: '시작 시', start_minute: '시작 분', end_hour: '종료 시', end_minute: '종료 분', interval_minutes: '간격(분)', booking_id: '예약 번호', sent_at: '발송 시각', thread_id: '질문 ID', alerted_at: '알림 시각', joined_at: '참여 시각', intro_done: '소개 완료', completed_at: '완료 시각', round_id: '평가 회차', evaluator_id: '평가자 ID', target_id: '평가 대상 ID', target_name: '평가 대상', score1: '과업 완수', score2: '협업·소통', score3: '책임·약속', score4: '팀 기여', comment: '의견' }
const empty: State = { courses: [], revision: '', guildIds: [], tables: [], imports: [], settings: [] }

export default function BotData({ workspaceId }: { workspaceId: string }) {
  const [state, setState] = useState<State>(empty), [table, setTable] = useState<Table | null>(null)
  const [selectedTable, setSelectedTable] = useState('mentors'), [page, setPage] = useState(0)
  const [guildId, setGuildId] = useState(''), [operation, setOperation] = useState(actions[0].id)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const action = actions.find(a => a.id === operation)!
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (demoMode) return
    try {
      const [next, rows]: [State, Table] = await Promise.all([workspaceRequest(workspaceId, 'bot-data', { signal }), workspaceRequest(workspaceId, `bot-data/table/${selectedTable}?page=${page}`, { signal })])
      if (signal?.aborted) return
      setState(next); setTable(rows); setGuildId(current => current || next.guildIds[0] || ''); setError('')
    } catch (failure) { if (!signal?.aborted) setError((failure as Error).message) }
  }, [workspaceId, selectedTable, page])
  useEffect(() => {
    const controller = new AbortController()
    // eslint-disable-next-line react/set-state-in-effect -- Read the selected workspace dataset.
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])
  async function operate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return
    const form = new FormData(event.currentTarget), kwargs: Record<string, unknown> = {}
    for (const [key, , type] of action.fields) {
      const value = String(form.get(key) || '')
      kwargs[key] = type === 'number' ? Number(value) : type === 'numbers' ? value.split(',').map(v => v.trim()).filter(Boolean).map(Number) : type === 'lines' ? JSON.stringify(value.split('\n').map(v => v.trim()).filter(Boolean)) : value
    }
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await workspaceRequest(workspaceId, 'bot-data/operation', { method: 'POST', body: JSON.stringify({ guildId, operation, kwargs, requestId: crypto.randomUUID(), revision: state.revision }) })
      if (response.result === false || response.result === null) setNotice('변경할 대상을 찾지 못했거나 이미 처리된 상태입니다.')
      else setNotice(`${action.label} 작업을 저장했습니다.`)
      await refresh()
    } catch (failure) { setError((failure as Error).message) }
    finally { setBusy(false) }
  }
  async function saveSettings() {
    if (!draft || busy) return
    setBusy(true); setError('')
    try {
      const { guildId: target, revision, ...value } = draft
      if (value.qaNotifyRoleIds) value.qaNotifyRoleIds = value.qaNotifyRoleIds.map(id => id.trim()).filter(Boolean)
      const next: State = await workspaceRequest(workspaceId, 'bot-data/settings', { method: 'POST', body: JSON.stringify({ guildId: target, value, revision }) })
      setState(next); setDraft(next.settings.find(s => s.guildId === target) || null)
      setNotice('채널·역할 설정을 저장했습니다. 봇이 다음 확인 주기에 반영합니다.')
    } catch (failure) { setError((failure as Error).message) }
    finally { setBusy(false) }
  }
  async function download(hash: string) {
    try {
      const data = await workspaceRequest(workspaceId, `bot-data/archive/${hash}`)
      const url = URL.createObjectURL(new Blob([data.archive], { type: 'application/json' }))
      const link = document.createElement('a'); link.href = url; link.download = `bot-backup-${hash.slice(0, 12)}.json`; link.click(); URL.revokeObjectURL(url)
    } catch (failure) { setError((failure as Error).message) }
  }
  const columns = table?.rows[0] ? Object.keys(table.rows[0]) : []
  if (demoMode) return <section className="panel modal-form">운영 서비스에서 봇 데이터를 이관하고 관리할 수 있습니다.</section>
  return <>
    <div className="operations-toolbar"><p>기존 봇 데이터 · 운영 작업 · 채널 패널 설정</p><button className="button secondary" onClick={() => void refresh()}><RefreshCw size={15} />새로고침</button></div>
    {error && <p role="alert" className="inline-note error-note">{error}</p>}{notice && <p role="status" className="inline-note">{notice}</p>}
    <section className="panel modal-form"><CardHeading title="데이터 이관"><Badge tone={state.imports.some(i => i.state === 'complete') ? 'green' : 'orange'}>{state.imports.some(i => i.state === 'complete') ? '이관 완료' : state.imports.length ? '이관 확인 필요' : '이관 이력 없음'}</Badge></CardHeading>
      <p>새 워크스페이스는 연결된 Discord 서버를 기준으로 웹 저장소를 사용합니다. 기존 로컬 자료의 이관은 원본 서버의 워크스페이스에 한 번만 진행하며 원본은 보관합니다.</p>
      {state.imports.map(item => <div className="bot-import-row" key={item.checksum}><span>{item.guildId} · {item.createdAt} · {item.state === 'complete' ? '이관 완료' : item.state === 'conflict' ? '충돌 확인 필요' : '이관 중'}{item.error && <strong className="error-text">{item.error}</strong>}</span><button className="button secondary" onClick={() => void download(item.checksum)}><Download size={15} />원본 다운로드</button></div>)}
      {!state.imports.length && <p>이관할 기존 자료가 없어도 웹 연동 URL과 키를 설정하면 이 서버의 봇 기능을 사용할 수 있습니다.</p>}
    </section>
    <div className="bot-data-grid">
      <section className="panel modal-form"><h2>운영 작업</h2><form onSubmit={operate}><fieldset disabled={busy || !guildId}>
        <label>대상 서버<select value={guildId} onChange={e => { setGuildId(e.target.value); setDraft(null) }}>{state.guildIds.map(id => <option key={id}>{id}</option>)}</select></label>
        <label>작업<select value={operation} onChange={e => setOperation(e.target.value)}>{actions.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label>
        <div key={operation}>{action.fields.map(([key, label, type]) => <label key={key}>{label}{type === 'course' ? <select name={key} required defaultValue={state.courses.length === 1 ? state.courses[0].id : ''}><option value="" disabled>과정 선택 · 생성 시 자동 연결</option>{state.courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select> : type === 'assignment-type' ? <select name={key}><option value="team">팀별</option><option value="individual">개인별</option></select> : ['textarea', 'lines'].includes(type) ? <textarea aria-label={label} name={key} rows={3} required={type === 'lines'} defaultValue={type === 'lines' ? '제출 내용' : ''} /> : <input name={key} type={type === 'numbers' ? 'text' : type} required={type !== 'numbers'} />}</label>)}</div>
        {action.help && <p>{action.help}</p>}<button className="button primary" type="submit"><Save size={15} />작업 저장</button>
      </fieldset></form></section>
      <section className="panel modal-form"><h2>채널 · 역할 설정</h2><p>과제 대시보드 채널에는 과제 현황·참여도·진행 중인 비밀평가를, 제출 채널과 멘토링 채널에는 해당 버튼 패널을 자동 게시하고 고정합니다.</p>
        {!draft ? <button className="button secondary" disabled={!guildId} onClick={() => setDraft(state.settings.find(s => s.guildId === guildId) || { guildId, revision: '', channels: {}, teams: [], qaUnansweredHours: 24 })}>서버 설정 편집</button> : <fieldset disabled={busy}>
          {Object.entries(channelLabels).map(([key, label]) => <label key={key}>{label} ID<input value={draft.channels[key] || ''} inputMode="numeric" pattern="[0-9]{17,20}" onChange={e => setDraft({ ...draft, channels: { ...draft.channels, [key]: e.target.value } })} /></label>)}
          <label>질문 미응답 알림 기준(시간)<input type="number" min={1} max={168} value={draft.qaUnansweredHours} onChange={e => setDraft({ ...draft, qaUnansweredHours: Number(e.target.value) })} /></label>
          <label>질문 알림을 받을 역할 ID (한 줄에 하나)<textarea value={(draft.qaNotifyRoleIds || []).join('\n')} onChange={e => setDraft({ ...draft, qaNotifyRoleIds: e.target.value.split('\n') })} /></label>
          <h3>이관된 팀 채널</h3>{draft.teams.map((team, index) => <div className="form-row" key={index}><label>팀 이름<input value={team.name} onChange={e => setDraft({ ...draft, teams: draft.teams.map((t, i) => i === index ? { ...t, name: e.target.value } : t) })} /></label><label>대화 채널 ID<input value={team.channelId} onChange={e => setDraft({ ...draft, teams: draft.teams.map((t, i) => i === index ? { ...t, channelId: e.target.value } : t) })} /></label></div>)}
          <p>새 팀 생성과 인원 배정은 팀 관리·학생 계정 발급에서 설정합니다.</p><button className="button primary" onClick={() => void saveSettings()}><Save size={15} />채널 설정 저장</button>
        </fieldset>}
      </section>
    </div>
    <section className="panel modal-form"><h2>저장된 자료</h2><label>조회 항목<select value={selectedTable} onChange={e => { setSelectedTable(e.target.value); setPage(0) }}>{state.tables.map(t => <option key={t.key} value={t.key}>{t.label} · {t.count}건</option>)}</select></label>
      <div className="table-scroll"><table><thead><tr>{columns.map(c => <th key={c}>{labels[c] || c}</th>)}</tr></thead><tbody>{table?.rows.map((row, index) => <tr key={index}>{columns.map(c => <td key={c} className="bot-data-cell">{row[c] === null ? '—' : String(row[c])}</td>)}</tr>)}</tbody></table></div>
      {!table?.rows.length && <p>저장된 자료가 없습니다.</p>}
      <div className="operations-toolbar"><span>전체 {table?.total || 0}건 · {page + 1}페이지</span><div className="flex gap-2"><button className="button secondary" disabled={!page} onClick={() => setPage(page - 1)}>이전</button><button className="button secondary" disabled={(page + 1) * 100 >= (table?.total || 0)} onClick={() => setPage(page + 1)}>다음</button></div></div>
    </section>
  </>
}

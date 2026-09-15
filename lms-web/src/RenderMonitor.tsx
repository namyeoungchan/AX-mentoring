import { useCallback, useEffect, useState } from 'react'
import { Bot, RefreshCw, Server } from 'lucide-react'
import { Badge, CardHeading } from './components'
import { workspaceRequest, demoMode } from './api'

type Row = Record<string, string | number | null>
type SyncState = {
  connection?: { configured: boolean; worker: null | { id: string; name: string; ready: boolean; connected: boolean; seenAt: number }; guilds: { id: string; name: string; connected: boolean; memberCount: number | null }[] };
  configured: boolean; state: 'waiting' | 'synced' | 'stale'; receivedAt: string | null;
  snapshot: null | { name: string; capturedAt: string; rowLimit: number;
    bot: { name: string; ready: boolean; latencyMs: number | null; guildName: string | null; guildId: string; memberCount: number | null };
    counts: { mentors: number; bookings: number; assignments: number; submissions: number; onboarding_progress: number; pending_bookings: number };
    mentors: Row[]; bookings: Row[]; assignments: Row[]; submissions: Row[];
  }
}
const tabs = [
  { key: 'mentors', label: '멘토', columns: [['name', '이름'], ['bio', '소개']] },
  { key: 'bookings', label: '멘토링 예약', columns: [['label', '멘토링'], ['mentor_name', '멘토'], ['user_name', '예약자'], ['start_time', '시작'], ['end_time', '종료'], ['status', '상태']] },
  { key: 'assignments', label: '과제', columns: [['week', '주차'], ['title', '과제명'], ['due_date', '마감'], ['type', '유형'], ['submitted', '제출 건수'], ['is_active', '상태']] },
  { key: 'submissions', label: '제출 내역', columns: [['assignment_title', '과제명'], ['user_name', '제출자'], ['team', '팀'], ['content', '내용'], ['link', '제출 링크'], ['submitted_at', '제출일시']] },
] as const
const formatDate = (value: string) => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
export default function RenderMonitor({ query, workspaceId, workspaceName }: { query: string; workspaceId: string; workspaceName: string }) {
  const [result, setResult] = useState<SyncState | null>(null)
  const [error, setError] = useState('')
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (demoMode) return
    setBusy(true)
    try {
      const body = await workspaceRequest(workspaceId, 'integrations/render', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) })
      setResult(body); setError('')
    } catch (e) { if (!signal?.aborted) setError((e as Error).message) }
    finally { if (!signal?.aborted) setBusy(false) }
  }, [workspaceId])
  useEffect(() => {
    if (demoMode) return
    const controller = new AbortController()
    // eslint-disable-next-line react/set-state-in-effect -- Fetch external status on mount, then poll.
    void refresh(controller.signal)
    const interval = setInterval(() => { if (!document.hidden) void refresh(controller.signal) }, 15000)
    return () => { controller.abort(); clearInterval(interval) }
  }, [refresh])
  const snapshot = result?.snapshot
  const connection = result?.connection
  const synced = !error && result?.configured && result.state === 'synced'
  const status = demoMode ? '데모 · 운영 API 미연결' : error ? '조회 실패' : !result ? '확인 중' : !result.configured ? '연결 설정 필요' : !snapshot ? '데이터 수신 대기' : result.state === 'stale' ? '동기화 지연' : '동기화 정상'
  const tab = tabs[active]
  const rows = snapshot?.[tab.key].filter(row => Object.values(row).join(' ').toLowerCase().includes(query.toLowerCase())) || []
  function display(key: string, value: Row[string]) {
    if (key === 'status') return ({ pending: '승인 대기', approved: '예약 확정', completed: '완료' } as Record<string, string>)[String(value)] || value
    if (key === 'is_active') return value === 1 ? '진행 중' : '마감'
    if (key === 'type') return value === 'team' ? '팀' : '개인'
    if (key === 'link' && /^https?:\/\//.test(String(value))) return <a className="text-button" href={String(value)} target="_blank" rel="noreferrer">제출물 열기</a>
    return value === null || value === '' ? '—' : value
  }
  return <>
    {connection && <section className="panel shared-bot-status"><CardHeading title="Render 공통 봇" subtitle="봇 하나가 연결된 모든 워크스페이스를 관리합니다."><Badge tone={connection.worker?.connected ? 'green' : 'orange'}>{connection.worker?.connected ? '공통 봇 온라인' : connection.worker ? connection.worker.ready ? '공통 봇 응답 지연' : '공통 봇 연결 끊김' : '공통 봇 상태 대기'}</Badge></CardHeading><div className="admission-detail"><p>{connection.worker ? `${connection.worker.name} · ${connection.worker.id}` : '봇의 연결 상태를 기다리고 있습니다.'}</p>{connection.worker && <p>마지막 상태 수신: {formatDate(new Date(connection.worker.seenAt).toISOString())}</p>}{!connection.guilds.length && <p>Discord 채널 설정에서 이 워크스페이스의 서버 ID를 연결하세요.</p>}</div>{connection.guilds.length > 0 && <div className="table-scroll"><table><thead><tr><th>이 워크스페이스의 Discord 서버</th><th>멤버</th><th>봇 연결</th></tr></thead><tbody>{connection.guilds.map(guild => <tr key={guild.id}><td>{guild.name}<small className="muted"> · {guild.id}</small></td><td>{guild.memberCount ?? '—'}</td><td><Badge tone={guild.connected ? 'green' : 'orange'}>{guild.connected ? '서버 참여 중' : '서버 연결 대기'}</Badge></td></tr>)}</tbody></table></div>}</section>}
    <div className="operations-toolbar"><Badge tone={synced ? 'green' : 'orange'}>{status}</Badge><button className="button secondary" disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} />새로고침</button></div>
    {error && <div className="inline-note error-note" role="alert">{error}{snapshot && ' · 아래는 마지막 수신 데이터입니다.'}</div>}
    {(snapshot || !connection?.worker) && <section className="panel remote-overview"><div className="remote-title"><span className="server-icon"><Server size={24} /></span><div><h2>{workspaceName}</h2><p>기존 운영 DB · 마지막 수신 기록</p></div><Badge tone="neutral">읽기 전용</Badge></div><dl className="remote-status"><div><dt>수신 당시 봇</dt><dd>{synced && snapshot ? snapshot.bot.ready ? '연결됨' : '연결 끊김' : '현재 상태 확인 불가'}</dd></div><div><dt>Discord 서버</dt><dd>{snapshot?.bot.guildName || '—'}</dd></div><div><dt>전체 서버 멤버</dt><dd>{snapshot?.bot.memberCount ?? '—'}</dd></div><div><dt>마지막 수신 (한국 시간)</dt><dd>{result?.receivedAt ? formatDate(result.receivedAt) : '수신 이력 없음'}</dd></div></dl></section>}
    {!snapshot ? <section className="panel remote-empty"><Bot size={34} /><h2>이 워크스페이스에 수신된 운영 데이터가 없습니다.</h2><p>채널 구성·수강생 초대·계정 인증은 Render의 공통 봇이 처리합니다.</p><p>기존 운영 데이터는 연결된 Discord 서버에 해당하는 워크스페이스에만 표시됩니다.</p></section> : <>
      {!synced && <div className="inline-note">마지막 수신 데이터입니다. 봇이 현재 실행 중인지 이 데이터만으로 확인할 수 없습니다.</div>}
      <section className="stats-grid">{[{ label: '멘토', value: snapshot.counts.mentors }, { label: '멘토링 예약', value: snapshot.counts.bookings }, { label: '과제', value: snapshot.counts.assignments }, { label: '과제 제출', value: snapshot.counts.submissions }].map(item => <div className="stat-card" key={item.label}><div className="stat-top">{item.label}</div><div className="stat-value">{item.value}<span>건</span></div></div>)}</section>
      <div className="remote-meta"><span>승인 대기 {snapshot.counts.pending_bookings}건</span><span>온보딩 기록 {snapshot.counts.onboarding_progress}명</span><span>봇 보고 시각 {formatDate(snapshot.capturedAt)}</span></div>
      <div className="tabs remote-tabs">{tabs.map((item, i) => <button key={item.key} className={active === i ? 'selected' : ''} onClick={() => setActive(i)}>{item.label}</button>)}</div>
      <section className="panel"><CardHeading title={tab.label} subtitle={`최신 ${snapshot.rowLimit.toLocaleString()}건까지 표시 · 15초마다 수신 상태 확인`} /><div className="table-scroll"><table><thead><tr>{tab.columns.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id}>{tab.columns.map(([key]) => <td key={key} className={key === 'content' || key === 'bio' ? 'submission-content' : ''}>{display(key, row[key])}</td>)}</tr>)}</tbody></table></div>{!rows.length && <div className="calendar-empty">표시할 데이터가 없습니다.</div>}</section>
    </>}
  </>
}

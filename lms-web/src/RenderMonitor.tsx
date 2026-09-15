import { useCallback, useEffect, useState } from 'react'
import { Bot, RefreshCw, Server } from 'lucide-react'
import { Badge, CardHeading } from './components'
import { apiRequest, demoMode } from './api'

type Row = Record<string, string | number | null>
type SyncState = {
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
export default function RenderMonitor({ query }: { query: string }) {
  const [result, setResult] = useState<SyncState | null>(null)
  const [error, setError] = useState('')
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (demoMode) return
    setBusy(true)
    try {
      const body = await apiRequest('integrations/render', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) })
      setResult(body); setError('')
    } catch (e) { if (!signal?.aborted) setError((e as Error).message) }
    finally { if (!signal?.aborted) setBusy(false) }
  }, [])
  useEffect(() => {
    if (demoMode) return
    const controller = new AbortController()
    // eslint-disable-next-line react/set-state-in-effect -- Fetch external status on mount, then poll.
    void refresh(controller.signal)
    const interval = setInterval(() => { if (!document.hidden) void refresh(controller.signal) }, 15000)
    return () => { controller.abort(); clearInterval(interval) }
  }, [refresh])
  const snapshot = result?.snapshot
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
    <div className="operations-toolbar"><Badge tone={synced ? 'green' : 'orange'}>{status}</Badge><button className="button secondary" disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} />새로고침</button></div>
    {error && <div className="inline-note error-note" role="alert">{error}{snapshot && ' · 아래는 마지막 수신 데이터입니다.'}</div>}
    <section className="panel remote-overview"><div className="remote-title"><span className="server-icon"><Server size={24} /></span><div><h2>{snapshot?.name || '아산 AX'}</h2><p>Render · 운영 데이터 조회</p></div><Badge tone="neutral">읽기 전용</Badge></div><dl className="remote-status"><div><dt>Discord 봇</dt><dd>{synced && snapshot ? snapshot.bot.ready ? '연결됨' : '연결 끊김' : '현재 상태 확인 불가'}</dd></div><div><dt>Discord 서버</dt><dd>{snapshot?.bot.guildName || '—'}</dd></div><div><dt>전체 서버 멤버</dt><dd>{snapshot?.bot.memberCount ?? '—'}</dd></div><div><dt>마지막 수신 (한국 시간)</dt><dd>{result?.receivedAt ? formatDate(result.receivedAt) : '수신 이력 없음'}</dd></div></dl></section>
    {!snapshot ? <section className="panel remote-empty"><Bot size={34} /><h2>Render 봇의 데이터 수신을 기다리고 있습니다.</h2><p>기존 봇에 동기화 코드를 배포하고 웹 API 주소와 전용 인증 키를 설정하면 데이터가 표시됩니다.</p><div className="remote-steps"><span>1. 웹 API를 HTTPS 주소로 배포</span><span>2. Render에 LEARNINGOPS_SYNC_URL / TOKEN 설정</span><span>3. 봇 배포 후 최초 데이터 수신 확인</span></div><p>현재 PC의 localhost 주소에는 Render가 접속할 수 없습니다. 동기화 설정 전에는 운영 상태를 추정하지 않습니다.</p></section> : <>
      {!synced && <div className="inline-note">마지막 수신 데이터입니다. 봇이 현재 실행 중인지 이 데이터만으로 확인할 수 없습니다.</div>}
      <section className="stats-grid">{[{ label: '멘토', value: snapshot.counts.mentors }, { label: '멘토링 예약', value: snapshot.counts.bookings }, { label: '과제', value: snapshot.counts.assignments }, { label: '과제 제출', value: snapshot.counts.submissions }].map(item => <div className="stat-card" key={item.label}><div className="stat-top">{item.label}</div><div className="stat-value">{item.value}<span>건</span></div></div>)}</section>
      <div className="remote-meta"><span>승인 대기 {snapshot.counts.pending_bookings}건</span><span>온보딩 기록 {snapshot.counts.onboarding_progress}명</span><span>봇 보고 시각 {formatDate(snapshot.capturedAt)}</span></div>
      <div className="tabs remote-tabs">{tabs.map((item, i) => <button key={item.key} className={active === i ? 'selected' : ''} onClick={() => setActive(i)}>{item.label}</button>)}</div>
      <section className="panel"><CardHeading title={tab.label} subtitle={`최신 ${snapshot.rowLimit.toLocaleString()}건까지 표시 · 15초마다 수신 상태 확인`} /><div className="table-scroll"><table><thead><tr>{tab.columns.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id}>{tab.columns.map(([key]) => <td key={key} className={key === 'content' || key === 'bio' ? 'submission-content' : ''}>{display(key, row[key])}</td>)}</tr>)}</tbody></table></div>{!rows.length && <div className="calendar-empty">표시할 데이터가 없습니다.</div>}</section>
    </>}
  </>
}

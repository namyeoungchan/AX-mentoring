import { useEffect, useState } from 'react'
import { Search, RefreshCw, ShieldCheck } from 'lucide-react'
import { apiRequest } from './api'
import { ModalShell } from './components'
import './DiscordIdentities.css'

type Record = { kind: string; username: string; userId: string; workspaceName: string; guildId: string; verifiedAt: number | null; expiresAt: number | null; orphan: boolean }
type Identity = { discordId: string; account: { id: string; username: string; name: string } | null; records: Record[]; state: string; orphanCount: number; revision: string }
const states: { [key: string]: string } = { linked: '계정 연결됨', unverified: '인증 전 연결', orphan: '고아 기록', pending: '가입 인증 대기' }
const kinds: { [key: string]: string } = { account: '계정 연결', verification: '서버 인증', registration: '인증 코드 이력', staff: '멘토 연결' }
const date = (value: number) => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })

export default function DiscordIdentities({ logout }: { logout: () => Promise<void> }) {
  const [rows, setRows] = useState<Identity[]>([]), [query, setQuery] = useState(''), [filter, setFilter] = useState('all')
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [reload, setReload] = useState(0)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [limit, setLimit] = useState(25)
  const [selected, setSelected] = useState<Identity | null>(null), [confirmation, setConfirmation] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    apiRequest('admin/discord-identities', { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setRows(result.identities); setLoading(false) } })
      .catch(reason => { if (!controller.signal.aborted) { setError(reason.message); setLoading(false) } })
    return () => controller.abort()
  }, [reload])
  function refresh() { setLoading(true); setError(''); setReload(value => value + 1) }
  const filtered = rows.filter(row => (filter === 'all' || (filter === 'orphan' ? row.state === 'orphan' || row.orphanCount > 0 : row.state === filter)) &&
    `${row.discordId} ${row.account?.name || ''} ${row.account?.username || ''} ${row.records.map(record => `${record.username} ${record.workspaceName} ${record.guildId}`).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()))
  async function remove() {
    if (!selected || busy || confirmation !== selected.discordId) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await apiRequest(`admin/discord-identities/${selected.discordId}`, { method: 'DELETE', body: JSON.stringify({ discordId: confirmation, revision: selected.revision }) })
      setNotice(`${selected.discordId} 인증 기록을 정리했습니다. 웹에서 새 코드를 발급받아 Discord 인증을 진행하세요.`)
      setSelected(null); setConfirmation('')
      if (result.signedOut) await logout()
      else refresh()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '인증 기록을 삭제하지 못했습니다.') }
    finally { setBusy(false) }
  }
  return <section className="identity-panel" aria-label="Discord 인증 기록 관리">
    <div className="identity-intro"><ShieldCheck size={22} /><p>전체 워크스페이스의 Discord 연결과 인증 기록입니다. <strong>고아 기록</strong>은 계정이 없거나 현재 연결과 맞지 않는 기록입니다.</p></div>
    <div className="identity-controls"><label><span>인증 기록 검색</span><div><Search size={17} /><input type="search" value={query} placeholder="Discord ID, 이름, LMS 아이디, 서버" onChange={event => { setQuery(event.target.value); setLimit(25) }} /></div></label><label><span>기록 상태</span><select aria-label="기록 상태" value={filter} onChange={event => { setFilter(event.target.value); setLimit(25) }}><option value="all">전체 기록</option><option value="orphan">고아·불일치 기록</option><option value="linked">계정 연결됨</option><option value="unverified">인증 전 연결</option><option value="pending">가입 인증 대기</option></select></label><button className="button secondary" disabled={busy || loading} onClick={refresh}><RefreshCw size={16} />목록 새로고침</button></div>
    <div className="identity-counts">Discord 계정 {rows.length}개 · 고아·불일치 {rows.filter(row => row.state === 'orphan' || row.orphanCount > 0).length}개 <span>검색 결과 {filtered.length}개</span></div>
    {!selected && error && <p role="alert" className="inline-note error-note">{error}</p>}{notice && <p role="status" className="inline-note">{notice}</p>}
    {loading ? <p role="status" className="identity-empty">인증 기록을 불러오는 중…</p> : !filtered.length ? <p className="identity-empty">조건에 맞는 인증 기록이 없습니다.</p> : <ul className="identity-list">{filtered.slice(0,limit).map(row => <li key={row.discordId}>
      <div className="identity-row"><div><strong className="identity-discord-id">{row.discordId}</strong><p>{row.account ? `${row.account.name} · ${row.account.username}` : '연결된 LMS 계정 없음'}</p></div><div><span className={`identity-state ${row.state === 'orphan' || row.orphanCount ? 'needs-cleanup' : ''}`}>{states[row.state]}</span>{row.orphanCount > 0 && <small>고아·불일치 {row.orphanCount}건</small>}</div><div className="identity-workspaces">{[...new Set(row.records.map(record => record.workspaceName).filter(Boolean))].join(', ') || '서버 인증 기록 없음'}<small>연결·인증 이력 {row.records.length}건</small></div><button className="button secondary" disabled={busy} onClick={() => { setSelected(row); setConfirmation(''); setError('') }}>{row.account ? '인증 연결 해제' : '인증 기록 삭제'}</button></div>
      <details className="identity-details"><summary>인증 내역 {row.records.length}건 보기</summary><ul>{row.records.map((record,index) => <li key={index}><div><strong>{kinds[record.kind]}</strong>{record.orphan && <span>고아·불일치</span>}<p>{record.workspaceName || '전체 계정'}{record.guildId && ` · 서버 ${record.guildId}`}</p>{record.username && <p>LMS 아이디 {record.username}</p>}</div><p>{record.verifiedAt !== null ? `인증 ${date(record.verifiedAt)}` : record.expiresAt !== null ? `코드 만료 ${date(record.expiresAt)}` : '인증 시각 없음'}</p></li>)}</ul></details>
    </li>)}</ul>}
    {filtered.length > limit && <button className="button secondary identity-more" onClick={() => setLimit(value => value + 25)}>25개 더 보기</button>}
    {selected && <ModalShell title={selected.account ? 'Discord 인증 연결 해제' : 'Discord 인증 기록 삭제'} busy={busy} close={() => { if (!busy) { setSelected(null); setError('') } }}><form className="modal-form" onSubmit={event => { event.preventDefault(); void remove() }}>
      <p><strong>{selected.discordId}</strong><br />{selected.account ? `${selected.account.name} · ${selected.account.username}` : '연결된 LMS 계정 없음'}</p>
      <p>이 Discord ID의 전체 서버 인증과 인증 코드 이력을 삭제합니다.{selected.account && ' 현재 LMS 계정의 Discord 연결을 해제하고 해당 계정의 로그인을 모두 종료합니다.'} 정리 후에는 웹에서 새 인증 코드를 발급받으세요.</p>
      <p>로그인 계정과 소속, 출결·과제·멘토링 기록은 유지됩니다.</p>
      <label>확인할 Discord ID<input value={confirmation} onChange={event => setConfirmation(event.target.value)} required autoComplete="off" inputMode="numeric" disabled={busy} placeholder={selected.discordId} /></label>
      {error && <p role="alert" className="error-note">{error}</p>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => { setSelected(null); setError('') }}>취소</button><button className="button danger" disabled={busy || confirmation !== selected.discordId}>{busy ? '정리 중…' : '인증 기록 삭제'}</button></div>
    </form></ModalShell>}
  </section>
}

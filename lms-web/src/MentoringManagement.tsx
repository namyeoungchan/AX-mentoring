import { useState } from 'react'
import { Check } from 'lucide-react'
import { Avatar, Badge, CardHeading, Empty } from './components'
import type { Workspace } from './data'
import type { Change } from './Management'

export default function MentoringManagement({ data, query = '', filter, setFilter, change, saving = false }: { data: Workspace; query?: string; filter: string; setFilter: (filter: string) => void; change: Change; saving?: boolean }) {
  const [notice, setNotice] = useState('')
  const matches = (text: string) => text.toLowerCase().includes(query.toLowerCase())
  const sessions = data.sessions.filter(s => matches(`${s.title} ${s.mentor} ${s.team}`) && (filter === '전체' || s.status === filter)).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
  async function update(updater: Parameters<Change>[0], message: string) {
    setNotice('')
    if (await change(updater, message)) setNotice(message)
  }
  return <div className="panel">{notice && <p className="inline-note" role="status">{notice}</p>}<CardHeading title="멘토링 예약 현황" subtitle={`승인을 기다리는 예약이 ${data.sessions.filter(s => s.status === '승인 대기').length}건 있어요.`}><select className="select-control" aria-label="예약 상태 필터" value={filter} onChange={e => setFilter(e.target.value)}>{['전체', '승인 대기', '예약 확정', '완료', '취소'].map(f => <option key={f}>{f}</option>)}</select></CardHeading><div className="table-scroll"><table><thead><tr><th>멘토링</th><th>담당 멘토</th><th>일정</th><th>상태</th><th>관리</th></tr></thead><tbody>{sessions.map(s => <tr key={s.id}><td><strong>{s.title}</strong><small>{s.team}</small></td><td><div className="person-cell"><Avatar name={s.mentor} small />{s.mentor}</div></td><td>{s.date}<small>{s.time} – 50분</small></td><td><Badge tone={s.status === '승인 대기' ? 'orange' : s.status === '완료' ? 'neutral' : 'green'}>{s.status}</Badge></td><td>{!['완료', '취소'].includes(s.status) ? <button className="button compact secondary" disabled={saving} onClick={() => update(d => ({ ...d, sessions: d.sessions.map(row => row.id === s.id ? { ...row, status: s.status === '승인 대기' ? '예약 확정' : '완료' } : row) }), s.status === '승인 대기' ? '예약을 승인했습니다.' : '멘토링을 완료 처리했습니다.')}><Check size={14} />{s.status === '승인 대기' ? '승인' : '완료 처리'}</button> : <span className="muted">{s.status}</span>}{!['완료', '취소'].includes(s.status) && <button className="button compact secondary ml-2" disabled={saving} onClick={() => update(d => ({ ...d, sessions: d.sessions.map(row => row.id === s.id ? { ...row, status: '취소' } : row) }), '예약을 취소했습니다.')}>취소</button>}</td></tr>)}</tbody></table></div>{!sessions.length && <Empty />}</div>
}

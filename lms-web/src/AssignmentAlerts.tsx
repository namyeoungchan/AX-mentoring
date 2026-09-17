import { useEffect, useState } from 'react'
import { workspaceRequest } from './api'
import { CardHeading } from './components'
type Assignment = { id: string; title: string; courseId: string; dueDate: string; type: string; submitted: number; total: number; unmatchedSubmissions: number; targets: { key: string; name: string; completed: boolean }[] }
type Delivery = { id: string; kind: string; assignmentId: string; state: string; attempts: number; error: string; messageId: string; payload: { title: string; description: string } }
type Data = { policy: string; courses: { id: string; title: string }[]; assignments: Assignment[]; deliveries: Delivery[] }
const states: Record<string, string> = { pending: '대기', sending: '발송 중', failed: '실패', uncertain: '결과 확인 필요', reconcile: '기존 메시지 확인 대기', sent: '발송 완료', manual: '수동 완료', held: '수동 대기', cancelled: '발송 취소' }
const errors: Record<string, string> = { permissions: '봇 채널/DM 권한을 확인하세요.', channel_unconfigured: '비공개 과제 대시보드 채널을 적용하세요.', recipient_unavailable: 'Discord 인증 또는 팀 채널·역할을 확인하세요.', private_channel_required: '알림 대상 채널의 비공개 권한을 확인하세요.', channel_missing: '채널 또는 서버 참여자를 찾지 못했습니다.', rate_limit: 'Discord 요청 제한입니다.', timeout: '응답이 없어 기존 메시지를 확인합니다.', not_found: '기존 메시지를 찾지 못했습니다. 수동 대사가 필요합니다.', discord_error: 'Discord 오류입니다.', no_longer_due: '제출 완료·마감 변경 등으로 알림 대상에서 제외했습니다.', assignment_removed: '삭제된 과제입니다.' }
export default function AssignmentAlerts({ workspaceId, revision }: { workspaceId: string; revision?: string }) {
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [reload, setReload] = useState(0)
  const [bindings, setBindings] = useState<Record<string, string>>({})
  useEffect(() => { const c = new AbortController(); workspaceRequest(workspaceId, 'assignment-alerts', { signal: c.signal }).then(setData).catch((e: Error) => { if (!c.signal.aborted) setError(e.message) }); return () => c.abort() }, [workspaceId, revision, reload])
  async function run(path: string, body: unknown) {
    if (busy) return
    setBusy(true); setError('')
    try { await workspaceRequest(workspaceId, path, { method: 'POST', body: JSON.stringify(body) }); setReload(n => n + 1); setMessage('요청을 저장했습니다. 알림 상태를 확인하세요.') } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  function copy(text: string) { void navigator.clipboard.writeText(text.replaceAll('@', '@\u200b')).then(() => setMessage('수동 안내문을 복사했습니다.')).catch(() => setError('클립보드를 사용할 수 없습니다. 화면의 명단과 안내문을 직접 복사하세요.')) }
  return <section className="panel assignment-alerts"><CardHeading title="과제 제출 대상·알림" subtitle="제출 원장을 기준으로 확인합니다. D-1은 한국시간 오전 9시부터 하루 1회입니다." />
    <p className="inline-note">{data?.policy}</p>{error && <p role="alert" className="inline-note error-note">{error}</p>}{message && <p role="status" className="inline-note">{message}</p>}
    <button className="button secondary" onClick={() => setReload(n => n + 1)}>과제 알림 새로고침</button>
    {data?.assignments.map(a => <details key={a.id} className="assignment-item"><summary>{a.title} · {a.type === 'team' ? '팀' : '개인'} 제출 완료 {a.submitted}/{a.total}</summary>
      {!a.courseId && <div className="modal-form"><p>과정을 연결해야 제출 대상과 D-1 알림을 계산할 수 있습니다. 연결 후 과정은 바꿀 수 없습니다.</p><label>{a.title} 대상 과정<select value={bindings[a.id] || ''} onChange={e => setBindings(v => ({ ...v, [a.id]: e.target.value }))}><option value="">선택하세요</option>{data.courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label><button className="button secondary" disabled={busy || !bindings[a.id]} onClick={() => void run(`assignment-alerts/${a.id}/course`, { courseId: bindings[a.id] })}>과제 대상 과정 연결</button></div>}
      <p>{a.unmatchedSubmissions > 0 ? `팀을 식별하지 못한 기존 제출 ${a.unmatchedSubmissions}건이 있습니다. 제출 원장과 명단을 대조하세요.` : ''}</p><p>미제출: {a.targets.filter(t => !t.completed).map(t => t.name).join(', ') || '없음'}</p><p>제출 완료: {a.targets.filter(t => t.completed).map(t => t.name).join(', ') || '없음'}</p>
      <p>안내문: {a.title} 과제 마감은 {a.dueDate}입니다. 제출 여부를 확인해 주세요.</p>
      <button className="button secondary" onClick={() => copy(`${a.title} 과제 마감: ${a.dueDate}\n미제출 대상: ${a.targets.filter(t => !t.completed).map(t => t.name).join(', ')}\n제출 여부를 확인해 주세요.`)}>미제출 안내문 복사</button>
    </details>)}
    <div className="table-scroll"><table><thead><tr><th>알림</th><th>상태</th><th>시도</th><th>확인 사항</th><th>메시지 ID</th><th>관리</th></tr></thead><tbody>{data?.deliveries.map(d => <tr key={d.id}><td><strong>{d.payload.title}</strong><small style={{ whiteSpace: 'pre-wrap' }}>{d.payload.description}</small></td><td>{states[d.state]}</td><td>{d.attempts}</td><td>{errors[d.error] || '—'}</td><td>{d.messageId || '—'}</td><td>{['failed', 'uncertain'].includes(d.state) && <button disabled={busy} className="button secondary" onClick={() => void run(`outbox/${d.id}/retry`, {})}>{d.state === 'uncertain' ? '기존 메시지 확인' : '알림 재시도'}</button>}<button className="button secondary" disabled={busy || !['pending', 'failed', 'uncertain'].includes(d.state)} onClick={() => void run(`outbox/${d.id}/hold`, {})}>자동 알림 중지</button><button className="button secondary" onClick={() => copy(`${d.payload.title}\n${d.payload.description}`)}>안내문 복사</button></td></tr>)}</tbody></table></div>
  </section>
}

import { useState } from 'react'
import { Badge } from './components'
import type { useAssignmentAlerts } from './useAssignmentAlerts'

const states: Record<string, string> = { pending: '대기', sending: '발송 중', failed: '실패', uncertain: '결과 확인 필요', reconcile: '기존 메시지 확인 대기', sent: '발송 완료', manual: '수동 완료', held: '수동 대기', cancelled: '발송 취소' }
const errors: Record<string, string> = { permissions: '봇 채널/DM 권한을 확인하세요.', channel_unconfigured: '비공개 과제 대시보드 채널을 적용하세요.', recipient_unavailable: 'Discord 인증 또는 팀 채널·역할을 확인하세요.', private_channel_required: '알림 대상 채널의 비공개 권한을 확인하세요.', channel_missing: '채널 또는 서버 참여자를 찾지 못했습니다.', rate_limit: 'Discord 요청 제한입니다.', timeout: '응답이 없어 기존 메시지를 확인합니다.', not_found: '기존 메시지를 찾지 못했습니다. 수동 대사가 필요합니다.', discord_error: 'Discord 오류입니다.', no_longer_due: '제출 완료·마감 변경 등으로 알림 대상에서 제외했습니다.', assignment_removed: '삭제된 과제입니다.', publication_target_changed: '과제 마감 또는 대상·서버 변경으로 배포 알림을 취소했습니다.' }
export default function AssignmentAlerts({ state, assignmentId }: { state: ReturnType<typeof useAssignmentAlerts>; assignmentId: string }) {
  const [binding, setBinding] = useState('')
  const { data, busy, run, copy } = state
  const a = data?.assignments.find(row => row.id === assignmentId)
  if (!a) return <p className="assignment-no-submissions">제출 대상 정보를 불러오는 중…</p>
  const deliveries = data!.deliveries.filter(d => d.assignmentId === assignmentId)
  return <section className="assignment-alerts" aria-label={`${a.title} 제출 대상 및 알림`}>
    <div className="assignment-target-heading"><div><h3>제출 대상 · Discord 알림</h3><p>{data!.courses.find(c => c.id === a.courseId)?.title || '기존 과제의 과정 확인 필요'} · {a.type === 'team' ? '팀별' : '개인별'} 제출</p></div><Badge tone={a.courseId ? 'green' : 'orange'}>{a.courseId ? '대상 연결 완료' : '과정 확인 필요'}</Badge></div>
    {!a.courseId && <div className="assignment-legacy-binding"><p>{data!.courses.length ? '기존 과제의 대상 과정을 확인해 주세요. 새 과제는 생성할 때 자동으로 연결됩니다.' : '학습 과정을 먼저 등록해 주세요. 과정이 하나면 기존 과제의 대상도 자동으로 연결됩니다.'}</p><label>{a.title} 대상 과정<select value={binding} onChange={e => setBinding(e.target.value)}><option value="">과정 선택</option>{data!.courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label><button className="button secondary" disabled={busy || !binding} onClick={() => void run(`assignment-alerts/${a.id}/course`, { courseId: binding })}>기존 과제 과정 지정</button></div>}
    {a.unmatchedSubmissions > 0 && <p className="inline-note">팀을 식별하지 못한 기존 제출 {a.unmatchedSubmissions}건이 있습니다. 제출 내역과 명단을 확인하세요.</p>}
    <div className="assignment-target-roster"><p><strong>미제출:</strong> {a.targets.filter(t => !t.completed).map(t => t.name).join(', ') || '없음'}</p><p><strong>제출 완료:</strong> {a.targets.filter(t => t.completed).map(t => t.name).join(', ') || '없음'}</p><small>{a.type === 'team' ? '팀 과제는 팀에서 한 명 이상 제출하면 완료로 집계합니다.' : '선택한 과정의 수강생별로 제출 여부를 집계합니다.'}</small></div>
    <div className="publication-preview"><strong>{a.type === 'team' ? `팀 채팅 ${a.total}곳에 배포` : `수강생 ${a.total}명에게 개인 DM 배포`}</strong><p>대상: {a.targets.map(t => t.name).join(', ') || '없음'} · 마감: {a.dueDate}</p><p>과제 생성 시 제출 대상이 연결됩니다. 새 과제 알림은 아래 배포 버튼으로 보낼 수 있습니다. D-1 알림은 한국시간 오전 9시부터입니다.</p>
      <div className="assignment-action-group"><button className="button primary" disabled={busy || a.publishedAt !== null || !a.active || !a.courseId || !a.total} onClick={() => void run(`assignment-alerts/${a.id}/publish`, { revision: a.revision })}>{a.publishedAt !== null ? '배포 요청 완료' : '과제 배포'}</button><button className="button secondary" onClick={() => copy(`${a.title} 과제 마감: ${a.dueDate}\n미제출 대상: ${a.targets.filter(t => !t.completed).map(t => t.name).join(', ')}\n제출 여부를 확인해 주세요.`)}>미제출 안내문 복사</button></div>
      {a.publishedAt !== null && <p role="status">배포 요청이 저장되었습니다. 아래에서 발송 상태를 확인하세요.</p>}
    </div>
    <details className="assignment-delivery-history"><summary>알림 발송 내역 · {deliveries.length}건{deliveries.some(d => ['failed','uncertain'].includes(d.state)) ? ' · 확인 필요' : ''}</summary>
      {deliveries.length ? <div className="table-scroll"><table><thead><tr><th>알림</th><th>상태</th><th>확인 사항</th><th>관리</th></tr></thead><tbody>{deliveries.map(d => <tr key={d.id}><td><strong>{d.payload.title}</strong><small>{d.payload.description}</small></td><td><Badge tone={['failed','uncertain'].includes(d.state) ? 'orange' : 'neutral'}>{states[d.state]}</Badge><small>{d.attempts}회 시도</small></td><td>{errors[d.error] || '—'}</td><td><div className="assignment-action-group">{['failed','uncertain'].includes(d.state) && <button disabled={busy} className="button secondary compact" onClick={() => void run(`outbox/${d.id}/retry`, {})}>{d.state === 'uncertain' ? '기존 메시지 확인' : '알림 재시도'}</button>}{['pending','failed','uncertain'].includes(d.state) && <button className="button secondary compact" disabled={busy} onClick={() => void run(`outbox/${d.id}/hold`, {})}>자동 알림 중지</button>}<button className="button secondary compact" onClick={() => copy(`${d.payload.title}\n${d.payload.description}`)}>안내문 복사</button></div></td></tr>)}</tbody></table></div> : <p>아직 발송 내역이 없습니다.</p>}
    </details>
  </section>
}

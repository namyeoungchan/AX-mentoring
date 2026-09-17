import { useEffect, useState } from 'react'
import { workspaceRequest } from './api'
import { CardHeading, ModalShell } from './components'
const states: Record<string, string> = { pending: '발송 대기', sending: '발송 중', sent: '발송 완료', failed: '발송 실패', uncertain: '결과 확인 필요', reconcile: '기존 메시지 확인 대기', manual: '수동 발송 완료', held: '수동 발송 대기' }
const errors: Record<string, string> = { permissions: '봇 채널 권한을 확인하세요.', channel_missing: '지정 채널이 없습니다. 서버 구성을 확인하세요.', rate_limit: 'Discord 요청 제한입니다. 잠시 후 재시도하세요.', timeout: '응답을 확인하지 못했습니다. 기존 메시지를 먼저 조회합니다.', not_found: '기존 메시지를 찾지 못했습니다. Discord에서 확인 후 메시지 링크를 기록하세요.', discord_error: 'Discord 오류입니다. 채널과 메시지를 확인하세요.' }
type Notice = { id: string; title: string; target: string; revision: string; preview: { title: string; description: string; course: string }; delivery: null | { id: string; state: string; error: string; attempts: number; channelId: string; guildId: string; messageId: string }; attempts: { state: string; error: string; createdAt: number }[] }
type Data = { destination: { channelId: string; guildId: string } | null; channelError: string; notices: Notice[] }
export default function NoticeDelivery({ workspaceId, revision, refresh }: { workspaceId: string; revision?: string; refresh?: () => Promise<void> }) {
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Notice | null>(null), [messageUrl, setMessageUrl] = useState(''), [reload, setReload] = useState(0)
  useEffect(() => { const c = new AbortController(); workspaceRequest(workspaceId, 'notices', { signal: c.signal }).then(setData).catch((e: Error) => { if (!c.signal.aborted) setError(e.message) }); return () => c.abort() }, [workspaceId, revision, reload])
  async function act(action: 'send' | 'retry' | 'manual' | 'hold') {
    if (!selected || busy) return
    setBusy(true); setError(''); setMessage('')
    try {
      const path = action === 'send' ? `notices/${encodeURIComponent(selected.id)}/send` : `outbox/${selected.delivery?.id}/${action}`
      await workspaceRequest(workspaceId, path, { method: 'POST', body: JSON.stringify(action === 'send' ? { revision: selected.revision } : action === 'manual' ? { messageUrl } : {}) })
      setSelected(null); setReload(n => n + 1); await refresh?.(); setMessage(action === 'manual' ? '수동 발송 기록을 저장했습니다.' : '발송 작업을 요청했습니다. 결과를 새로고침해 확인하세요.')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="panel"><CardHeading title="Discord 공지 발송" subtitle="과정명을 표시하고 공통 공지 채널에 게시합니다. 모든 멘션은 차단됩니다." />
    {message && <p role="status" className="inline-note">{message}</p>}{!selected && error && <p role="alert" className="inline-note error-note">{error}</p>}
    <p className="inline-note">{data?.destination ? `게시 채널: ${data.destination.channelId} · 이 채널을 볼 수 있는 모든 구성원이 읽을 수 있습니다. 관리자·멘토 전용 초안은 발송할 수 없습니다.` : data?.channelError}</p>
    <button className="button secondary" disabled={busy} onClick={() => setReload(n => n + 1)}>발송 결과 새로고침</button>
    <div className="table-scroll"><table><thead><tr><th>공지</th><th>발송 상태</th><th>시도</th><th>확인 사항</th><th>관리</th></tr></thead><tbody>{data?.notices.map(n => <tr key={n.id}><td>{n.title}</td><td>{n.delivery ? states[n.delivery.state] : '초안'}</td><td>{n.delivery?.attempts || 0}</td><td>{errors[n.delivery?.error || ''] || '—'}</td><td><button className="button secondary" onClick={() => { setSelected(n); setError(''); setMessageUrl('') }}>발송 미리보기</button></td></tr>)}</tbody></table></div>
    {selected && <ModalShell title="공지 발송 미리보기" close={() => { if (!busy) setSelected(null) }}>
      {error && <p role="alert" className="inline-note error-note">{error}</p>}
      <h3>{selected.preview.title}</h3><p>{selected.preview.course}</p><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{selected.preview.description}</p>
      <p>공통 공지 채널 게시 · 멘션 없음. 발송 요청 후 내용은 고정되며 수정 공지는 새로 작성합니다.</p>
      <button className="button secondary" onClick={() => { void navigator.clipboard.writeText(`${selected.preview.course}\n${selected.preview.title}\n${selected.preview.description}`.replaceAll('@', '@\u200b')).then(() => setMessage('미리보기를 복사했습니다.')).catch(() => setError('클립보드를 사용할 수 없습니다. 미리보기 텍스트를 선택해 복사하세요.')) }}>공지 내용 복사</button>
      {!selected.delivery && <button disabled={busy || !data?.destination || selected.target !== '과정 전체'} className="button primary" onClick={() => void act('send')}>Discord 발송 요청</button>}
      {selected.delivery && ['failed', 'uncertain'].includes(selected.delivery.state) && <button disabled={busy} className="button primary" onClick={() => void act('retry')}>{selected.delivery.state === 'uncertain' ? '기존 메시지 확인' : '발송 재시도'}</button>}
      {selected.delivery?.messageId && <p><a target="_blank" rel="noreferrer" href={`https://discord.com/channels/${selected.delivery.guildId}/${selected.delivery.channelId}/${selected.delivery.messageId}`}>발송 메시지 보기</a></p>}
      {selected.delivery && ['pending', 'failed', 'uncertain'].includes(selected.delivery.state) && <button disabled={busy} className="button secondary" onClick={() => void act('hold')}>수동 발송으로 전환</button>}
      {selected.delivery?.state === 'held' && <div className="modal-form"><p>자동 발송을 중지했습니다. Discord의 기존 메시지를 먼저 확인한 뒤 수동 게시하거나 확인한 메시지 링크를 입력하세요.</p><label>수동 게시 메시지 링크<input value={messageUrl} onChange={e => setMessageUrl(e.target.value)} placeholder="https://discord.com/channels/..." /></label><button disabled={busy || !messageUrl} className="button secondary" onClick={() => void act('manual')}>수동 발송 완료 기록</button></div>}
      <details><summary>발송 시도 이력</summary>{selected.attempts.map((attempt, i) => <p key={i}>{new Date(attempt.createdAt).toLocaleString()} · {states[attempt.state]} · {errors[attempt.error] || ''}</p>)}</details>
    </ModalShell>}
  </section>
}

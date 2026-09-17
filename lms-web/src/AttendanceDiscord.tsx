import { useEffect, useState } from 'react'
import { workspaceRequest } from './api'

type Delivery = { state: string; error: string; current: boolean; guildId: string; channelId: string; messageId: string }
type Summary = { revision: string; destination: { guildId: string; channelId: string } | null; channelError: string; canShare: boolean; preview: { title: string; course: string; description: string }; delivery: Delivery | null }
const labels: Record<string, string> = { pending: '발송 대기', sending: '발송 중', sent: '발송 완료', failed: '발송 실패', uncertain: '결과 확인 필요', reconcile: '기존 메시지 확인 중', held: '발송 보류', manual: '수동 발송 완료' }
const errors: Record<string, string> = { permissions: '봇의 채널 권한을 확인하세요.', private_channel_required: '운영자 전용 채널 권한을 확인하세요.', channel_missing: '서버 구성을 적용해 운영자 채널을 확인하세요.', timeout: '발송 응답을 확인하지 못했습니다. 기존 메시지를 먼저 확인합니다.', not_found: '기존 메시지를 찾지 못했습니다. Discord에서 확인하세요.', rate_limit: 'Discord 요청 제한입니다. 잠시 후 다시 시도하세요.', discord_error: 'Discord 상태를 확인하세요.' }
export default function AttendanceDiscord({ workspaceId, courseId, date, period, revision, dirty }: { workspaceId: string; courseId: string; date: string; period: number; revision: string; dirty: boolean }) {
  const [data, setData] = useState<Summary | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [reload, setReload] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    workspaceRequest(workspaceId, `attendance/discord?${new URLSearchParams({ courseId, date, period: String(period) })}`, { signal: controller.signal }).then(setData).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [workspaceId, courseId, date, period, revision, reload])
  const deliveryState = data?.delivery?.state
  useEffect(() => {
    if (!deliveryState || !['pending', 'sending', 'reconcile'].includes(deliveryState)) return
    const timer = setInterval(() => setReload(n => n + 1), 5000)
    return () => clearInterval(timer)
  }, [deliveryState])
  async function send() {
    if (!data || busy || dirty || data.revision !== revision) return
    setBusy(true); setError('')
    try { setData(await workspaceRequest(workspaceId, 'attendance/discord', { method: 'POST', body: JSON.stringify({ courseId, date, period, revision }) })) }
    catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  const delivery = data?.delivery
  const sent = delivery?.current && ['pending', 'sending', 'sent', 'reconcile', 'manual', 'held'].includes(delivery.state)
  return <details className="attendance-history attendance-discord"><summary>Discord 출결 집계 공유{delivery && ` · ${labels[delivery.state] || delivery.state}`}</summary>
    <p>저장한 담당 명단의 인원 집계를 운영자 전용 과제 대시보드 채널에 공유합니다. 학생 이름·사유는 보내지 않습니다.</p>
    {data && <><h3>{data.preview.title}</h3><p>{data.preview.course}</p><p className="attendance-discord-preview">{data.preview.description}</p></>}
    {error && <p role="alert">{error}</p>}
    {data?.channelError && <p>{data.channelError} 출결 입력과 저장은 계속할 수 있습니다.</p>}
    {dirty && <p>저장 전 변경이 있습니다. 먼저 출결 일괄 저장을 눌러주세요.</p>}
    {delivery && <p>{delivery.current ? '현재 집계' : '이전 집계'}: {labels[delivery.state]} {errors[delivery.error] || ''}</p>}
    <div className="attendance-round-actions"><button className="button primary" disabled={busy || dirty || !data?.destination || !data.canShare || data.revision !== revision || !!sent} onClick={() => void send()}>{busy ? '요청 중…' : delivery?.current && delivery.state === 'failed' ? '출결 집계 발송 재시도' : delivery?.current && delivery.state === 'uncertain' ? '기존 출결 메시지 확인' : 'Discord에 출결 집계 공유'}</button>
      <button className="button secondary" disabled={busy} onClick={() => { setError(''); setReload(n => n + 1) }}>출결 발송 상태 확인</button>
      {delivery?.messageId && <a href={`https://discord.com/channels/${delivery.guildId}/${delivery.channelId}/${delivery.messageId}`} target="_blank" rel="noreferrer">Discord 출결 메시지 보기</a>}
    </div>
  </details>
}

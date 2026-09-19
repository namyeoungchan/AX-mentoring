import { useEffect, useState } from 'react'
import { workspaceRequest } from './api'

export type AssignmentTarget = { revision: string; publishedAt: number | null; active: boolean; id: string; title: string; courseId: string; dueDate: string; type: string; submitted: number; total: number; unmatchedSubmissions: number; targets: { key: string; name: string; completed: boolean }[] }
type Delivery = { id: string; kind: string; assignmentId: string; state: string; attempts: number; error: string; messageId: string; payload: { title: string; description: string } }
type Data = { policy: string; courses: { id: string; title: string }[]; assignments: AssignmentTarget[]; deliveries: Delivery[] }

export function useAssignmentAlerts(workspaceId: string, revision?: string, enabled = true) {
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [reload, setReload] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const c = new AbortController()
    workspaceRequest(workspaceId, 'assignment-alerts', { signal: c.signal }).then(result => { setData(result); setError('') }).catch((e: Error) => { if (!c.signal.aborted) setError(e.message) })
    return () => c.abort()
  }, [workspaceId, revision, reload, enabled])
  async function run(path: string, body: unknown) {
    if (busy) return
    setBusy(true); setError(''); setMessage('')
    try { await workspaceRequest(workspaceId, path, { method: 'POST', body: JSON.stringify(body) }); setReload(n => n + 1); setMessage('요청을 저장했습니다. 처리 상태를 확인하세요.') }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const waiting = data?.deliveries.some(d => ['pending', 'sending', 'reconcile'].includes(d.state))
  useEffect(() => { if (!waiting) return; const timer = window.setInterval(() => { if (!document.hidden) setReload(n => n + 1) }, 10000); return () => window.clearInterval(timer) }, [waiting])
  function copy(text: string) { void navigator.clipboard.writeText(text.replaceAll('@', '@\u200b')).then(() => setMessage('안내문을 복사했습니다.')).catch(() => setError('복사 버튼을 사용할 수 없습니다. 표시된 안내문을 직접 복사하세요.')) }
  return { data, error, message, busy, run, copy, refresh: () => setReload(n => n + 1) }
}

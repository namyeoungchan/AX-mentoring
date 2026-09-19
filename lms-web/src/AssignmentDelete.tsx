import { useEffect, useRef, useState } from 'react'
import { ModalShell } from './components'
import { workspaceRequest } from './api'

type Preview = { assignment: { title: string; week: number }; submissionCount: number; revision: string }
export default function AssignmentDelete({ workspaceId, assignmentId, close, removed }: { workspaceId: string; assignmentId: string; close: () => void; removed: (deleted: boolean) => void }) {
  const [preview, setPreview] = useState<Preview | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [reload, setReload] = useState(0)
  const requestId = useRef(crypto.randomUUID())
  const path = `assignments/${encodeURIComponent(assignmentId)}`
  useEffect(() => {
    const controller = new AbortController()
    workspaceRequest(workspaceId, `${path}/deletion`, { signal: controller.signal }).then((result: Preview) => { setPreview(result); setError(''); requestId.current = crypto.randomUUID() }).catch((e: Error) => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [workspaceId, path, reload])
  async function remove() {
    if (!preview || busy) return
    setBusy(true); setError('')
    try {
      const result = await workspaceRequest(workspaceId, path, { method: 'DELETE', body: JSON.stringify({ revision: preview.revision, requestId: requestId.current }) })
      removed(result.deleted)
    } catch (e) {
      setError((e as Error).message)
      if ((e as { status?: number }).status === 409) setPreview(null)
    } finally { setBusy(false) }
  }
  return <ModalShell title="과제 삭제" close={close} busy={busy} className="membership-removal">
    <div className="modal-form">
      {preview ? <><p><strong>{preview.assignment.week}주차 · {preview.assignment.title}</strong></p><p>이 과제와 제출 내역 <strong>{preview.submissionCount}건</strong>을 영구 삭제합니다. 연결된 제출 대상과 대기 중인 알림도 정리됩니다.</p><p className="inline-note error-note">삭제 후 되돌릴 수 없습니다. 제출 내역이 필요하면 취소 후 과제 목록에서 다운로드하세요.</p></> : !error && <p role="status">삭제할 과제와 제출 내역을 확인하는 중…</p>}
      {error && <p className="inline-note error-note" role="alert">{error}</p>}
      <div className="modal-actions"><button className="button secondary" disabled={busy} data-modal-autofocus onClick={close}>취소</button>{!preview && error ? <button className="button secondary" onClick={() => { setError(''); setReload(n => n + 1) }}>최신 내역 다시 확인</button> : <button className="button danger" disabled={!preview || busy} onClick={() => void remove()}>{busy ? '삭제 중…' : '과제 영구 삭제'}</button>}</div>
    </div>
  </ModalShell>
}

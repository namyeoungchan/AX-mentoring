import { useEffect, useState } from 'react'
import { ModalShell } from './components'
import { workspaceRequest } from './api'
import type { Learner, Workspace } from './data'
import type { Change } from './Management'

type Plan = { learner: Learner; course: string; accounts: { username: string }[]; history: { attendance: number; scores: number }; revision: string }
export default function LearnerDelete({ learner, data, change, close, removed }: { learner: Learner; data: Workspace; change: Change; close: () => void; removed: (deleted: boolean) => void }) {
  const [plan, setPlan] = useState<Plan | null>(data.mode === 'api' ? null : { learner, course: data.courses.find(c => c.id === learner.courseId)?.title || '', accounts: [], history: { attendance: data.attendance.filter(r => r.studentId === learner.id).length, scores: data.scores.filter(r => r.studentId === learner.id).length }, revision: '' })
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [reload, setReload] = useState(0)
  const path = `learners/${encodeURIComponent(learner.id)}`
  useEffect(() => {
    if (data.mode !== 'api') return
    const controller = new AbortController()
    workspaceRequest(data.workspaceId!, `${path}/deletion`, { signal: controller.signal }).then(setPlan).catch((e: Error) => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [data.mode, data.workspaceId, path, reload])
  async function remove() {
    if (!plan || busy) return
    setBusy(true); setError('')
    try {
      if (data.mode === 'api') {
        const result = await workspaceRequest(data.workspaceId!, path, { method: 'DELETE', body: JSON.stringify({ revision: plan.revision }) })
        removed(result.deleted)
      } else if (await change(d => ({ ...d, learners: d.learners.filter(l => l.id !== learner.id), removedLearners: [...(d.removedLearners || []), { ...learner, status: '비활성' }] }), '수강생을 삭제했습니다.')) removed(true)
    } catch (e) {
      setError((e as Error).message)
      if ((e as { status?: number }).status === 409) setPlan(null)
    } finally { setBusy(false) }
  }
  return <ModalShell title="수강생 삭제 확인" close={close} busy={busy} className="membership-removal">
    <div className="modal-form">
      <p><strong>{learner.name}</strong>{plan && <><br />{plan.course} · {plan.learner.team || '팀 미배정'}</>}</p>
      {!plan && !error && <p role="status">연결된 계정과 학습 이력을 확인하고 있습니다…</p>}
      {plan && <><p>이 워크스페이스의 수강생 명단에서 삭제합니다. 연결된 계정의 소속과 Discord 인증을 해제해 이 워크스페이스에 접근할 수 없게 합니다.</p><p>연결된 로그인 계정: {plan.accounts.map(a => a.username).join(', ') || '없음 · 직접 등록된 수강생'}</p><p className="inline-note">출결 {plan.history.attendance}건 · 성적 {plan.history.scores}건과 기존 과제 제출 이력은 보관합니다. 로그인 계정 자체와 다른 워크스페이스 소속은 유지됩니다.</p></>}
      {error && <p className="inline-note error-note" role="alert">{error}</p>}
      <div className="modal-actions"><button className="button secondary" disabled={busy} data-modal-autofocus onClick={close}>취소</button>{!plan && error ? <button className="button secondary" onClick={() => { setError(''); setReload(n => n + 1) }}>최신 내역 다시 확인</button> : <button className="button danger" disabled={!plan || busy} onClick={() => void remove()}>{busy ? '삭제 중…' : '수강생 삭제'}</button>}</div>
    </div>
  </ModalShell>
}

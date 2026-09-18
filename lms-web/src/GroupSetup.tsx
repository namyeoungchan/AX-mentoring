import { useEffect, useState, type FormEvent } from 'react'
import { demoMode, workspaceRequest } from './api'
import { CardHeading } from './components'
import StudentRosterImport from './StudentRosterImport'

type State = { courses: { id: string; title: string }[]; teams: { id: string; courseId: string; name: string }[]; courseId: string; revision: string }
export default function GroupSetup({ workspaceId, onSaved }: { workspaceId: string; onSaved?: () => void }) {
  const [state, setState] = useState<State | null>(null), [course, setCourse] = useState('')
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => {
    if (demoMode) return
    const controller = new AbortController()
    workspaceRequest(workspaceId, 'discord/groups', { signal: controller.signal }).then(result => { setState(result); setCourse(result.courseId) }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [workspaceId])
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!state || busy) return
    const form = new FormData(event.currentTarget); setBusy(true); setError(''); setNotice('')
    try {
      const result = await workspaceRequest(workspaceId, 'discord/groups', { method: 'POST', body: JSON.stringify({ count: Number(form.get('count')), courseId: course, title: String(form.get('title') || '기본 교육 과정'), revision: state.revision }) })
      setState(result); setCourse(result.courseId); setNotice('조 구성을 저장했습니다. 서버 연결과 봇 초대를 마치면 조별 역할·대화·음성 채널이 자동으로 생성됩니다.')
      onSaved?.()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="panel membership-invite"><CardHeading title="1. 운영할 조 설정" subtitle="과정과 조를 먼저 설정한 뒤 아래에서 Discord 서버를 연결하세요."><button className="text-button" disabled={busy || demoMode} onClick={async () => { try { setState(await workspaceRequest(workspaceId, 'discord/groups')); setError('') } catch (e) { setError((e as Error).message) } }}>조 정보 새로고침</button></CardHeading>
    <form className="modal-form" onSubmit={save}><fieldset disabled={busy || !state || demoMode}><div className="form-row"><label>운영 과정<select value={course} onChange={e => setCourse(e.target.value)}><option value="">새 기본 과정 만들기</option>{state?.courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>{!course && <label>과정 이름<input name="title" required maxLength={100} defaultValue="기본 교육 과정" /></label>}<label>운영할 조 수<input key={course} name="count" type="number" min={Math.max(1, state?.teams.filter(t => t.courseId === course).length || 1)} max={50} required defaultValue={Math.max(1, state?.teams.filter(t => t.courseId === course).length || 1)} /></label></div><button className="button primary">조 구성 저장</button></fieldset></form>
    <p className="discord-hint">최대 50개 조 · 기존 조는 유지됩니다. 새 과정의 기간은 과정 관리에서 수정하세요. 조 구성을 저장하면 해당 과정의 Discord 팀 연동을 켭니다.</p>
    {notice && <p role="status" className="inline-note">{notice}</p>}{error && <p role="alert" className="inline-note error-note">{error}</p>}
    <StudentRosterImport workspaceId={workspaceId} mode="groups" onSaved={async () => { const next = await workspaceRequest(workspaceId, 'discord/groups'); setState(next); setCourse(next.courseId); onSaved?.() }} />
  </section>
}

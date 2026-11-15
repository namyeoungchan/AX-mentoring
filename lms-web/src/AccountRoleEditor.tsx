import { useEffect, useState, type FormEvent } from 'react'
import { workspaceRequest } from './api'
import { ModalShell } from './components'

type Role = 'admin' | 'instructor' | 'student'
type RoleState = { workspaceName: string; role: Role | null; mentorType: 'main' | 'group'; teamIds: string[]; teams: { id: string; name: string }[] }
const choices = { admin: '워크스페이스 관리자', main: '메인 강사 · 전체 조', group: '조 담당 멘토', student: '수강생' }
type Choice = keyof typeof choices

export default function AccountRoleEditor({ workspaceId, account, close, saved }: { workspaceId: string; account: { id: string; name: string; username: string }; close: () => void; saved: () => void }) {
  const [state, setState] = useState<RoleState | null>(null)
  const [choice, setChoice] = useState<Choice>('student'), [teamIds, setTeamIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    workspaceRequest(workspaceId, `accounts/${encodeURIComponent(account.id)}/role`, { signal: controller.signal }).then((result: RoleState) => {
      setState(result); setChoice(result.role === 'instructor' ? result.mentorType : result.role || 'student'); setTeamIds(result.teamIds); setLoading(false)
    }).catch(e => { if (!controller.signal.aborted) { setError(e.message); setLoading(false) } })
    return () => controller.abort()
  }, [workspaceId, account.id])
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!state || saving) return
    setSaving(true); setError('')
    try {
      await workspaceRequest(workspaceId, `accounts/${encodeURIComponent(account.id)}/role`, { method: 'PATCH', body: JSON.stringify({ role: choice === 'main' || choice === 'group' ? 'instructor' : choice, expectedRole: state.role, mentorType: choice === 'group' ? 'group' : 'main', teamIds: choice === 'group' ? teamIds : [] }) })
      saved()
    } catch (e) { setError((e as Error).message) }
    finally { setSaving(false) }
  }
  return <ModalShell title="워크스페이스 역할 변경" busy={saving} close={close}>
    <form className="modal-form" onSubmit={submit}>
      <p><strong>{account.name} · {account.username}</strong></p>
      {loading && <p role="status">현재 역할을 불러오는 중…</p>}
      {state && <>
        <p><strong>{state.workspaceName}</strong>에서 사용할 역할을 선택하세요. 현재 역할: {state.role === 'instructor' ? choices[state.mentorType] : state.role ? choices[state.role] : '소속 없음'}.</p>
        <fieldset disabled={saving}>
          <label>변경할 역할<select value={choice} onChange={event => setChoice(event.target.value as Choice)}>{Object.entries(choices).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {choice === 'group' && <fieldset className="mentor-team-picker"><legend>담당 조 · 복수 선택 가능</legend><div className="mentor-team-options">
            {state.teams.map(team => <label key={team.id}><input type="checkbox" checked={teamIds.includes(team.id)} onChange={event => setTeamIds(ids => event.target.checked ? [...ids, team.id] : ids.filter(id => id !== team.id))} />{team.name}</label>)}
            {!state.teams.length && <p>조 담당 멘토를 지정하려면 워크스페이스에 조를 먼저 만드세요.</p>}
          </div></fieldset>}
        </fieldset>
        <p className="inline-note">이 워크스페이스의 역할만 변경합니다. 대상 계정의 기존 로그인이 해제되므로 다시 로그인해 새 역할을 테스트하세요.</p>
        {choice === 'student' && <p>수강생 학습 내용은 과정·조 배정과 Discord 인증을 완료해야 표시됩니다. 기존 학습 이력과 배정은 유지됩니다.</p>}
      </>}
      {error && <p role="alert" className="error-text">{error}</p>}
      <div className="modal-actions"><button className="button secondary" type="button" disabled={saving} onClick={close}>취소</button><button className="button primary" disabled={loading || saving || !state || choice === 'group' && !teamIds.length}>{saving ? '저장 중…' : '역할 저장'}</button></div>
    </form>
  </ModalShell>
}

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { workspaceRequest, demoMode } from './api'
import { CardHeading, ModalShell } from './components'

type Data = { teams: { id: string; name: string; courseTitle: string }[]; guildIds: string[]; archived: boolean; accounts: { id: string; username: string; name: string; setupPending: number; passwordPending: number; teamId: string; state: string }[] }
type Delivery = { username: string; name: string; initialPassword: string; workspaceName: string; courseTitle: string; teamName: string }
export default function StudentAccounts({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [query, setQuery] = useState('')
  const [delivery, setDelivery] = useState<Delivery | null>(null), [copied, setCopied] = useState(false)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (demoMode) return
    try { const next = await workspaceRequest(workspaceId, 'student-accounts', { signal }); if (!signal?.aborted) setData(next) }
    catch (e) { if (!signal?.aborted) setError((e as Error).message) }
  }, [workspaceId])
  // eslint-disable-next-line react/set-state-in-effect -- Read persisted account issuance state.
  useEffect(() => { const c = new AbortController(); void refresh(c.signal); return () => c.abort() }, [refresh])
  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return
    const element = event.currentTarget, form = new FormData(element)
    setBusy(true); setError(''); setCopied(false)
    try {
      const name = String(form.get('name') || '').trim()
      const result = await workspaceRequest(workspaceId, 'student-accounts', { method: 'POST', body: JSON.stringify({ username: form.get('username'), teamId: form.get('teamId'), ...(name ? { name } : {}) }) })
      setDelivery(result); element.reset(); await refresh()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const credential = delivery ? ['워크스페이스: ' + delivery.workspaceName, '아이디: ' + delivery.username, '초기 비밀번호: ' + delivery.initialPassword, '배정: ' + delivery.courseTitle + ' · ' + delivery.teamName, '로그인 후 본인 이름과 새 비밀번호를 설정하세요.'].join('\n') : ''
  const accounts = (data?.accounts || []).filter(a => (a.name + ' ' + a.username).toLowerCase().includes(query.toLowerCase().trim()))
  return <section className="panel student-account-panel">
    <CardHeading title="학생 계정 발급" subtitle="수강생의 과정과 조를 배정하고 로그인 계정을 발급합니다. 학생은 직접 가입하지 않습니다." />
    <form className="modal-form student-account-form" onSubmit={issue}><fieldset disabled={busy || demoMode || !data || data.archived || data.guildIds.length !== 1 || !data.teams.length}>
      <div className="form-row"><label>발급할 아이디<input name="username" required pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{3,31}" minLength={4} maxLength={32} autoComplete="off" autoCapitalize="none" placeholder="영문·숫자 4~32자" /></label><label>이름 (선택)<input name="name" maxLength={50} autoComplete="off" placeholder="학생이 첫 로그인에서 확인합니다" /></label></div>
      <label>배정할 과정 · 조<select name="teamId" required defaultValue=""><option value="" disabled>과정과 조를 선택하세요</option>{data?.teams.map(t => <option key={t.id} value={t.id}>{t.courseTitle} · {t.name}</option>)}</select></label>
      <p>초기 비밀번호는 발급 직후 한 번만 표시됩니다. 계정 정보를 해당 학생에게 전달하세요.</p>
      <button className="button primary" type="submit">{busy ? '발급 중…' : '학생 계정·초기 비밀번호 발급'}</button>
    </fieldset></form>
    {demoMode ? <p className="inline-note">실제 워크스페이스에서 계정을 발급할 수 있습니다.</p> : data && (!data.teams.length || data.guildIds.length !== 1) && <p className="inline-note">Discord 빠른 설정에서 서버 연결과 조 구성을 먼저 완료하세요.</p>}
    {error && <p className="inline-note error-note" role="alert">{error}</p>}
    <div className="student-account-tools"><label>학생 계정 검색<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="이름 또는 아이디" /></label><button className="button secondary" disabled={busy} onClick={() => void refresh()}>계정 상태 새로고침</button></div>
    <div className="table-scroll"><table><thead><tr><th>이름 · 아이디</th><th>과정 · 조</th><th>계정 설정</th><th>Discord 참여</th></tr></thead><tbody>{accounts.map(a => <tr key={a.id}><td><strong>{a.name}</strong><small>{a.username}</small></td><td>{data?.teams.find(t => t.id === a.teamId)?.courseTitle} · {data?.teams.find(t => t.id === a.teamId)?.name || '배정 확인 필요'}</td><td>{a.setupPending ? '첫 로그인 설정 대기' : a.passwordPending ? '비밀번호 변경 대기' : '설정 완료'}</td><td>{a.state === 'joined' ? '인증 완료' : a.state === 'approved' ? '참여·인증 대기' : a.state === 'pending' ? '기존 가입 신청' : '반려'}</td></tr>)}</tbody></table>{!accounts.length && <p className="calendar-empty">표시할 학생 계정이 없습니다.</p>}</div>
    <p className="inline-note">기존 계정의 비밀번호 재발급이나 계정 삭제는 총관리자에게 요청하세요.</p>
    {delivery && <ModalShell title="학생 계정 발급 완료" close={() => { setDelivery(null); setCopied(false) }}>
      <div className="modal-form"><p role="status">계정과 조 배정을 완료했습니다. 화면을 닫으면 초기 비밀번호를 다시 볼 수 없습니다.</p><label>학생에게 전달할 계정 정보<textarea readOnly rows={7} value={credential} /></label><button className="button secondary" onClick={() => void navigator.clipboard.writeText(credential).then(() => setCopied(true)).catch(() => setError('계정 정보를 직접 선택해 복사하세요.'))}>{copied ? '복사 완료' : '계정 정보 복사'}</button><button className="button primary" onClick={() => setDelivery(null)}>전달 정보 확인 완료</button></div>
    </ModalShell>}
  </section>
}

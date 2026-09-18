import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { workspaceRequest, demoMode } from './api'
import { CardHeading, ModalShell } from './components'
import StudentRosterImport from './StudentRosterImport'

type Data = { revision: string; teams: { id: string; name: string; courseId: string; courseTitle: string }[]; guildIds: string[]; archived: boolean; accounts: { id: string; username: string; name: string; email?: string; phone?: string; school?: string; department?: string; profileRevision: string; setupPending: number; passwordPending: number; teamId: string; courseId: string; state: string }[] }
type Delivery = { username: string; name: string; initialPassword: string; workspaceName: string; courseTitle: string; teamName: string }
export default function StudentAccounts({ workspaceId, refreshWorkspace }: { workspaceId: string; refreshWorkspace?: () => Promise<void> }) {
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [query, setQuery] = useState('')
  const [delivery, setDelivery] = useState<Delivery | null>(null), [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState<{ account: Data['accounts'][number]; revision: string } | null>(null)
  const [teamId, setTeamId] = useState(''), [notice, setNotice] = useState('')
  const [manage, setManage] = useState<{ kind: 'edit' | 'delete'; account: Data['accounts'][number]; revision: string } | null>(null)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (demoMode) return
    try { const next = await workspaceRequest(workspaceId, 'student-accounts', { signal }); if (!signal?.aborted) { setData(next); setError('') } }
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
  async function changeTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editing || busy || !teamId) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await workspaceRequest(workspaceId, `student-accounts/${encodeURIComponent(editing.account.id)}/team`, { method: 'PATCH', body: JSON.stringify({ teamId, expectedTeamId: editing.account.teamId, revision: editing.revision }) })
      setData(result); setEditing(null); setNotice('조 배정을 변경했습니다. Discord 인증 전이면 새 조로 참여하고, 인증 후이면 팀 동기화에 반영됩니다.')
      await refreshWorkspace?.()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function saveStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!manage || busy) return
    const form = new FormData(event.currentTarget), account = manage.account
    setBusy(true); setError('')
    try {
      const body = { username: account.username, revision: manage.revision, profileRevision: account.profileRevision, ...(manage.kind === 'delete' ? {} : Object.fromEntries(['name','email','phone','school','department'].map(key => [key, String(form.get(key) || '').trim()]))) }
      const result = await workspaceRequest(workspaceId, `student-accounts/${encodeURIComponent(account.id)}`, { method: manage.kind === 'delete' ? 'DELETE' : 'PATCH', body: JSON.stringify(body) })
      setData(result); setNotice(manage.kind === 'delete' ? '워크스페이스 수강생 목록에서 삭제했습니다.' : '수강생 정보를 수정했습니다.'); setManage(null); await refreshWorkspace?.()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const credential = delivery ? ['워크스페이스: ' + delivery.workspaceName, '아이디: ' + delivery.username, '초기 비밀번호: ' + delivery.initialPassword, '배정: ' + delivery.courseTitle + ' · ' + delivery.teamName, '로그인 후 본인 이름과 새 비밀번호를 설정하세요.'].join('\n') : ''
  const accounts = (data?.accounts || []).filter(a => (a.name + ' ' + a.username).toLowerCase().includes(query.toLowerCase().trim()))
  return <section className="panel student-account-panel">
    <CardHeading title="학생 계정 발급" subtitle="엑셀 명단 등록 · 개별 추가 · 수강생 정보 수정 · 조 변경 · 명단 삭제" />
    <StudentRosterImport workspaceId={workspaceId} mode="accounts" onSaved={async () => { await refresh(); await refreshWorkspace?.() }} />
    <form className="modal-form student-account-form" onSubmit={issue}><fieldset disabled={busy || demoMode || !data || data.archived || data.guildIds.length !== 1 || !data.teams.length}>
      <div className="form-row"><label>발급할 아이디<input name="username" required pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{3,31}" minLength={4} maxLength={32} autoComplete="off" autoCapitalize="none" placeholder="영문·숫자 4~32자" /></label><label>이름 (선택)<input name="name" maxLength={50} autoComplete="off" placeholder="학생이 첫 로그인에서 확인합니다" /></label></div>
      <label>배정할 과정 · 조<select name="teamId" required defaultValue=""><option value="" disabled>과정과 조를 선택하세요</option>{data?.teams.map(t => <option key={t.id} value={t.id}>{t.courseTitle} · {t.name}</option>)}</select></label>
      <p>초기 비밀번호는 bdaxuser1! 입니다. 첫 로그인에서 본인 비밀번호로 변경합니다.</p>
      <button className="button primary" type="submit">{busy ? '발급 중…' : '학생 계정·초기 비밀번호 발급'}</button>
    </fieldset></form>
    {demoMode ? <p className="inline-note">실제 워크스페이스에서 계정을 발급할 수 있습니다.</p> : data && (!data.teams.length || data.guildIds.length !== 1) && <p className="inline-note">Discord 빠른 설정에서 서버 연결과 조 구성을 먼저 완료하세요.</p>}
    {error && !editing && !manage && <p className="inline-note error-note" role="alert">{error}</p>}
    {notice && <p className="inline-note" role="status">{notice}</p>}
    <div className="student-account-tools"><label>학생 계정 검색<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="이름 또는 아이디" /></label><button className="button secondary" disabled={busy} onClick={() => void refresh()}>계정 상태 새로고침</button></div>
    <div className="table-scroll"><table><thead><tr><th>이름 · 아이디</th><th>과정 · 조</th><th>계정 설정</th><th>Discord 참여</th><th>수강생 관리</th></tr></thead><tbody>{accounts.map(a => <tr key={a.id}><td><strong>{a.name}</strong><small>{a.username}</small><small>{[a.school, a.department].filter(Boolean).join(' · ')}</small><small>{[a.email, a.phone].filter(Boolean).join(' · ')}</small></td><td>{data?.teams.find(t => t.id === a.teamId)?.courseTitle} · {data?.teams.find(t => t.id === a.teamId)?.name || '배정 확인 필요'}</td><td>{a.setupPending ? '첫 로그인 설정 대기' : a.passwordPending ? '비밀번호 변경 대기' : '설정 완료'}</td><td>{a.state === 'joined' ? '인증 완료' : a.state === 'approved' ? '참여·인증 대기' : a.state === 'pending' ? '기존 가입 신청' : '반려'}</td><td><button className="button secondary" aria-label={`${a.name} (${a.username}) 조 변경`} disabled={busy || demoMode || data?.archived || !['approved', 'joined'].includes(a.state)} onClick={() => { setEditing({ account: a, revision: data!.revision }); setTeamId(a.teamId); setError(''); setNotice('') }}>조 변경</button><button className="button secondary" disabled={busy || demoMode || data?.archived} onClick={() => { setManage({ kind: 'edit', account: a, revision: data!.revision }); setError('') }}>정보 수정</button><button className="button danger" disabled={busy || demoMode || data?.archived} onClick={() => { setManage({ kind: 'delete', account: a, revision: data!.revision }); setError('') }}>수강생 삭제</button></td></tr>)}</tbody></table>{!accounts.length && <p className="calendar-empty">표시할 학생 계정이 없습니다.</p>}</div>
    <p className="inline-note">기존 계정의 비밀번호 재발급이나 계정 삭제는 총관리자에게 요청하세요.</p>
    {editing && <ModalShell title="수강생 조 변경" busy={busy} close={() => { if (!busy) { setEditing(null); setError('') } }}>
      <form className="modal-form" onSubmit={changeTeam}><fieldset disabled={busy}>
        <p><strong>{editing.account.name}</strong> · {editing.account.username}</p>
        <p>현재 배정: {data?.teams.find(t => t.id === editing.account.teamId)?.courseTitle} · {data?.teams.find(t => t.id === editing.account.teamId)?.name || '미배정'}</p>
        <label>변경할 조<select required value={teamId} onChange={e => setTeamId(e.target.value)}><option value="">조를 선택하세요</option>{data?.teams.filter(t => !editing.account.courseId || t.courseId === editing.account.courseId).map(t => <option key={t.id} value={t.id}>{t.courseTitle} · {t.name}</option>)}</select></label>
        <p>같은 과정 안에서 조를 변경합니다. 계정과 기존 출결·성적 기록은 유지됩니다. 인증 전 학생도 변경할 수 있습니다.</p>
        {error && <p role="alert" className="error-text">{error}</p>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={() => { setEditing(null); setError(''); void refresh() }}>취소 · 목록 새로고침</button><button className="button primary" type="submit" disabled={!teamId || teamId === editing.account.teamId}>{busy ? '변경 중…' : '조 변경 저장'}</button></div>
      </fieldset></form>
    </ModalShell>}
    {manage && <ModalShell title={manage.kind === 'delete' ? '수강생 삭제 확인' : '수강생 정보 수정'} busy={busy} close={() => { if (!busy) { setManage(null); setError('') } }}>
      <form className="modal-form" onSubmit={saveStudent}><fieldset disabled={busy}>
        <p><strong>{manage.account.name}</strong> · {manage.account.username}</p>
        {manage.kind === 'delete' ? <p>이 워크스페이스의 수강생 목록·소속·Discord 인증을 삭제합니다. 로그인 계정과 다른 워크스페이스 소속, 기존 출결·과제 이력은 유지됩니다. 해당 학생을 삭제할까요?</p> : <>
          <label>성명<input name="name" required maxLength={50} defaultValue={manage.account.name} /></label>
          <div className="form-row"><label>이메일<input name="email" type="email" maxLength={100} defaultValue={manage.account.email || ''} /></label><label>연락처<input name="phone" maxLength={100} defaultValue={manage.account.phone || ''} /></label></div>
          <div className="form-row"><label>학교<input name="school" maxLength={100} defaultValue={manage.account.school || ''} /></label><label>학과<input name="department" maxLength={100} defaultValue={manage.account.department || ''} /></label></div>
          <p>이 워크스페이스의 명단 정보만 수정합니다. 로그인 아이디와 비밀번호는 유지됩니다.</p>
        </>}
        {error && <p role="alert" className="error-text">{error}</p>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={() => { setManage(null); setError('') }}>취소</button><button className={`button ${manage.kind === 'delete' ? 'danger' : 'primary'}`} type="submit">{busy ? '처리 중…' : manage.kind === 'delete' ? '이 워크스페이스에서 삭제' : '수강생 정보 저장'}</button></div>
      </fieldset></form>
    </ModalShell>}
    {delivery && <ModalShell title="학생 계정 발급 완료" close={() => { setDelivery(null); setCopied(false) }}>
      <div className="modal-form"><p role="status">계정과 조 배정을 완료했습니다. 화면을 닫으면 초기 비밀번호를 다시 볼 수 없습니다.</p><label>학생에게 전달할 계정 정보<textarea readOnly rows={7} value={credential} /></label><button className="button secondary" onClick={() => void navigator.clipboard.writeText(credential).then(() => setCopied(true)).catch(() => setError('계정 정보를 직접 선택해 복사하세요.'))}>{copied ? '복사 완료' : '계정 정보 복사'}</button><button className="button primary" onClick={() => setDelivery(null)}>전달 정보 확인 완료</button></div>
    </ModalShell>}
  </section>
}

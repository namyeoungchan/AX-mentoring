import AccountSettings from './AccountSettings'
import { AdmissionsReview } from './Admissions'
import { useState } from 'react'
import { BookOpen, LogOut } from 'lucide-react'
import WorkspaceSwitcher from './WorkspaceSwitcher'
import { Badge, CardHeading } from './components'
import Operations from './Operations'
import type { useWorkspace } from './useWorkspace'

export default function InstructorHome({ workspace }: { workspace: ReturnType<typeof useWorkspace> }) {
  const { data, account, workspaces, activeId, selectWorkspace, update, saving, error, logout, refresh } = workspace
  const [page, setPage] = useState('courses')
  return <div className="student-page"><header className="student-header"><span className="auth-brand"><span><BookOpen size={21} /></span>AX <b>LearningOps</b></span><AccountSettings /><button className="button secondary" onClick={() => void logout()}><LogOut size={15} />로그아웃</button></header><main className="student-main">
    <WorkspaceSwitcher workspaces={workspaces} activeId={activeId} selectWorkspace={selectWorkspace} saving={saving} />
    <div className="page-heading"><div><span className="eyebrow">TEACHING</span><h1>강사 수업 관리</h1><p>{account?.name} · {data.name}</p></div><Badge>강사</Badge></div>
    <div className="tabs"><button className={page === 'courses' ? 'selected' : ''} onClick={() => setPage('courses')}>수업 현황</button><button className={page === 'attendance' ? 'selected' : ''} onClick={() => setPage('attendance')}>출결 관리</button><button className={page === 'scores' ? 'selected' : ''} onClick={() => setPage('scores')}>성적 관리</button><button className={page === 'admissions' ? 'selected' : ''} onClick={() => setPage('admissions')}>가입 승인</button><button disabled={saving} onClick={() => void refresh()}>새로고침</button></div>
    {error && <p className="inline-note error-note" role="alert">{error}</p>}
    {page === 'admissions' ? <AdmissionsReview workspaceId={activeId} /> : page !== 'courses' ? <Operations key={page} page={page} data={data} query="" change={async updater => update(updater)} saving={saving} error={error} /> : <>
      {data.courses.map(c => <section className="panel student-course" key={c.id}><Badge>{c.status}</Badge><h2>{c.title}</h2><p>{c.description}</p><span>수강생 {c.learners}명 · {c.startDate} — {c.endDate}</span></section>)}
      {!data.courses.length && <section className="panel student-empty"><h2>등록된 수업이 없습니다.</h2></section>}
      <section className="panel"><CardHeading title="과제 현황" /><div className="table-scroll"><table><thead><tr><th>과정</th><th>과제</th><th>마감</th><th>제출</th></tr></thead><tbody>{data.assignments.map(a => <tr key={a.id}><td>{a.course}</td><td>{a.title}</td><td>{a.due}</td><td>{a.submitted} / {a.total}</td></tr>)}</tbody></table></div></section>
    </>}
  </main></div>
}

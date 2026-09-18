import { useState } from 'react'
import { workspaceRequest } from './api'
import { AdmissionStatus } from './Admissions'
import RoleWorkspace, { type RolePage } from './RoleWorkspace'
import { useRolePage } from './useRolePage'
import type { WorkspaceMetadata } from './demoWorkspaces'
import { BookOpen, CheckCheck, ClipboardList, GraduationCap, Users, ArrowRight } from 'lucide-react'
import { Badge, CardHeading } from './components'

const pages: RolePage[] = [
  { id: 'learning', name: '나의 학습', description: '내 과정과 팀을 확인하고 필요한 학습 메뉴로 이동하세요.', icon: GraduationCap },
  { id: 'attendance', name: '나의 출결', description: 'Discord 코드 출석 안내 · 마감된 회차의 출결 기록', icon: CheckCheck },
  { id: 'scores', name: '나의 성적', description: '본인의 평가항목별 점수와 배점을 확인하세요.', icon: ClipboardList },
  { id: 'assignments', name: '과제', description: '등록된 과정의 과제와 마감일을 확인하세요.', icon: BookOpen },
  { id: 'participation', name: '워크스페이스 참여', description: '계정 배정 · Discord 서버 참여와 인증 상태', icon: Users },
]

export type Account = { id: string; username: string; name: string; discordId: string; role: 'admin' | 'student'; verified?: boolean; mustCompleteProfile?: boolean; mustChangePassword?: boolean }
export type Learning = {
  enrollment: null | { name: string; status: string; team: string };
  courses: { id: string; title: string; description: string; status: string; startDate: string; endDate: string }[];
  attendance: { id: string; date: string; period: number; status: string }[];
  scores: { id: string; item: string; score: number; maximum: number }[];
  assignments: { id: number; title: string; dueDate: string; active: number }[];
}
function WorkspaceVerification({ workspace, refresh }: { workspace: WorkspaceMetadata; refresh: () => Promise<void> }) {
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function issue() {
    setBusy(true); setError('')
    try { setCode(await workspaceRequest(workspace.id, 'me/verification', { method: 'POST', body: '{}' })) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="panel admission-detail" aria-label="워크스페이스 인증"><h2>{workspace.name} · Discord 인증</h2><p>이 워크스페이스의 Discord 서버에서 별도로 인증해 주세요.</p>
    <button className="button secondary" disabled={busy || workspace.guildIds.length !== 1 || workspace.archivedAt != null} onClick={() => void issue()}>워크스페이스 인증 코드 받기</button>
    {code && <><p>‘시작하기’ 채널에서 LMS 인증 버튼을 누르거나 아래 명령어를 실행하세요.</p><code>/lms인증 코드:{code.code}</code><p>만료: {new Date(code.expiresAt).toLocaleTimeString('ko-KR')}</p><button className="button secondary" onClick={() => void refresh()}>인증 상태 새로고침</button></>}
    {error && <p role="alert" className="error-note">{error}</p>}
  </section>
}
export default function StudentHome({ user, learning, error, refresh, logout, workspaces, activeId, selectWorkspace, setWorkspaceArchived, saving }: { setWorkspaceArchived?: (id: string, archived: boolean) => Promise<boolean>; saving?: boolean; workspaces: WorkspaceMetadata[]; activeId: string; selectWorkspace: (id: string) => Promise<void>; user: Account; learning: Learning | null; error: string; refresh: () => Promise<void>; logout: () => Promise<void> }) {
  const activeWorkspace = workspaces.find(w => w.id === activeId)
  const [page, go] = useRolePage(pages, 'learning')
  return <RoleWorkspace role="student" username={user.username} name={user.name} title={pages.find(p => p.id === page)!.name} pages={pages} page={page} go={go} workspaces={workspaces} activeId={activeId} selectWorkspace={selectWorkspace} setWorkspaceArchived={setWorkspaceArchived} saving={saving} error={error} refresh={refresh} logout={logout} status={<Badge>{activeWorkspace?.discordVerified ? 'Discord 인증 완료' : 'Discord 참여 대기'}</Badge>}>
    {(page === 'participation' || page === 'learning' && !activeWorkspace?.discordVerified) && <>
      {activeWorkspace && !activeWorkspace.discordVerified && <WorkspaceVerification key={activeId} workspace={activeWorkspace} refresh={refresh} />}
      <AdmissionStatus refreshWorkspace={refresh} />
    </>}
    {page === 'learning' && <>
      {!learning?.courses.length && <section className="panel student-empty"><BookOpen size={28} /><h2>{learning?.enrollment ? '수강 상태를 확인해 주세요.' : '등록된 학습 과정이 없습니다.'}</h2><p>{learning?.enrollment ? `현재 상태: ${learning.enrollment.status}` : '운영자가 인증된 Discord 계정을 과정에 등록하면 학습 정보가 표시됩니다.'}</p></section>}
      {learning?.courses.map(course => <section key={course.id} className="panel student-course"><Badge>{course.status}</Badge><h2>{course.title}</h2><p>{course.description}</p><span>{course.startDate} — {course.endDate}</span>{learning.enrollment?.team && <span> · {learning.enrollment.team}</span>}</section>)}
      <div className="role-shortcuts">{pages.slice(1, 4).map(item => <button key={item.id} className="panel role-shortcut" onClick={() => go(item.id)}><item.icon size={23} /><strong>{item.name}</strong><span>{item.id === 'attendance' ? `확정 기록 ${learning?.attendance.length || 0}건` : item.id === 'scores' ? `평가항목 ${learning?.scores.length || 0}개` : `진행 중 ${learning?.assignments.filter(a => a.active).length || 0}개`}</span><ArrowRight size={17} /></button>)}</div>
    </>}
    {page === 'attendance' && <>
      <section className="panel role-guidance"><CardHeading title="Discord 코드 출석" subtitle="멘토가 안내한 유효시간 안에 수업 서버에서 등록하세요." /><ol><li>해당 워크스페이스의 Discord 인증을 완료합니다.</li><li>멘토에게 받은 6자리 코드로 <code>/출석 코드:123456</code>을 입력합니다. 123456은 예시입니다.</li><li>본인에게 보이는 날짜·차시·출결 상태를 확인합니다. 만료 코드는 멘토에게 요청하세요.</li></ol><p>중복 등록으로 기존 출결은 바뀌지 않습니다. 지각·결석 정정은 담당 멘토에게 요청하세요.</p></section>
      <section className="panel"><CardHeading title="출결 기록" subtitle="관리자가 회차를 마감하면 확정된 본인 기록이 표시됩니다." /><div className="table-scroll"><table><thead><tr><th>날짜</th><th>차시</th><th>상태</th></tr></thead><tbody>{learning?.attendance.map(row => <tr key={row.id}><td>{row.date}</td><td>{row.period}</td><td><Badge>{row.status}</Badge></td></tr>)}</tbody></table></div>{!learning?.attendance.length && <p className="calendar-empty">확정된 출결 기록이 없습니다. 오늘의 출결은 멘토에게 회차 마감 여부를 확인하세요.</p>}</section>
    </>}
    {page === 'scores' && <section className="panel"><CardHeading title="성적 기록" subtitle="기록 정정은 과정·평가항목과 함께 담당 멘토에게 요청하세요." /><div className="table-scroll"><table><thead><tr><th>평가항목</th><th>점수</th><th>배점</th></tr></thead><tbody>{learning?.scores.map(row => <tr key={row.id}><td>{row.item}</td><td>{row.score}</td><td>{row.maximum}</td></tr>)}</tbody></table></div>{!learning?.scores.length && <p className="calendar-empty">등록된 성적 기록이 없습니다.</p>}</section>}
    {page === 'assignments' && <section className="panel"><CardHeading title="과제 목록" subtitle="제출은 수업 Discord 서버의 과제 제출 패널에서 진행하세요." /><div className="table-scroll"><table><thead><tr><th>과제명</th><th>마감일</th><th>상태</th></tr></thead><tbody>{learning?.assignments.map(row => <tr key={row.id}><td>{row.title}</td><td>{row.dueDate}</td><td><Badge>{row.active ? '진행 중' : '마감'}</Badge></td></tr>)}</tbody></table></div>{!learning?.assignments.length && <p className="calendar-empty">등록된 과제가 없습니다.</p>}</section>}
  </RoleWorkspace>
}

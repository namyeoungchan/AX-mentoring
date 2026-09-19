import StudentAttendance from './StudentAttendance'
import CourseVideos from './CourseVideos'
import { AdmissionStatus } from './Admissions'
import RoleWorkspace, { type RolePage } from './RoleWorkspace'
import { useRolePage } from './useRolePage'
import type { WorkspaceMetadata } from './demoWorkspaces'
import { BookOpen, CheckCheck, ClipboardList, GraduationCap, Users, ArrowRight } from 'lucide-react'
import { Badge, CardHeading } from './components'

const pages: RolePage[] = [
  { id: 'learning', name: '나의 학습', description: '내 과정과 팀을 확인하고 필요한 학습 메뉴로 이동하세요.', icon: GraduationCap },
  { id: 'attendance', name: '나의 출결', description: '입실·퇴실 기록 · 나의 출석 내역', icon: CheckCheck },
  { id: 'scores', name: '나의 성적', description: '본인의 평가항목별 점수와 배점을 확인하세요.', icon: ClipboardList },
  { id: 'assignments', name: '과제', description: '등록된 과정의 과제와 마감일을 확인하세요.', icon: BookOpen },
  { id: 'videos', name: '강의 영상', description: '내 과정의 강의 영상을 시청하세요.', icon: BookOpen },
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
export default function StudentHome({ user, learning, error, refresh, logout, workspaces, activeId, selectWorkspace, setWorkspaceArchived, saving }: { setWorkspaceArchived?: (id: string, archived: boolean) => Promise<boolean>; saving?: boolean; workspaces: WorkspaceMetadata[]; activeId: string; selectWorkspace: (id: string) => Promise<void>; user: Account; learning: Learning | null; error: string; refresh: () => Promise<void>; logout: () => Promise<void> }) {
  const activeWorkspace = workspaces.find(w => w.id === activeId)
  const [page, go] = useRolePage(pages, 'learning')
  return <RoleWorkspace role="student" username={user.username} name={user.name} title={pages.find(p => p.id === page)!.name} pages={pages} page={page} go={go} workspaces={workspaces} activeId={activeId} selectWorkspace={selectWorkspace} setWorkspaceArchived={setWorkspaceArchived} saving={saving} error={error} refresh={refresh} logout={logout} status={<Badge>{activeWorkspace?.discordVerified ? 'Discord 인증 완료' : 'Discord 참여 대기'}</Badge>}>
    {(page === 'participation' || page === 'learning' && !activeWorkspace?.discordVerified) && <>
      <AdmissionStatus key={activeId || user.id} workspace={activeWorkspace} refreshWorkspace={refresh} />
    </>}
    {page === 'learning' && activeWorkspace?.discordVerified && <>
      <details className="panel discord-after-auth-help"><summary>Discord 역할·별명 적용 안내</summary><p>수강생은 LMS 인증 후 <strong>시작하기 → 2 · 자기소개 작성</strong>에서 자기소개를 제출해야 Discord 역할과 별명이 적용되고, 배정된 조의 학습 채널이 열립니다. 이미 제출했다면 잠시 기다린 뒤 확인하세요. 계속 반영되지 않으면 운영자에게 문의하세요.</p></details>
      {!learning?.courses.length && <section className="panel student-empty"><BookOpen size={28} /><h2>{learning?.enrollment ? '수강 상태를 확인해 주세요.' : '등록된 학습 과정이 없습니다.'}</h2><p>{learning?.enrollment ? `현재 상태: ${learning.enrollment.status}` : '운영자가 인증된 Discord 계정을 과정에 등록하면 학습 정보가 표시됩니다.'}</p></section>}
      {learning?.courses.map(course => <section key={course.id} className="panel student-course"><Badge>{course.status}</Badge><h2>{course.title}</h2><p>{course.description}</p><span>{course.startDate} — {course.endDate}</span>{learning.enrollment?.team && <span> · {learning.enrollment.team}</span>}</section>)}
      <div className="role-shortcuts">{pages.slice(1, 4).map(item => <button key={item.id} className="panel role-shortcut" onClick={() => go(item.id)}><item.icon size={23} /><strong>{item.name}</strong><span>{item.id === 'attendance' ? `확정 기록 ${learning?.attendance.length || 0}건` : item.id === 'scores' ? `평가항목 ${learning?.scores.length || 0}개` : `진행 중 ${learning?.assignments.filter(a => a.active).length || 0}개`}</span><ArrowRight size={17} /></button>)}</div>
    </>}
    {page === 'videos' && <CourseVideos key={activeId} workspaceId={activeId} />}
    {page === 'attendance' && <StudentAttendance key={activeId} workspaceId={activeId} verified={!!activeWorkspace?.discordVerified} attendance={learning?.attendance || []} />}
    {page === 'scores' && <section className="panel"><CardHeading title="성적 기록" subtitle="기록 정정은 과정·평가항목과 함께 담당 멘토에게 요청하세요." /><div className="table-scroll"><table><thead><tr><th>평가항목</th><th>점수</th><th>배점</th></tr></thead><tbody>{learning?.scores.map(row => <tr key={row.id}><td>{row.item}</td><td>{row.score}</td><td>{row.maximum}</td></tr>)}</tbody></table></div>{!learning?.scores.length && <p className="calendar-empty">등록된 성적 기록이 없습니다.</p>}</section>}
    {page === 'assignments' && <section className="panel"><CardHeading title="과제 목록" subtitle="제출은 수업 Discord 서버의 과제 제출 패널에서 진행하세요." /><div className="table-scroll"><table><thead><tr><th>과제명</th><th>마감일</th><th>상태</th></tr></thead><tbody>{learning?.assignments.map(row => <tr key={row.id}><td>{row.title}</td><td>{row.dueDate}</td><td><Badge>{row.active ? '진행 중' : '마감'}</Badge></td></tr>)}</tbody></table></div>{!learning?.assignments.length && <p className="calendar-empty">등록된 과제가 없습니다.</p>}</section>}
  </RoleWorkspace>
}

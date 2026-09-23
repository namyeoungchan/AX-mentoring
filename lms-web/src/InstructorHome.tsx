import { useState } from 'react'
import MentoringManagement from './MentoringManagement'
import CourseVideos from './CourseVideos'
import MentorOnboarding from './MentorOnboarding'
import { CalendarDays, BookOpen, CheckCheck, ClipboardList, Users, GraduationCap } from 'lucide-react'
import RoleWorkspace, { type RolePage } from './RoleWorkspace'
import { useRolePage } from './useRolePage'
import { Badge, CardHeading } from './components'
import Operations from './Operations'
import TeamOperations from './TeamOperations'
import type { useWorkspace } from './useWorkspace'

const pages: RolePage[] = [
  { id: 'courses', name: '수업 현황', description: '담당 과정과 과제 진행 현황을 확인하세요.', icon: BookOpen },
  { id: 'mentoring', name: '멘토링 관리', description: '담당 범위의 멘토링 예약을 확인하고 승인 · 완료 · 취소하세요.', icon: CalendarDays },
  { id: 'videos', name: '강의 영상', description: '영상 업로드 · 변환 상태 확인 · 수강생에게 게시', icon: BookOpen },
  { id: 'attendance', name: '출결 관리', description: '담당 명단 · 출석 코드 발급 · 회차별 출결 정정', icon: CheckCheck },
  { id: 'teams', name: '팀 배정', description: '담당 수강생의 조 배정과 변경 이력을 확인하세요.', icon: Users },
  { id: 'scores', name: '성적 관리', description: '담당 수강생의 평가항목과 점수를 관리하세요.', icon: ClipboardList },
  { id: 'onboarding', name: '멘토 온보딩', description: '기본 정보 · Discord 참여 및 인증 · 업무 안내', icon: GraduationCap },
]

export default function InstructorHome({ workspace }: { workspace: ReturnType<typeof useWorkspace> }) {
  const { data, account, workspaces, activeId, selectWorkspace, update, saving, error, logout, refresh } = workspace
  const [filter, setFilter] = useState('전체')
  const [page, go] = useRolePage(pages, data.onboardingComplete ? 'courses' : 'onboarding')
  return <RoleWorkspace role="mentor" username={account?.username} name={account?.name || '멘토'} title={['courses', 'onboarding'].includes(page) ? '멘토 활동 관리' : pages.find(p => p.id === page)!.name} pages={pages} page={page} go={go} workspaces={workspaces} activeId={activeId} selectWorkspace={selectWorkspace} setWorkspaceArchived={workspace.setWorkspaceArchived} saving={saving} error={error} refresh={refresh} logout={logout}>
    {page === 'mentoring' ? <MentoringManagement data={data} filter={filter} setFilter={setFilter} change={async updater => update(updater)} saving={saving} /> : page === 'videos' ? <CourseVideos key={activeId} workspaceId={activeId} /> : page === 'onboarding' ? <MentorOnboarding workspace={workspace} /> : page === 'teams' ? <TeamOperations key={activeId} workspaceId={activeId} refresh={workspace.refreshQuietly} /> : page !== 'courses' ? <Operations refresh={workspace.refreshQuietly} key={page} page={page} data={data} query="" change={async updater => update(updater)} saving={saving} error={error} /> : <>
      {data.courses.map(c => <section className="panel student-course" key={c.id}><Badge>{c.status}</Badge><h2>{c.title}</h2><p>{c.description}</p><span>수강생 {c.learners}명 · {c.startDate} — {c.endDate}</span></section>)}
      {!data.courses.length && <section className="panel student-empty"><h2>등록된 수업이 없습니다.</h2></section>}
      <section className="panel"><CardHeading title="과제 현황" /><div className="table-scroll"><table><thead><tr><th>과정</th><th>과제</th><th>마감</th><th>제출</th></tr></thead><tbody>{data.assignments.map(a => <tr key={a.id}><td>{a.course}</td><td>{a.title}</td><td>{a.due}</td><td>{a.submitted} / {a.total}</td></tr>)}</tbody></table></div></section>
    </>}
  </RoleWorkspace>
}

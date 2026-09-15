import { BookOpen, CheckCheck, ClipboardList, LogOut, RefreshCw } from 'lucide-react'
import { Badge, CardHeading } from './components'

export type Account = { id: string; username: string; name: string; discordId: string; role: 'admin' | 'student' }
export type Learning = {
  enrollment: null | { name: string; status: string; team: string };
  courses: { id: string; title: string; description: string; status: string; startDate: string; endDate: string }[];
  attendance: { id: string; date: string; period: number; status: string }[];
  scores: { id: string; item: string; score: number; maximum: number }[];
  assignments: { id: number; title: string; dueDate: string; active: number }[];
}
export default function StudentHome({ user, learning, error, refresh, logout }: { user: Account; learning: Learning | null; error: string; refresh: () => Promise<void>; logout: () => Promise<void> }) {
  return <div className="student-page"><header className="student-header"><span className="auth-brand"><span><BookOpen size={21} /></span>AX <b>LearningOps</b></span><button className="button secondary" onClick={() => void logout()}><LogOut size={15} />로그아웃</button></header>
    <main className="student-main"><div className="page-heading"><div><span className="eyebrow">MY LEARNING</span><h1>나의 학습</h1><p>{user.name} · {user.username}</p></div><button className="button secondary" onClick={() => void refresh()}><RefreshCw size={15} />새로고침</button></div>
      <div className="student-identity"><Badge>Discord 인증 완료</Badge><span>Discord ID {user.discordId}</span><span>수강생</span></div>
      {error && <p className="inline-note error-note" role="alert">{error}</p>}
      {!learning?.courses.length && <section className="panel student-empty"><BookOpen size={28} /><h2>{learning?.enrollment ? '수강 상태를 확인해 주세요.' : '등록된 학습 과정이 없습니다.'}</h2><p>{learning?.enrollment ? `현재 상태: ${learning.enrollment.status}` : '운영자가 인증된 Discord 계정을 과정에 등록하면 학습 정보가 표시됩니다.'}</p></section>}
      {learning?.courses.map(course => <section key={course.id} className="panel student-course"><Badge>{course.status}</Badge><h2>{course.title}</h2><p>{course.description}</p><span>{course.startDate} — {course.endDate}</span>{learning.enrollment?.team && <span> · {learning.enrollment.team}</span>}</section>)}
      <div className="student-grid"><section className="panel"><CardHeading title="나의 출결"><CheckCheck size={19} /></CardHeading><div className="table-scroll"><table><thead><tr><th>날짜</th><th>차시</th><th>상태</th></tr></thead><tbody>{learning?.attendance.map(row => <tr key={row.id}><td>{row.date}</td><td>{row.period}</td><td>{row.status}</td></tr>)}</tbody></table></div>{!learning?.attendance.length && <p className="calendar-empty">출결 기록이 없습니다.</p>}</section>
        <section className="panel"><CardHeading title="나의 성적"><ClipboardList size={19} /></CardHeading><div className="table-scroll"><table><thead><tr><th>평가항목</th><th>점수</th><th>배점</th></tr></thead><tbody>{learning?.scores.map(row => <tr key={row.id}><td>{row.item}</td><td>{row.score}</td><td>{row.maximum}</td></tr>)}</tbody></table></div>{!learning?.scores.length && <p className="calendar-empty">성적 기록이 없습니다.</p>}</section></div>
      <section className="panel"><CardHeading title="과제" subtitle="등록된 과정의 과제입니다." /><div className="table-scroll"><table><thead><tr><th>과제명</th><th>마감일</th><th>상태</th></tr></thead><tbody>{learning?.assignments.map(row => <tr key={row.id}><td>{row.title}</td><td>{row.dueDate}</td><td>{row.active ? '진행 중' : '마감'}</td></tr>)}</tbody></table></div>{!learning?.assignments.length && <p className="calendar-empty">등록된 과제가 없습니다.</p>}</section>
    </main></div>
}

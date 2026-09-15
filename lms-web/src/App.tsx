import AccountSettings from './AccountSettings'
import OnboardingSetup from './OnboardingSetup'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, Bell, BookOpen, Bot, CalendarDays, Check, CheckCheck, ChevronRight, ClipboardList, Command, ExternalLink, GraduationCap, LayoutDashboard, Menu, MoreHorizontal, Plus, Search, Settings2, Sparkles, Users, X } from 'lucide-react'
import { Avatar, Badge, ModalShell } from './components'
import { type Course, type Workspace } from './data'
import Dashboard from './Dashboard'
import RenderMonitor from './RenderMonitor'
import Management from './Management'
import Operations from './Operations'
import { useWorkspace } from './useWorkspace'
import AuthScreen from './AuthScreen'
import StudentHome from './StudentHome'
import DiscordSetup from './DiscordSetup'
import WorkspaceSwitcher from './WorkspaceSwitcher'
import WorkspaceMembers from './WorkspaceMembers'
import InstructorHome from './InstructorHome'
import InvitationPage from './InvitationPage'
import { AdmissionsReview } from './Admissions'

const navigation = [
  { id: 'dashboard', name: '대시보드', icon: LayoutDashboard }, { id: 'courses', name: '학습 과정', icon: BookOpen },
  { id: 'learners', name: '수강생 관리', icon: Users }, { id: 'mentoring', name: '멘토링 일정', icon: CalendarDays },
  { id: 'assignments', name: '과제 관리', icon: ClipboardList }, { id: 'bots', name: '봇 · 서버 관리', icon: Bot },
  { id: 'logs', name: '활동 로그', icon: Activity }, { id: 'settings', name: '워크스페이스 설정', icon: Settings2 },
]
navigation.splice(1, 0, { id: 'connection', name: '봇 연결 현황', icon: Bot })
navigation.push({ id: 'members', name: '구성원 · 초대', icon: Users }, { id: 'admissions', name: '가입 승인', icon: CheckCheck })
navigation.push({ id: 'discord', name: 'Discord 채널 설정', icon: Settings2 })
navigation.push({ id: 'onboarding', name: '온보딩 · 팀 연동', icon: Users })
navigation.splice(4, 0, { id: 'teams', name: '팀 관리', icon: Users }, { id: 'mentors', name: '멘토 관리', icon: GraduationCap }, { id: 'attendance', name: '출결 관리', icon: CheckCheck }, { id: 'scores', name: '성적 관리', icon: ClipboardList })
navigation.splice(navigation.length - 3, 0, { id: 'submissions', name: '제출 내역', icon: ClipboardList }, { id: 'notices', name: '공지 관리', icon: Bell }, { id: 'files', name: '통합 파일함', icon: BookOpen })
type Modal = 'course' | 'session' | 'server' | 'assignment' | 'help' | null
function readPage() { const hash = location.hash === '#asan' ? 'connection' : location.hash.slice(1); return navigation.some(n => n.id === hash) ? hash : 'dashboard' }
const pageInfo: Record<string, [string, string]> = {
  onboarding: ['온보딩 · 팀 연동', '서버 참여 안내 · 역할 부여 · 팀 채널 자동 구성'],
  members: ['구성원 · 초대', '워크스페이스 권한 및 초대 관리'], admissions: ['가입 승인', '수강생 가입 신청 및 Discord 초대'],
  discord: ['Discord 채널 설정', '봇 초대 시 적용할 서버 채널 구성'],
  connection: ['봇 연결 현황', 'Render 봇 연결 상태 · 멘토링 · 과제 · 제출 데이터'], submissions: ['제출 내역', '기존 봇의 과제 제출 데이터'], teams: ['팀 관리', '과정별 팀 구성 및 담당 멘토'], mentors: ['멘토 관리', '멘토 정보 및 Discord 계정'], attendance: ['출결 관리', '차시별 출결 등록 및 변경 이력'], scores: ['성적 관리', '항목별 점수 및 종합점수'], notices: ['공지 관리', '과정별 공지 초안'], files: ['통합 파일함', '과정·팀별 파일 및 S3 연동 상태'],
  dashboard: ['운영 대시보드', '과정, 수강생, 과제, 멘토링 현황'], courses: ['과정 관리', '과정 및 기수 등록 · 운영 상태 관리'], learners: ['수강생 관리', '수강생 정보 · Discord 계정 · 팀 배정'], mentoring: ['멘토링 일정', '예약 등록 · 승인 · 진행 이력'], assignments: ['과제 관리', '과제 등록 · 제출 현황 · 마감 관리'], bots: ['봇 · 서버 관리', '배포 환경 및 연동 상태'], logs: ['활동 로그', '데이터 변경 및 운영 작업 이력'], settings: ['워크스페이스 설정', '기본 정보 및 연결 설정'],
}
export default function App() {
  const workspace = useWorkspace()
  const [invitationToken, setInvitationToken] = useState(() => location.hash.startsWith('#invite=') ? location.hash.slice(8) : '')
  const { loading, authRequired, account, learning, error, refresh, login, logout, enterDemo, workspaces, activeId, selectWorkspace } = workspace
  if (loading) return <div className="connection-screen"><Command size={32} /><h1>LearningOps</h1><p>운영 데이터 불러오는 중…</p></div>
  const authScreen = <AuthScreen login={login} error={error} enterDemo={enterDemo} registered={refresh} staffInvitation={Boolean(invitationToken)} />
  if (invitationToken) return <InvitationPage token={invitationToken} account={account} auth={authScreen} logout={logout} accepted={async id => { location.hash = 'dashboard'; await selectWorkspace(id); setInvitationToken('') }} />
  if (authRequired) return authScreen
  if (workspace.activeRole === 'instructor') return <InstructorHome key={activeId} workspace={workspace} />
  if (account && workspace.activeRole !== 'admin') return <StudentHome user={account} learning={learning} error={error} refresh={refresh} logout={logout} workspaces={workspaces} activeId={activeId} selectWorkspace={selectWorkspace} />
  return <AdminWorkspace key={activeId} workspace={workspace} />
}
function AdminWorkspace({ workspace }: { workspace: ReturnType<typeof useWorkspace> }) {
  const { data, update, saving, error, refresh, logout, leaveDemo, workspaces, activeId, selectWorkspace, createWorkspace } = workspace
  const [page, setPage] = useState(readPage)
  const [sidebar, setSidebar] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('전체')
  const [modal, setModal] = useState<Modal>(null)
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null)
  const [notice, setNotice] = useState('')
  const [notifications, setNotifications] = useState(false)
  const [read, setRead] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const pending = data.sessions.filter(s => s.status === '승인 대기').length
  function go(next: string) { location.hash = next; setPage(next); setQuery(''); setFilter('전체'); setSidebar(false); setNotifications(false); window.scrollTo(0, 0) }
  useEffect(() => { const handle = () => { setPage(readPage()); setQuery(''); setFilter('전체') }; window.addEventListener('hashchange', handle); return () => window.removeEventListener('hashchange', handle) }, [])
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 4000); return () => clearTimeout(timer) }, [notice])
  useEffect(() => { const shortcut = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); searchInput.current?.focus() } if (e.key === 'Escape') { setSidebar(false); setNotifications(false) } }; window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut) }, [])
  async function change(updater: (current: Workspace) => Workspace, message: string) { const ok = await update(updater); if (ok) setNotice(message); return ok }
  function exportReport() {
    const rows = [['과정명', '수강생', '진도', '상태'], ...data.courses.map(c => [c.title, c.learners, `${c.progress}%`, c.status])]
    const csv = '\uFEFF' + rows.map(row => row.map(value => `"${String(value).replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = 'asanax-learning-report.csv'; a.click(); URL.revokeObjectURL(url); setNotice('학습 리포트를 다운로드했습니다.')
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const fields = new FormData(e.currentTarget); const value = (key: string) => String(fields.get(key) || '').trim(); const id = crypto.randomUUID()
    if (!value('title')) return
    let ok = false
    if (modal === 'course') ok = await change(d => ({ ...d, courses: [...d.courses, { id, title: value('title'), description: value('description'), category: value('category'), mentor: value('mentor'), weeks: `${value('weeks')}주 과정`, progress: 0, learners: 0, theme: 'green', status: '모집 중', code: value('code'), cohort: value('cohort'), guildId: value('guildId'), startDate: value('startDate'), endDate: value('endDate') }] }), '새 학습 과정을 만들었습니다.')
    if (modal === 'session') ok = await change(d => ({ ...d, sessions: [...d.sessions, { id, title: value('title'), mentor: data.mentors.find(m => m.id === value('mentorId'))?.name || '', mentorId: value('mentorId'), studentId: value('studentId'), team: value('team'), date: value('date'), time: value('time'), status: '승인 대기' }] }), '멘토링 일정이 등록되었습니다.')
    if (modal === 'assignment') ok = await change(d => ({ ...d, assignments: [...d.assignments, { id, title: value('title'), course: data.courses.find(c => c.id === value('course'))?.title || value('course'), courseId: value('course'), due: value('date'), submitted: 0, total: d.courses.find(c => c.id === value('course'))?.learners || 0, status: '진행 중' }] }), '과제가 등록되었습니다.')
    if (modal === 'server') ok = await change(d => ({ ...d, servers: [...d.servers, { id, name: value('title'), provider: value('provider'), region: value('region'), status: data.mode === 'api' ? '미연결' : '중지됨', version: '미확인' }], logs: [...d.logs, { id: crypto.randomUUID(), time: new Date().toLocaleTimeString('ko-KR', { hour12: false }), text: `${value('title')} 배포 환경이 등록되었습니다.` }] }), '배포 환경을 등록했습니다.')
    if (ok) setModal(null)
  }
  return <div className="app-shell">
    {sidebar && <button className="sidebar-overlay" aria-label="메뉴 닫기" onClick={() => setSidebar(false)} />}
    <aside className={`sidebar ${sidebar ? 'open' : ''}`}>
      <a href="#dashboard" className="brand" onClick={() => go('dashboard')}><span className="brand-mark"><Command size={23} /></span><span><span className="brand-ax">AX</span><small>LEARNINGOPS</small></span></a>
      <WorkspaceSwitcher workspaces={workspaces} activeId={activeId} selectWorkspace={selectWorkspace} createWorkspace={workspace.account?.role === 'admin' || data.mode === 'demo' ? createWorkspace : undefined} saving={saving} error={error} />
      <p className="nav-label">WORKSPACE</p>
      <nav aria-label="주 메뉴">{navigation.slice(0, -3).map(n => <button key={n.id} onClick={() => go(n.id)} className={`nav-item ${page === n.id ? 'active' : ''}`} aria-current={page === n.id ? 'page' : undefined}><n.icon size={19} /><span>{n.name}</span>{n.id === 'mentoring' && pending > 0 && <span className="nav-count">{pending}</span>}{page === n.id && <span className="active-dot" />}</button>)}<p className="nav-label system-label">MANAGEMENT</p>{navigation.slice(-3).map(n => <button key={n.id} onClick={() => go(n.id)} className={`nav-item ${page === n.id ? 'active' : ''}`} aria-current={page === n.id ? 'page' : undefined}><n.icon size={19} /><span>{n.name}</span>{n.id === 'bots' && <span className="online-dot" />}</button>)}</nav>
      <div className="sidebar-bottom"><div className="help-card"><span className="help-spark"><Sparkles size={19} /></span><h3>운영 도움말</h3><p>기능별 사용 방법과<br />연동 범위를 확인하세요.</p><button onClick={() => setModal('help')}>운영 가이드 <ArrowUpRight size={14} /></button></div><button className="profile" onClick={() => go('settings')}><Avatar name="관" color="peach" /><span><strong>{workspace.account?.name || '관리자'}</strong><small>{workspace.account?.role === 'admin' ? '전체 관리자' : '워크스페이스 관리자'}</small></span><MoreHorizontal size={19} /></button></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="flex items-center gap-3"><button className="icon-button mobile-menu" aria-label="메뉴 열기" onClick={() => setSidebar(true)}><Menu size={22} /></button><span className="breadcrumb">{data.name}</span><ChevronRight size={13} className="breadcrumb" /><strong>{navigation.find(n => n.id === page)?.name}</strong></div><div className="header-tools"><label className="search-box"><Search size={16} /><input ref={searchInput} aria-label="현재 화면 검색" placeholder="현재 화면 검색" value={query} onChange={e => setQuery(e.target.value)} /><kbd>⌘ K</kbd></label><span className="header-divider" /><div className="notification-wrap"><button className="icon-button notification-button" aria-label="알림" aria-expanded={notifications} onClick={() => setNotifications(!notifications)}><Bell size={19} />{!read && <i />}</button>{notifications && <div className="notification-panel"><div className="flex items-center justify-between"><h3>운영 알림</h3><button className="text-button" onClick={() => setRead(true)}><CheckCheck size={15} /> 모두 읽음</button></div><button onClick={() => go('mentoring')}><span className="notification-icon"><CalendarDays size={17} /></span><span><strong>멘토링 승인 요청 {pending}건</strong><small>미처리 예약을 확인하세요.</small></span></button><button onClick={() => go('assignments')}><span className="notification-icon orange"><ClipboardList size={17} /></span><span><strong>진행 중인 과제를 확인하세요</strong><small>수강생의 제출 현황을 살펴보세요.</small></span></button><span className="notification-foot">{read ? '모든 알림을 읽었습니다.' : '현재 데이터 기준'}</span></div>}</div><button className="profile-avatar" aria-label="내 설정" onClick={() => go('settings')}><Avatar name="관" color="peach" small /></button></div></header>
      <main><div className="page-heading"><div><div className="eyebrow">LEARNING OPERATIONS</div><h1>{pageInfo[page][0]}</h1><p>{pageInfo[page][1]}</p></div><div className="page-actions">{page === 'dashboard' && <button className="button secondary" onClick={exportReport}><ArrowDownToLine size={16} /> 리포트 내보내기</button>}{['dashboard', 'courses', 'bots', 'mentoring', 'assignments'].includes(page) && <button className="button primary" onClick={() => setModal(page === 'bots' ? 'server' : page === 'mentoring' ? 'session' : page === 'assignments' ? 'assignment' : 'course')}><Plus size={17} />{page === 'bots' ? '서버 추가' : page === 'mentoring' ? '일정 등록' : page === 'assignments' ? '과제 만들기' : '새 과정 만들기'}</button>}</div></div>
      <div className="demo-indicator"><span className="online-dot" /> {page === 'connection' ? 'Render 원격 데이터' : error ? '연결·저장 오류' : data.mode === 'api' ? 'DB 연결됨' : '데모 모드'} <span>{page === 'connection' ? '읽기 전용 · 원본 데이터는 Render에서 관리' : data.mode === 'api' ? '관리자 · ' + data.name : '브라우저에만 저장'}</span><button className="text-button" onClick={() => void refresh()}>새로고침</button>{workspace.account && workspace.account.id !== 'admin' && <AccountSettings />}{data.authEnabled ? <button className="text-button" onClick={() => void logout()}>로그아웃</button> : <button className="text-button" onClick={leaveDemo}>로그인 화면</button>}</div>
      {error && <div role="alert" className="inline-note error-note">{error}<button onClick={() => void refresh()} className="text-button">다시 불러오기</button></div>}
      {page === 'onboarding' ? <OnboardingSetup workspaceId={activeId} /> : page === 'members' ? <WorkspaceMembers workspaceId={activeId} platformAdmin={workspace.account?.role === 'admin' || data.mode === 'demo'} /> : page === 'admissions' ? <AdmissionsReview workspaceId={activeId} /> : page === 'discord' ? <DiscordSetup workspaceId={activeId} /> : page === 'connection' ? <RenderMonitor query={query} workspaceId={activeId} workspaceName={data.name} /> : page === 'dashboard' ? <Dashboard data={data} query={query} go={go} selectCourse={setSelectedCourse} addSession={() => setModal('session')} /> : ['learners', 'teams', 'mentors', 'attendance', 'scores', 'notices', 'files', 'submissions'].includes(page) ? <Operations key={page} page={page} data={data} query={query} change={change} saving={saving} error={error} /> : <Management page={page} data={data} query={query} filter={filter} setFilter={setFilter} change={change} go={go} selectCourse={setSelectedCourse} help={() => setModal('help')} />}
      <footer><span>© 2026 {data.name} LearningOps</span><span>LearningOps <Sparkles size={12} /></span><button onClick={() => setModal('help')}>도움말 <ExternalLink size={12} /></button></footer>
      </main>
    </div>
    {notice && <div className="toast" role="status"><span><Check size={16} /></span>{notice}<button aria-label="알림 닫기" onClick={() => setNotice('')}><X size={14} /></button></div>}
    {modal && <ModalShell title={{ course: '새 학습 과정 만들기', session: '멘토링 일정 등록', server: '배포 서버 추가', assignment: '새 과제 만들기', help: '운영 가이드' }[modal]} close={() => setModal(null)}>{modal === 'help' ? <div className="guide-content"><p>기능별 사용 방법</p>{[{ icon: BookOpen, title: '01. 학습 과정 만들기', text: '과정명과 담당 멘토를 입력해 새 과정을 등록하세요. 생성한 과정은 모집 중 상태로 저장됩니다.' }, { icon: CalendarDays, title: '02. 멘토링과 과제 관리', text: '멘토링 일정을 등록하고 예약을 승인하세요. 과제별 제출 현황과 마감을 관리할 수 있어요.' }, { icon: Bot, title: '03. 서버 연결 상태', text: '서버 정보와 연동 상태를 관리합니다. 원격 프로세스 실행과 배포는 별도 에이전트 연결이 필요합니다.' }].map(item => <div key={item.title}><item.icon size={23} /><span><h3>{item.title}</h3><p>{item.text}</p></span></div>)}<div className="inline-note">기본 모드는 API와 SQLite를 사용합니다. 출결·성적·공지 초안은 웹 추가 기능이며, Discord 자동 발송 및 S3 연동은 미구현입니다.</div><button className="button primary w-full" onClick={() => setModal(null)}>닫기 <ArrowRight size={16} /></button></div> : <form className="modal-form" onSubmit={submit}><fieldset disabled={saving}>{error && <div role="alert" className="inline-note error-note">{error}</div>}<p>{modal === 'server' ? '배포 환경을 등록하고 봇 운영 흐름을 체험해 보세요.' : '필수 항목을 입력하세요.'}</p><label>{modal === 'server' ? '서버 이름' : modal === 'session' ? '멘토링 주제' : modal === 'assignment' ? '과제명' : '과정명'}<input name="title" placeholder={modal === 'server' ? '예: asanAX-production' : '이름을 입력하세요'} required maxLength={80} pattern=".*\S.*" /></label>{modal === 'course' && <><div className="form-row"><label>과정 코드<input name="code" required maxLength={40} /></label><label>기수<input name="cohort" defaultValue="1기" required maxLength={20} /></label></div><div className="form-row"><label>시작일<input name="startDate" type="date" required /></label><label>종료일<input name="endDate" type="date" required /></label></div><label>Discord 서버 ID<input name="guildId" pattern="[0-9]{17,20}" placeholder="선택 입력" /></label><label>과정 소개<textarea name="description" placeholder="과정 설명" required maxLength={200} /></label><div className="form-row"><label>분야<select name="category"><option>AI & PRODUCTIVITY</option><option>DATA & BUSINESS</option><option>BUILD & COLLABORATE</option></select></label><label>운영 기간 (주)<input name="weeks" type="number" defaultValue={8} min={1} max={52} required /></label></div></>}{(modal === 'course' || modal === 'session') && <label>담당 멘토<select name={modal === 'session' ? 'mentorId' : 'mentor'} required={modal === 'session'}><option value="">선택하세요</option>{data.mentors.map(m => <option key={m.id} value={modal === 'session' ? m.id : m.name}>{m.name}</option>)}</select></label>}{modal === 'session' && <><label>수강생<select name="studentId" required><option value="">선택하세요</option>{data.learners.map(l => <option key={l.id} value={l.id}>{l.name}{!l.discordId ? ' (Discord 미연결)' : ''}</option>)}</select></label><label>참여 팀<select name="team"><option value="">개인</option>{data.teams.map(t => <option key={t.id}>{t.name}</option>)}</select></label><div className="form-row"><label>날짜<input name="date" type="date" defaultValue="2026-09-15" required /></label><label>시작 시간<input name="time" type="time" defaultValue="14:00" required /></label></div></>}{modal === 'assignment' && <><label>학습 과정<select name="course">{data.courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label><label>마감일<input name="date" type="date" defaultValue="2026-09-22" required /></label></>}{modal === 'server' && <><label>배포 환경<select name="provider"><option>Docker</option><option>Render</option><option>AWS</option><option>Railway</option><option>자체 서버</option></select></label><label>리전<input name="region" defaultValue="Seoul" required maxLength={40} /></label><div className="inline-note">배포 환경 정보만 저장합니다. 원격 실행·배포는 아직 연결되지 않았습니다.</div></>}<div className="modal-actions"><button type="button" className="button secondary" onClick={() => setModal(null)}>취소</button><button className="button primary" type="submit"><Plus size={16} />{modal === 'server' ? '서버 등록' : '만들기'}</button></div></fieldset></form>}</ModalShell>}
    {selectedCourse && <ModalShell title={selectedCourse.title} close={() => setSelectedCourse(null)}><div className="course-detail"><div className={`detail-art ${selectedCourse.theme}`}><GraduationCap size={55} /><span>{selectedCourse.category}</span></div><p>{selectedCourse.description}</p><div className="detail-stats"><span>담당 멘토<strong>{selectedCourse.mentor}</strong></span><span>수강생<strong>{selectedCourse.learners}명</strong></span><span>운영 기간<strong>{selectedCourse.weeks}</strong></span></div><div className="progress-label"><span>학습 진도</span><strong>{selectedCourse.progress}%</strong></div><div className="progress-track"><div style={{ width: `${selectedCourse.progress}%` }} /></div><h3>이 과정의 과제</h3>{data.assignments.filter(a => a.course === selectedCourse.title).map(a => <div className="detail-assignment" key={a.id}><ClipboardList size={18} /><span>{a.title}<small>{a.due} 마감</small></span><Badge>{a.status}</Badge></div>)}{!data.assignments.some(a => a.course === selectedCourse.title) && <p className="muted">아직 등록된 과제가 없습니다.</p>}<div className="detail-actions"><button disabled={saving} className="button secondary w-full" onClick={async () => { const updated = { ...selectedCourse, status: selectedCourse.status === '진행 중' ? '종료' as const : '진행 중' as const }; if (await change(d => ({ ...d, courses: d.courses.map(c => c.id === updated.id ? updated : c) }), '과정 상태를 변경했습니다.')) setSelectedCourse(updated) }}>{selectedCourse.status === '진행 중' ? '과정 종료' : '운영 시작'}</button></div>{error && <p role="alert" className="error-text">{error}</p>}<button className="button primary w-full" onClick={() => { setSelectedCourse(null); go('assignments') }}>과제 관리하기 <ArrowRight size={16} /></button></div></ModalShell>}
  </div>
}

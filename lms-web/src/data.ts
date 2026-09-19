export type CourseSession = { id: string; week: number; title: string; date: string; startTime: string; endTime: string; notes: string }
export type Course = { id: string; title: string; category: string; description: string; progress: number; learners: number; weeks: string; mentor: string; theme: 'orange' | 'green' | 'blue'; status: '진행 중' | '모집 중' | '종료'; code?: string; cohort?: string; guildId?: string; startDate?: string; endDate?: string; schedule?: CourseSession[] }
export type Session = { id: string; title: string; mentor: string; mentorId?: string; studentId?: string; team: string; date: string; time: string; status: '승인 대기' | '예약 확정' | '완료' | '취소' }
export type Assignment = { type?: 'team' | 'individual'; id: string; title: string; course: string; courseId?: string; due: string; submitted: number; total: number; status: '진행 중' | '마감' }
export type Server = { id: string; name: string; provider: string; region: string; status: '실행 중' | '중지됨' | '미연결'; version: string }
export type Log = { id: string; time: string; text: string; before?: string; after?: string }
export type RecordData = { id: string; [key: string]: string | number }
export type Learner = { id: string; name: string; email: string; team: string; courseId: string; discordId: string; status: string; progress: number; color: string }
export type Mentor = { id: string; name: string; discordId: string; bio: string }
export type Workspace = { onboardingComplete?: boolean; workspaceId?: string; courses: Course[]; sessions: Session[]; assignments: Assignment[]; servers: Server[]; logs: Log[]; learners: Learner[]; mentors: Mentor[]; teams: RecordData[]; attendance: RecordData[]; scores: RecordData[]; notices: RecordData[]; files: RecordData[]; submissions: RecordData[]; name: string; reminders: boolean; onboarding: boolean; qa: boolean; revision?: string; mode?: 'api' | 'demo'; authEnabled?: boolean }
export const initialData: Workspace = {
  name: 'AX LearningOps', reminders: true, onboarding: true, qa: true,
  learners: [], mentors: [], teams: [], attendance: [], scores: [], notices: [], files: [], submissions: [],
  courses: [
    { id: 'c1', title: 'AX LearningOps 1기', category: 'AI & PRODUCTIVITY', description: '생성형 AI 실무 · 8주 과정', progress: 68, learners: 32, weeks: '8주 과정', mentor: '김민준', theme: 'orange', status: '진행 중' },
    { id: 'c2', title: 'AX LearningOps 2기', category: 'DATA & BUSINESS', description: '데이터 분석 · 6주 과정', progress: 42, learners: 28, weeks: '6주 과정', mentor: '이지은', theme: 'green', status: '진행 중' },
    { id: 'c3', title: 'AX 프로젝트 실습', category: 'BUILD & COLLABORATE', description: '팀 프로젝트 · 10주 과정', progress: 24, learners: 24, weeks: '10주 과정', mentor: '박서연', theme: 'blue', status: '진행 중' },
  ],
  sessions: [
    { id: 's1', title: 'AI 서비스 기획 피드백', mentor: '김민준', team: '팀 1 · 이도윤 외 3명', date: '2026-09-15', time: '14:00', status: '예약 확정' },
    { id: 's2', title: '데이터 분석 방향성 멘토링', mentor: '이지은', team: '팀 3 · 최유진 외 2명', date: '2026-09-15', time: '16:00', status: '예약 확정' },
    { id: 's3', title: '프로젝트 중간 점검', mentor: '박서연', team: '팀 2 · 정하린 외 3명', date: '2026-09-15', time: '17:30', status: '승인 대기' },
    { id: 's4', title: '자동화 워크플로 리뷰', mentor: '김민준', team: '팀 4 · 김지호 외 3명', date: '2026-09-16', time: '11:00', status: '승인 대기' },
  ],
  assignments: [
    { id: 'a1', title: '나만의 AI 워크플로 만들기', course: 'AX LearningOps 1기', due: '2026-09-18', submitted: 24, total: 32, status: '진행 중' },
    { id: 'a2', title: '비즈니스 데이터 분석 리포트', course: 'AX LearningOps 2기', due: '2026-09-20', submitted: 16, total: 28, status: '진행 중' },
    { id: 'a3', title: '팀 프로젝트 문제 정의', course: 'AX 프로젝트 실습', due: '2026-09-22', submitted: 8, total: 24, status: '진행 중' },
  ],
  servers: [
    { id: 'b1', name: 'asanAX-mentoring', provider: 'Render', region: 'Singapore', status: '실행 중', version: 'v1.2.0' },
    { id: 'b2', name: 'asanAX-staging', provider: 'Docker', region: 'Seoul', status: '중지됨', version: 'v1.2.0' },
  ],
  logs: [{ id: 'l1', time: '13:42:08', text: '멘토링 봇 데모 인스턴스가 준비되었습니다.' }, { id: 'l2', time: '13:42:09', text: '학습 운영 모듈 10개가 로드되었습니다.' }, { id: 'l3', time: '13:45:12', text: '김민준 멘토의 예약 일정이 갱신되었습니다.' }],
}
export const learners = [
  { name: '이도윤', email: 'doyun@example.com', team: '팀 1', progress: 86, status: '학습 중', color: 'peach' },
  { name: '최유진', email: 'yujin@example.com', team: '팀 3', progress: 72, status: '학습 중', color: 'sage' },
  { name: '정하린', email: 'harin@example.com', team: '팀 2', progress: 94, status: '학습 중', color: 'lavender' },
  { name: '김지호', email: 'jiho@example.com', team: '팀 4', progress: 45, status: '학습 중', color: 'sky' },
  { name: '박수빈', email: 'subin@example.com', team: '팀 1', progress: 100, status: '수료', color: 'sage' },
  { name: '한서준', email: 'seojun@example.com', team: '팀 5', progress: 18, status: '온보딩', color: 'peach' },
]

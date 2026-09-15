import { useEffect, useRef, type ReactNode } from 'react'
import { Activity, ArrowRight, ArrowUpRight, Clock3, Code2, Search, Sparkles, Users, X } from 'lucide-react'
import type { Course } from './data'

export function Badge({ children, tone = 'green' }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}>{children}</span> }
export function Avatar({ name, color = 'sage', small = false }: { name: string; color?: string; small?: boolean }) { return <span className={`avatar ${color} ${small ? 'small' : ''}`}>{name.slice(0, 1)}</span> }
export function Empty() { return <div className="empty"><Search size={26} /><strong>표시할 데이터가 없습니다.</strong><span>항목을 등록하거나 검색 조건을 변경하세요.</span></div> }
export function CardHeading({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) { return <div className="card-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{children}</div> }
export function CourseCard({ course, onClick }: { course: Course; onClick: () => void }) {
  return <button className="course-card group text-left" onClick={onClick}>
    <div className={`course-art ${course.theme}`}><span className="course-category">{course.category}</span><Badge tone="white">{course.status}</Badge><div className="course-symbol">{course.theme === 'orange' ? <Sparkles /> : course.theme === 'green' ? <Activity /> : <Code2 />}</div><div className="art-ring one" /><div className="art-ring two" /><span className="art-caption">AX <span>CLASS</span></span><ArrowUpRight className="art-arrow" size={25} /></div>
    <div className="course-body"><h3>{course.title}</h3><p>{course.description}</p><div className="course-meta"><span><Users size={13} /> {course.learners}명</span><span><Clock3 size={13} /> {course.weeks}</span><span>{course.mentor} 멘토</span></div><div className="progress-label"><span>{course.code ? '과정 운영 상태' : '전체 학습 진도'}</span><strong>{course.code ? course.status : `${course.progress}%`}</strong></div><div className="progress-track"><div style={{ width: `${course.progress}%` }} /></div><div className="course-bottom"><div className="avatar-stack">{course.code ? <span>{course.code} · {course.cohort}</span> : <><Avatar name="이" color="peach" small /><Avatar name="김" color="sage" small /><Avatar name="박" color="lavender" small /><span>+{Math.max(0, course.learners - 3)}</span></>}</div><span className="course-link">과정 살펴보기 <ArrowRight size={14} /></span></div></div>
  </button>
}
export function ModalShell({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close() }, [])
  return <dialog ref={dialog} className="modal" onCancel={close} onClick={e => { if (e.target === e.currentTarget) close() }} aria-label={title}><div className="modal-heading"><div><span className="eyebrow">LEARNINGOPS</span><h2>{title}</h2></div><button className="icon-button" onClick={close} aria-label="닫기"><X size={20} /></button></div>{children}</dialog>
}

import { useState } from 'react'
import { Check, Search } from 'lucide-react'
import type { AssignmentTarget } from './useAssignmentAlerts'
import './assignment-roster.css'

export default function AssignmentRoster({ assignment: a }: { assignment: AssignmentTarget }) {
  const [query, setQuery] = useState('')
  const team = a.type === 'team', unit = team ? '팀' : '명'
  const groups = [
    { completed: false, title: team ? '미제출 팀' : '미제출 수강생' },
    { completed: true, title: team ? '제출한 팀' : '제출한 수강생' },
  ]
  return <section className="assignment-roster" aria-label={`${a.title} 제출·미제출 명단`}>
    <div className="assignment-roster-heading"><div><h3>제출 현황</h3><p>{team ? '정상 수강생이 있는 팀 기준 · 팀원 한 명 이상 제출하면 완료' : '이 과정의 정상 수강생 기준 · 본인 제출 기록으로 집계'}</p></div><label className="assignment-roster-search"><Search size={16} /><input aria-label={`${a.title} ${team ? '팀' : '수강생'} 검색`} placeholder={team ? '팀 이름 검색' : '이름 또는 조 검색'} value={query} onChange={e => setQuery(e.target.value)} /></label></div>
    {!a.courseId ? <p className="assignment-roster-empty">대상 과정을 연결하면 제출·미제출 명단을 확인할 수 있습니다.</p> : <div className="assignment-roster-columns">{groups.map(group => {
      const all = a.targets.filter(t => t.completed === group.completed)
      const visible = all.filter(t => `${t.name} ${t.team || ''}`.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.key.localeCompare(b.key))
      return <section className={`assignment-roster-group ${group.completed ? 'completed' : 'missing'}`} key={group.title} aria-label={`${a.title} ${group.title}`}>
        <h4>{group.completed && <Check size={16} />}{group.title}<span>{all.length}{unit}</span></h4>
        {visible.length ? <ul tabIndex={0} aria-label={`${group.title} 목록`}>{visible.map(target => <li key={target.key}><strong>{target.name}</strong>{!team && <span>{target.team || '조 미배정'} · {target.targetId ? `Discord 끝 ${target.targetId.slice(-4)}` : 'Discord 미인증'}</span>}</li>)}</ul> : <p className="assignment-roster-empty">{query.trim() ? '검색 조건에 맞는 대상이 없습니다.' : !a.total ? '아직 제출 대상이 없습니다.' : group.completed ? '아직 제출한 대상이 없습니다.' : '모두 제출했습니다.'}</p>}
        {!!query.trim() && <p className="assignment-roster-result">검색 결과 {visible.length}{unit} / 전체 {all.length}{unit}</p>}
      </section>
    })}</div>}
    {a.unmatchedSubmissions > 0 && <p className="assignment-roster-warning">명단과 연결되지 않은 제출 {a.unmatchedSubmissions}건이 있습니다. 아래 제출 내역을 확인하세요.</p>}
  </section>
}

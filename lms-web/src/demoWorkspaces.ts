import { initialData, learners, type Workspace } from './data'
import branding from '../shared/branding.json'

export type WorkspaceRole = 'admin' | 'instructor' | 'student'
export const roleNames = { admin: '워크스페이스 관리자', instructor: '강사', student: '수강생' }
export type WorkspaceMetadata = { id: string; name: string; description: string; sourceId: string; guildIds: string[]; role?: WorkspaceRole; archivedAt?: number | null }
export type WorkspaceInput = { name: string; description: string; guildId: string }
export const demoStorageKey = 'learningops-workspaces-demo-v2'
export const emptyWorkspace: Workspace = { name: '', reminders: true, onboarding: true, qa: true, courses: [], learners: [], mentors: [], teams: [], attendance: [], scores: [], notices: [], files: [], submissions: [], sessions: [], assignments: [], servers: [], logs: [], mode: 'api' }
type DemoWorkspaces = { workspaces: WorkspaceMetadata[]; data: Record<string, Workspace> }
function migrateDemoBranding(saved: DemoWorkspaces): DemoWorkspaces {
  let changed = false
  const rename = (value: string) => {
    const next = value.replaceAll(branding.legacyName, branding.name)
    if (next !== value) changed = true
    return next
  }
  saved.workspaces.forEach(w => { w.name = rename(w.name) })
  Object.values(saved.data).forEach(data => {
    data.name = rename(data.name)
    data.courses.forEach(course => { course.title = rename(course.title) })
    data.assignments.forEach(assignment => { assignment.course = rename(assignment.course) })
  })
  if (changed) localStorage.setItem(demoStorageKey, JSON.stringify(saved))
  return saved
}
export function readDemoWorkspaces(): DemoWorkspaces {
  try {
    const saved = JSON.parse(localStorage.getItem(demoStorageKey) || 'null')
    if (saved?.workspaces?.length && saved.workspaces.every((w: WorkspaceMetadata) => saved.data?.[w.id])) return migrateDemoBranding(saved)
  } catch { /* Restore the existing demo below. */ }
  let legacy: Partial<Workspace> = {}
  try { legacy = JSON.parse(localStorage.getItem('asanax-campus-demo-v1') || '{}') } catch { /* Use samples. */ }
  const original: Workspace = { ...structuredClone(initialData), ...legacy, workspaceId: 'default', mode: 'demo', learners: legacy.learners?.length ? legacy.learners : learners.map((l, i) => ({ ...l, id: `student-${i}`, discordId: '', courseId: 'c1' })), mentors: legacy.mentors?.length ? legacy.mentors : ['김민준', '이지은', '박서연'].map((name, i) => ({ id: String(i + 1), name, discordId: '', bio: '' })) }
  return migrateDemoBranding({ workspaces: [
    { id: 'default', name: original.name, description: '기존 학습 운영 데이터', sourceId: 'local-default', guildIds: [] },
    { id: 'asan-ax', name: '아산 AX', description: '아산 AX 학습 운영', sourceId: 'asan-ax', guildIds: [] },
  ], data: { default: original, 'asan-ax': { ...structuredClone(emptyWorkspace), workspaceId: 'asan-ax', name: '아산 AX', mode: 'demo' } } })
}
export function preferredWorkspace() { return new URLSearchParams(location.search).get('workspace') || (location.hash === '#asan' ? 'asan-ax' : '') }
export function rememberWorkspace(id: string) {
  const url = new URL(location.href)
  if (id) url.searchParams.set('workspace', id); else url.searchParams.delete('workspace')
  if (url.hash === '#asan') url.hash = 'connection'
  history.replaceState(null, '', url)
}

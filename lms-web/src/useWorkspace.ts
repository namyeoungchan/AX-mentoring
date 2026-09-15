import { useCallback, useEffect, useRef, useState } from 'react'
import { initialData, learners, type Workspace } from './data'
import { apiRequest as request, demoMode, setSessionToken } from './api'

const key = 'asanax-campus-demo-v1'
const kinds = ['courses', 'learners', 'teams', 'mentors', 'attendance', 'scores', 'notices', 'servers', 'assignments', 'sessions'] as const
export { demoMode } from './api'
const empty: Workspace = { ...initialData, courses: [], sessions: [], assignments: [], servers: [], logs: [], mode: 'api' }
function restore(): Workspace {
  if (!demoMode) return empty
  let saved = null
  try { saved = JSON.parse(localStorage.getItem(key) || 'null') } catch { /* Use sample data. */ }
  return { ...structuredClone(initialData), ...(saved || {}), mode: 'demo', learners: saved?.learners?.length ? saved.learners : learners.map((l, i) => ({ ...l, id: `student-${i}`, discordId: '', courseId: 'c1' })), mentors: saved?.mentors?.length ? saved.mentors : [{ id: '1', name: '김민준', discordId: '', bio: '' }, { id: '2', name: '이지은', discordId: '', bio: '' }, { id: '3', name: '박서연', discordId: '', bio: '' }] }
}
export function useWorkspace() {
  const [data, setData] = useState<Workspace>(restore)
  const [loading, setLoading] = useState(!demoMode)
  const [error, setError] = useState('')
  const [authRequired, setAuthRequired] = useState(false)
  const [saving, setSaving] = useState(false)
  const locked = useRef(false)
  const refresh = useCallback(async () => {
    if (demoMode) return
    try { const result = await request('workspace'); setData(result); setError(''); setAuthRequired(false) }
    catch (e) { const failure = e as Error & { status?: number }; setError(failure.message); setAuthRequired(failure.status === 401) }
    finally { setLoading(false) }
  }, [])
  // eslint-disable-next-line react/set-state-in-effect -- Initial asynchronous API fetch, not derived local state.
  useEffect(() => { void refresh() }, [refresh])
  async function update(updater: (current: Workspace) => Workspace) {
    if (locked.current) return false
    locked.current = true; setSaving(true); setError('')
    try {
      const next = updater(data)
      if (demoMode) { localStorage.setItem(key, JSON.stringify(next)); setData(next); return true }
      const changes: { kind: string; value: unknown }[] = []
      for (const kind of kinds) for (const row of next[kind]) {
        const previous = data[kind].find(item => item.id === row.id)
        if (JSON.stringify(previous) !== JSON.stringify(row)) changes.push({ kind, value: row })
      }
      const settings = { name: next.name, reminders: next.reminders, onboarding: next.onboarding, qa: next.qa }
      if (Object.entries(settings).some(([k, v]) => data[k as keyof Workspace] !== v)) changes.push({ kind: 'settings', value: settings })
      if (changes.length) setData(await request('workspace', { method: 'PATCH', body: JSON.stringify({ revision: data.revision, changes }) }))
      return true
    } catch (e) { const failure = e as Error & { status?: number }; setError(failure.message); if (failure.status === 401) setAuthRequired(true); return false }
    finally { locked.current = false; setSaving(false) }
  }
  async function login(password: string) { try { const result = await request('login', { method: 'POST', body: JSON.stringify({ password }) }); setSessionToken(result.token || ''); await refresh() } catch (e) { setError((e as Error).message) } }
  async function logout() { await request('logout', { method: 'POST', body: '{}' }); setSessionToken(''); setData(empty); setAuthRequired(true) }
  return { data, update, loading, saving, error, authRequired, refresh, login, logout }
}

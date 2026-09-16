import { useCallback, useEffect, useRef, useState } from 'react'
import type { Workspace } from './data'
import { apiRequest as request, workspaceRequest, demoMode, setSessionToken } from './api'
import { demoStorageKey, emptyWorkspace, readDemoWorkspaces, preferredWorkspace, rememberWorkspace, type WorkspaceMetadata, type WorkspaceInput } from './demoWorkspaces'
import type { Account, Learning } from './StudentHome'

const kinds = ['courses', 'learners', 'teams', 'mentors', 'attendance', 'scores', 'notices', 'servers', 'assignments', 'sessions'] as const
export { demoMode } from './api'
export function useWorkspace() {
  const [data, setData] = useState<Workspace>(emptyWorkspace)
  const [workspaces, setWorkspaces] = useState<WorkspaceMetadata[]>([])
  const [activeId, setActiveId] = useState('')
  const active = useRef('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [authRequired, setAuthRequired] = useState(!(demoMode && new URLSearchParams(location.search).get('demo') === '1'))
  const [account, setAccount] = useState<Account | null>(null)
  const [learning, setLearning] = useState<Learning | null>(null)
  const [saving, setSaving] = useState(false)
  const locked = useRef(false)
  const loggingOut = useRef(false)
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const refresh = useCallback(async (requestedId?: string, quiet = false) => {
    if (locked.current || loggingOut.current) return
    const version = ++generation.current
    controller.current?.abort()
    const nextController = new AbortController(); controller.current = nextController
    const signal = AbortSignal.any([nextController.signal, AbortSignal.timeout(15000)])
    if (!quiet) { setLoading(true); setData(emptyWorkspace); setLearning(null) }
    try {
      const demo = demoMode ? readDemoWorkspaces() : null
      const user: Account | null = demo ? null : (await request('auth/me', { signal })).user
      const list: WorkspaceMetadata[] = demo ? demo.workspaces : (await request('workspaces?includeArchived=true', { signal })).workspaces
      const preferred = requestedId || preferredWorkspace() || active.current
      const id = list.some(w => w.id === preferred) ? preferred : list.find(w => w.archivedAt == null)?.id || ''
      const role = demo ? 'admin' : list.find(w => w.id === id)?.role
      const result = demo ? demo.data[id] : id ? await workspaceRequest(id, role === 'admin' ? 'workspace' : role === 'instructor' ? 'teaching' : 'me/learning', { signal }) : null
      if (version !== generation.current) return
      active.current = id; setActiveId(id); setWorkspaces(list); rememberWorkspace(id); setAccount(user)
      if (demo || role === 'admin' || role === 'instructor') setData(result || emptyWorkspace); else setLearning(result)
      setError(''); if (!demo) setAuthRequired(false)
    } catch (e) {
      if (version !== generation.current || nextController.signal.aborted) return
      const failure = e as Error & { status?: number }
      setError(failure.status === 401 ? '' : failure.message)
      if (failure.status === 401) { setSessionToken(''); setAccount(null); setWorkspaces([]); setAuthRequired(true) }
    } finally { if (version === generation.current) setLoading(false) }
  }, [])
  const cancelPending = useCallback(() => { controller.current?.abort(); generation.current++ }, [])
  // eslint-disable-next-line react/set-state-in-effect -- Fetch persisted workspace context.
  useEffect(() => { void refresh(); const pop = () => { if (preferredWorkspace() !== active.current) void refresh(preferredWorkspace()) }; window.addEventListener('popstate', pop); return () => { cancelPending(); window.removeEventListener('popstate', pop) } }, [refresh, cancelPending])
  async function update(updater: (current: Workspace) => Workspace) {
    if (locked.current || !activeId || data.workspaceId !== activeId) return false
    const id = activeId, version = generation.current
    locked.current = true; setSaving(true); setError('')
    try {
      const next = updater(data)
      let result = next
      if (demoMode) {
        const saved = readDemoWorkspaces(); saved.data[id] = next; saved.workspaces = saved.workspaces.map(w => w.id === id ? { ...w, name: next.name } : w)
        localStorage.setItem(demoStorageKey, JSON.stringify(saved))
      } else {
        const changes: { kind: string; value: unknown }[] = []
        for (const kind of kinds) for (const row of next[kind]) {
          const previous = data[kind].find(item => item.id === row.id)
          if (JSON.stringify(previous) !== JSON.stringify(row)) changes.push({ kind, value: row })
        }
        const settings = { name: next.name, reminders: next.reminders, onboarding: next.onboarding, qa: next.qa }
        if (Object.entries(settings).some(([k, v]) => data[k as keyof Workspace] !== v)) changes.push({ kind: 'settings', value: settings })
        if (changes.length) result = await workspaceRequest(id, workspaces.find(w => w.id === id)?.role === 'instructor' ? 'teaching' : 'workspace', { method: 'PATCH', body: JSON.stringify({ revision: data.revision, changes }) })
      }
      if (active.current === id && version === generation.current) { setData(result); setWorkspaces(list => list.map(w => w.id === id ? { ...w, name: result.name } : w)) }
      return true
    } catch (e) { if (active.current === id && version === generation.current) { const failure = e as Error & { status?: number }; setError(failure.message); if (failure.status === 401) setAuthRequired(true) } return false }
    finally { locked.current = false; setSaving(false) }
  }
  async function createWorkspace(input: WorkspaceInput) {
    if (locked.current) return false
    locked.current = true; setSaving(true); setError('')
    let created: WorkspaceMetadata
    try {
      if (demoMode) {
        const saved = readDemoWorkspaces()
        if (saved.workspaces.some(w => w.name.toLowerCase() === input.name.toLowerCase())) throw new Error('같은 이름의 워크스페이스가 있습니다.')
        if (input.guildId && saved.workspaces.some(w => w.guildIds.includes(input.guildId))) throw new Error('다른 워크스페이스에 연결된 Discord 서버입니다.')
        const id = crypto.randomUUID()
        created = { id, name: input.name, description: input.description, sourceId: id, guildIds: input.guildId ? [input.guildId] : [] }
        saved.workspaces.push(created); saved.data[id] = { ...structuredClone(emptyWorkspace), workspaceId: id, name: input.name, mode: 'demo' }
        localStorage.setItem(demoStorageKey, JSON.stringify(saved))
      } else created = await request('workspaces', { method: 'POST', body: JSON.stringify(input) })
    } catch (e) { setError((e as Error).message); return false }
    finally { locked.current = false; setSaving(false) }
    await refresh(created.id); return true
  }
  async function login(username: string, password: string, admin = false) {
    try { const result = await request(admin ? 'login' : 'auth/login', { method: 'POST', body: JSON.stringify(admin ? { password } : { username, password }) }); setSessionToken(result.token || ''); await refresh() }
    catch (e) { setError((e as Error).message) }
  }
  async function setWorkspaceArchived(id: string, archived: boolean) {
    if (locked.current || loggingOut.current) return false
    const version = generation.current
    locked.current = true; setSaving(true); setError('')
    try {
      let updated: WorkspaceMetadata
      if (demoMode) {
        const saved = readDemoWorkspaces(), current = saved.workspaces.find(w => w.id === id)
        if (!current) throw new Error('워크스페이스를 찾을 수 없습니다.')
        updated = { ...current, archivedAt: archived ? current.archivedAt ?? Date.now() : null }
        saved.workspaces = saved.workspaces.map(w => w.id === id ? updated : w)
        localStorage.setItem(demoStorageKey, JSON.stringify(saved))
      } else updated = await workspaceRequest(id, archived ? 'archive' : 'restore', { method: 'POST', body: '{}' })
      if (loggingOut.current || version !== generation.current) return false
      setWorkspaces(list => list.map(w => w.id === id ? updated : w))
      // Keep the current view open so the result and restore action remain visible.
      // A future visit without an explicit selection chooses an active workspace.
      return true
    } catch (e) { setError((e as Error).message); return false }
    finally { locked.current = false; setSaving(false) }
  }
  async function logout() {
    if (loggingOut.current) return
    loggingOut.current = true
    cancelPending(); setLoading(false)
    try { await request('logout', { method: 'POST', body: '{}' }) }
    catch (e) { if ((e as Error & { status?: number }).status !== 401) { setError('로그아웃하지 못했습니다. 연결을 확인하고 다시 시도하세요.'); loggingOut.current = false; return } }
    controller.current?.abort(); generation.current++
    setSessionToken(''); setData(emptyWorkspace); setLearning(null); setAccount(null); setWorkspaces([]); setError(''); setAuthRequired(true)
    active.current = ''; setActiveId(''); rememberWorkspace(''); setLoading(false)
    const url = new URL(location.href); url.hash = 'login'; history.replaceState(null, '', url)
    loggingOut.current = false
  }
  function enterDemo() { const url = new URL(location.href); url.searchParams.set('demo', '1'); url.hash = 'dashboard'; location.assign(url.href) }
  function leaveDemo() { const url = new URL(location.href); url.searchParams.delete('demo'); url.hash = 'login'; location.assign(url.href) }
  return { data, update, loading, saving, error, authRequired, account, learning, refresh: () => refresh(), refreshQuietly: () => refresh(undefined, true), login, logout, enterDemo, leaveDemo, workspaces, activeId, activeRole: demoMode ? 'admin' : workspaces.find(w => w.id === activeId)?.role, selectWorkspace: (id: string) => refresh(id), createWorkspace, setWorkspaceArchived }
}

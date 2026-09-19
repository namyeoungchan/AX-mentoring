import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUpRight, ChevronRight, Command, Menu, RefreshCw, X, type LucideIcon } from 'lucide-react'
import { Avatar } from './components'
import AccountSettings from './AccountSettings'
import LogoutButton from './LogoutButton'
import WorkspaceSwitcher from './WorkspaceSwitcher'
import type { WorkspaceMetadata } from './demoWorkspaces'

export type RolePage = { id: string; name: string; description: string; icon: LucideIcon }

type Props = {
  role: 'mentor' | 'student'; name: string; username?: string; title: string; pages: RolePage[]; page: string; go: (page: string) => void;
  workspaces: WorkspaceMetadata[]; activeId: string; selectWorkspace: (id: string) => Promise<void>;
  setWorkspaceArchived?: (id: string, archived: boolean) => Promise<boolean>; saving?: boolean; error: string;
  refresh: () => Promise<void>; logout: () => Promise<void>; children: ReactNode; status?: ReactNode;
}
export default function RoleWorkspace({ role, name, username, title, pages, page, go, workspaces, activeId, selectWorkspace, setWorkspaceArchived, saving, error, refresh, logout, children, status }: Props) {
  const [open, setOpen] = useState(false), [refreshing, setRefreshing] = useState(false)
  const [mobile, setMobile] = useState(() => matchMedia('(max-width: 760px)').matches)
  const menuButton = useRef<HTMLButtonElement>(null), sidebar = useRef<HTMLElement>(null), focusPage = useRef(false)
  const restoreMenuFocus = useRef(false), previousPage = useRef(page)
  const heading = useRef<HTMLHeadingElement>(null)
  const active = workspaces.find(w => w.id === activeId), current = pages.find(p => p.id === page) || pages[0]
  const roleName = role === 'mentor' ? '멘토' : '수강생'
  useEffect(() => {
    const media = matchMedia('(max-width: 760px)'), changed = () => setMobile(media.matches)
    media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [])
  useEffect(() => {
    if (open) return
    if (focusPage.current || previousPage.current !== page) { heading.current?.focus(); focusPage.current = false }
    previousPage.current = page
  }, [page, open])
  useEffect(() => {
    if (!open && restoreMenuFocus.current) { menuButton.current?.focus(); restoreMenuFocus.current = false }
  }, [open])
  useEffect(() => {
    const close = () => setOpen(false)
    window.addEventListener('hashchange', close)
    return () => window.removeEventListener('hashchange', close)
  }, [])
  useEffect(() => {
    if (!open || !mobile) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    sidebar.current?.querySelector<HTMLButtonElement>('.role-menu-close')?.focus()
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { restoreMenuFocus.current = true; setOpen(false) }
      if (event.key === 'Tab') {
        const items = [...(sidebar.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,select,[tabindex="0"]') || [])].filter(e => e.getClientRects().length)
        const first = items[0], last = items.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', handle)
    return () => { document.body.style.overflow = previous; document.removeEventListener('keydown', handle) }
  }, [open, mobile])
  function closeMenu() { restoreMenuFocus.current = true; setOpen(false) }
  function navigate(next: string) { setOpen(false); focusPage.current = true; go(next); if (next === page && !open) { heading.current?.focus(); focusPage.current = false } }
  async function reload() { if (refreshing) return; setRefreshing(true); try { await refresh() } finally { setRefreshing(false) } }
  const pdf = `${import.meta.env.BASE_URL}guides/${role}-guide.pdf`
  return <div className="app-shell role-workspace">
    <a className="skip-content" href="#role-main" onClick={e => { e.preventDefault(); heading.current?.focus() }}>본문으로 이동</a>
    {open && mobile && <button className="sidebar-overlay" aria-label="메뉴 닫기" onClick={closeMenu} />}
    <aside ref={sidebar} className={`sidebar ${open ? 'open' : ''}`} inert={mobile && !open} aria-label={`${roleName} 메뉴`}>
      <a href={`#${pages[0].id}`} className="brand" onClick={e => { e.preventDefault(); navigate(pages[0].id) }}><span className="brand-mark"><Command size={23} /></span><span><span className="brand-ax">AX</span><small>학습관리시스템</small></span></a>
      <button className="icon-button role-menu-close" aria-label="메뉴 접기" onClick={closeMenu}><X size={20} /></button>
      <WorkspaceSwitcher workspaces={workspaces} activeId={activeId} selectWorkspace={async id => { setOpen(false); await selectWorkspace(id) }} setWorkspaceArchived={setWorkspaceArchived} saving={saving} error={error} />
      <p className="nav-label">WORKSPACE</p>
      <nav aria-label="주 메뉴">{pages.map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} aria-current={page === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><item.icon size={19} /><span>{item.name}</span>{page === item.id && <span className="active-dot" />}</button>)}</nav>
      <div className="sidebar-bottom"><div className="help-card"><h3>이용 도움말</h3><a className="role-guide-link" href={pdf} target="_blank" rel="noreferrer">{roleName} 가이드 PDF <ArrowUpRight size={14} /></a></div><div className="profile"><Avatar name={name.slice(0, 1)} color="sage" /><span><strong>{name}</strong><small>{roleName}{username && ` · ${username}`}</small></span></div></div>
    </aside>
    <div className="main-shell" inert={mobile && open}>
      <header className="topbar"><div className="role-breadcrumb"><button ref={menuButton} className="icon-button mobile-menu" aria-label="메뉴 열기" aria-expanded={open} onClick={() => setOpen(true)}><Menu size={22} /></button><span className="breadcrumb">{active?.name || '워크스페이스 참여'}</span><ChevronRight size={13} className="breadcrumb" /><strong>{current.name}</strong></div><div className="header-tools"><LogoutButton logout={logout} /></div></header>
      <main id="role-main"><div className="page-heading"><div><div className="eyebrow">{role === 'mentor' ? 'TEACHING' : 'MY LEARNING'}</div><h1 ref={heading} tabIndex={-1}>{title}</h1><p>{current.description}</p></div></div>
        <div className="demo-indicator"><span className="online-dot" /><span>{roleName} · {active?.name || '참여 준비'}</span>{status}<button className="text-button" disabled={saving || refreshing} onClick={() => void reload()}><RefreshCw size={13} />{refreshing ? '불러오는 중…' : '새로고침'}</button><AccountSettings /></div>
        {error && <div className="inline-note error-note" role="alert">{error}<button className="text-button" disabled={refreshing} onClick={() => void reload()}>다시 불러오기</button></div>}
        <div className="role-content">{children}</div>
      <footer><span>© {new Date().getFullYear()} {active?.name || 'AX 학습관리시스템'} · {roleName}</span><a href={pdf} target="_blank" rel="noreferrer">이용 가이드 PDF <ArrowUpRight size={12} /></a></footer>
      </main>
    </div>
  </div>
}

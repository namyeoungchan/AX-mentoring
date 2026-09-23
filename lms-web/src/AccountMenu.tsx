import { useEffect, useRef, useState, type ReactNode } from 'react'
import { RefreshCw, Settings2, UserRound } from 'lucide-react'
import AccountSettings from './AccountSettings'

export default function AccountMenu({ name, role, refresh, disabled, password = true, settings, leaveDemo, status }: {
  name: string; role: string; refresh: () => Promise<void>; disabled?: boolean; password?: boolean;
  settings?: () => void; leaveDemo?: () => void; status?: ReactNode;
}) {
  const menu = useRef<HTMLDetailsElement>(null)
  const [refreshing, setRefreshing] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    const close = () => { if (menu.current) menu.current.open = false }
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close() }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !menu.current?.open || (event.target as Element).closest('dialog')) return
      close(); menu.current.querySelector('summary')?.focus()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    window.addEventListener('hashchange', close)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('hashchange', close)
    }
  }, [])
  async function reload() {
    if (refreshing) return
    setRefreshing(true); setError('')
    try { await refresh() } catch (failure) { setError((failure as Error).message) }
    finally { setRefreshing(false) }
  }
  return <details className="account-menu" ref={menu}>
    <summary className="icon-button" aria-label="계정 메뉴" title="계정 메뉴"><UserRound size={19} /></summary>
    <div className="account-menu-panel">
      <div className="account-menu-identity"><strong>{name}</strong><small>{role}</small>{status}</div>
      {settings && <button className="text-button" onClick={() => { if (menu.current) menu.current.open = false; settings() }}><Settings2 size={14} />워크스페이스 설정</button>}
      {password && <AccountSettings />}
      <button className="text-button" disabled={disabled || refreshing} onClick={() => void reload()}><RefreshCw size={14} />{refreshing ? '불러오는 중…' : '새로고침'}</button>
      {leaveDemo && <button className="text-button" onClick={leaveDemo}>로그인 화면</button>}
      {error && <p role="alert">{error}</p>}
    </div>
  </details>
}

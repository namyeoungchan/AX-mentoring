import { useState } from 'react'
import { LogOut } from 'lucide-react'

export default function LogoutButton({ logout }: { logout: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  async function leave() {
    if (busy) return
    setBusy(true)
    try { await logout() } finally { setBusy(false) }
  }
  return <button className="button secondary logout-button" aria-label="로그아웃" disabled={busy} onClick={() => void leave()}><LogOut size={16} /><span>{busy ? '종료 중…' : '로그아웃'}</span></button>
}

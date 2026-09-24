import { useEffect, useRef, useState } from 'react'
import { confirmNavigation } from './navigationGuard'

export function usePageNavigation(read: () => string) {
  const [page, setPage] = useState(read)
  const approved = useRef<string | null>(null)
  useEffect(() => {
    const changed = () => {
      const next = read()
      if (next === page) { approved.current = null; return }
      if (approved.current !== next && !confirmNavigation()) {
        history.replaceState(history.state, '', `${location.pathname}${location.search}#${page}`)
        return
      }
      approved.current = null
      setPage(next)
    }
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [page, read])
  function go(next: string) {
    if (next === page) return true
    if (!confirmNavigation()) return false
    approved.current = next
    location.hash = next
    setPage(next)
    return true
  }
  return [page, go] as const
}

import { useEffect, useState } from 'react'

export function useRolePage(pages: { id: string }[], fallback: string) {
  const read = () => pages.some(p => p.id === location.hash.slice(1)) ? location.hash.slice(1) : fallback
  const [page, setPage] = useState(read)
  useEffect(() => {
    const changed = () => setPage(pages.some(p => p.id === location.hash.slice(1)) ? location.hash.slice(1) : fallback)
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [pages, fallback])
  function go(next: string) {
    if (pages.some(p => p.id === next)) {
      location.hash = next
      setPage(next)
      window.scrollTo(0, 0)
    }
  }
  return [page, go] as const
}

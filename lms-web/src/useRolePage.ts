import { usePageNavigation } from './usePageNavigation'

export function useRolePage(pages: { id: string }[], fallback: string) {
  const read = () => pages.some(p => p.id === location.hash.slice(1)) ? location.hash.slice(1) : fallback
  const [page, navigate] = usePageNavigation(read)
  function go(next: string) {
    if (pages.some(p => p.id === next)) {
      if (navigate(next)) window.scrollTo(0, 0)
    }
  }
  return [page, go] as const
}

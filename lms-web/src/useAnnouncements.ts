import { useEffect, useState } from 'react'
import { workspaceRequest } from './api'

export type Layout = 'text' | 'image' | 'split' | 'overlay'
export type Position = `${'top' | 'middle' | 'bottom'}-${'left' | 'center' | 'right'}`
export type Theme = 'forest' | 'mint' | 'sand' | 'sky' | 'lilac' | 'ink'
export type Placement = 'banner' | 'sidebar' | 'popup'
export type Tab = 'all' | 'home' | 'assignments' | 'attendance' | 'scores' | 'videos' | 'mentoring' | 'help'
export type Design = { layout: Layout; textPosition: Position; imageSide: 'left' | 'right'; theme: Theme }
export type Shown = Design & { id: string; placement: Placement; pages: Tab[]; title: string; body: string; image: string; linkUrl: string; linkLabel: string; revision: number }

const kstDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' })
const hideKey = (workspaceId: string, v: Shown) => `ax-announcement-hidden:${workspaceId}:${v.id}:${v.revision}`
function hiddenToday(workspaceId: string, v: Shown) { try { return localStorage.getItem(hideKey(workspaceId, v)) === kstDate() } catch { return false } }

// Fetched once per workspace screen and shared by the tab banners, the menu banner and the popups.
export function useAnnouncements(workspaceId: string, demo = false) {
  const [state, setState] = useState<{ banners: Shown[]; sidebars: Shown[]; popups: Shown[] }>({ banners: [], sidebars: [], popups: [] })
  useEffect(() => {
    if (demo || !workspaceId) return
    const controller = new AbortController()
    workspaceRequest(workspaceId, 'announcements/active', { signal: controller.signal })
      .then((result: { banners: Shown[]; sidebars?: Shown[]; popups: Shown[] }) => {
        if (controller.signal.aborted) return
        const visible = (items: Shown[] = []) => items.filter(v => !hiddenToday(workspaceId, v))
        setState({ banners: result.banners, sidebars: visible(result.sidebars), popups: visible(result.popups) })
      })
      .catch(() => {})
    return () => controller.abort()
  }, [workspaceId, demo])
  function hideToday(v: Shown) { try { localStorage.setItem(hideKey(workspaceId, v), kstDate()) } catch { /* it still closes for this visit */ } }
  return {
    ...state,
    dismissPopup(today: boolean) { const [popup] = state.popups; if (today && popup) hideToday(popup); setState(previous => ({ ...previous, popups: previous.popups.slice(1) })) },
    hideSidebar(v: Shown) { hideToday(v); setState(previous => ({ ...previous, sidebars: previous.sidebars.filter(item => item.id !== v.id) })) },
  }
}
export type Announcements = ReturnType<typeof useAnnouncements>

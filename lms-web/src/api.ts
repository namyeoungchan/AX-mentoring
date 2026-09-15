// These are public build settings. Never add bot tokens or synchronization keys.
export const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
export const demoMode = import.meta.env.VITE_APP_MODE === 'demo' || new URLSearchParams(location.search).get('demo') === '1'
let sessionToken = ''

export function setSessionToken(value: string) { sessionToken = value }

export async function apiRequest(path: string, init: RequestInit = {}) {
  let external = false
  if (apiBaseUrl) {
    const url = new URL(apiBaseUrl)
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !localHttp)) throw new Error('API 주소는 자격증명과 경로 없는 HTTPS 주소여야 합니다.')
    external = url.origin !== location.origin
  }
  const headers = new Headers(init.headers)
  if (init.body) headers.set('Content-Type', 'application/json')
  if (external && sessionToken) headers.set('Authorization', `Bearer ${sessionToken}`)
  const response = await fetch(`${apiBaseUrl}/api/${path}`, { ...init, headers, credentials: external ? 'omit' : 'same-origin' })
  const body = await response.json().catch(() => ({ error: 'API에 연결하지 못했습니다. API 서버 주소와 실행 상태를 확인하세요.' }))
  if (!response.ok) throw Object.assign(new Error(body.error || '요청에 실패했습니다.'), { status: response.status })
  return body
}

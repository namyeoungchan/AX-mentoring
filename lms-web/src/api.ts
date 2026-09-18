// These are public build settings. Never add bot tokens or synchronization keys.
export const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
export const demoMode = import.meta.env.VITE_APP_MODE === 'demo' || (import.meta.env.DEV && new URLSearchParams(location.search).get('demo') === '1')
export const serviceUnavailable = import.meta.env.VITE_APP_MODE === 'unconfigured'
let sessionToken = ''

export function setSessionToken(value: string) { sessionToken = value }

export function workspaceRequest(workspaceId: string, path: string, init: RequestInit = {}) {
  if (!workspaceId) throw new Error('워크스페이스를 선택하세요.')
  return apiRequest(`workspaces/${encodeURIComponent(workspaceId)}/${path}`, init)
}

async function apiResponse(path: string, init: RequestInit = {}) {
  if (serviceUnavailable) throw new Error('로그인 서비스가 아직 연결되지 않았습니다. 연결 후 이용할 수 있습니다.')
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
  const response = await fetch(`${apiBaseUrl}/api/${path}`, { ...init, signal: init.signal || AbortSignal.timeout(15000), headers, credentials: external ? 'omit' : 'same-origin' })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'API에 연결하지 못했습니다. API 서버 주소와 실행 상태를 확인하세요.' }))
    throw Object.assign(new Error(body.error || '요청에 실패했습니다.'), { status: response.status })
  }
  return response
}

export async function apiRequest(path: string, init: RequestInit = {}) {
  return (await apiResponse(path, init)).json()
}

export async function apiDownload(path: string) {
  return (await apiResponse(path, { signal: AbortSignal.timeout(120000) })).blob()
}

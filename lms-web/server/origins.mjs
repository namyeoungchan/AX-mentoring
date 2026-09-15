const developmentOrigins = 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3001,http://127.0.0.1:3001'

function configuredOrigin(value, key) {
  try {
    const url = new URL(value)
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !localHttp) || url.hostname.includes('*') || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error()
    return url.origin
  } catch { throw new Error(`${key}: 경로 없는 HTTPS 주소를 입력하세요. 여러 주소는 쉼표로 구분합니다.`) }
}

export function configuredOrigins({ production = false, allowedOrigins = '', renderExternalUrl = '' } = {}) {
  const entries = (allowedOrigins || (production ? '' : developmentOrigins)).split(',').map(value => value.trim()).filter(Boolean)
  const origins = new Set(entries.map(value => configuredOrigin(value, 'ALLOWED_ORIGINS')))
  // Render supplies this value. Never derive trusted origins from request Host/Forwarded headers.
  if (renderExternalUrl.trim()) origins.add(configuredOrigin(renderExternalUrl.trim(), 'RENDER_EXTERNAL_URL'))
  return origins
}

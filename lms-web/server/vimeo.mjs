import { ApiError } from './store.mjs';
import { configuredOrigins } from './origins.mjs';

export function embedDomains(env) {
  const explicit = env.VIMEO_EMBED_DOMAINS?.trim();
  const domains = explicit ? explicit.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : [...configuredOrigins({ production: env.NODE_ENV === 'production', allowedOrigins: env.ALLOWED_ORIGINS, renderExternalUrl: env.RENDER_EXTERNAL_URL })].map(origin => new URL(origin).hostname);
  if (domains.some(d => d.length > 253 || !/^(?:localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/.test(d) || d.includes('..'))) throw new Error('VIMEO_EMBED_DOMAINS: 경로·포트 없는 도메인을 쉼표로 구분하세요.');
  const unique = [...new Set(domains)];
  if (unique.length > 50) throw new Error('Vimeo 허용 도메인은 최대 50개입니다.');
  return unique;
}

export function createVimeo(env, fetcher = fetch) {
  const token = env.VIMEO_ACCESS_TOKEN || '', domains = embedDomains(env);
  const maxBytes = Number(env.VIMEO_MAX_UPLOAD_BYTES || 5 * 1024 ** 3);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 300 * 1024 ** 3) throw new Error('VIMEO_MAX_UPLOAD_BYTES 설정을 확인하세요.');
  let verifiedUntil = 0;
  async function request(path, method = 'GET', body) {
    if (!token) throw new ApiError(503, '영상 서비스가 아직 연결되지 않았습니다. 관리자에게 문의하세요.');
    let response;
    try {
      response = await fetcher(`https://api.vimeo.com${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.vimeo.*+json;version=3.4', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new ApiError(502, 'Vimeo 연결이 지연되고 있습니다. 잠시 후 상태를 확인하세요.'); }
    if (!response.ok) {
      const message = response.status === 429 ? 'Vimeo 요청 한도에 도달했습니다. 잠시 후 다시 시도하세요.' : response.status === 401 ? 'Vimeo 인증 설정을 확인하세요.' : response.status === 403 ? 'Vimeo 토큰 권한·업로드 승인·저장 용량을 확인하세요.' : response.status === 404 ? 'Vimeo에서 영상을 찾을 수 없습니다.' : 'Vimeo 작업에 실패했습니다. 잠시 후 다시 시도하세요.';
      throw new ApiError(response.status === 429 ? 429 : 502, message);
    }
    return response.status === 204 ? null : response.json();
  }
  async function verify() {
    if (!domains.length) throw new ApiError(503, '영상 재생을 허용할 웹 도메인을 설정하세요.');
    if (Date.now() < verifiedUntil) return;
    const result = await request('/oauth/verify');
    const scopes = String(result.scope || '').split(/\s+/);
    if (['private', 'upload', 'edit'].some(scope => !scopes.includes(scope))) throw new ApiError(503, 'Vimeo 토큰에 private, upload, edit 권한이 필요합니다.');
    verifiedUntil = Date.now() + 60000;
  }
  const path = id => {
    if (!/^\d+$/.test(id)) throw new ApiError(422, '영상 번호를 확인하세요.');
    return `/videos/${id}`;
  };
  async function protect(id) {
    await verify();
    await request(path(id), 'PATCH', { privacy: { view: 'nobody', embed: 'whitelist', download: false } });
    // Remove inherited preset domains as well as adding the configured domains.
    const existing = await request(`${path(id)}/privacy/domains?per_page=100`);
    for (const entry of existing.data || []) if (!domains.includes(entry.domain)) await request(`${path(id)}/privacy/domains/${encodeURIComponent(entry.domain)}`, 'DELETE');
    for (const domain of domains) await request(`${path(id)}/privacy/domains/${encodeURIComponent(domain)}`, 'PUT');
  }
  return {
    configured: Boolean(token && domains.length), maxBytes, domains, verify,
    async create(input) {
      const result = await request('/me/videos', 'POST', { name: input.title, description: input.description, upload: { approach: 'tus', size: String(input.size) }, privacy: { view: 'nobody', embed: 'whitelist', download: false } });
      const id = result.uri?.match(/^\/videos\/(\d+)$/)?.[1];
      if (!id) throw new ApiError(502, 'Vimeo 영상 생성 결과를 확인하지 못했습니다.');
      return { id, uploadUrl: result.upload?.upload_link || '' };
    },
    protect,
    read: id => request(`${path(id)}?fields=uri,status,upload.status,transcode.status,duration,privacy`),
    async publish(id, published) {
      if (published) await protect(id);
      await request(path(id), 'PATCH', { privacy: { view: published ? 'disable' : 'nobody', embed: 'whitelist', download: false } });
    },
  };
}

export function safeUploadUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname.endsWith('.vimeo.com') && !url.username && !url.password; } catch { return false; }
}

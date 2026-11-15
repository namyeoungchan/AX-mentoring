import { ApiError } from './store.mjs';

const stages = { verify: '연결 확인', create: '업로드 준비', privacy: '재생 보호 설정', status: '영상 상태 확인', publish: '게시 설정' };

export class VimeoError extends ApiError {
  constructor(code, message, stage, upstreamStatus = null, upstreamCode = null) {
    super(upstreamStatus === 429 ? 429 : 502, `${stages[stage] || '영상 처리'}: ${message}`);
    this.details = { code, stage, upstreamStatus, upstreamCode };
  }
}

// Only fixed messages and numeric upstream codes leave the server. Never expose
// Vimeo's raw response, credentials, upload links or developer_message.
export function vimeoFailure(status, payload, stage) {
  const upstreamCode = /^\d{1,8}$/.test(String(payload?.error_code ?? '')) ? Number(payload.error_code) : null;
  const text = [payload?.error, payload?.developer_message].filter(s => typeof s === 'string').join(' ').slice(0, 4000).toLowerCase();
  let code = 'upstream_error', message = 'Vimeo 작업에 실패했습니다. 잠시 후 다시 시도하세요.';
  if (upstreamCode === 4101) { code = 'storage_limit'; message = 'Vimeo 계정의 전체 업로드·저장 한도에 도달했습니다. Vimeo에서 사용량과 계정 한도를 확인하세요.'; }
  else if (upstreamCode === 4102) { code = 'weekly_limit'; message = 'Vimeo 주간 업로드 한도에 도달했습니다. Vimeo에서 한도 초기화 시점을 확인하세요.'; }
  else if (upstreamCode === 4104) { code = 'daily_limit'; message = 'Vimeo 일간 업로드 한도에 도달했습니다. 다음 초기화 이후 다시 시도하세요.'; }
  else if (status === 401) { code = 'authentication'; message = 'Vimeo 토큰이 유효하지 않거나 만료됐습니다. 관리자에게 영상 서비스 인증 확인을 요청하세요.'; }
  else if (status === 429) { code = 'rate_limit'; message = 'Vimeo 요청 한도에 도달했습니다. 잠시 후 다시 시도하세요.'; }
  else if (status === 404 || status === 410) { code = 'not_found'; message = 'Vimeo에서 연결된 영상을 찾을 수 없습니다. 원본 삭제 여부와 계정 연결을 확인하세요.'; }
  else if (status === 403 && /scope|permission|privilege/.test(text) && !/upload access|upload permission|upload privileges/.test(text)) {
    code = 'permissions'; message = 'Vimeo 토큰에 이 작업의 권한이 없습니다. 관리자에게 토큰 권한 확인을 요청하세요.';
  } else if (status === 403 && /upload access|upload permission|upload privileges|not (?:allowed|approved|permitted) to upload/.test(text)) {
    code = 'upload_approval'; message = 'Vimeo 앱의 API 업로드가 승인되지 않았습니다. 관리자에게 앱의 Upload Access 확인을 요청하세요.';
  } else if (status === 403 && /membership|subscription|upgrade|(?:plan|account).*(?:support|feature)|premium|paid/.test(text)) {
    code = 'plan_feature'; message = '현재 Vimeo 요금제에서 이 설정을 사용할 수 없습니다. 관리자에게 계정 기능과 재생 설정 확인을 요청하세요.';
  } else if (status === 403) {
    code = 'forbidden'; message = 'Vimeo가 이 작업의 접근을 거부했습니다. 관리자에게 계정·영상 접근 권한 확인을 요청하세요. 응답만으로 정확한 원인을 확인하지 못했습니다.';
  } else if (status === 400 || status === 422) {
    code = 'invalid_request'; message = 'Vimeo가 업로드 또는 설정 정보를 받아들이지 않았습니다. 관리자에게 영상 설정 확인을 요청하세요.';
  } else if (status >= 500) { code = 'unavailable'; message = 'Vimeo 서비스가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도하세요.'; }
  return new VimeoError(code, message, stage, status, upstreamCode);
}

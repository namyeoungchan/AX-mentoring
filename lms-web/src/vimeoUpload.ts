// TUS upload URLs are scoped to one file. The Vimeo account token stays on the server.
export async function uploadVimeo(file: File, url: string, signal: AbortSignal, progress: (percent: number) => void) {
  const target = new URL(url)
  if (target.protocol !== 'https:' || !target.hostname.endsWith('.vimeo.com') || target.username || target.password) throw new Error('업로드 주소를 확인하세요.')
  const headers = { 'Tus-Resumable': '1.0.0' }
  async function offset() {
    const response = await fetch(url, { method: 'HEAD', headers, credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) })
    const value = response.headers.get('Upload-Offset'), length = response.headers.get('Upload-Length')
    if (!response.ok || value === null || !/^\d+$/.test(value) || Number(value) > file.size || length !== null && Number(length) !== file.size) throw new Error('업로드 상태를 확인하지 못했습니다. 만료된 업로드는 새로 등록하세요.')
    return Number(value)
  }
  let sent = await offset(), failures = 0
  progress(Math.floor(sent / file.size * 100))
  while (sent < file.size) {
    signal.throwIfAborted()
    const end = Math.min(sent + 8 * 1024 ** 2, file.size)
    try {
      const response = await fetch(url, { method: 'PATCH', headers: { ...headers, 'Upload-Offset': String(sent), 'Content-Type': 'application/offset+octet-stream' }, body: file.slice(sent, end), credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) })
      if (!response.ok || Number(response.headers.get('Upload-Offset')) !== end) throw new Error('전송 확인 실패')
      sent = end; failures = 0; progress(Math.floor(sent / file.size * 100))
    } catch {
      signal.throwIfAborted()
      if (++failures > 3) throw new Error('연결이 끊겼습니다. 같은 원본 파일을 선택해 이어 올릴 수 있습니다.')
      // A timed-out PATCH may have committed; recover the actual server offset.
      sent = await offset()
    }
  }
  progress(100)
}

import { useEffect, useState } from 'react'
import { Download, RotateCcw, Upload } from 'lucide-react'
import { apiDownload, apiRequest, setSessionToken } from './api'
import { CardHeading, ModalShell } from './components'

type Backup = { id: string; createdAt: string; bytes: number }
type Status = { resetEnabled: boolean; maxBackupBytes: number; backups: Backup[] }
type Preview = { token: string; createdAt: string; expiresAt: number; accounts: number; workspaces: number; databases: number }
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`
const timestamp = (value: string) => new Date(value).toLocaleString('ko-KR')

export default function DataAdministration() {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [file, setFile] = useState<File | null>(null), [preview, setPreview] = useState<Preview | null>(null)
  const [action, setAction] = useState<'reset' | 'restore' | null>(null)
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('')
  const [completed, setCompleted] = useState<'reset' | 'restore' | null>(null)
  const phrase = action === 'reset' ? '전체 데이터 초기화' : '백업으로 전체 복구'
  useEffect(() => {
    const controller = new AbortController()
    apiRequest('admin/data', { signal: controller.signal }).then(setStatus).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [])
  async function download(id?: string) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const blob = await apiDownload(id ? `admin/data/backups/${encodeURIComponent(id)}` : 'admin/data/backup')
      const url = URL.createObjectURL(blob), link = document.createElement('a')
      link.href = url; link.download = id || `learningops-${new Date().toISOString().slice(0, 10)}.axbackup`
      document.body.append(link); link.click(); link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60000)
      setNotice('백업 파일 다운로드를 시작했습니다. 계정과 학습 기록이 포함되므로 안전한 곳에 보관하세요.')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function inspect() {
    if (!file || !status || busy) return
    setBusy(true); setError(''); setNotice(''); setPreview(null)
    try {
      if (file.size > status.maxBackupBytes) throw new Error('백업 파일은 최대 32MB까지 지원합니다.')
      const encoded = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1])
        reader.onerror = () => reject(new Error('파일을 읽지 못했습니다. 다시 선택하세요.'))
        reader.readAsDataURL(file)
      })
      setPreview(await apiRequest('admin/data/preview', { method: 'POST', body: JSON.stringify({ backup: encoded }), signal: AbortSignal.timeout(120000) }))
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  function choose(next: 'reset' | 'restore') { setPassword(''); setConfirmation(''); setError(''); setAction(next) }
  async function replace() {
    if (!action || busy || confirmation !== phrase || !password) return
    setBusy(true); setError('')
    try {
      await apiRequest(`admin/data/${action}`, { method: 'POST', body: JSON.stringify({ confirmation, currentPassword: password, token: preview?.token }), signal: AbortSignal.timeout(120000) })
      setSessionToken(''); setCompleted(action); setAction(null); setPassword('')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  if (completed) return <section className="panel data-admin-card" role="status">
    <h2>{completed === 'reset' ? '데이터 초기화 완료' : '백업 복구 완료'}</h2>
    <p>{completed === 'reset' ? '기존 계정과 운영 데이터를 초기화했습니다. 최초 관리자 등록부터 다시 시작하세요.' : '백업 시점의 계정과 운영 데이터를 복구했습니다. 복구된 계정으로 다시 로그인하세요.'}</p>
    <p>작업 직전의 자동 백업은 총관리자로 로그인한 뒤 이 화면에서 다운로드할 수 있습니다.</p>
    <button className="button primary" onClick={() => { location.hash = 'dashboard'; location.reload() }}>로그인 화면으로 이동</button>
  </section>
  return <div className="data-administration" aria-busy={busy}>
    <div className="inline-note"><div><strong>전체 서비스 데이터 관리 · 총관리자 전용</strong><p>현재 접속한 서버의 모든 계정, 워크스페이스, 학습 기록과 저장된 Discord 연결 설정을 관리합니다. 다른 서버의 DB와 Discord 채널·메시지, 외부 첨부파일, 서버의 비밀키는 포함하지 않습니다.</p></div></div>
    {error && !action && <p className="inline-note error-note" role="alert">{error}</p>}
    {notice && <p className="inline-note" role="status">{notice}</p>}
    {!status && !error && <p role="status">데이터 관리 정보를 불러오는 중…</p>}
    <div className="data-admin-grid">
      <section className="panel data-admin-card"><CardHeading title="백업 다운로드" subtitle="공통 DB와 모든 워크스페이스를 하나의 파일로 보관합니다." />
        <p>계정 정보와 비밀번호 해시가 포함됩니다. 백업을 공유하지 말고 안전한 곳에 보관하세요.</p>
        <button className="button primary" disabled={busy || !status} onClick={() => void download()}><Download size={17} />전체 백업 다운로드</button>
      </section>
      <section className="panel data-admin-card"><CardHeading title="백업 파일 복구" subtitle="현재 데이터를 백업 시점의 데이터로 교체합니다." />
        <label>복구할 백업 파일<input type="file" accept=".axbackup" disabled={busy || !status} onChange={e => { setFile(e.target.files?.[0] || null); setPreview(null); setError('') }} /></label>
        <p>이 화면에서 받은 .axbackup 파일 · 최대 32MB</p>
        <button className="button secondary" disabled={busy || !file} onClick={() => void inspect()}><Upload size={17} />백업 파일 검증</button>
        {preview && <div className="data-backup-preview" role="status"><strong>복구 파일 검증 완료</strong><dl><div><dt>백업 시각</dt><dd>{timestamp(preview.createdAt)}</dd></div><div><dt>계정</dt><dd>{preview.accounts}개</dd></div><div><dt>워크스페이스</dt><dd>{preview.workspaces}개</dd></div></dl><p>검증 결과는 10분간 유효합니다. 모든 로그인 세션은 만료되며 대기 중인 알림과 초대 발급 작업은 취소됩니다.</p><button className="button primary" disabled={busy} onClick={() => choose('restore')}>이 백업으로 복구</button></div>}
      </section>
      <section className="panel data-admin-card data-admin-danger"><CardHeading title="전체 데이터 초기화" subtitle="총관리자를 포함한 모든 계정과 운영 데이터를 삭제합니다." />
        <p>초기화 후 기본 워크스페이스만 생성됩니다. 서버의 최초 관리자 설정 키로 새 관리자를 등록해야 합니다.</p>
        <p>웹과 봇의 저장 요청이 잠시 중단됩니다. 작업 직전 자동 백업을 서버에 남깁니다.</p>
        {status && !status.resetEnabled && <p role="status">최초 관리자 설정 키가 준비되지 않아 초기화할 수 없습니다. 서버 운영자에게 설정을 요청하세요.</p>}
        <button className="button secondary" disabled={busy || !status?.resetEnabled} onClick={() => choose('reset')}><RotateCcw size={17} />전체 데이터 초기화</button>
      </section>
    </div>
    <section className="panel data-admin-card"><CardHeading title="작업 전 자동 백업" subtitle="초기화·복구 직전의 데이터를 다시 다운로드할 수 있습니다." />
      {status?.backups.length ? <ul className="data-backup-list">{status.backups.map(backup => <li key={backup.id}><span>{timestamp(backup.createdAt)}<small>{size(backup.bytes)}</small></span><button className="button secondary" disabled={busy} onClick={() => void download(backup.id)}>다운로드<span className="sr-only"> {timestamp(backup.createdAt)}</span></button></li>)}</ul> : <p>아직 자동 백업이 없습니다.</p>}
    </section>
    {busy && <p role="status">데이터 작업 중입니다. 완료될 때까지 이 화면을 유지하세요.</p>}
    {action && <ModalShell busy={busy} title={action === 'reset' ? '전체 데이터 초기화 확인' : '백업 복구 확인'} close={() => { if (!busy) setAction(null) }}><form className="modal-form" onSubmit={e => { e.preventDefault(); void replace() }}><fieldset disabled={busy}>
      <p>{action === 'reset' ? '모든 계정과 학습 기록을 삭제하고 로그아웃합니다. 최초 관리자 설정 키를 준비했는지 확인하세요.' : '현재 데이터를 검증한 백업으로 교체하고 로그아웃합니다. 복구된 계정의 로그인 정보를 준비하세요.'}</p>
      <p>작업 전 전체 자동 백업을 생성합니다.</p>
      {error && <p role="alert" className="error-text">{error}</p>}
      <label>현재 총관리자 비밀번호<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required maxLength={128} /></label>
      <label>확인 문구: {phrase}<input value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off" required /></label>
      <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setAction(null)}>취소</button><button className="button primary" type="submit" disabled={confirmation !== phrase || !password}>{busy ? '처리 중…' : action === 'reset' ? '초기화 실행' : '복구 실행'}</button></div>
    </fieldset></form></ModalShell>}
  </div>
}

import { useRef, useState } from 'react'
import { ArrowDownToLine, Copy, Upload } from 'lucide-react'
import { staffCsv, staffExport, staffRoles, staffRows, type StaffRow } from '../shared/staff-import.mjs'
import { demoMode, workspaceRequest } from './api'
import { CardHeading } from './components'
import type { RenewedInvitations } from './invitationLinks'

type Row = StaffRow & { teamIds: string[]; selected: boolean; teamWarning: string }
type Preview = { valid: boolean; rows: { row: number; errors: string[] }[] }
type Result = { row: number; id?: string; username: string; name?: string; token?: string; initialPassword?: string; expiresAt?: number; error?: string }
type Team = { id: string; name: string }
const mapping = (category: string) => Object.hasOwn(staffRoles, category) ? staffRoles[category] : undefined
function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export default function StaffAccountImport({ workspaceId, workspaceName, teams, platformAdmin, refreshed, openSetup, renewed = {} }: { workspaceId: string; workspaceName: string; teams: Team[]; platformAdmin: boolean; refreshed: () => Promise<void>; openSetup: () => void; renewed?: RenewedInvitations }) {
  const input = useRef<HTMLInputElement>(null), locked = useRef(false)
  const [rows, setRows] = useState<Row[]>([]), [preview, setPreview] = useState<Preview | null>(null)
  const [originalResults, setResults] = useState<Result[]>([]), [busy, setBusy] = useState(false), [filename, setFilename] = useState('')
  const results = originalResults.map(result => result.id && renewed[result.id] ? { ...result, ...renewed[result.id] } : result)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const issued = (row: Row) => results.find(r => r.row === row.row && r.token)
  const pending = rows.filter(row => row.selected && !issued(row))
  const payload = () => ({ rows: pending.map(({ row, category, name, username, teamIds }) => ({ row, category, name, username, teamIds })) })
  function change(rowNumber: number, changes: Partial<Row>) { setRows(list => list.map(row => row.row === rowNumber ? { ...row, ...changes } : row)); setPreview(null); setError(''); setNotice('') }
  async function upload(file?: File) {
    if (!file || locked.current) return
    locked.current = true; setBusy(true); setError(''); setNotice(''); setPreview(null); setRows([]); setResults([]); setFilename(file.name)
    try {
      if (file.size > 2 * 1024 * 1024 || !/\.(xlsx|csv)$/i.test(file.name)) throw new Error('2MB 이하의 .xlsx 또는 .csv 파일을 선택하세요.')
      let sheet: unknown[][]
      if (/\.csv$/i.test(file.name)) {
        const bytes = await file.arrayBuffer()
        let text: string
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { text = new TextDecoder('euc-kr').decode(bytes) }
        sheet = staffCsv(text)
      } else { const { readSheet } = await import('read-excel-file/browser'); sheet = await readSheet(file) }
      setRows(staffRows(sheet).map(row => {
        const matches = row.teamNames.map(name => teams.filter(t => t.name === name))
        return { ...row, selected: true, teamIds: [...new Set(matches.filter(found => found.length === 1).map(found => found[0].id))], teamWarning: matches.some(found => found.length !== 1) ? '파일의 담당 조를 찾을 수 없거나 이름이 중복됩니다. 아래에서 다시 선택하세요.' : '' }
      }))
    } catch (e) { setError((e as Error).message) } finally { locked.current = false; setBusy(false) }
  }
  async function validate() {
    if (!pending.length || locked.current) return
    locked.current = true; setBusy(true); setError(''); setNotice('')
    try { setPreview(await workspaceRequest(workspaceId, 'staff-import/preview', { method: 'POST', body: JSON.stringify(payload()) })) }
    catch (e) { setError((e as Error).message) } finally { locked.current = false; setBusy(false) }
  }
  async function issue() {
    if (!preview?.valid || !pending.length || locked.current || pending.some(row => row.teamWarning && mapping(row.category)?.mentorType === 'group')) return
    locked.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const response: { results: Result[] } = await workspaceRequest(workspaceId, 'staff-import', { method: 'POST', body: JSON.stringify(payload()), signal: AbortSignal.timeout(120000) })
      setResults(current => [...current.filter(old => !response.results.some(value => value.row === old.row)), ...response.results]); setPreview(null)
      setNotice(`계정 ${response.results.filter(r => r.token).length}개 발급 완료 · 실패 ${response.results.filter(r => r.error).length}개. 발급 결과를 다운로드하고 각 사람에게 해당 안내문을 전달하세요.`)
      await refreshed()
    } catch (e) { setPreview(null); setError(`${(e as Error).message} 응답을 받지 못했다면 다시 검증하여 발급 여부를 확인하세요. 이미 생성된 계정의 비밀번호는 전체 계정 관리에서 재발급할 수 있습니다.`) }
    finally { locked.current = false; setBusy(false) }
  }
  function delivery(row: Row, result: Result) {
    const url = new URL(location.href); url.search = ''; url.hash = `invite=${result.token}`
    return { url: url.href, text: [`[${workspaceName}] ${row.name}님 초대`, `역할: ${mapping(row.category)?.label}`, ...(row.teamIds.length ? [`담당 조: ${teams.filter(t => row.teamIds.includes(t.id)).map(t => t.name).join(', ')}`] : []), `초대 링크: ${url.href}`, `아이디: ${row.username}`, `초기 비밀번호: ${result.initialPassword}`, '', '1. 초대 링크를 열고 초기 비밀번호로 로그인하세요.', '2. 본인 비밀번호로 변경한 뒤 초대 수락을 누르세요.', '3. 화면 안내에 따라 기본 정보와 Discord 연결을 완료하세요.', `만료: ${new Date(result.expiresAt!).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (한국 시간)`].join('\n') }
  }
  function exportResults() {
    download(staffExport([['구분', '이름', '연락처', '이메일', '아이디', '역할', '담당 조', '결과', '초기 비밀번호', '초대 링크', '전달할 안내문'], ...rows.map(row => {
      const result = results.find(r => r.row === row.row), invitation = result?.token ? delivery(row, result) : null
      return [row.category, row.name, row.phone, row.email, row.username, mapping(row.category)?.label || '', teams.filter(t => row.teamIds.includes(t.id)).map(t => t.name).join(', '), result?.token ? '발급 완료' : result?.error || '미발급', result?.initialPassword || '', invitation?.url || '', invitation?.text || '']
    })]), '구성원-계정발급-결과.csv')
  }
  return <section className="panel staff-import" aria-label="구성원 엑셀 일괄 등록">
    <CardHeading title="엑셀로 구성원 초대" subtitle={`${workspaceName} · 명단 확인 → 담당 조 선택 → 계정 발급 → 안내문 전달`} />
    <div className="staff-import-body">
      <p>첫 행은 <strong>구분 · 이름 · 연락처 · 이메일 · 아이디</strong>로 작성하세요. 연락처·이메일은 비워도 됩니다. 구분이 비어 있거나 병합된 행은 위 구분을 이어받습니다.</p>
      <ul className="staff-import-mapping"><li>PM·강의 <strong>메인 강사</strong></li><li>기술멘토 <strong>조 담당 멘토</strong></li><li>자문/운영 <strong>워크스페이스 관리자</strong></li></ul>
      {!platformAdmin && <p className="inline-note">자문/운영은 총관리자만 발급할 수 있습니다. 해당 행을 제외하고 멘토 계정만 발급하거나 총관리자에게 요청하세요.</p>}
      <div className="assignment-action-group"><a className="button secondary" href={`${import.meta.env.BASE_URL}templates/staff-accounts-template.xlsx`} download="구성원-계정발급-양식.xlsx"><ArrowDownToLine size={16} />엑셀 양식 다운로드</a><button className="button secondary" disabled={busy || demoMode || results.some(r => r.token)} onClick={() => input.current?.click()}><Upload size={16} />{busy ? '처리 중…' : '엑셀·CSV 선택'}</button></div>
      <input ref={input} type="file" hidden accept=".xlsx,.csv" aria-label="구성원 명단 파일" disabled={busy || demoMode || results.some(r => r.token)} onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }} />
      <p className="staff-import-note">최대 50명 · xlsx는 첫 번째 시트를 읽습니다. 연락처·이메일은 전달용 결과 파일에만 포함되며 계정에 저장하거나 메시지를 자동 발송하지 않습니다.</p>
      {error && <p className="inline-note error-note" role="alert">{error}</p>}
      {notice && <p className="inline-note" role="status">{notice}</p>}
      {rows.length > 0 && <><h3>명단 미리보기 · {filename}</h3><p>발급 대상 {pending.length}명 · 발급 완료 {results.filter(r => r.token).length}명. 수정이 필요한 행은 체크를 해제하고 나머지를 발급할 수 있습니다.</p>
        {rows.some(row => mapping(row.category)?.mentorType === 'group') && !teams.length && <p className="inline-note">기술멘토를 배정할 조가 없습니다. <button className="text-button" onClick={openSetup} disabled={busy}>조 구성 화면 열기</button></p>}
        <div className="table-scroll"><table><thead><tr><th>발급</th><th>행 · 구분</th><th>이름 · 아이디</th><th>연락처 · 이메일</th><th>초대 역할 · 담당 조</th><th>확인 결과</th></tr></thead><tbody>{rows.map(row => {
          const role = mapping(row.category), result = results.find(r => r.row === row.row), messages = preview?.rows.find(p => p.row === row.row)?.errors || []
          return <tr key={row.row}><td><input type="checkbox" aria-label={`${row.name || row.row} 발급 대상`} checked={row.selected} disabled={busy || Boolean(issued(row))} onChange={e => change(row.row, { selected: e.target.checked })} /></td><td>{row.row}행<small>{row.category || '구분 없음'}</small></td><td>{row.name || '이름 없음'}<small>{row.username || '아이디 없음'}</small></td><td>{row.phone || '—'}<small>{row.email || '—'}</small></td><td>{role?.label || '구분 확인 필요'}{role?.mentorType === 'group' && <fieldset className="staff-import-teams" disabled={busy || Boolean(issued(row)) || !row.selected}><legend>{row.name} 담당 조</legend>{teams.map(team => <label key={team.id}><input type="checkbox" checked={row.teamIds.includes(team.id)} onChange={e => change(row.row, { teamWarning: '', teamIds: e.target.checked ? [...row.teamIds, team.id] : row.teamIds.filter(id => id !== team.id) })} />{team.name}</label>)}</fieldset>}</td><td>{result?.token ? <><strong>발급 완료</strong><button className="text-button" onClick={async () => { try { await navigator.clipboard.writeText(delivery(row, result).text); setNotice(`${row.name}님의 안내문을 복사했습니다.`) } catch { setError('복사가 허용되지 않습니다. 발급 결과 CSV를 다운로드해 안내문을 확인하세요.') } }}><Copy size={14} />{row.name} 안내문 복사</button></> : <>{row.selected ? <>{row.teamWarning && <p className="error-text">{row.teamWarning}</p>}{messages.map(message => <p className="error-text" key={message}>{message}</p>)}{result?.error && <p className="error-text">{result.error}</p>}{!messages.length && (preview ? '발급 가능' : '검증 대기')}</> : '발급 제외'}</>}</td></tr>
        })}</tbody></table></div>
        <div className="staff-import-actions"><button className="button secondary" disabled={busy || !pending.length || demoMode} onClick={() => void validate()}>명단 검증</button><button className="button primary" disabled={busy || !preview?.valid || !pending.length || demoMode || pending.some(row => row.teamWarning && mapping(row.category)?.mentorType === 'group')} onClick={() => void issue()}>{busy ? '처리 중…' : `확인 · ${pending.length}명 계정 발급`}</button>{results.some(r => r.token) && <button className="button secondary" disabled={busy} onClick={exportResults}><ArrowDownToLine size={16} />발급 결과 CSV 다운로드</button>}</div>
        <p className="staff-import-note">초기 비밀번호와 초대 링크는 발급 결과에 한 번 표시됩니다. 화면을 떠나기 전에 결과를 다운로드하고 각 사람에게 해당 안내문만 전달하세요. 비밀번호는 서버에 해시로만 저장됩니다.</p>
        {results.some(r => r.token) && <button className="text-button" disabled={busy} onClick={() => { exportResults(); setRows([]); setResults([]); setPreview(null); setNotice(''); setError('') }}>결과 다운로드하고 다음 파일 등록</button>}
      </>}
    </div>
  </section>
}

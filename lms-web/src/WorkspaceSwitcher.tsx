import { useState, type FormEvent } from 'react'
import { Archive, ArchiveRestore, Check, ChevronDown, GraduationCap, Plus } from 'lucide-react'
import { ModalShell } from './components'
import { demoMode } from './api'
import type { WorkspaceInput, WorkspaceMetadata } from './demoWorkspaces'

type Props = {
  workspaces: WorkspaceMetadata[]; activeId: string
  selectWorkspace: (id: string) => Promise<void>
  createWorkspace?: (input: WorkspaceInput) => Promise<boolean>
  setWorkspaceArchived?: (id: string, archived: boolean) => Promise<boolean>
  saving?: boolean; error?: string
}
export default function WorkspaceSwitcher({ workspaces, activeId, selectWorkspace, createWorkspace, setWorkspaceArchived, saving, error }: Props) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [archiving, setArchiving] = useState<WorkspaceMetadata | null>(null)
  const current = workspaces.find(w => w.id === activeId)
  const activeWorkspaces = workspaces.filter(w => w.archivedAt == null)
  const archivedWorkspaces = workspaces.filter(w => w.archivedAt != null)
  const canManage = (w: WorkspaceMetadata) => Boolean(setWorkspaceArchived && (demoMode || w.role === 'admin'))
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    if (await createWorkspace?.({ name: String(form.get('name')).trim().normalize('NFKC'), description: String(form.get('description')).trim(), guildId: String(form.get('guildId')).trim() })) setCreating(false)
  }
  return <div className="workspace-switcher" onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}>
    <button className="workspace-selector" aria-label="워크스페이스 선택" aria-expanded={open} disabled={saving} onClick={() => { setOpen(!open); setShowArchived(false) }}>
      <span className="workspace-icon"><GraduationCap size={20} /></span>
      <span><strong>{current?.name || '워크스페이스 없음'}</strong><small>{current?.archivedAt != null ? '보관됨 · ' : ''}워크스페이스 {activeWorkspaces.length}개</small></span><ChevronDown size={15} />
    </button>
    {createWorkspace && <button className="workspace-new-button" disabled={saving} onClick={() => { setOpen(false); setCreating(true) }}><Plus size={16} />워크스페이스 만들기</button>}
    {open && <>
      <button className="workspace-dismiss" aria-label="워크스페이스 목록 닫기" onClick={() => setOpen(false)} />
      <div className="workspace-menu" aria-label="워크스페이스 목록">
        <div className="workspace-tabs" aria-label="워크스페이스 분류">
          <button aria-pressed={!showArchived} onClick={() => setShowArchived(false)}>운영 중 ({activeWorkspaces.length})</button>
          <button aria-pressed={showArchived} onClick={() => setShowArchived(true)}>보관함 ({archivedWorkspaces.length})</button>
        </div>
        {(showArchived ? archivedWorkspaces : activeWorkspaces).map(w => <div className="workspace-option" key={w.id}>
          <button disabled={saving} className={w.id === activeId ? 'selected' : ''} onClick={() => { setOpen(false); void selectWorkspace(w.id) }}>
            <span>{w.name}<small>{w.archivedAt != null ? `보관일 ${new Date(w.archivedAt).toLocaleDateString('ko-KR')}` : w.description || '학습 운영'}</small></span>
            {w.id === activeId && <Check size={16} />}
          </button>
          {showArchived && canManage(w) && <button className="workspace-restore" aria-label={`${w.name} 복원`} disabled={saving} onClick={async () => { if (await setWorkspaceArchived?.(w.id, false)) { setShowArchived(false); if (!activeId) await selectWorkspace(w.id) } }}><ArchiveRestore size={16} />복원</button>}
        </div>)}
        {!(showArchived ? archivedWorkspaces : activeWorkspaces).length && <p>{showArchived ? '보관된 워크스페이스가 없습니다.' : '운영 중인 워크스페이스가 없습니다.'}</p>}
        {error && <p role="alert" className="error-text">{error}</p>}
        {current && canManage(current) && current.archivedAt == null && <button className="workspace-create" disabled={saving} onClick={() => { setOpen(false); setArchiving(current) }}><Archive size={17} />현재 워크스페이스 보관</button>}
        {createWorkspace && <button className="workspace-create" disabled={saving} onClick={() => { setOpen(false); setCreating(true) }}><Plus size={17} />새 워크스페이스</button>}
      </div>
    </>}
    {current?.archivedAt != null && <p className="workspace-archive-notice">보관된 워크스페이스입니다. 데이터와 Discord 연동은 유지됩니다.</p>}
    {archiving && <ModalShell title="워크스페이스 보관" close={() => { if (!saving) setArchiving(null) }}>
      <div className="modal-form"><p><strong>{archiving.name}</strong>을 보관함으로 옮깁니다. 모든 구성원의 운영 목록에서 숨겨지며, 보관함에서 다시 열 수 있습니다. 데이터와 Discord 연동은 유지되고 관리자는 언제든 복원할 수 있습니다.</p>
        {error && <p className="inline-note error-note" role="alert">{error}</p>}
        <div className="modal-actions"><button className="button secondary" disabled={saving} onClick={() => setArchiving(null)}>취소</button><button className="button primary" disabled={saving} onClick={async () => { if (await setWorkspaceArchived?.(archiving.id, true)) { setArchiving(null); setShowArchived(true); setOpen(true) } }}>{saving ? '보관 중…' : '보관하기'}</button></div>
      </div>
    </ModalShell>}
    {creating && <ModalShell title="워크스페이스 만들기" busy={saving} close={() => { if (!saving) setCreating(false) }}><form className="modal-form workspace-create-form" onSubmit={submit}><fieldset disabled={saving}>
      <p className="workspace-create-intro">함께 운영할 과정과 사람들을 모아두는 공간입니다.<br />지금은 이름만 정하면 됩니다.</p>
      {error && <p className="inline-note error-note" role="alert">{error}</p>}
      <label>워크스페이스 이름<input name="name" required maxLength={60} pattern=".*\S.*" placeholder="예: 세종 AX 3기" autoFocus /><small>멘토와 수강생에게 표시되는 이름입니다.</small></label>
      <label>설명<textarea name="description" maxLength={300} placeholder="선택 · 어떤 교육을 위한 공간인지 적어주세요" rows={2} /></label>
      <details className="workspace-optional"><summary>Discord 서버도 지금 연결할까요? <span>선택</span></summary><p>서버가 준비되지 않았다면 비워 두세요. 생성 후 ‘봇 · 서버 관리’에서 조 구성과 서버 연결을 안내합니다.</p><label>Discord 서버 ID<input name="guildId" pattern="[0-9]{17,20}" placeholder="17~20자리 서버 ID" /><small>입력하면 기본 채널과 역할의 자동 구축을 준비합니다.</small></label></details>
      <div className="workspace-after-create"><strong>만든 다음에는</strong><p>대시보드의 ‘워크스페이스 시작하기’에서 조를 구성하고 멘토를 초대할 수 있습니다. 혼자 운영한다면 관리자 초대는 건너뛰세요.</p></div>
      <div className="modal-actions"><button type="button" className="button secondary" disabled={saving} onClick={() => setCreating(false)}>취소</button><button className="button primary" type="submit">{saving ? '만드는 중…' : '워크스페이스 만들기'}</button></div>
    </fieldset></form></ModalShell>}
  </div>
}

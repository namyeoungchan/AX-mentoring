import { useState, type FormEvent } from 'react'
import { Check, ChevronDown, GraduationCap, Plus } from 'lucide-react'
import { ModalShell } from './components'
import type { WorkspaceInput, WorkspaceMetadata } from './demoWorkspaces'

type Props = { workspaces: WorkspaceMetadata[]; activeId: string; selectWorkspace: (id: string) => Promise<void>; createWorkspace?: (input: WorkspaceInput) => Promise<boolean>; saving?: boolean; error?: string }
export default function WorkspaceSwitcher({ workspaces, activeId, selectWorkspace, createWorkspace, saving, error }: Props) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    if (await createWorkspace?.({ name: String(form.get('name')).trim().normalize('NFKC'), description: String(form.get('description')).trim(), guildId: String(form.get('guildId')).trim() })) setCreating(false)
  }
  return <div className="workspace-switcher" onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}>
    <button className="workspace-selector" aria-label="워크스페이스 선택" aria-expanded={open} disabled={saving} onClick={() => setOpen(!open)}><span className="workspace-icon"><GraduationCap size={20} /></span><span><strong>{workspaces.find(w => w.id === activeId)?.name || '워크스페이스 없음'}</strong><small>워크스페이스 {workspaces.length}개</small></span><ChevronDown size={15} /></button>
    {open && <><button className="workspace-dismiss" aria-label="워크스페이스 목록 닫기" onClick={() => setOpen(false)} /><div className="workspace-menu" aria-label="워크스페이스 목록"><p>워크스페이스</p>{workspaces.map(w => <button key={w.id} className={w.id === activeId ? 'selected' : ''} onClick={() => { setOpen(false); void selectWorkspace(w.id) }}><span>{w.name}<small>{w.description || '학습 운영'}</small></span>{w.id === activeId && <Check size={16} />}</button>)}{createWorkspace && <button className="workspace-create" onClick={() => { setOpen(false); setCreating(true) }}><Plus size={17} />새 워크스페이스</button>}</div></>}
    {creating && <ModalShell title="워크스페이스 만들기" close={() => { if (!saving) setCreating(false) }}><form className="modal-form" onSubmit={submit}><fieldset disabled={saving}>{error && <p className="inline-note error-note" role="alert">{error}</p>}<label>워크스페이스 이름<input name="name" required maxLength={60} pattern=".*\S.*" placeholder="예: 세종 AX" autoFocus /></label><label>설명<textarea name="description" maxLength={300} placeholder="선택 입력" /></label><label>Discord 서버 ID<input name="guildId" pattern="[0-9]{17,20}" placeholder="선택 입력 · 입력하면 기본 구성 자동 구축" /></label><div className="modal-actions"><button type="button" className="button secondary" onClick={() => setCreating(false)}>취소</button><button className="button primary" type="submit">{saving ? '만드는 중…' : '워크스페이스 만들기'}</button></div></fieldset></form></ModalShell>}
  </div>
}

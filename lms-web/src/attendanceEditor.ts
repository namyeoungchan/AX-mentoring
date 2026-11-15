export type Row = { checkInAt?: number | null; checkOutAt?: number | null; checkInSource?: string; checkOutSource?: string; studentId: string; name: string; team: string; enrollment: string; status: string; reason: string }
export type History = { actor: string; time: string; before: Row | null; after: Row }
export type Roster = { session: { endedAt: number | null } | null; courseId: string; date: string; period: number; state: string; revision: string; canManage: boolean; rows: Row[]; counts: Record<string, number>; history: History[] }
export type Draft = Record<string, { status: string; reason: string }>
export type Conflict = { before?: Row; latest?: Row; mine: Draft[string] }
export type SavedEditor = { roster: Roster; draft: Draft; reason: string; conflicts: Record<string, Conflict> }

// Temporary edits stay in this tab's memory, scoped to the authenticated user.
// They survive internal navigation, but are cleared on logout/account changes.
let owner = ''
const editors = new Map<string, SavedEditor>()
const selections = new Map<string, { courseId: string; date: string; period: number }>()
export function setAttendanceEditorOwner(id: string) {
  if (owner === id) return
  owner = id; editors.clear(); selections.clear()
}
export const editorKey = (workspaceId: string, courseId: string, date: string, period: number) => JSON.stringify([workspaceId, courseId, date, period])
export const readEditor = (key: string) => editors.get(key)
export function rememberEditor(key: string, value: SavedEditor) {
  if (Object.keys(value.draft).length || value.reason) editors.set(key, value)
  else editors.delete(key)
}
export const readAttendanceSelection = (workspaceId: string) => selections.get(workspaceId)
export const rememberAttendanceSelection = (workspaceId: string, selected: { courseId: string; date: string; period: number }) => selections.set(workspaceId, selected)

export function reconcileDraft(before: Roster, latest: Roster, draft: Draft, previousConflicts: Record<string, Conflict> = {}) {
  const next: Draft = {}, conflicts: Record<string, Conflict> = {}
  for (const [id, mine] of Object.entries(draft)) {
    const original = before.rows.find(row => row.studentId === id)
    const current = latest.rows.find(row => row.studentId === id)
    if (current?.status === mine.status && current.reason === mine.reason) continue
    next[id] = mine
    const changed = !original || !current || ['status', 'reason', 'checkInAt', 'checkOutAt'].some(key => original[key as keyof Row] !== current[key as keyof Row])
    if (changed || previousConflicts[id]) conflicts[id] = { before: previousConflicts[id]?.before || original, latest: current, mine }
  }
  return { draft: next, conflicts }
}

export type RosterRow = { row: number; studentId: string; status: string; team: string; name: string; email: string; phone: string; school: string; department: string }
export function rosterRows(sheet: unknown[][]): RosterRow[]
export function normalizeRoster(rows: unknown[]): { participants: (RosterRow & { username: string })[]; excluded: RosterRow[]; failed: (RosterRow & { error: string })[]; teams: string[] }

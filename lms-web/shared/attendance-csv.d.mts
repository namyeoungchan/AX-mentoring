type Selection = { courseId: string; date: string; period: number }
type Entry = { studentId: string; status: string; reason: string }
export function exportAttendance(selection: Selection, rows: (Entry & { name: string; team: string; checkInAt?: number | null; checkOutAt?: number | null })[]): string
export function importAttendance(source: string, selection: Selection, allowedIds: string[]): Entry[]

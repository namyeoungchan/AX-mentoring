export type StaffRow = { row: number; category: string; name: string; username: string; phone: string; email: string; teamNames: string[] }
export const staffRoles: Record<string, { role: 'admin' | 'instructor'; mentorType: 'main' | 'group'; label: string }>
export function staffCsv(text: string): unknown[][]
export function staffRows(sheet: unknown[][]): StaffRow[]
export function staffExport(rows: unknown[][]): string

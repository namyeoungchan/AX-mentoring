import type { CourseSession } from '../src/data'
type Session = Omit<CourseSession, 'id'>
export type ScheduleImport = { year: number; entries: { row: number; title: string; status: string; message: string; session: Session | null }[]; sessions: Session[]; startDate: string; endDate: string; weeks: number }
export function scheduleYear(sheet: unknown[][], fallback: number): number
export function parseCourseSchedule(sheet: unknown[][], year: number): ScheduleImport

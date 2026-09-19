import { z } from 'zod';

const time = z.union([z.literal(''), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)]);
export const courseSchedule = z.array(z.object({
    id: z.string().min(1).max(100), week: z.number().int().min(1).max(52),
    title: z.string().trim().min(1).max(120), date: z.string().date(),
    startTime: time, endTime: time, notes: z.string().trim().max(1000),
}).strict().refine(s => (!s.startTime && !s.endTime) || (s.startTime && s.endTime && s.startTime < s.endTime), '시작·종료 시간을 함께 입력하고 종료 시간을 더 늦게 지정하세요.')).max(104)
    .refine(rows => new Set(rows.map(r => r.id)).size === rows.length, '중복된 일정입니다.');
export function validCourseSchedule(c) {
    return (c.schedule || []).every(s => s.date >= c.startDate && s.date <= c.endDate && s.week <= Number.parseInt(c.weeks));
}

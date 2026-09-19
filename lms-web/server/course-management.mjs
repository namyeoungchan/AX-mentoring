import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './store.mjs';
import { courseSchedule, validCourseSchedule } from './course-schedule.mjs';

const editable = z.object({
    status: z.enum(['진행 중', '모집 중', '종료']).optional(),
    startDate: z.string().date().optional(), endDate: z.string().date().optional(),
    weeks: z.string().regex(/^(?:[1-9]|[1-4]\d|5[0-2])주 과정$/).optional(),
    schedule: courseSchedule.optional(),
}).strict().refine(v => Object.keys(v).length > 0);
const fingerprint = raw => createHash('sha256').update(raw).digest('hex');
export function createCourseManagement(workspaces) {
    async function context(id, user) {
        await workspaces.requireRole(id, user, ['admin']);
        return (await workspaces.open(id)).db;
    }
    async function record(db, courseId) {
        const row = await db.prepare("SELECT data FROM lms_records WHERE kind='courses' AND id=?").get(courseId);
        if (!row) throw new ApiError(404, '과정을 찾을 수 없습니다.');
        return row.data;
    }
    async function read(id, courseId, user) {
        const db = await context(id, user), raw = await record(db, courseId);
        return { course: JSON.parse(raw), revision: fingerprint(raw) };
    }
    async function update(id, courseId, body, user) {
        const db = await context(id, user);
        if ((await workspaces.metadata(id)).archivedAt !== null) throw new ApiError(409, '보관된 워크스페이스입니다.');
        const { revision, changes } = z.object({ revision: z.string().length(64), changes: editable }).strict().parse(body);
        await db.exec('BEGIN IMMEDIATE');
        try {
            const raw = await record(db, courseId), before = JSON.parse(raw);
            if (revision !== fingerprint(raw)) throw new ApiError(409, '다른 관리자가 이 과정을 수정했습니다. 입력 내용은 유지됩니다. 최신 과정을 불러와 확인하세요.');
            const next = { ...before, ...changes };
            if (next.startDate > next.endDate) throw new ApiError(422, '종료일은 시작일 이후여야 합니다.');
            if (!validCourseSchedule(next)) throw new ApiError(422, '주차별 일정의 날짜와 주차는 과정 운영 기간 안에 있어야 합니다.');
            const after = JSON.stringify(next);
            // Compare the actual course record, never unrelated submissions or bot audit rows.
            const saved = await db.prepare("UPDATE lms_records SET data=? WHERE kind='courses' AND id=? AND data=?").run(after, courseId, raw);
            if (saved.changes !== 1) throw new ApiError(409, '다른 관리자가 이 과정을 수정했습니다. 최신 과정을 불러와 확인하세요.');
            await db.prepare('INSERT INTO lms_audit(actor,action,target,before_json,after_json) VALUES(?,?,?,?,?)').run(user.username || user.id, 'courses.update', courseId, raw, after);
            await db.exec('COMMIT');
            return { course: next, revision: fingerprint(after) };
        } catch (e) { await db.exec('ROLLBACK'); throw e; }
    }
    return { read, update };
}

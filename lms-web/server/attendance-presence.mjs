import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './store.mjs';
import { studentEnrollment } from './student.mjs';
import { workspaceForGuild, workspaceVerified } from './workspace-verification.mjs';

const selection = z.object({ courseId: z.string().min(1).max(200), date: z.string().date(), period: z.number().int().min(1).max(100) });
const input = selection.extend({ action: z.enum(['in', 'out']) }).strict();
const identity = z.object({ guildId: z.string().regex(/^\d{17,20}$/), discordId: z.string().regex(/^\d{17,20}$/) });
const koreanDate = ms => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
export const presenceKey = (studentId, s) => createHash('sha256').update(JSON.stringify([studentId, s.courseId, s.date, s.period])).digest('hex');
export function createAttendancePresence(identityDb, workspaces, { now = Date.now } = {}) {
    async function context(id, user) {
        if (await workspaces.role(id, user) !== 'student' || (await workspaces.metadata(id)).archivedAt !== null)
            throw new ApiError(403, '참여 중인 워크스페이스의 수강생만 입실·퇴실할 수 있습니다.');
        const db = (await workspaces.open(id)).db;
        const verified = await workspaceVerified(identityDb, id, user.id);
        const { learner, course } = await studentEnrollment(db, user, verified);
        if (!learner || !course || learner.status !== '정상') throw new ApiError(403, '이 워크스페이스의 Discord 인증과 정상 수강 등록을 확인하세요.');
        return { db, learner, course };
    }
    async function record(db, learner, selected) {
        const row = await db.prepare("SELECT data FROM lms_records WHERE kind='attendancePresence' AND id=?").get(presenceKey(learner.id, selected));
        return row ? JSON.parse(row.data) : null;
    }
    async function view(id, user) {
        const { db, learner, course } = await context(id, user), today = koreanDate(now());
        const allRounds = await db.prepare('SELECT date,period,state FROM lms_attendance_rounds WHERE course_id=? ORDER BY date DESC,period').all(course.id);
        const rounds = allRounds.filter(r => r.date === today);
        const history = (await db.prepare("SELECT data FROM lms_records WHERE kind='attendancePresence' AND json_extract(data,'$.studentId')=? AND json_extract(data,'$.courseId')=? ORDER BY json_extract(data,'$.date') DESC,json_extract(data,'$.period') DESC LIMIT 100").all(learner.id, course.id)).map(r => JSON.parse(r.data));
        const records = (await db.prepare("SELECT data FROM lms_records WHERE kind='attendance' AND json_extract(data,'$.studentId')=? AND json_extract(data,'$.courseId')=?").all(learner.id, course.id)).map(r => JSON.parse(r.data));
        for (const item of history) {
            if (allRounds.some(r => r.date === item.date && r.period === item.period && r.state === '마감')) item.status = records.find(r => r.date === item.date && r.period === item.period)?.status;
        }
        return { today, course: { id: course.id, title: course.title }, rounds: await Promise.all(rounds.map(async r => ({ ...r, courseId: course.id, ...await record(db, learner, { courseId: course.id, ...r }) }))), history };
    }
    async function mark(id, raw, user, source = 'web') {
        const selected = input.parse(raw), { db, learner, course } = await context(id, user);
        if (course.id !== selected.courseId) throw new ApiError(403, '수강 중인 과정의 회차만 기록할 수 있습니다.');
        await db.exec('BEGIN IMMEDIATE');
        try {
            // Both database adapters serialize workspace writers, including staff closing/correcting a round.
            const timestamp = now(), existing = await record(db, learner, selected);
            const at = selected.action === 'in' ? 'checkInAt' : 'checkOutAt';
            if (existing?.[at]) { await db.exec('COMMIT'); return { ...existing, alreadyRecorded: true }; }
            const round = await db.prepare('SELECT state FROM lms_attendance_rounds WHERE course_id=? AND date=? AND period=?').get(selected.courseId, selected.date, selected.period);
            if (selected.date !== koreanDate(timestamp) || round?.state !== '진행 중') throw new ApiError(409, '오늘 진행 중인 회차에서만 입실·퇴실할 수 있습니다. 멘토에게 회차 시작 여부를 확인하세요.');
            if (selected.action === 'out' && !existing?.checkInAt) throw new ApiError(409, '입실 기록이 없습니다. 먼저 입실을 눌러 주세요.');
            const after = { ...(existing || { id: presenceKey(learner.id, selected), studentId: learner.id, courseId: selected.courseId, date: selected.date, period: selected.period, checkInAt: null, checkOutAt: null, checkInSource: '', checkOutSource: '' }), [at]: timestamp, [selected.action === 'in' ? 'checkInSource' : 'checkOutSource']: source };
            await db.prepare("INSERT INTO lms_records(kind,id,data) VALUES('attendancePresence',?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data").run(after.id, JSON.stringify(after));
            if (selected.action === 'out') {
                const previous = await db.prepare("SELECT data FROM lms_records WHERE kind='attendance' AND json_extract(data,'$.studentId')=? AND json_extract(data,'$.courseId')=? AND json_extract(data,'$.date')=? AND json_extract(data,'$.period')=?").get(learner.id, course.id, selected.date, selected.period);
                // Preserve all staff corrections and legacy code attendance. Presence is independent evidence.
                if (!previous) {
                    const attendance = { id: randomUUID(), studentId: learner.id, courseId: course.id, date: selected.date, period: selected.period, status: '출석', reason: '입실·퇴실 기록 완료' };
                    await db.prepare("INSERT INTO lms_records(kind,id,data) VALUES('attendance',?,?)").run(attendance.id, JSON.stringify(attendance));
                    await db.prepare('INSERT INTO lms_audit(actor,action,target,after_json) VALUES(?,?,?,?)').run(user.username, 'attendance.checkinout', attendance.id, JSON.stringify(attendance));
                }
            }
            await db.prepare('INSERT INTO lms_audit(actor,action,target,before_json,after_json) VALUES(?,?,?,?,?)').run(user.username, `attendance.presence.${selected.action}`, after.id, JSON.stringify(existing), JSON.stringify(after));
            await db.prepare('UPDATE lms_attendance_rounds SET version=version+1 WHERE course_id=? AND date=? AND period=?').run(course.id, selected.date, selected.period);
            await db.exec('COMMIT');
            return { ...after, alreadyRecorded: false };
        } catch (error) { await db.exec('ROLLBACK'); throw error; }
    }
    async function discord(raw, writing = false) {
        const credentials = identity.parse(raw), id = await workspaceForGuild(identityDb, credentials.guildId);
        if (!id) throw new ApiError(403, '연결된 수업 서버가 아닙니다.');
        const user = await identityDb.prepare('SELECT id,username,discord_id AS discordId,platform_role AS role FROM lms_users WHERE discord_id=?').get(credentials.discordId);
        if (!user || !await workspaceVerified(identityDb, id, user.id, credentials.guildId)) throw new ApiError(403, '이 서버의 LMS 인증을 완료하세요.');
        if (!writing) { identity.strict().parse(raw); return view(id, user); }
        const body = identity.extend(input.shape).strict().parse(raw);
        return mark(id, { courseId: body.courseId, date: body.date, period: body.period, action: body.action }, user, 'discord');
    }
    return { view, mark, discord };
}

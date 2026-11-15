import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './store.mjs';
import { studentEnrollment } from './student.mjs';
import { readSession, koreanDate } from './attendance-session.mjs';
import { workspaceForGuild, workspaceVerified } from './workspace-verification.mjs';

const input = z.object({ code: z.string().trim().regex(/^\d{6}$/), action: z.enum(['in', 'out']).optional() }).strict();
const identity = z.object({ guildId: z.string().regex(/^\d{17,20}$/), discordId: z.string().regex(/^\d{17,20}$/) });
export const presenceKey = (studentId, s) => createHash('sha256').update(JSON.stringify([studentId, s.courseId, s.date, s.period])).digest('hex');
export function createAttendancePresence(identityDb, workspaces, { now = Date.now, attendance } = {}) {
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
        return { today, course: { id: course.id, title: course.title }, rounds: await Promise.all(rounds.map(async r => ({ ...r, courseId: course.id, session: await readSession(db, { courseId: course.id, ...r }), ...await record(db, learner, { courseId: course.id, ...r }) }))), history };
    }
    async function mark(id, raw, user, source = 'web') {
        const request = input.parse(raw), { db, learner, course } = await context(id, user);
        await db.exec('BEGIN IMMEDIATE');
        try {
            const timestamp = now();
            const code = await db.prepare('SELECT * FROM lms_attendance_codes WHERE code_hash=?').get(createHash('sha256').update(request.code).digest('hex'));
            if (!code) throw new ApiError(410, '만료되었거나 사용할 수 없는 코드입니다. 강사에게 새 코드를 확인하세요.');
            const metadata = await db.prepare("SELECT data FROM lms_records WHERE kind='attendanceCode' AND id=?").get(code.id);
            if (!metadata) throw new ApiError(410, '이전 방식의 출석 코드입니다. 시작 또는 종료 코드를 새로 발급받으세요.');
            const phase = JSON.parse(metadata.data).phase;
            if (request.action && phase !== request.action) throw new ApiError(422, phase === 'in' ? '입실용 시작 코드입니다. 입실에서 등록하세요.' : '퇴실용 종료 코드입니다. 퇴실에서 등록하세요.');
            const selected = { courseId: code.course_id, date: code.date, period: code.period, action: phase };
            if (course.id !== selected.courseId || !JSON.parse(code.student_ids).includes(learner.id)) throw new ApiError(403, '이 코드의 출석 대상 수강생이 아닙니다.');
            const existing = await record(db, learner, selected);
            const currentStatus = async () => {
                const row = await db.prepare("SELECT data FROM lms_records WHERE kind='attendance' AND json_extract(data,'$.studentId')=? AND json_extract(data,'$.courseId')=? AND json_extract(data,'$.date')=? AND json_extract(data,'$.period')=?").get(learner.id, course.id, selected.date, selected.period);
                return row ? JSON.parse(row.data).status : '미처리';
            };
            const at = selected.action === 'in' ? 'checkInAt' : 'checkOutAt';
            // A committed mark may lose its HTTP response. Return only this verified
            // student's existing evidence before checking whether a NEW mark is allowed.
            // This never changes timestamps, staff corrections, or the round revision.
            if (existing?.[at]) { const status = await currentStatus(); await db.exec('COMMIT'); return { ...existing, action: phase, status, alreadyRecorded: true }; }
            if (code.revoked_at !== null || code.expires_at <= timestamp) throw new ApiError(410, '만료되었거나 사용할 수 없는 코드입니다. 강사에게 새 코드를 확인하세요.');
            const issuer = await identityDb.prepare('SELECT id,username,platform_role AS role FROM lms_users WHERE id=?').get(code.actor_id);
            if (!issuer) throw new ApiError(410, '코드 발급자의 권한이 변경되었습니다.');
            const roster = await attendance.view(id, selected, issuer);
            if (!roster.rows.some(r => r.studentId === learner.id && r.enrollment === '정상')) throw new ApiError(403, '현재 코드 발급자의 담당 수강생이 아닙니다.');
            if (roster.state !== '진행 중' || selected.date !== koreanDate(timestamp)) throw new ApiError(409, '오늘 진행 중인 회차에서만 코드를 등록할 수 있습니다.');
            const session = await readSession(db, selected);
            if (!session || (phase === 'in' && session.endedAt) || (phase === 'out' && !session.endedAt)) throw new ApiError(409, '현재 강의 단계에 맞는 코드를 입력하세요.');
            if (selected.action === 'out' && !existing?.checkInAt) throw new ApiError(409, '시작 코드로 등록한 입실 기록이 없습니다. 강사에게 확인을 요청하세요.');
            const after = { ...(existing || { id: presenceKey(learner.id, selected), studentId: learner.id, courseId: selected.courseId, date: selected.date, period: selected.period, checkInAt: null, checkOutAt: null, checkInSource: '', checkOutSource: '' }), [at]: timestamp, [selected.action === 'in' ? 'checkInSource' : 'checkOutSource']: source };
            await db.prepare("INSERT INTO lms_records(kind,id,data) VALUES('attendancePresence',?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data").run(after.id, JSON.stringify(after));
            if (selected.action === 'out') {
                const previous = await db.prepare("SELECT data FROM lms_records WHERE kind='attendance' AND json_extract(data,'$.studentId')=? AND json_extract(data,'$.courseId')=? AND json_extract(data,'$.date')=? AND json_extract(data,'$.period')=?").get(learner.id, course.id, selected.date, selected.period);
                // Preserve all staff corrections and legacy code attendance. Presence is independent evidence.
                if (!previous) {
                    const attendance = { id: randomUUID(), studentId: learner.id, courseId: course.id, date: selected.date, period: selected.period, status: '출석', reason: '시작·종료 코드 출석 완료' };
                    await db.prepare("INSERT INTO lms_records(kind,id,data) VALUES('attendance',?,?)").run(attendance.id, JSON.stringify(attendance));
                    await db.prepare('INSERT INTO lms_audit(actor,action,target,after_json) VALUES(?,?,?,?)').run(user.username, 'attendance.checkinout', attendance.id, JSON.stringify(attendance));
                }
            }
            await db.prepare('INSERT INTO lms_audit(actor,action,target,before_json,after_json) VALUES(?,?,?,?,?)').run(user.username, `attendance.presence.${selected.action}`, after.id, JSON.stringify(existing), JSON.stringify(after));
            await db.prepare('UPDATE lms_attendance_rounds SET version=version+1 WHERE course_id=? AND date=? AND period=?').run(course.id, selected.date, selected.period);
            const status = await currentStatus();
            await db.exec('COMMIT');
            return { ...after, action: phase, status, alreadyRecorded: false };
        } catch (error) { await db.exec('ROLLBACK'); throw error; }
    }
    async function discord(raw, writing = false) {
        const credentials = identity.parse(raw), id = await workspaceForGuild(identityDb, credentials.guildId);
        if (!id) throw new ApiError(403, '연결된 수업 서버가 아닙니다.');
        const user = await identityDb.prepare('SELECT id,username,discord_id AS discordId,platform_role AS role FROM lms_users WHERE discord_id=?').get(credentials.discordId);
        if (!user || !await workspaceVerified(identityDb, id, user.id, credentials.guildId)) throw new ApiError(403, '이 서버의 LMS 인증을 완료하세요.');
        if (!writing) { identity.strict().parse(raw); return view(id, user); }
        const body = identity.extend(input.shape).strict().parse(raw);
        return mark(id, { code: body.code, ...(body.action ? { action: body.action } : {}) }, user, 'discord');
    }
    return { view, mark, discord };
}

import { createHash, randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './store.mjs';
import { createAttendancePresence } from './attendance-presence.mjs';
import { readSession, writeSession, sessionKey, koreanDate } from './attendance-session.mjs';
const selection = z.object({ courseId: z.string().min(1).max(200), date: z.string().date(), period: z.coerce.number().int().min(1).max(100) });
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const issueInput = selection.extend({ phase: z.enum(['in','out']).default('in'), startTime: clock.optional(), endTime: clock.optional(), minutes: z.number().int().min(1).max(10).default(5) }).strict();
const checkInput = z.object({ guildId: z.string().regex(/^\d{17,20}$/), discordId: z.string().regex(/^\d{17,20}$/), code: z.string().trim().regex(/^\d{6}$/) }).strict();
const digest = code => createHash('sha256').update(code).digest('hex');
export function createAttendanceCodes(identityDb, workspaces, attendance, { now = Date.now, enabled = true } = {}) {
    const presence = createAttendancePresence(identityDb, workspaces, { now, attendance });
    async function context(id, raw, user) {
        const selected = selection.parse(raw);
        const roster = await attendance.view(id, selected, user);
        const meta = await workspaces.metadata(id);
        if (meta.archivedAt !== null)
            throw new ApiError(409, '보관된 워크스페이스입니다.');
        return { selected, roster, meta, db: (await workspaces.open(id)).db };
    }
    async function status(id, raw, user) {
        const { selected: s, roster, meta, db } = await context(id, raw, user);
        const row = await (db.prepare('SELECT id,expires_at AS expiresAt,revoked_at AS revokedAt FROM lms_attendance_codes WHERE course_id=? AND date=? AND period=? AND actor_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1')).get(s.courseId, s.date, s.period, user.id);
        const session = await readSession(db, s);
        const metadata = row && await db.prepare("SELECT data FROM lms_records WHERE kind='attendanceCode' AND id=?").get(row.id);
        const phase = metadata ? JSON.parse(metadata.data).phase : null;
        return { enabled: enabled && meta.guildIds.length === 1 && roster.state !== '마감' && s.date === koreanDate(now()) && roster.rows.some(r => r.enrollment === '정상'), botConfigured: enabled,
            canManage: roster.canManage, session, state: roster.state, scope: roster.canManage ? '과정 전체' : '담당 조', guildConnected: meta.guildIds.length === 1,
            active: row && phase && row.expiresAt > now() && row.revokedAt === null && roster.state === '진행 중' && (phase === 'out' || !session?.endedAt) ? { id: row.id, expiresAt: row.expiresAt, phase } : null };
    }
    async function issue(id, raw, user) {
        if (!enabled) throw new ApiError(409, 'Discord 인증 봇 연결을 설정하세요.');
        const input = issueInput.parse(raw), { db } = await context(id, input, user);
        if (!await identityDb.prepare('SELECT 1 FROM lms_users WHERE id=?').get(user.id)) throw new ApiError(403, '개인 관리자 또는 멘토 계정으로 로그인하세요.');
        await db.exec('BEGIN IMMEDIATE');
        try {
            const { roster, meta } = await context(id, input, user), timestamp = now();
            if (meta.guildIds.length !== 1) throw new ApiError(409, 'Discord 서버 하나를 연결하세요.');
            if (input.date !== koreanDate(timestamp)) throw new ApiError(409, '오늘 강의의 코드만 생성할 수 있습니다.');
            if (roster.state === '마감') throw new ApiError(409, '마감한 회차입니다.');
            const students = roster.rows.filter(r => r.enrollment === '정상').map(r => r.studentId);
            if (!students.length) throw new ApiError(422, '코드를 사용할 정상 수강생이 없습니다.');
            let session = await readSession(db, input);
            if (!session) {
                if (!roster.canManage || input.phase !== 'in') throw new ApiError(403, '관리자 또는 메인 강사가 시작 코드를 생성해야 합니다.');
                if (!input.startTime || !input.endTime || input.startTime >= input.endTime) throw new ApiError(422, '강의 시작·종료 예정 시각을 정확히 입력하세요. 종료는 시작 이후여야 합니다.');
                session = { id: sessionKey(input), courseId: input.courseId, date: input.date, period: input.period, startTime: input.startTime, endTime: input.endTime, startedAt: timestamp, endedAt: null };
            } else {
                if ((input.startTime && input.startTime !== session.startTime) || (input.endTime && input.endTime !== session.endTime)) throw new ApiError(409, '시작한 강의의 시간대는 코드 재발급으로 변경할 수 없습니다.');
                if (input.phase === 'in' && session.endedAt) throw new ApiError(409, '강의가 종료되어 입실 코드를 생성할 수 없습니다.');
                if (input.phase === 'out' && !roster.canManage) throw new ApiError(403, '강의 종료 코드는 관리자 또는 메인 강사가 생성합니다.');
            }
            if (input.phase === 'out') {
                session.endedAt ||= timestamp;
                // Closing the lecture invalidates every instructor's entry code immediately.
                await db.prepare('UPDATE lms_attendance_codes SET revoked_at=? WHERE course_id=? AND date=? AND period=? AND revoked_at IS NULL').run(timestamp, input.courseId, input.date, input.period);
            }
            await writeSession(db, session);
            await db.prepare("INSERT INTO lms_attendance_rounds(course_id,date,period,state,version) VALUES(?,?,?,'진행 중',1) ON CONFLICT(course_id,date,period) DO UPDATE SET version=lms_attendance_rounds.version+1").run(input.courseId, input.date, input.period);
            await db.prepare('DELETE FROM lms_attendance_codes WHERE expires_at<?').run(timestamp - 86400000);
            let code;
            for (let attempts = 0; attempts < 30; attempts++) {
                const candidate = String(randomInt(0, 1000000)).padStart(6, '0');
                if (!await db.prepare('SELECT 1 FROM lms_attendance_codes WHERE code_hash=?').get(digest(candidate))) { code = candidate; break; }
            }
            if (!code) throw new ApiError(503, '코드를 생성하지 못했습니다. 다시 시도하세요.');
            await db.prepare('UPDATE lms_attendance_codes SET revoked_at=? WHERE course_id=? AND date=? AND period=? AND actor_id=? AND revoked_at IS NULL').run(timestamp, input.courseId, input.date, input.period, user.id);
            const codeId = randomUUID(), expiresAt = timestamp + input.minutes * 60000;
            await db.prepare('INSERT INTO lms_attendance_codes VALUES(?,?,?,?,?,?,?,?,?,?,NULL)').run(codeId, digest(code), input.courseId, input.date, input.period, meta.guildIds[0], user.id, JSON.stringify(students), timestamp, expiresAt);
            await db.prepare("INSERT INTO lms_records(kind,id,data) VALUES('attendanceCode',?,?)").run(codeId, JSON.stringify({ id: codeId, phase: input.phase }));
            await db.prepare('INSERT INTO lms_audit(actor,action,target,after_json) VALUES(?,?,?,?)').run(user.username, 'attendance.code.issue', codeId, JSON.stringify({ ...input, expiresAt, students: students.length, session }));
            const result = { ...await status(id, input, user), code };
            await db.exec('COMMIT');
            return result;
        } catch (error) { await db.exec('ROLLBACK'); throw error; }
    }

    async function revoke(id, raw, user) {
        const { selected: s, db } = await context(id, selection.strict().parse(raw), user);
        await (db.prepare('UPDATE lms_attendance_codes SET revoked_at=? WHERE course_id=? AND date=? AND period=? AND actor_id=? AND revoked_at IS NULL')).run(now(), s.courseId, s.date, s.period, user.id);
        return await status(id, s, user);
    }
    async function checkIn(raw) { return presence.discord(checkInput.parse(raw), true); }
    return { status, issue, revoke, checkIn, presence };
}

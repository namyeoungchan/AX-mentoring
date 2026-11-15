import { z } from 'zod';
import { ApiError } from './store.mjs';

const kind = 'mentoringActivity';
const key = z.string().trim().min(1).max(200);
const fields = {
    mentorId: key, courseId: key, teamId: z.string().max(200),
    studentIds: z.array(key).max(100), title: z.string().trim().min(1).max(150),
    date: z.string().date(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), content: z.string().trim().min(1).max(4000),
};
const createInput = z.object({ id: z.uuid(), ...fields }).strict();
const editInput = z.object({ revision: z.number().int().positive(), ...fields }).strict();

// Separate from bookings: a recorded activity must never reserve a slot or send a DM.
export function createMentoringActivities(main, workspaces, { now = Date.now } = {}) {
    async function context(id, user, writing = false) {
        await workspaces.requireRole(id, user, ['admin', 'instructor']);
        const meta = await workspaces.requireAccess(id, user);
        if (writing && meta.archivedAt !== null) throw new ApiError(409, '보관된 워크스페이스의 기록은 변경할 수 없습니다.');
        const admin = meta.role === 'admin';
        const data = admin ? await workspaces.snapshot(id) : await workspaces.teaching(id, user);
        // Use workspace membership, not a name or legacy Discord mentor ID.
        const members = await main.prepare(`SELECT u.id,u.name,u.username FROM lms_workspace_members m
            JOIN lms_users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.role='instructor' ORDER BY u.name,u.id`).all(id);
        return { db: (await workspaces.open(id)).db, data, admin, archived: meta.archivedAt !== null,
            mentors: admin ? members : members.filter(m => m.id === user.id) };
    }
    function allowed(c, record, user) {
        if (!c.admin && record.mentorId !== user.id) throw new ApiError(403, '본인의 멘토링 기록만 확인하거나 수정할 수 있습니다.');
    }
    function summary(c, record, user) {
        const { createRequest: _request, createdBy: _creator, ...result } = record;
        return { ...result, canEdit: !c.archived && (c.admin || record.mentorId === user.id) };
    }
    async function read(db, id) {
        const row = await db.prepare('SELECT data FROM lms_records WHERE kind=? AND id=?').get(kind, id);
        return row ? JSON.parse(row.data) : null;
    }
    function validate(c, input, user) {
        if (!c.admin && input.mentorId !== user.id) throw new ApiError(403, '멘토는 본인 이름으로만 기록할 수 있습니다.');
        const mentor = c.mentors.find(m => m.id === input.mentorId);
        if (!mentor) throw new ApiError(422, '이 워크스페이스의 멘토를 선택하세요.');
        const course = c.data.courses.find(v => v.id === input.courseId);
        const team = c.data.teams.find(v => v.id === input.teamId && v.courseId === input.courseId);
        if (!course || (input.teamId && !team)) throw new ApiError(403, '담당 범위의 과정과 팀을 선택하세요.');
        if (!input.teamId && !input.studentIds.length) throw new ApiError(422, '대상 팀 또는 참여 학생을 선택하세요.');
        if (team && !input.studentIds.length && c.data.learners.some(v => v.courseId === input.courseId && v.team === team.name))
            throw new ApiError(422, '참여 학생을 1명 이상 선택하세요. 전원을 해제한 상태로는 저장할 수 없습니다.');
        if (new Set(input.studentIds).size !== input.studentIds.length) throw new ApiError(422, '참여 학생을 중복 선택할 수 없습니다.');
        const students = input.studentIds.map(studentId => c.data.learners.find(v => v.id === studentId && v.courseId === input.courseId && (!team || v.team === team.name)));
        if (students.some(v => !v)) throw new ApiError(403, '선택한 과정과 팀의 담당 학생만 기록할 수 있습니다.');
        if (input.endTime <= input.time) throw new ApiError(422, '종료 시간은 같은 날의 시작 시간 이후로 입력하세요.');
        if (Date.parse(`${input.date}T${input.endTime}:00+09:00`) > now()) throw new ApiError(422, '진행을 마친 멘토링의 날짜와 시간을 입력하세요.');
        return { mentorName: mentor.name, courseTitle: course.title, teamName: team?.name || '',
            students: students.map(v => ({ id: v.id, name: v.name })) };
    }
    async function list(id, user) {
        const c = await context(id, user);
        const records = (await c.db.prepare('SELECT data FROM lms_records WHERE kind=?').all(kind)).map(row => JSON.parse(row.data));
        return { admin: c.admin, canCreate: !c.archived && c.mentors.length > 0, mentors: c.mentors,
            courses: c.data.courses.map(v => ({ id: v.id, title: v.title })),
            teams: c.data.teams.map(v => ({ id: v.id, name: v.name, courseId: v.courseId })),
            students: c.data.learners.map(v => ({ id: v.id, name: v.name, courseId: v.courseId, team: v.team })),
            records: records.filter(v => c.admin || v.mentorId === user.id)
                .sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time) || a.id.localeCompare(b.id))
                .map(v => summary(c, v, user)) };
    }
    async function create(id, raw, user) {
        const input = createInput.parse(raw), c = await context(id, user, true);
        const labels = validate(c, input, user), createRequest = JSON.stringify(input);
        await c.db.exec('BEGIN IMMEDIATE');
        try {
            const timestamp = now();
            const record = { ...input, ...labels, revision: 1, createdAt: timestamp, updatedAt: timestamp,
                createdBy: user.id, updatedBy: user.id, createRequest };
            const inserted = await c.db.prepare('INSERT OR IGNORE INTO lms_records(kind,id,data) VALUES(?,?,?)').run(kind, input.id, JSON.stringify(record));
            const stored = inserted.changes ? record : await read(c.db, input.id);
            if (!inserted.changes && (stored.createdBy !== user.id || stored.createRequest !== createRequest))
                throw new ApiError(409, '이미 사용된 등록 요청입니다. 기록 목록을 확인하세요.');
            allowed(c, stored, user);
            if (inserted.changes) await c.db.prepare('INSERT INTO lms_audit(actor,action,target,before_json,after_json) VALUES(?,?,?,?,?)')
                .run(user.username, 'mentoring.activity.create', input.id, 'null', JSON.stringify(summary(c, record, user)));
            await c.db.exec('COMMIT');
            return summary(c, stored, user);
        } catch (error) { await c.db.exec('ROLLBACK'); throw error; }
    }
    async function edit(id, recordId, raw, user) {
        const input = editInput.parse(raw), c = await context(id, user, true);
        await c.db.exec('BEGIN IMMEDIATE');
        try {
            const before = await read(c.db, recordId);
            if (!before) throw new ApiError(404, '멘토링 기록을 찾을 수 없습니다.');
            allowed(c, before, user);
            if (before.revision !== input.revision) throw new ApiError(409, '다른 사용자가 기록을 수정했습니다. 목록을 새로고침한 뒤 다시 열어 주세요.');
            const labels = validate(c, input, user);
            const after = { ...before, ...input, ...labels, revision: before.revision + 1, updatedAt: now(), updatedBy: user.id };
            const changed = await c.db.prepare('UPDATE lms_records SET data=? WHERE kind=? AND id=? AND data=?')
                .run(JSON.stringify(after), kind, recordId, JSON.stringify(before));
            if (!changed.changes) throw new ApiError(409, '기록이 변경되었습니다. 목록을 새로고침하세요.');
            await c.db.prepare('INSERT INTO lms_audit(actor,action,target,before_json,after_json) VALUES(?,?,?,?,?)')
                .run(user.username, 'mentoring.activity.update', recordId, JSON.stringify(summary(c, before, user)), JSON.stringify(summary(c, after, user)));
            await c.db.exec('COMMIT');
            return summary(c, after, user);
        } catch (error) { await c.db.exec('ROLLBACK'); throw error; }
    }
    return { list, create, edit };
}

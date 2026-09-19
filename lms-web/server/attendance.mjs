import { createHash, randomUUID } from 'node:crypto';
import { readSession } from './attendance-session.mjs';
import { z } from 'zod';
import { ApiError } from './store.mjs';
const key = z.string().trim().min(1).max(200);
const selection = z.object({ courseId: key, date: z.string().date(), period: z.coerce.number().int().min(1).max(100) });
const input = selection.extend({
    requestId: z.uuid(), revision: key,
    action: z.enum(['start', 'save', 'close']),
    entries: z.array(z.object({ studentId: key, status: z.enum(['출석', '지각', '결석', '공결']), reason: z.string().trim().max(200).default('') }).strict()).max(1000).default([]),
}).strict();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Each workspace owns its rounds and request receipts in the same SQLite DB as its records.
export function createAttendance(workspaces, { outbox } = {}) {
    async function context(id, user, writing = false) {
        await workspaces.requireRole(id, user, ['admin', 'instructor']);
        if (writing && (await workspaces.metadata(id)).archivedAt !== null)
            throw new ApiError(409, '보관된 워크스페이스입니다.');
        return (await workspaces.open(id)).db;
    }
    async function view(id, raw, user) {
        const db = await context(id, user), selected = selection.parse(raw);
        const admin = await workspaces.role(id, user) === 'admin';
        const data = admin ? await workspaces.snapshot(id) : await workspaces.teaching(id, user);
        if (!data.courses.some(c => c.id === selected.courseId))
            throw new ApiError(403, '담당 과정이 아닙니다.');
        const round = await (db.prepare('SELECT state, version FROM lms_attendance_rounds WHERE course_id=? AND date=? AND period=?')).get(selected.courseId, selected.date, selected.period) || { state: '진행 전', version: 0 };
        const records = data.attendance.filter(a => a.courseId === selected.courseId && a.date === selected.date && a.period === selected.period);
        const presence = (await db.prepare("SELECT data FROM lms_records WHERE kind='attendancePresence' AND json_extract(data,'$.courseId')=? AND json_extract(data,'$.date')=? AND json_extract(data,'$.period')=?").all(selected.courseId, selected.date, selected.period)).map(row => JSON.parse(row.data));
        const rows = data.learners.filter(l => l.courseId === selected.courseId).map(l => {
            const record = records.find(a => a.studentId === l.id);
            const times = presence.find(p => p.studentId === l.id);
            return { checkInAt: times?.checkInAt || null, checkOutAt: times?.checkOutAt || null, checkInSource: times?.checkInSource || '', checkOutSource: times?.checkOutSource || '', studentId: l.id, name: l.name, team: l.team, enrollment: l.status, status: record?.status || '미처리', reason: record?.reason || '' };
        });
        const counts = Object.fromEntries(['미처리', '출석', '지각', '결석', '공결'].map(status => [status, rows.filter(r => r.status === status).length]));
        const targets = records.map(r => r.id);
        // Filter before LIMIT so unrelated history cannot hide this roster's corrections.
        const history = (await (db.prepare("SELECT actor,action,before_json,after_json,created_at FROM lms_audit WHERE action LIKE 'attendance.%' AND target IN (SELECT value FROM json_each(?)) ORDER BY id DESC LIMIT 200")).all(JSON.stringify(targets))).map(r => ({ actor: r.actor, action: r.action, before: JSON.parse(r.before_json || 'null'), after: JSON.parse(r.after_json || 'null'), time: r.created_at + ' UTC' }));
        const canManage = admin || (await workspaces.mentorScope(id, user.id)).mentorType === 'main';
        const session = await readSession(db, selected);
        return { ...selected, ...round, session, canManage, rows, counts, history, revision: hash({ selected, round, rows, session }) };
    }
    async function save(id, raw, user) {
        const request = input.parse(raw), db = await context(id, user, true);
        await db.exec('BEGIN IMMEDIATE');
        try {
            const current = await view(id, request, user);
            if (request.action !== 'save' && !current.canManage)
                throw new ApiError(403, '회차 시작·마감은 관리자 또는 메인 강사만 할 수 있습니다.');
            const allowed = new Set(current.rows.map(r => r.studentId));
            if (request.entries.some(e => !allowed.has(e.studentId)))
                throw new ApiError(403, '담당 수강생이 아닙니다.');
            if (new Set(request.entries.map(e => e.studentId)).size !== request.entries.length)
                throw new ApiError(422, '중복 수강생이 포함되어 있습니다.');
            if (request.action !== 'save' && request.entries.length)
                throw new ApiError(422, '출결 저장 후 회차 상태를 변경하세요.');
            const digest = hash(request), actor = user.id || user.username;
            const receipt = await (db.prepare('SELECT actor, digest FROM lms_attendance_requests WHERE id=?')).get(request.requestId);
            if (receipt) {
                if (receipt.actor !== actor || receipt.digest !== digest)
                    throw new ApiError(409, '이미 사용된 요청 번호입니다.');
                await db.exec('COMMIT');
                return current;
            }
            if (current.revision !== request.revision)
                throw new ApiError(409, '다른 작업으로 출결이 변경되었습니다. 명단 새로고침 후 다시 확인하세요.');
            let state = current.state;
            if (request.action === 'start') {
                if (state !== '진행 전')
                    throw new ApiError(409, '진행 전 회차만 시작할 수 있습니다.');
                state = '진행 중';
            }
            else if (request.action === 'close') {
                if (current.session && !current.session.endedAt) throw new ApiError(409, '종료 코드를 생성해 강의를 종료한 뒤 출결을 확정하세요.');
                if (state !== '진행 중')
                    throw new ApiError(409, '진행 중 회차만 마감할 수 있습니다.');
                if (!current.rows.length || current.counts['미처리'])
                    throw new ApiError(422, '전체 명단의 미처리 출결을 입력한 뒤 마감하세요.');
                state = '마감';
            }
            else {
                if (state === '진행 전')
                    throw new ApiError(409, '관리자 또는 메인 강사가 회차를 시작한 뒤 저장하세요.');
                if (!request.entries.length)
                    throw new ApiError(422, '저장할 출결이 없습니다.');
                for (const entry of request.entries) {
                    const existing = await (db.prepare("SELECT data FROM lms_records WHERE kind='attendance' AND json_extract(data,'$.studentId')=? AND json_extract(data,'$.courseId')=? AND json_extract(data,'$.date')=? AND json_extract(data,'$.period')=?")).get(entry.studentId, request.courseId, request.date, request.period);
                    const before = existing ? JSON.parse(existing.data) : null;
                    if (before?.status === entry.status && (!entry.reason || before.reason === entry.reason))
                        continue;
                    if (state === '마감' && !entry.reason)
                        throw new ApiError(422, '마감 후 정정 사유를 입력하세요.');
                    const after = { id: before?.id || randomUUID(), studentId: entry.studentId, courseId: request.courseId, date: request.date, period: request.period, status: entry.status, reason: entry.reason || '명단 출결 입력' };
                    await (db.prepare("INSERT INTO lms_records(kind,id,data) VALUES('attendance',?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data")).run(after.id, JSON.stringify(after));
                    await (db.prepare('INSERT INTO lms_audit(actor,action,target,before_json,after_json) VALUES(?,?,?,?,?)')).run(user.username || actor, before ? 'attendance.update' : 'attendance.create', after.id, JSON.stringify(before), JSON.stringify(after));
                }
            }
            await (db.prepare('INSERT INTO lms_attendance_rounds(course_id,date,period,state,version) VALUES(?,?,?,?,1) ON CONFLICT(course_id,date,period) DO UPDATE SET state=excluded.state, version=lms_attendance_rounds.version+1')).run(request.courseId, request.date, request.period, state);
            if (state !== current.state)
                await (db.prepare('INSERT INTO lms_audit(actor,action,target,before_json,after_json) VALUES(?,?,?,?,?)')).run(user.username || actor, 'attendance.round', JSON.stringify([request.courseId, request.date, request.period]), JSON.stringify({ state: current.state }), JSON.stringify({ state }));
            await (db.prepare('INSERT INTO lms_attendance_requests(id,actor,digest) VALUES(?,?,?)')).run(request.requestId, actor, digest);
            const result = await view(id, request, user);
            await db.exec('COMMIT');
            return result;
        }
        catch (error) {
            await db.exec('ROLLBACK');
            throw error;
        }
    }
    async function discord(id, raw, user) {
        const roster = await view(id, raw, user), db = await context(id, user);
        const scope = roster.canManage ? 'course' : (await workspaces.mentorScope(id, user.id)).teamIds.slice().sort();
        const source = hash({ courseId: roster.courseId, date: roster.date, period: roster.period, scope });
        const event = `attendance:${source}:${roster.revision}`;
        const row = await (db.prepare("SELECT * FROM lms_outbox WHERE kind='attendance' AND source_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1")).get(source);
        let destination = null, channelError = '';
        try {
            if (!outbox)
                throw new ApiError(409, 'Discord 발송이 설정되지 않았습니다.');
            destination = await outbox.channel(id, 'attendance');
        }
        catch (error) {
            channelError = error.message;
        }
        const course = (await workspaces.snapshot(id)).courses.find(c => c.id === roster.courseId)?.title || '';
        const scopeLabel = roster.canManage ? '과정 전체' : `담당 조: ${[...new Set(roster.rows.map(r => r.team || '미배정'))].join(', ')}`;
        const preview = { title: `출결 현황 · ${roster.date} · ${roster.period}차시`, course, description: `${scopeLabel}\n회차: ${roster.state} · 명단 ${roster.rows.length}명\n${Object.entries(roster.counts).map(([status, count]) => `${status} ${count}명`).join(' · ')}\n저장된 출결 기준 · 개인 이름과 사유는 공유하지 않습니다.` };
        return { revision: roster.revision, destination, channelError, preview, canShare: roster.state !== '진행 전' && roster.rows.length > 0,
            delivery: row ? { id: row.id, state: row.state, error: row.error, guildId: row.guild_id, channelId: row.channel_id, messageId: row.message_id, current: row.event_key === event } : null };
    }
    async function share(id, raw, user) {
        const request = selection.extend({ revision: key }).strict().parse(raw), db = await context(id, user, true);
        await db.exec('BEGIN IMMEDIATE');
        try {
            const current = await discord(id, request, user);
            if (request.revision !== current.revision)
                throw new ApiError(409, '출결이 변경되었습니다. 명단을 새로고침하고 저장된 집계를 확인하세요.');
            if (!current.canShare)
                throw new ApiError(409, '회차를 시작하고 수강생 명단을 확인하세요.');
            if (!current.destination)
                throw new ApiError(409, current.channelError);
            const roster = await view(id, request, user);
            const scope = roster.canManage ? 'course' : (await workspaces.mentorScope(id, user.id)).teamIds.slice().sort();
            const source = hash({ courseId: request.courseId, date: request.date, period: request.period, scope });
            const event = `attendance:${source}:${current.revision}`;
            const previous = await (db.prepare('SELECT * FROM lms_outbox WHERE event_key=?')).get(event);
            const { guildId, channelId } = current.destination;
            if (!previous) {
                // Replace only unclaimed older summaries; ambiguous/sent deliveries retain their evidence.
                await (db.prepare("UPDATE lms_outbox SET state='held' WHERE kind='attendance' AND source_id=? AND state='pending'")).run(source);
                const jobId = randomUUID();
                await (db.prepare('INSERT INTO lms_outbox(id,event_key,kind,source_id,guild_id,channel_id,payload,actor,created_at) VALUES(?,?,?,?,?,?,?,?,?)')).run(jobId, event, 'attendance', source, guildId, channelId, JSON.stringify(current.preview), user.username || user.id, Date.now());
                await (db.prepare('INSERT INTO lms_audit(actor,action,target,after_json) VALUES(?,?,?,?)')).run(user.username || user.id, 'attendance.share', jobId, JSON.stringify({ channelId, counts: roster.counts }));
            }
            else if (['failed', 'uncertain'].includes(previous.state)) {
                await (db.prepare("UPDATE lms_outbox SET state=?,guild_id=?,channel_id=?,claim=NULL,error='' WHERE id=?")).run(previous.state === 'failed' ? 'pending' : 'reconcile', previous.state === 'failed' ? guildId : previous.guild_id, previous.state === 'failed' ? channelId : previous.channel_id, previous.id);
                await (db.prepare('INSERT INTO lms_audit(actor,action,target) VALUES(?,?,?)')).run(user.username || user.id, 'attendance.share.retry', previous.id);
            }
            await db.exec('COMMIT');
        }
        catch (error) {
            await db.exec('ROLLBACK');
            throw error;
        }
        return await discord(id, request, user);
    }
    return { view, save, discord, share };
}

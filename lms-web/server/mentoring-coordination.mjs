import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './store.mjs';
import { onlineMentors } from './online-mentoring.mjs';

// These internal records participate in the existing workspace backup/restore contract.
const kind = 'mentoringCoordination';
const operationQueues = new WeakMap();
const snowflake = z.string().regex(/^\d{17,20}$/);
const recordId = z.string().regex(/^[1-9]\d*$/);
export const mentoringMillis = value => Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}+09:00`);
export const coordinating = state => ['proposed', 'needs_coordination'].includes(state?.status);
export async function coordinationState(db, id) {
    const row = await db.prepare('SELECT data FROM lms_records WHERE kind=? AND id=?').get(kind, String(id));
    return row ? JSON.parse(row.data) : { version: 0, status: 'confirmed', unavailable: [], proposal: null };
}
export async function coordinationHolds(db, now = Date.now()) {
    return (await db.prepare("SELECT data FROM lms_records WHERE kind=? AND json_extract(data,'$.status')='proposed'").all(kind)).map(row => JSON.parse(row.data))
        .filter(row => row.status === 'proposed' && row.proposal.expiresAt > now);
}
const bookingQuery = `SELECT b.*,s.mentor_id,s.start_time,s.end_time,s.label,m.name AS mentor_name,m.discord_id AS mentor_discord
    FROM bookings b JOIN slots s ON s.id=b.slot_id JOIN mentors m ON m.id=s.mentor_id`;
const inputSchema = z.object({ eventId: z.string().regex(/^(?:[a-f0-9-]{36}|\d{17,20})$/), version: z.number().int().nonnegative(),
    action: z.enum(['propose', 'accept', 'reject', 'withdraw', 'cancel']), slotId: recordId.optional(),
    reason: z.string().trim().min(1).max(1000).optional(), originalAvailable: z.boolean().optional() }).strict();
const actionLabels = { propose: '멘토링 일정 변경 제안', accept: '멘토링 일정 변경 확정', reject: '일정 변경 제안 거절', withdraw: '일정 변경 제안 철회', cancel: '멘토링 예약 취소', expire: '일정 변경 제안 만료' };

export function createMentoringCoordination(main, workspaces, { now = Date.now } = {}) {
    if (!operationQueues.has(workspaces)) operationQueues.set(workspaces, new Map());
    const queues = operationQueues.get(workspaces);
    function serial(operation) {
        return async (id, ...args) => {
            const task = (queues.get(id) || Promise.resolve()).catch(() => {}).then(() => operation(id, ...args));
            queues.set(id, task);
            try { return await task; }
            finally { if (queues.get(id) === task) queues.delete(id); }
        };
    }
    async function context(id, user) {
        const meta = await workspaces.requireAccess(id, user);
        const role = meta.role;
        if (role !== 'student' && !(role === 'instructor' && (await workspaces.mentorScope(id, user.id)).mentorType === 'group'))
            throw new ApiError(403, '일정 재조율은 예약 당사자인 조 담당 멘토와 수강생만 할 수 있습니다.');
        if (!meta.discordVerified || meta.guildIds.length !== 1) throw new ApiError(403, '이 워크스페이스에서 Discord 인증을 완료하세요.');
        const account = await main.prepare('SELECT discord_id FROM lms_users WHERE id=?').get(user.id);
        if (!account?.discord_id) throw new ApiError(403, '연결된 Discord 계정이 없습니다.');
        return { db: (await workspaces.open(id)).db, meta, discordId: account.discord_id, role: role === 'student' ? 'student' : 'mentor', user };
    }
    function participant(ctx, booking) {
        if (!booking || (ctx.role === 'student' ? booking.user_id : booking.mentor_discord) !== ctx.discordId)
            throw new ApiError(404, '본인의 멘토링 예약을 찾을 수 없습니다.');
    }
    async function getBooking(ctx, bookingId) {
        const booking = await ctx.db.prepare(`${bookingQuery} WHERE CAST(b.id AS TEXT)=?`).get(bookingId);
        participant(ctx, booking);
        return booking;
    }
    async function save(db, booking, state, action, actor, reason = '') {
        state.version += 1;
        state.bookingId = String(booking.id);
        state.updatedAt = now();
        await db.prepare('INSERT INTO lms_records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data')
            .run(kind, String(booking.id), JSON.stringify(state));
        await db.prepare('INSERT INTO lms_audit(actor,action,target,after_json) VALUES(?,?,?,?)')
            .run(actor, `mentoring.${action}`, String(booking.id), JSON.stringify({ ...state, reason }));
    }
    async function notify(db, meta, booking, state, action, actor, reason = '') {
        // Superseded buttons remain safe: they open current state and actions carry a version.
        await db.prepare("UPDATE lms_outbox SET state='cancelled',claim=NULL,error='superseded' WHERE kind='mentoring_coordination' AND source_id=? AND state IN ('pending','failed','reconcile','uncertain')").run(String(booking.id));
        for (const targetId of new Set([booking.user_id, booking.mentor_discord])) {
            const status = state.status === 'needs_coordination' ? '재조율 필요 · 기존 시간으로 진행하지 않습니다.'
                : state.status === 'proposed' ? '상대방의 응답을 기다리는 중입니다.' : state.status === 'cancelled' ? '예약이 취소되었습니다.' : '확정 일정으로 진행합니다.';
            const payload = { title: actionLabels[action], audience: 'individual', targetId, bookingId: String(booking.id),
                description: `${meta.name}\n${booking.mentor_name} · ${booking.user_name}\n기존/확정 일정: ${booking.start_time.replace('T', ' ')} – ${booking.end_time.slice(11, 16)} (한국시간)\n${state.proposal ? `제안 일정: ${state.proposal.start.replace('T', ' ')} – ${state.proposal.end.slice(11, 16)}\n응답 기한: ${new Date(state.proposal.expiresAt + 9 * 3600000).toISOString().slice(0, 16).replace('T', ' ')} (한국시간)\n` : ''}${status}${reason ? `\n사유: ${reason}` : ''}\nLMS 또는 아래 버튼에서 최신 상태를 확인하세요.` };
            await db.prepare('INSERT INTO lms_outbox(id,event_key,kind,source_id,guild_id,channel_id,payload,actor,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
                .run(randomUUID(), `mentoring-coordinate:${booking.id}:${state.version}:${targetId}`, 'mentoring_coordination', String(booking.id), meta.guildIds[0], `dm:${targetId}`, JSON.stringify(payload), actor, now());
        }
    }
    async function expire(db, meta, booking, state) {
        if (state.status !== 'proposed' || state.proposal.expiresAt > now()) return;
        state.proposal = null;
        state.status = state.unavailable.length || mentoringMillis(booking.start_time) <= now() ? 'needs_coordination' : 'confirmed';
        await save(db, booking, state, 'expire', 'scheduler');
        await notify(db, meta, booking, state, 'expire', 'scheduler');
    }
    async function prepare(id) {
        const meta = await workspaces.metadata(id);
        if (meta.archivedAt !== null || meta.guildIds.length !== 1) return;
        const db = (await workspaces.open(id)).db;
        await db.exec('BEGIN IMMEDIATE');
        try {
            for (const row of await db.prepare("SELECT data FROM lms_records WHERE kind=? AND json_extract(data,'$.status')='proposed'").all(kind)) {
                const state = JSON.parse(row.data);
                if (state.status !== 'proposed') continue;
                const booking = await db.prepare(`${bookingQuery} WHERE CAST(b.id AS TEXT)=?`).get(state.bookingId);
                if (booking?.status === 'approved') await expire(db, meta, booking, state);
            }
            await db.exec('COMMIT');
        } catch (error) { await db.exec('ROLLBACK'); throw error; }
    }
    async function freeSlot(db, booking, slot, holds) {
        if (!slot || slot.mentor_id !== booking.mentor_id || !slot.is_active || mentoringMillis(slot.start_time) <= now()) return false;
        if (await db.prepare(`SELECT 1 FROM bookings b JOIN slots s ON s.id=b.slot_id WHERE b.id<>? AND
            (s.id=? OR (b.status IN ('pending','approved') AND (s.mentor_id=? OR b.user_id=?) AND s.start_time<? AND s.end_time>?))`).get(booking.id, slot.id, booking.mentor_id, booking.user_id, slot.end_time, slot.start_time)) return false;
        return !holds.some(hold => hold.bookingId !== String(booking.id) && (hold.proposal.mentorId === booking.mentor_id || hold.proposal.studentId === booking.user_id)
            && hold.proposal.start < slot.end_time && hold.proposal.end > slot.start_time);
    }
    async function view(ctx, booking) {
        const state = await coordinationState(ctx.db, booking.id);
        const holds = await coordinationHolds(ctx.db, now());
        const editable = ctx.meta.archivedAt === null && booking.status === 'approved' && (coordinating(state) || mentoringMillis(booking.start_time) > now());
        const slots = [];
        const localNow = new Date(now() + 9 * 3600000).toISOString().slice(0, 19);
        if (editable) for (const slot of await ctx.db.prepare(`SELECT candidate.* FROM slots candidate WHERE candidate.mentor_id=? AND candidate.is_active=1 AND candidate.start_time>?
            AND NOT EXISTS (SELECT 1 FROM bookings b JOIN slots occupied ON occupied.id=b.slot_id WHERE b.id<>? AND
                (occupied.id=candidate.id OR (b.status IN ('pending','approved') AND (occupied.mentor_id=candidate.mentor_id OR b.user_id=?)
                    AND occupied.start_time<candidate.end_time AND occupied.end_time>candidate.start_time))) ORDER BY candidate.start_time,candidate.id`).all(booking.mentor_id, localNow, booking.id, booking.user_id)) {
            if (slot.id === booking.slot_id && !coordinating(state)) continue;
            if (!holds.some(hold => hold.bookingId !== String(booking.id) && (hold.proposal.mentorId === booking.mentor_id || hold.proposal.studentId === booking.user_id)
                && hold.proposal.start < slot.end_time && hold.proposal.end > slot.start_time)) slots.push({ id: String(slot.id), start: slot.start_time, end: slot.end_time });
        }
        const history = (await ctx.db.prepare("SELECT actor,action,after_json,created_at FROM lms_audit WHERE target=? AND action LIKE 'mentoring.%' ORDER BY id DESC LIMIT 30").all(String(booking.id)))
            .map(row => { const value = JSON.parse(row.after_json); return { action: row.action.slice(10), reason: value.reason, at: value.updatedAt, proposal: value.proposal, status: value.status }; });
        const deliveries = await ctx.db.prepare("SELECT id,state,error FROM lms_outbox WHERE kind='mentoring_coordination' AND source_id=? AND state IN ('failed','uncertain')").all(String(booking.id));
        return { id: String(booking.id), title: booking.label, mentor: booking.mentor_name, student: booking.user_name,
            start: booking.start_time, end: booking.end_time, bookingStatus: booking.status, role: ctx.role, editable, ...state, slots, history, deliveries };
    }
    async function list(id, user) {
        const ctx = await context(id, user);
        await prepare(id);
        const bookings = await ctx.db.prepare(`${bookingQuery} WHERE ${ctx.role === 'student' ? 'b.user_id' : 'm.discord_id'}=? AND b.status='approved' ORDER BY s.start_time DESC LIMIT 100`).all(ctx.discordId);
        return { sessions: await Promise.all(bookings.map(booking => view(ctx, booking))) };
    }
    async function read(id, bookingId, user) {
        recordId.parse(bookingId);
        const ctx = await context(id, user);
        await getBooking(ctx, bookingId);
        await prepare(id);
        return view(ctx, await getBooking(ctx, bookingId));
    }
    async function act(id, bookingId, user, body) {
        recordId.parse(bookingId);
        const input = inputSchema.parse(body), ctx = await context(id, user), { db, meta } = ctx;
        if (meta.archivedAt !== null) throw new ApiError(409, '보관된 워크스페이스입니다.');
        const digest = createHash('sha256').update(JSON.stringify({ bookingId, userId: user.id, input })).digest('hex');
        const receiptId = `${user.id}:${input.eventId}`;
        // All web and bot slot mutations share BEGIN IMMEDIATE / the PG workspace write lock.
        await db.exec('BEGIN IMMEDIATE');
        try {
            const receipt = await db.prepare("SELECT data FROM lms_records WHERE kind='mentoringCoordinationReceipt' AND id=?").get(receiptId);
            if (receipt) {
                const previous = JSON.parse(receipt.data);
                if (previous.digest !== digest) throw new ApiError(409, '이미 처리한 요청과 내용이 다릅니다. 최신 상태를 확인하세요.');
                await db.exec('COMMIT');
                return { ok: true, duplicate: true };
            }
            const booking = await getBooking(ctx, bookingId), state = await coordinationState(db, bookingId);
            if (booking.status !== 'approved') throw new ApiError(409, '승인된 예약만 재조율할 수 있습니다.');
            if (['propose', 'accept'].includes(input.action) && !(await onlineMentors(main, workspaces, id)).some(mentor => mentor.id === booking.mentor_id)) throw new ApiError(403, '현재 조 담당 멘토가 담당하는 예약만 재조율할 수 있습니다.');
            if (state.status === 'proposed' && state.proposal.expiresAt <= now()) {
                await expire(db, meta, booking, state);
                await db.exec('COMMIT');
                throw new ApiError(409, '제안 기한이 지났습니다. 최신 상태를 확인하고 다시 제안하세요.');
            }
            if (state.version !== input.version) throw new ApiError(409, '상대방이 일정을 변경했습니다. 최신 상태를 확인하세요.');
            if (!coordinating(state) && mentoringMillis(booking.start_time) <= now()) throw new ApiError(409, '이미 시작된 멘토링은 재조율할 수 없습니다.');
            if (input.action !== 'accept' && !input.reason) throw new ApiError(422, '사유를 입력하세요.');
            if (['propose', 'reject', 'withdraw'].includes(input.action)) {
                if (typeof input.originalAvailable !== 'boolean') throw new ApiError(422, '기존 일정 참석 가능 여부를 선택하세요.');
                state.unavailable = state.unavailable.filter(role => role !== ctx.role);
                if (!input.originalAvailable) state.unavailable.push(ctx.role);
            }
            if (input.action === 'propose') {
                if (!input.slotId) throw new ApiError(422, '변경할 시간을 선택하세요.');
                const slot = await db.prepare('SELECT * FROM slots WHERE CAST(id AS TEXT)=?').get(input.slotId);
                if (slot?.id === booking.slot_id && !coordinating(state)) throw new ApiError(422, '변경할 다른 시간을 선택하세요.');
                if (!await freeSlot(db, booking, slot, await coordinationHolds(db, now()))) throw new ApiError(409, '해당 시간은 예약하거나 변경할 수 없습니다. 다른 시간을 선택하세요.');
                const oldStart = mentoringMillis(booking.start_time);
                state.proposal = { id: randomUUID(), by: ctx.role, slotId: String(slot.id), mentorId: booking.mentor_id, studentId: booking.user_id,
                    start: slot.start_time, end: slot.end_time, reason: input.reason,
                    expiresAt: Math.min(now() + 24 * 3600000, mentoringMillis(slot.start_time), oldStart > now() ? oldStart : Infinity) };
                state.status = 'proposed';
            } else if (input.action === 'cancel') {
                const historyId = `cancelled-${randomUUID()}`;
                await db.prepare('INSERT INTO lms_booking_history(id,data) VALUES(?,?)').run(historyId, JSON.stringify({ id: historyId, title: booking.label, mentor: booking.mentor_name, mentorId: String(booking.mentor_id), team: booking.user_name,
                    date: booking.start_time.slice(0, 10), time: booking.start_time.slice(11, 16), endDate: booking.end_time.slice(0, 10), endTime: booking.end_time.slice(11, 16), status: '취소' }));
                await db.prepare('DELETE FROM reminders WHERE booking_id=?').run(booking.id);
                await db.prepare('DELETE FROM bookings WHERE id=?').run(booking.id);
                state.status = 'cancelled'; state.proposal = null;
            } else {
                if (state.status !== 'proposed') throw new ApiError(409, '응답할 변경 제안이 없습니다.');
                if ((input.action === 'withdraw') !== (state.proposal.by === ctx.role)) throw new ApiError(403, input.action === 'withdraw' ? '본인이 보낸 제안만 철회할 수 있습니다.' : '상대방의 제안에만 응답할 수 있습니다.');
                if (input.action === 'accept') {
                    const slot = await db.prepare('SELECT * FROM slots WHERE CAST(id AS TEXT)=?').get(state.proposal.slotId);
                    if (!await freeSlot(db, booking, slot, await coordinationHolds(db, now())) || slot.start_time !== state.proposal.start || slot.end_time !== state.proposal.end)
                        throw new ApiError(409, '제안 시간이 변경되었거나 예약할 수 없습니다. 다시 제안하세요.');
                    await db.prepare('UPDATE bookings SET slot_id=? WHERE id=?').run(slot.id, booking.id);
                    await db.prepare('DELETE FROM reminders WHERE booking_id=?').run(booking.id);
                    booking.slot_id = slot.id; booking.start_time = slot.start_time; booking.end_time = slot.end_time; booking.label = slot.label;
                    state.unavailable = [];
                }
                state.proposal = null;
                state.status = state.unavailable.length || mentoringMillis(booking.start_time) <= now() ? 'needs_coordination' : 'confirmed';
            }
            await save(db, booking, state, input.action, ctx.discordId, input.reason);
            await notify(db, meta, booking, state, input.action, ctx.discordId, input.reason);
            await db.prepare("UPDATE lms_outbox SET state='cancelled',claim=NULL,error='schedule_changed' WHERE kind='mentoring_feedback' AND source_id=? AND state IN ('pending','failed','reconcile','uncertain')").run(bookingId);
            await db.prepare("INSERT INTO lms_records(kind,id,data) VALUES('mentoringCoordinationReceipt',?,?)").run(receiptId, JSON.stringify({ digest }));
            await db.exec('COMMIT');
            return { ok: true };
        } catch (error) { try { await db.exec('ROLLBACK'); } catch { /* Expiry has already committed. */ } throw error; }
    }
    async function retry(id, bookingId, deliveryId, user) {
        const ctx = await context(id, user);
        await getBooking(ctx, bookingId);
        if (ctx.meta.archivedAt !== null) throw new ApiError(409, '보관된 워크스페이스입니다.');
        await prepare(id);
        const result = await ctx.db.prepare(`UPDATE lms_outbox SET state=CASE WHEN state='failed' THEN 'pending' ELSE 'reconcile' END,claim=NULL,error=''
            WHERE id=? AND source_id=? AND kind='mentoring_coordination' AND state IN ('failed','uncertain')`).run(deliveryId, bookingId);
        if (!result.changes) throw new ApiError(409, '재시도할 알림이 없습니다.');
        return { ok: true };
    }
    async function discord(body, operation) {
        const envelope = z.object({ guildId: snowflake, discordId: snowflake, bookingId: recordId.optional(), input: inputSchema.optional() }).strict().parse(body);
        const id = (await main.prepare('SELECT workspace_id FROM lms_workspace_guilds WHERE guild_id=?').get(envelope.guildId))?.workspace_id;
        const user = await main.prepare('SELECT id,username,platform_role AS role FROM lms_users WHERE discord_id=?').get(envelope.discordId);
        if (!id || !user) throw new ApiError(403, 'LMS 계정과 Discord 인증을 확인하세요.');
        if (operation === 'list') return api.list(id, user);
        if (!envelope.bookingId) throw new ApiError(422, '예약을 선택하세요.');
        if (operation === 'read') return api.read(id, envelope.bookingId, user);
        if (operation === 'act') return api.act(id, envelope.bookingId, user, envelope.input);
        throw new ApiError(404, '지원하지 않는 작업입니다.');
    }
    const api = { list: serial(list), read: serial(read), act: serial(act), retry: serial(retry), prepare: serial(prepare), discord };
    return api;
}

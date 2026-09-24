import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './store.mjs';

const snowflake = z.string().regex(/^\d{17,20}$/);
const endMillis = value => Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}+09:00`);
export function createMentoringFeedback(main, workspaces, { now = Date.now } = {}) {
    async function prepare(id) {
        const meta = await workspaces.metadata(id);
        if (meta.archivedAt !== null || meta.guildIds.length !== 1) return;
        const db = (await workspaces.open(id)).db;
        await db.exec('BEGIN IMMEDIATE');
        try {
            const { activated_at: activatedAt } = await db.prepare('SELECT activated_at FROM lms_mentoring_feedback_control WHERE id=1').get();
            const bookings = await db.prepare(`SELECT b.id,b.user_id,b.user_name,b.status,s.start_time,s.end_time,s.label,
                m.discord_id AS mentor_discord,m.name AS mentor_name FROM bookings b JOIN slots s ON s.id=b.slot_id JOIN mentors m ON m.id=s.mentor_id
                WHERE b.status IN ('approved','completed')`).all();
            for (const booking of bookings) {
                const ended = endMillis(booking.end_time);
                if (!Number.isFinite(ended) || ended < activatedAt || ended > now()) continue;
                for (const [role, discordId, name] of [['mentor', booking.mentor_discord, booking.mentor_name], ['mentee', booking.user_id, booking.user_name]]) {
                    if (!snowflake.safeParse(discordId).success) continue;
                    if (await db.prepare('SELECT id FROM lms_mentoring_feedback_requests WHERE booking_id=? AND role=?').get(String(booking.id), role)) continue;
                    const requestId = randomUUID();
                    await db.prepare('INSERT INTO lms_mentoring_feedback_requests VALUES(?,?,?,?,?,?)').run(requestId, String(booking.id), role, discordId, name, now());
                    const payload = { title: '멘토링 내용을 남겨 주세요', audience: 'individual', targetId: discordId,
                        description: `${meta.name}\n${booking.label}\n${booking.start_time.replace('T', ' ')} – ${booking.end_time.replace('T', ' ')} (한국시간)\n${role === 'mentor' ? '멘토' : '멘티'}: ${name}\n\n어떤 내용을 멘토링했나요? 다룬 주제, 주요 피드백, 다음 할 일을 적어 주세요.\n아래 버튼을 누르거나 이 안내 메시지에 ‘답장’해 주세요. 답변은 DB에 저장되며 웹에서 관리자와 담당 멘토가 확인합니다. 추가 답변도 별도로 보관합니다.` };
                    await db.prepare('INSERT INTO lms_outbox(id,event_key,kind,source_id,guild_id,channel_id,payload,actor,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
                        .run(requestId, `mentoring-feedback:${booking.id}:${role}`, 'mentoring_feedback', String(booking.id), meta.guildIds[0], `dm:${discordId}`, JSON.stringify(payload), 'scheduler', now());
                }
            }
            await db.prepare(`UPDATE lms_outbox SET state='cancelled',claim=NULL,error='booking_removed' WHERE kind='mentoring_feedback'
                AND state IN ('pending','failed','reconcile','uncertain') AND NOT EXISTS
                (SELECT 1 FROM bookings b WHERE CAST(b.id AS TEXT)=lms_outbox.source_id AND b.status IN ('approved','completed'))`).run();
            await db.exec('COMMIT');
        } catch (error) { await db.exec('ROLLBACK'); throw error; }
    }
    async function access(id, bookingId, user) {
        await workspaces.requireRole(id, user, ['admin', 'instructor']);
        const data = await workspaces.role(id, user) === 'admin' ? await workspaces.snapshot(id) : await workspaces.teaching(id, user);
        const booking = data.sessions.find(session => session.id === bookingId);
        if (!booking) throw new ApiError(404, '담당 범위에서 멘토링 일정을 찾을 수 없습니다.');
        return { db: (await workspaces.open(id)).db, booking };
    }
    async function read(id, bookingId, user) {
        const { db, booking } = await access(id, bookingId, user);
        const requests = await db.prepare(`SELECT r.*,o.state,o.error,o.attempts,o.message_id,o.completed_at FROM lms_mentoring_feedback_requests r
            JOIN lms_outbox o ON o.id=r.id WHERE r.booking_id=? ORDER BY r.role`).all(bookingId);
        const { activated_at: activatedAt } = await db.prepare('SELECT activated_at FROM lms_mentoring_feedback_control WHERE id=1').get();
        return { activatedAt, endAt: booking.endDate && booking.endTime ? `${booking.endDate}T${booking.endTime}:00+09:00` : null,
            requests: await Promise.all(requests.map(async row => ({ id: row.id, role: row.role, name: row.name, state: row.state, error: row.error,
                sentAt: row.completed_at, responses: await db.prepare('SELECT event_id AS id,content,submitted_at AS submittedAt FROM lms_mentoring_feedback_responses WHERE request_id=? ORDER BY submitted_at,event_id').all(row.id) }))) };
    }
    async function submit(body) {
        const input = z.object({ guildId: snowflake, requestId: z.uuid(), discordId: snowflake, eventId: snowflake, content: z.string().trim().min(1).max(4000) }).strict().parse(body);
        const id = (await main.prepare('SELECT workspace_id FROM lms_workspace_guilds WHERE guild_id=?').get(input.guildId))?.workspace_id;
        if (!id || (await workspaces.metadata(id)).archivedAt !== null) throw new ApiError(404, '사용할 수 없는 멘토링 요청입니다.');
        const db = (await workspaces.open(id)).db;
        await db.exec('BEGIN IMMEDIATE');
        try {
            const request = await db.prepare(`SELECT r.*,o.state,o.attempts FROM lms_mentoring_feedback_requests r JOIN lms_outbox o ON o.id=r.id
                WHERE r.id=? AND o.guild_id=?`).get(input.requestId, input.guildId);
            if (!request || request.discord_id !== input.discordId) throw new ApiError(403, '본인에게 발송된 멘토링 요청에만 답변할 수 있습니다.');
            const booking = await db.prepare('SELECT status FROM bookings WHERE CAST(id AS TEXT)=?').get(request.booking_id);
            if (!booking || !['approved', 'completed'].includes(booking.status) || request.state === 'cancelled' || !request.attempts)
                throw new ApiError(409, '취소되었거나 아직 발송되지 않은 멘토링 요청입니다.');
            const previous = await db.prepare('SELECT * FROM lms_mentoring_feedback_responses WHERE event_id=?').get(input.eventId);
            if (previous && (previous.request_id !== request.id || previous.content !== input.content)) throw new ApiError(409, '이미 처리된 응답입니다. 새 답변으로 제출하세요.');
            await db.prepare('INSERT OR IGNORE INTO lms_mentoring_feedback_responses VALUES(?,?,?,?)').run(input.eventId, request.id, input.content, now());
            await db.exec('COMMIT');
            return { ok: true, alreadyRecorded: Boolean(previous) };
        } catch (error) { await db.exec('ROLLBACK'); throw error; }
    }
    async function retry(id, bookingId, requestId, user) {
        const { db } = await access(id, bookingId, user);
        if ((await workspaces.metadata(id)).archivedAt !== null) throw new ApiError(409, '보관된 워크스페이스입니다.');
        await prepare(id);
        const result = await db.prepare(`UPDATE lms_outbox SET state=CASE WHEN state='failed' THEN 'pending' ELSE 'reconcile' END,claim=NULL,error=''
            WHERE id=? AND kind='mentoring_feedback' AND source_id=? AND state IN ('failed','uncertain')`).run(requestId, bookingId);
        if (!result.changes) throw new ApiError(409, '실패하거나 발송 결과 확인이 필요한 DM만 재시도할 수 있습니다.');
        return read(id, bookingId, user);
    }
    return { prepare, read, submit, retry };
}

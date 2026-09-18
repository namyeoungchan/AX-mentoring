import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
const short = z.string().max(300);
const optionalText = z.string().max(20000).nullable().optional();
const count = z.number().int().nonnegative();
const recordId = z.number().int().positive();
const rows = shape => z.array(z.object(shape)).max(1000);
const schema = z.object({
    sourceId: z.string().regex(/^[a-z0-9-]{1,64}$/), name: short,
    capturedAt: z.iso.datetime({ offset: true }), rowLimit: z.literal(1000),
    bot: z.object({ name: short, ready: z.boolean(), latencyMs: count.nullable(), guildId: z.string().regex(/^\d{17,20}$/), guildName: short.nullable(), memberCount: count.nullable() }),
    counts: z.object({ mentors: count, bookings: count, assignments: count, submissions: count, onboarding_progress: count, pending_bookings: count }),
    mentors: rows({ id: recordId, name: short, discord_id: z.string(), bio: optionalText }),
    bookings: rows({ id: recordId, user_name: short, status: short, label: short, start_time: short, end_time: short, mentor_name: short }),
    assignments: rows({ id: recordId, week: z.number().int(), title: short, due_date: short, type: short, is_active: z.number().int().min(0).max(1), submitted: count }),
    submissions: rows({ id: recordId, assignment_id: recordId, user_name: short, team: short, content: optionalText, link: z.string().max(4000).nullable(), submitted_at: short, assignment_title: short }),
});
export async function createRenderSync(db, { token = '', sourceId = 'asan-ax', now = Date.now } = {}) {
    if (token && token.length < 32)
        throw new Error('LEARNINGOPS_SYNC_TOKEN must contain at least 32 characters');
    await db.exec('CREATE TABLE IF NOT EXISTS lms_remote_snapshots (source_id TEXT PRIMARY KEY, received_at TEXT NOT NULL, payload TEXT NOT NULL)');
    const digest = value => createHash('sha256').update(value).digest();
    function authorized(header) { return token.length >= 32 && typeof header === 'string' && header.startsWith('Bearer ') && timingSafeEqual(digest(header.slice(7)), digest(token)); }
    async function ingest(raw) {
        const payload = schema.parse(raw);
        if (payload.sourceId !== sourceId)
            throw Object.assign(new Error('등록된 데이터 소스가 아닙니다.'), { status: 403 });
        const timestamp = Date.parse(payload.capturedAt);
        if (Math.abs(timestamp - now()) > 5 * 60000)
            throw Object.assign(new Error('동기화 시각이 유효하지 않습니다.'), { status: 422 });
        for (const key of ['mentors', 'bookings', 'assignments', 'submissions']) {
            if (payload[key].length !== Math.min(payload.counts[key], payload.rowLimit) || new Set(payload[key].map(row => row.id)).size !== payload[key].length)
                throw Object.assign(new Error('데이터 건수가 일치하지 않습니다.'), { status: 422 });
        }
        const previous = await (db.prepare('SELECT payload FROM lms_remote_snapshots WHERE source_id=?')).get(sourceId);
        if (previous && Date.parse(JSON.parse(previous.payload).capturedAt) >= timestamp)
            throw Object.assign(new Error('이미 수신했거나 이전에 생성된 데이터입니다.'), { status: 409 });
        await (db.prepare('INSERT INTO lms_remote_snapshots VALUES(?,?,?) ON CONFLICT(source_id) DO UPDATE SET received_at=excluded.received_at,payload=excluded.payload')).run(sourceId, new Date(now()).toISOString(), JSON.stringify(payload));
        return { ok: true };
    }
    async function read() {
        const row = await (db.prepare('SELECT * FROM lms_remote_snapshots WHERE source_id=?')).get(sourceId);
        if (!row)
            return { configured: Boolean(token), sourceId, state: 'waiting', snapshot: null, receivedAt: null };
        const snapshot = JSON.parse(row.payload);
        const stale = now() - Date.parse(row.received_at) > 180000 || now() - Date.parse(snapshot.capturedAt) > 180000;
        return { configured: Boolean(token), sourceId, state: stale ? 'stale' : 'synced', snapshot, receivedAt: row.received_at };
    }
    return { authorized, ingest, read };
}

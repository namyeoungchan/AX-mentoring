import { createHash } from 'node:crypto';
export const sessionKey = s => createHash('sha256').update(JSON.stringify([s.courseId, s.date, s.period])).digest('hex');
export const koreanDate = ms => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
export async function readSession(db, selected) {
    const row = await db.prepare("SELECT data FROM lms_records WHERE kind='attendanceSession' AND id=?").get(sessionKey(selected));
    return row ? JSON.parse(row.data) : null;
}
export async function writeSession(db, session) {
    await db.prepare("INSERT INTO lms_records(kind,id,data) VALUES('attendanceSession',?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data").run(session.id, JSON.stringify(session));
}

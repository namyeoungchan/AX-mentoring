import { z } from 'zod';
import { ApiError } from './store.mjs';

const kind = 'announcement';
const audiences = ['student', 'instructor', 'admin'];
const date = z.union([z.literal(''), z.string().date()]);
// Inline images keep the record self-contained; the client downsizes before upload.
const image = z.union([z.literal(''), z.string().max(1_500_000).regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/, '이미지는 PNG, JPG, WEBP, GIF만 사용할 수 있습니다.')]);
const link = z.union([z.literal(''), z.string().trim().max(500).url().refine(v => /^https?:\/\//i.test(v), '링크는 http 또는 https 주소만 사용할 수 있습니다.')]);
const fields = {
    placement: z.enum(['banner', 'popup']), title: z.string().trim().min(1).max(100), body: z.string().trim().max(1000),
    image, linkUrl: link, linkLabel: z.string().trim().max(30), audience: z.array(z.enum(audiences)).min(1).max(audiences.length),
    startDate: date, endDate: date, enabled: z.boolean(),
};
const createInput = z.object({ id: z.uuid(), ...fields }).strict();
const editInput = z.object({ revision: z.number().int().positive(), ...fields }).strict();
const removeInput = z.object({ revision: z.number().int().positive() }).strict();
const kstDate = timestamp => new Date(timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

// Workspace admins curate the main-screen banners and popups shown to members.
export function createAnnouncements(workspaces, { now = Date.now } = {}) {
    async function context(id, user, writing = false) {
        await workspaces.requireRole(id, user, ['admin']);
        const meta = await workspaces.requireAccess(id, user);
        if (writing && meta.archivedAt !== null) throw new ApiError(409, '보관된 워크스페이스의 배너와 팝업은 변경할 수 없습니다.');
        return { db: (await workspaces.open(id)).db, archived: meta.archivedAt !== null };
    }
    async function all(db) {
        return (await db.prepare('SELECT data FROM lms_records WHERE kind=?').all(kind)).map(row => JSON.parse(row.data))
            .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    }
    async function read(db, id) {
        const row = await db.prepare('SELECT data FROM lms_records WHERE kind=? AND id=?').get(kind, id);
        return row ? JSON.parse(row.data) : null;
    }
    function validate(input) {
        if (input.startDate && input.endDate && input.endDate < input.startDate) throw new ApiError(422, '종료일은 시작일 이후로 입력하세요.');
        if (input.linkLabel && !input.linkUrl) throw new ApiError(422, '버튼 문구를 쓰려면 링크 주소도 입력하세요.');
    }
    function summary(record) {
        const { createRequest: _request, ...result } = record;
        return result;
    }
    // Audit rows stay small: the image is recorded only as present or absent.
    const audited = record => record && JSON.stringify({ ...summary(record), image: record.image ? '(이미지)' : '' });
    async function audit(db, user, action, target, before, after) {
        await db.prepare('INSERT INTO lms_audit(actor,action,target,before_json,after_json) VALUES(?,?,?,?,?)')
            .run(user.username, action, target, before ? audited(before) : 'null', after ? audited(after) : 'null');
    }
    async function list(id, user) {
        const c = await context(id, user);
        return { canEdit: !c.archived, today: kstDate(now()), announcements: (await all(c.db)).map(summary) };
    }
    async function active(id, user) {
        const meta = await workspaces.requireAccess(id, user), today = kstDate(now());
        const shown = (await all((await workspaces.open(id)).db)).filter(v => v.enabled && v.audience.includes(meta.role)
            && (!v.startDate || v.startDate <= today) && (!v.endDate || today <= v.endDate));
        const visible = ({ id: key, placement, title, body, image, linkUrl, linkLabel, revision }) => ({ id: key, placement, title, body, image, linkUrl, linkLabel, revision });
        return { banners: shown.filter(v => v.placement === 'banner').map(visible), popups: shown.filter(v => v.placement === 'popup').map(visible) };
    }
    async function create(id, raw, user) {
        const input = createInput.parse(raw), c = await context(id, user, true);
        validate(input);
        const createRequest = JSON.stringify(input);
        await c.db.exec('BEGIN IMMEDIATE');
        try {
            const timestamp = now();
            const record = { ...input, revision: 1, createdAt: timestamp, updatedAt: timestamp, createdBy: user.id, updatedBy: user.id, createRequest };
            const inserted = await c.db.prepare('INSERT OR IGNORE INTO lms_records(kind,id,data) VALUES(?,?,?)').run(kind, input.id, JSON.stringify(record));
            const stored = inserted.changes ? record : await read(c.db, input.id);
            if (!inserted.changes && (stored.createdBy !== user.id || stored.createRequest !== createRequest))
                throw new ApiError(409, '이미 사용된 등록 요청입니다. 목록을 새로고침하세요.');
            if (inserted.changes) await audit(c.db, user, 'announcement.create', input.id, null, record);
            await c.db.exec('COMMIT');
            return summary(stored);
        } catch (error) { await c.db.exec('ROLLBACK'); throw error; }
    }
    async function edit(id, recordId, raw, user) {
        const input = editInput.parse(raw), c = await context(id, user, true);
        validate(input);
        await c.db.exec('BEGIN IMMEDIATE');
        try {
            const before = await read(c.db, recordId);
            if (!before) throw new ApiError(404, '배너 또는 팝업을 찾을 수 없습니다.');
            if (before.revision !== input.revision) throw new ApiError(409, '다른 관리자가 먼저 수정했습니다. 목록을 새로고침한 뒤 다시 열어 주세요.');
            const after = { ...before, ...input, revision: before.revision + 1, updatedAt: now(), updatedBy: user.id };
            const changed = await c.db.prepare('UPDATE lms_records SET data=? WHERE kind=? AND id=? AND data=?')
                .run(JSON.stringify(after), kind, recordId, JSON.stringify(before));
            if (!changed.changes) throw new ApiError(409, '배너 또는 팝업이 변경되었습니다. 목록을 새로고침하세요.');
            await audit(c.db, user, 'announcement.update', recordId, before, after);
            await c.db.exec('COMMIT');
            return summary(after);
        } catch (error) { await c.db.exec('ROLLBACK'); throw error; }
    }
    async function remove(id, recordId, raw, user) {
        const input = removeInput.parse(raw), c = await context(id, user, true);
        await c.db.exec('BEGIN IMMEDIATE');
        try {
            const before = await read(c.db, recordId);
            if (!before) throw new ApiError(404, '배너 또는 팝업을 찾을 수 없습니다.');
            if (before.revision !== input.revision) throw new ApiError(409, '다른 관리자가 먼저 수정했습니다. 목록을 새로고침한 뒤 다시 시도하세요.');
            await c.db.prepare('DELETE FROM lms_records WHERE kind=? AND id=?').run(kind, recordId);
            await audit(c.db, user, 'announcement.delete', recordId, before, null);
            await c.db.exec('COMMIT');
            return { id: recordId };
        } catch (error) { await c.db.exec('ROLLBACK'); throw error; }
    }
    return { list, active, create, edit, remove };
}

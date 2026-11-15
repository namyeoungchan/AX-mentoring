import { randomUUID } from 'node:crypto';

// Membership and workspace-scoped verification are the authority, never a legacy mentor row.
export async function onlineMentors(main, workspaces, id) {
    const meta = await workspaces.metadata(id);
    if (meta.archivedAt !== null || meta.guildIds.length !== 1) return [];
    const users = await main.prepare(`SELECT u.id,u.discord_id FROM lms_users u
        JOIN lms_workspace_members m ON m.user_id=u.id
        JOIN lms_mentor_scopes s ON s.workspace_id=m.workspace_id AND s.subject_id=u.id
        JOIN lms_workspace_verifications v ON v.workspace_id=m.workspace_id AND v.user_id=u.id AND v.discord_id=u.discord_id
        WHERE m.workspace_id=? AND m.role='instructor' AND s.kind='group' AND v.guild_id=?`).all(id, meta.guildIds[0]);
    const db = (await workspaces.open(id)).db;
    const mentors = await db.prepare('SELECT * FROM mentors WHERE is_active=1').all();
    return users.flatMap(user => mentors.filter(mentor => mentor.discord_id === user.discord_id).map(mentor => ({ ...mentor, userId: user.id })));
}

export async function onlineAvailability(main, workspaces, id, userId, now = Date.now()) {
    const member = await main.prepare(`SELECT m.role,s.kind FROM lms_workspace_members m
        LEFT JOIN lms_mentor_scopes s ON s.workspace_id=m.workspace_id AND s.subject_id=m.user_id
        WHERE m.workspace_id=? AND m.user_id=?`).get(id, userId);
    const required = member?.role === 'instructor' && member.kind === 'group';
    if (!required) return { required: false, configured: false, futureSlots: 0 };
    const mentor = (await onlineMentors(main, workspaces, id)).find(row => row.userId === userId);
    return { required, ...await slotStatus(workspaces, id, mentor, now) };
}

async function slotStatus(workspaces, id, mentor, now) {
    if (!mentor) return { configured: false, futureSlots: 0 };
    const db = (await workspaces.open(id)).db;
    // Legacy slot times are local Korean time without an offset.
    const localNow = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 19);
    const { n } = await db.prepare('SELECT COUNT(*) AS n FROM slots WHERE mentor_id=? AND is_active=1 AND start_time>?').get(mentor.id, localNow);
    return { configured: Number(n) > 0, futureSlots: Number(n) };
}

export function createOnlineMentoring(main, workspaces, { now = Date.now } = {}) {
    async function prepare(id) {
        const meta = await workspaces.metadata(id);
        if (meta.archivedAt !== null || meta.guildIds.length !== 1) return;
        const db = (await workspaces.open(id)).db, missing = new Set();
        for (const mentor of await onlineMentors(main, workspaces, id)) {
            if ((await slotStatus(workspaces, id, mentor, now())).configured) continue;
            missing.add(mentor.userId);
            const payload = { title: '온라인 멘토링 가능 시간을 등록해 주세요',
                description: `${meta.name} · 조 담당 멘토 안내\nLMS 인증은 완료되었습니다. 아래 버튼에서 시간대와 예약 가능한 날짜를 등록해 주세요. 모든 시간은 한국 시간(KST)입니다.\n이미 온보딩을 마쳤어도 가능 시간을 등록해야 수강생이 예약할 수 있습니다.`,
                audience: 'individual', targetId: mentor.discord_id };
            await db.prepare(`INSERT OR IGNORE INTO lms_outbox(id,event_key,kind,source_id,guild_id,channel_id,payload,actor,created_at)
                VALUES(?,?,?,?,?,?,?,?,?)`).run(randomUUID(), `mentor-availability:${meta.guildIds[0]}:${mentor.userId}`, 'mentor_availability', mentor.userId, meta.guildIds[0], `dm:${mentor.discord_id}`, JSON.stringify(payload), 'scheduler', now());
        }
        for (const row of await db.prepare("SELECT id,source_id FROM lms_outbox WHERE kind='mentor_availability' AND state IN ('pending','failed','reconcile','uncertain')").all()) {
            if (!missing.has(row.source_id)) await db.prepare("UPDATE lms_outbox SET state='cancelled',claim=NULL,error='no_longer_required' WHERE id=?").run(row.id);
        }
    }
    return { prepare };
}

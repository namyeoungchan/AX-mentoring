import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './store.mjs';
const koreanDate = ms => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
export function createAssignmentAlerts(main, workspaces, { now = Date.now } = {}) {
    async function roster(id) {
        const db = (await workspaces.open(id)).db, data = await workspaces.snapshot(id);
        const assignments = await (db.prepare('SELECT a.*,c.course_id FROM assignments a LEFT JOIN lms_assignment_courses c ON c.assignment_id=a.id ORDER BY a.id DESC')).all();
        const submissions = await (db.prepare('SELECT id,assignment_id,user_id,user_name,team,submitted_at FROM submissions')).all();
        return await Promise.all(assignments.map(async (a) => {
            const learners = data.learners.filter(l => l.courseId === a.course_id && l.status === '정상');
            const rows = submissions.filter(s => s.assignment_id === a.id);
            // Freeze known team identities so later team renames do not turn old work into missing work.
            for (const s of rows) {
                const team = data.teams.find(t => t.courseId === a.course_id && t.name === s.team);
                const target = a.type === 'team' ? team ? `team:${team.id}` : '' : `user:${s.user_id}`;
                if (target)
                    await (db.prepare('INSERT OR IGNORE INTO lms_submission_targets VALUES(?,?)')).run(s.id, target);
            }
            const mapped = await (db.prepare('SELECT t.submission_id,t.target_key FROM lms_submission_targets t JOIN submissions s ON s.id=t.submission_id WHERE s.assignment_id=?')).all(a.id);
            const completed = new Set(mapped.map(r => r.target_key));
            const targets = a.type === 'team'
                ? data.teams.filter(t => t.courseId === a.course_id && learners.some(l => l.team === t.name)).map(t => ({ key: `team:${t.id}`, name: t.name, audience: 'team', targetId: t.id, completed: completed.has(`team:${t.id}`) }))
                : learners.map(l => ({ key: l.discordId ? `user:${l.discordId}` : `learner:${l.id}`, name: l.name, learnerId: l.id, audience: 'individual', targetId: l.discordId, completed: !!l.discordId && completed.has(`user:${l.discordId}`) }));
            const revision = createHash('sha256').update(JSON.stringify([a.title, a.due_date, a.type, a.course_id, a.is_active, (await workspaces.metadata(id)).guildIds, targets.map(t => [t.key, t.name, t.learnerId, t.targetId, t.audience])])).digest('hex');
            const publishedAt = (await (db.prepare('SELECT created_at FROM lms_assignment_publications WHERE assignment_id=?')).get(a.id))?.created_at ?? null;
            return { revision, publishedAt, id: String(a.id), title: a.title, dueDate: a.due_date.slice(0, 10), active: !!a.is_active, type: a.type, courseId: a.course_id || '', targets, submitted: targets.filter(t => t.completed).length, total: targets.length, unmatchedSubmissions: rows.filter(s => !mapped.some(m => m.submission_id === s.id)).length };
        }));
    }
    async function read(id, user) {
        await workspaces.requireRole(id, user, ['admin']);
        const db = (await workspaces.open(id)).db;
        return { courses: (await workspaces.snapshot(id)).courses.map(c => ({ id: c.id, title: c.title })), policy: '개인별 1회 제출 유지 · 팀은 한 건 이상 제출하면 완료', assignments: await roster(id),
            deliveries: (await (db.prepare("SELECT id,kind,source_id AS assignmentId,state,attempts,error,message_id AS messageId,channel_id AS channelId,guild_id AS guildId,payload,created_at AS createdAt FROM lms_outbox WHERE kind IN ('submission','reminder','publication') ORDER BY created_at DESC,rowid DESC LIMIT 200")).all()).map(r => ({ ...r, payload: JSON.parse(r.payload) })) };
    }
    async function bind(id, assignmentId, body, user) {
        await workspaces.requireRole(id, user, ['admin']);
        const { courseId } = z.object({ courseId: z.string().min(1).max(200) }).strict().parse(body);
        if ((await workspaces.metadata(id)).archivedAt !== null)
            throw new ApiError(409, '보관된 워크스페이스입니다.');
        const db = (await workspaces.open(id)).db;
        if (!await (db.prepare('SELECT 1 FROM assignments WHERE id=?')).get(assignmentId) || !(await workspaces.snapshot(id)).courses.some(c => c.id === courseId))
            throw new ApiError(422, '과제와 과정을 확인하세요.');
        await db.exec('BEGIN IMMEDIATE');
        try {
            const previous = await (db.prepare('SELECT course_id FROM lms_assignment_courses WHERE assignment_id=?')).get(assignmentId);
            if (previous && previous.course_id !== courseId)
                throw new ApiError(409, '이미 연결한 과제의 과정은 변경할 수 없습니다.');
            await (db.prepare('INSERT OR IGNORE INTO lms_assignment_courses VALUES(?,?)')).run(assignmentId, courseId);
            await (db.prepare('INSERT INTO lms_audit(actor,action,target,after_json) VALUES(?,?,?,?)')).run(user.username || user.id, 'assignment.bind', assignmentId, JSON.stringify({ courseId }));
            await roster(id);
            await db.exec('COMMIT');
        }
        catch (e) {
            await db.exec('ROLLBACK');
            throw e;
        }
        return await read(id, user);
    }
    async function publish(id, assignmentId, body, user) {
        await workspaces.requireRole(id, user, ['admin']);
        const { revision } = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(body);
        if ((await workspaces.metadata(id)).archivedAt !== null)
            throw new ApiError(409, '보관된 워크스페이스입니다.');
        const db = (await workspaces.open(id)).db, guildId = (await workspaces.metadata(id)).guildIds[0];
        if (!guildId)
            throw new ApiError(409, 'Discord 서버를 먼저 연결하세요.');
        await db.exec('BEGIN IMMEDIATE');
        try {
            const a = (await roster(id)).find(a => a.id === assignmentId);
            if (!a)
                throw new ApiError(404, '과제를 찾을 수 없습니다.');
            if (a.publishedAt === null) {
                if (a.revision !== revision)
                    throw new ApiError(409, '과제 또는 대상이 변경되었습니다. 새로고침 후 확인하세요.');
                if (!a.active || !a.courseId || !a.targets.length)
                    throw new ApiError(422, '진행 중인 과제의 과정과 정상 수강생을 확인하세요.');
                for (const target of a.targets) {
                    const targetKey = target.audience === 'individual' ? `learner:${target.learnerId}` : target.key;
                    const payload = { title: '새 과제가 배포되었습니다', description: `${a.title}\n대상: ${target.name}\n마감: ${a.dueDate}\nLMS에서 과제를 확인하거나 Discord /과제 목록으로 확인해 주세요.`, assignmentId: a.id, dueDate: a.dueDate, audience: target.audience, targetId: target.targetId || '', learnerId: target.learnerId || '', targetKey, publicationGuildId: guildId };
                    await (db.prepare('INSERT OR IGNORE INTO lms_outbox(id,event_key,kind,source_id,guild_id,payload,actor,created_at) VALUES(?,?,?,?,?,?,?,?)')).run(randomUUID(), `publication:${a.id}:${targetKey}`, 'publication', a.id, guildId, JSON.stringify(payload), user.username || user.id, now());
                }
                await (db.prepare('INSERT INTO lms_assignment_publications VALUES(?,?,?)')).run(a.id, now(), user.username || user.id);
                await (db.prepare('INSERT INTO lms_audit(actor,action,target,after_json) VALUES(?,?,?,?)')).run(user.username || user.id, 'assignment.publish', a.id, JSON.stringify({ type: a.type, targets: a.total, revision }));
            }
            await db.exec('COMMIT');
        }
        catch (e) {
            await db.exec('ROLLBACK');
            throw e;
        }
        return await read(id, user);
    }
    async function prepare(id, resolveChannel) {
        const db = (await workspaces.open(id)).db, guildId = (await workspaces.metadata(id)).guildIds[0];
        if (!guildId)
            return;
        await db.exec('BEGIN IMMEDIATE');
        try {
            const assignments = await roster(id), tomorrow = koreanDate(now() + 86400000), hour = new Date(now() + 9 * 3600000).getUTCHours();
            // Catch up after restart during D-1 from 09:00 KST, once per assignment/target/deadline.
            if (hour >= 9)
                for (const a of assignments.filter(a => a.active && a.courseId && a.dueDate === tomorrow))
                    for (const target of a.targets.filter(t => !t.completed)) {
                        const payload = { title: '과제 마감 D-1 안내', description: `${a.title}\n마감: ${a.dueDate}\n${target.name}: 아직 제출된 과제가 없습니다. Web 제출 원장을 확인하세요.`, assignmentId: a.id, dueDate: a.dueDate, audience: target.audience, targetId: target.targetId, targetKey: target.key };
                        await (db.prepare('INSERT OR IGNORE INTO lms_outbox(id,event_key,kind,source_id,guild_id,payload,actor,created_at) VALUES(?,?,?,?,?,?,?,?)')).run(randomUUID(), `reminder:${a.id}:${a.dueDate}:${target.key}`, 'reminder', a.id, guildId, JSON.stringify(payload), 'scheduler', now());
                    }
            const resource = async (key, kind = 'channel') => {
                const row = await (main.prepare('SELECT data FROM lms_runtime_state WHERE guild_id=? AND kind=? AND record_key=?')).get(guildId, kind, key);
                return row ? String(JSON.parse(row.data).id || '') : '';
            };
            for (const row of await (db.prepare("SELECT * FROM lms_outbox WHERE kind IN ('submission','reminder','publication') AND state IN ('pending','failed')")).all()) {
                let channelId = '', error = '', payload = JSON.parse(row.payload);
                if (row.kind === 'submission') {
                    if (!assignments.some(a => a.id === row.source_id)) {
                        await (db.prepare("UPDATE lms_outbox SET state='cancelled',error='assignment_removed' WHERE id=?")).run(row.id);
                        continue;
                    }
                    try {
                        channelId = (await resolveChannel(id, 'submission')).channelId;
                    }
                    catch {
                        error = 'channel_unconfigured';
                    }
                }
                else {
                    const publication = row.kind === 'publication';
                    const a = assignments.find(a => a.id === row.source_id);
                    const target = a?.targets.find(t => publication && payload.audience === 'individual' ? t.learnerId === payload.learnerId : t.key === payload.targetKey);
                    const stale = !a?.active || !target || (publication ? payload.publicationGuildId !== guildId || (!!payload.targetId && payload.targetId !== target.targetId) : target.completed || a.dueDate !== payload.dueDate || a.dueDate !== tomorrow);
                    if (stale) {
                        await (db.prepare("UPDATE lms_outbox SET state='cancelled',error=? WHERE id=?")).run(publication ? 'publication_target_changed' : 'no_longer_due', row.id);
                        continue;
                    }
                    if (publication && !payload.targetId)
                        payload.targetId = target.targetId || '';
                    if (payload.audience === 'team') {
                        channelId = await resource(`team-text:${payload.targetId}`);
                        payload.roleId = await resource(`team:${payload.targetId}`, 'role');
                        if (!payload.roleId)
                            channelId = '';
                    }
                    else {
                        const verified = await (main.prepare('SELECT 1 FROM lms_workspace_verifications v JOIN lms_workspace_members m ON m.workspace_id=v.workspace_id AND m.user_id=v.user_id JOIN lms_users u ON u.id=v.user_id AND u.discord_id=v.discord_id WHERE v.workspace_id=? AND v.guild_id=? AND v.discord_id=?')).get(id, guildId, payload.targetId || '');
                        if (verified)
                            channelId = `dm:${payload.targetId}`;
                    }
                    if (!channelId)
                        error = 'recipient_unavailable';
                }
                await (db.prepare('UPDATE lms_outbox SET guild_id=?,channel_id=?,payload=?,error=? WHERE id=?')).run(guildId, channelId, JSON.stringify(payload), row.state === 'pending' ? error : row.error, row.id);
            }
            await db.exec('COMMIT');
        }
        catch (e) {
            await db.exec('ROLLBACK');
            throw e;
        }
    }
    return { read, bind, publish, prepare };
}

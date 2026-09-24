import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './store.mjs';
const snowflake = z.string().regex(/^\d{17,20}$/);
const key = z.string().min(1).max(200);
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publicRow = row => row ? { id: row.id, kind: row.kind, state: row.state, attempts: row.attempts, channelId: row.channel_id, messageId: row.message_id, guildId: row.guild_id, error: row.error, actor: row.actor, createdAt: row.created_at, completedAt: row.completed_at } : null;
export function createOutbox(main, workspaces, { now = Date.now, prepare = () => { } } = {}) {
    async function access(id, user, write = false) {
        await workspaces.requireRole(id, user, ['admin']);
        if (write && (await workspaces.metadata(id)).archivedAt !== null)
            throw new ApiError(409, '보관된 워크스페이스입니다.');
        return (await workspaces.open(id)).db;
    }
    async function channel(id, kind = 'notice') {
        const guildId = (await workspaces.metadata(id)).guildIds[0];
        if (!guildId)
            throw new ApiError(409, 'Discord 서버를 연결하세요.');
        const templateId = kind === 'notice' ? 'notice' : 'assignment-dashboard';
        const plan = await (main.prepare('SELECT data FROM lms_discord_plans WHERE guild_id=?')).get(guildId);
        if (!plan || !JSON.parse(plan.data).channels.some(c => c.id === templateId && c.type === 'text'))
            throw new ApiError(409, '관리되는 발송 채널을 서버 구성에 추가하세요.');
        const done = await (main.prepare("SELECT results FROM lms_discord_jobs WHERE guild_id=? AND state='succeeded' ORDER BY completed_at DESC,rowid DESC LIMIT 1")).get(guildId);
        const channelId = done && JSON.parse(done.results).find(r => r.id === templateId)?.discordId;
        if (!channelId)
            throw new ApiError(409, 'Discord 서버 구성을 적용해 발송 채널을 확인하세요.');
        return { guildId, channelId };
    }
    async function expire(db) { await (db.prepare("UPDATE lms_outbox SET state='uncertain',claim=NULL,error='timeout' WHERE state='sending' AND lease_until<=?")).run(now()); }
    async function notices(id, user) {
        const db = await access(id, user);
        await expire(db);
        const data = await workspaces.snapshot(id);
        let destination = null, channelError = '';
        try {
            destination = await channel(id);
        }
        catch (e) {
            channelError = e.message;
        }
        return { destination, channelError, notices: await Promise.all(data.notices.map(async (notice) => {
                const payload = { title: notice.title, description: notice.content, course: data.courses.find(c => c.id === notice.courseId)?.title || '', target: '공통 공지 채널 · 멘션 없음' };
                const row = await (db.prepare("SELECT * FROM lms_outbox WHERE event_key=?")).get(`notice:${notice.id}`);
                return { ...notice, preview: row ? JSON.parse(row.payload) : payload, revision: fingerprint(notice), delivery: publicRow(row), attempts: row ? await (db.prepare('SELECT state,error,created_at AS createdAt FROM lms_outbox_attempts WHERE outbox_id=? ORDER BY id DESC LIMIT 20')).all(row.id) : [] };
            })) };
    }
    async function enqueueNotice(id, noticeId, body, user) {
        const { revision } = z.object({ revision: key }).strict().parse(body), db = await access(id, user, true);
        await db.exec('BEGIN IMMEDIATE');
        try {
            const data = await workspaces.snapshot(id), notice = data.notices.find(n => n.id === noticeId);
            if (!notice)
                throw new ApiError(404, '공지를 찾을 수 없습니다.');
            const previous = await (db.prepare('SELECT * FROM lms_outbox WHERE event_key=?')).get(`notice:${noticeId}`);
            if (!previous) {
                if (fingerprint(notice) !== revision)
                    throw new ApiError(409, '공지 내용이 변경되었습니다. 미리보기를 다시 확인하세요.');
                if (notice.target !== '과정 전체')
                    throw new ApiError(422, '관리자·멘토 전용 공지는 공통 채널에 게시할 수 없습니다. 과정 전체 공지만 발송하세요.');
                const { guildId, channelId } = await channel(id);
                const payload = { title: notice.title, description: notice.content, course: data.courses.find(c => c.id === notice.courseId)?.title || '', target: '공통 공지 채널 · 멘션 없음' };
                const jobId = randomUUID();
                await (db.prepare('INSERT INTO lms_outbox(id,event_key,kind,source_id,guild_id,channel_id,payload,actor,created_at) VALUES(?,?,?,?,?,?,?,?,?)')).run(jobId, `notice:${noticeId}`, 'notice', noticeId, guildId, channelId, JSON.stringify(payload), user.username || user.id, now());
                await (db.prepare('INSERT INTO lms_audit(actor,action,target,after_json) VALUES(?,?,?,?)')).run(user.username || user.id, 'notice.queue', noticeId, JSON.stringify({ jobId, channelId }));
            }
            await db.exec('COMMIT');
        }
        catch (e) {
            await db.exec('ROLLBACK');
            throw e;
        }
        return await notices(id, user);
    }
    async function retry(id, jobId, user) {
        const db = await access(id, user, true);
        await expire(db);
        const row = await (db.prepare('SELECT * FROM lms_outbox WHERE id=?')).get(jobId);
        if (!row || !['failed', 'uncertain'].includes(row.state))
            throw new ApiError(409, '실패하거나 결과 확인이 필요한 발송만 재시도하세요.');
        if (['submission', 'reminder', 'publication'].includes(row.kind) && !await db.prepare('SELECT 1 FROM assignments WHERE CAST(id AS TEXT)=?').get(row.source_id))
            throw new ApiError(409, '삭제된 과제의 알림은 다시 발송할 수 없습니다.');
        // Uncertain sends retain their original channel and only search for the prior message.
        const target = row.state === 'failed' && !['reminder', 'publication', 'mentor_availability', 'mentoring_feedback'].includes(row.kind) ? await channel(id, row.kind) : { guildId: row.guild_id, channelId: row.channel_id };
        await (db.prepare("UPDATE lms_outbox SET state=?,guild_id=?,channel_id=?,claim=NULL,error='' WHERE id=?")).run(row.state === 'failed' ? 'pending' : 'reconcile', target.guildId, target.channelId, jobId);
        await (db.prepare('INSERT INTO lms_audit(actor,action,target) VALUES(?,?,?)')).run(user.username || user.id, 'outbox.retry', jobId);
        return { ok: true };
    }
    async function manual(id, jobId, body, user) {
        const { messageUrl } = z.object({ messageUrl: z.string().url() }).strict().parse(body), db = await access(id, user, true);
        await expire(db);
        const row = await (db.prepare('SELECT * FROM lms_outbox WHERE id=?')).get(jobId);
        if (!row || row.state !== 'held')
            throw new ApiError(409, '먼저 수동 발송으로 전환해 자동 발송을 중지하세요.');
        const match = messageUrl.match(/^https:\/\/discord\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})$/);
        if (!match || match[1] !== row.guild_id || match[2] !== row.channel_id)
            throw new ApiError(422, '지정된 서버·채널의 메시지 링크를 입력하세요.');
        await db.exec('BEGIN IMMEDIATE');
        try {
            await (db.prepare("UPDATE lms_outbox SET state='manual',message_id=?,completed_at=?,actor=?,error='' WHERE id=?")).run(match[3], now(), user.username || user.id, jobId);
            await (db.prepare('INSERT INTO lms_audit(actor,action,target,before_json,after_json) VALUES(?,?,?,?,?)')).run(user.username || user.id, 'outbox.manual', jobId, JSON.stringify(publicRow(row)), JSON.stringify({ messageUrl }));
            await db.exec('COMMIT');
        }
        catch (e) {
            await db.exec('ROLLBACK');
            throw e;
        }
        return { ok: true };
    }
    async function hold(id, jobId, user) {
        const db = await access(id, user, true);
        await expire(db);
        const result = await (db.prepare("UPDATE lms_outbox SET state='held',claim=NULL WHERE id=? AND state IN ('pending','failed','uncertain')")).run(jobId);
        if (!result.changes)
            throw new ApiError(409, '발송 중이거나 완료된 기록은 수동 전환할 수 없습니다.');
        await (db.prepare('INSERT INTO lms_audit(actor,action,target) VALUES(?,?,?)')).run(user.username || user.id, 'outbox.hold', jobId);
        return { ok: true };
    }
    async function poll(body) {
        const { guildIds, capabilities } = z.object({ guildIds: z.array(snowflake).max(10000), capabilities: z.array(z.enum(['mentor_availability', 'mentoring_feedback'])).max(2).default([]) }).strict().parse(body);
        for (const guildId of new Set(guildIds)) {
            const id = (await (main.prepare('SELECT workspace_id FROM lms_workspace_guilds WHERE guild_id=?')).get(guildId))?.workspace_id;
            if (!id || (await workspaces.metadata(id)).archivedAt !== null)
                continue;
            await prepare(id, channel);
            const db = (await workspaces.open(id)).db;
            await db.exec('BEGIN IMMEDIATE');
            try {
                await expire(db);
                await db.prepare("UPDATE lms_outbox SET state='cancelled',claim=NULL,error='assignment_removed' WHERE kind IN ('submission','reminder','publication') AND state IN ('pending','failed','held','reconcile','uncertain') AND NOT EXISTS (SELECT 1 FROM assignments WHERE CAST(assignments.id AS TEXT)=lms_outbox.source_id)").run();
                const row = await (db.prepare("SELECT * FROM lms_outbox WHERE guild_id=? AND (kind<>'mentor_availability' OR ?=1) AND (kind<>'mentoring_feedback' OR ?=1) AND channel_id<>'' AND state IN ('pending','reconcile','uncertain') AND (state<>'uncertain' OR error='timeout') ORDER BY created_at,rowid LIMIT 1")).get(guildId, capabilities.includes('mentor_availability') ? 1 : 0, capabilities.includes('mentoring_feedback') ? 1 : 0);
                if (!row) {
                    await db.exec('COMMIT');
                    continue;
                }
                const claim = randomUUID(), reconcile = row.state !== 'pending';
                await (db.prepare("UPDATE lms_outbox SET state='sending',claim=?,lease_until=?,attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,?) WHERE id=?")).run(claim, now() + 120000, now(), row.id);
                await (db.prepare("INSERT INTO lms_outbox_attempts(outbox_id,state,error,created_at) VALUES(?,'sending','',?)")).run(row.id, now());
                await db.exec('COMMIT');
                return { job: { id: row.id, workspaceId: id, kind: row.kind, claim, guildId, channelId: row.channel_id, payload: JSON.parse(row.payload), nonce: fingerprint(row.id).slice(0, 24), reconcile, createdAt: row.first_attempt_at || now() } };
            }
            catch (e) {
                await db.exec('ROLLBACK');
                throw e;
            }
        }
        return { job: null };
    }
    async function complete(body) {
        const input = z.object({ workspaceId: key, id: key, claim: z.uuid(), state: z.enum(['sent', 'failed', 'uncertain']), messageId: z.union([snowflake, z.literal('')]).default(''), error: z.enum(['', 'permissions', 'channel_missing', 'rate_limit', 'timeout', 'discord_error', 'not_found', 'private_channel_required']).default('') }).strict().parse(body);
        const db = (await workspaces.open(input.workspaceId)).db;
        await expire(db);
        const row = await (db.prepare('SELECT * FROM lms_outbox WHERE id=?')).get(input.id);
        if (!row || row.state !== 'sending' || row.claim !== input.claim)
            throw new ApiError(409, '만료되거나 종료된 발송 요청입니다.');
        if (input.state === 'sent' ? !input.messageId || input.error : !!input.messageId || !input.error)
            throw new ApiError(422, '발송 결과를 확인하세요.');
        await db.exec('BEGIN IMMEDIATE');
        try {
            await (db.prepare('UPDATE lms_outbox SET state=?,message_id=?,error=?,completed_at=?,claim=NULL WHERE id=?')).run(input.state, input.messageId, input.error, input.state === 'sent' ? now() : null, input.id);
            await (db.prepare('INSERT INTO lms_outbox_attempts(outbox_id,state,error,created_at) VALUES(?,?,?,?)')).run(input.id, input.state, input.error, now());
            await (db.prepare('INSERT INTO lms_audit(actor,action,target,after_json) VALUES(?,?,?,?)')).run('discord-bot', 'outbox.complete', input.id, JSON.stringify({ state: input.state, messageId: input.messageId, error: input.error }));
            await db.exec('COMMIT');
        }
        catch (e) {
            await db.exec('ROLLBACK');
            throw e;
        }
        return { ok: true };
    }
    return { notices, enqueueNotice, retry, manual, hold, poll, complete, channel };
}

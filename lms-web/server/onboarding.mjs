import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './store.mjs';
const snowflake = z.string().regex(/^\d{17,20}$/);
const channelName = z.string().trim().min(1).max(70).regex(/^[\p{L}\p{N}_-]+$/u);
const settings = z.object({ guildId: snowflake, enabled: z.boolean(), courseIds: z.array(z.string().min(1).max(100)).max(50), welcomeText: z.string().trim().min(1).max(1500), onboardingChannel: channelName, introChannel: channelName, revision: z.string().max(64) }).strict();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const defaults = { enabled: false, courseIds: [], welcomeText: '서버 이용 순서\n1. 웹에서 가입 승인 상태와 Discord 인증을 확인하세요.\n2. 수강생은 아래 버튼으로 자기소개를 작성하세요. 멘토·운영자는 자기소개가 필요 없습니다.\n3. 웹에 배정된 팀과 채널을 확인하세요.\n팀 배정은 운영자가 관리합니다. 미배정 상태라면 운영자에게 문의하세요.', onboardingChannel: '시작하기', introChannel: '자기소개' };
export async function createOnboarding(db, workspaces, provision, { now = Date.now } = {}) {
    await db.exec(`CREATE TABLE IF NOT EXISTS lms_onboarding_settings(guild_id TEXT PRIMARY KEY REFERENCES lms_workspace_guilds(guild_id), data TEXT NOT NULL, revision TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lms_onboarding_reports(guild_id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL, error TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS lms_onboarding_members(guild_id TEXT NOT NULL, discord_id TEXT NOT NULL, intro_done INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(guild_id,discord_id));`);
    await db.exec(`CREATE TABLE IF NOT EXISTS lms_member_sync(guild_id TEXT NOT NULL,discord_id TEXT NOT NULL,revision TEXT NOT NULL,state TEXT NOT NULL,error TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,discord_id));
    CREATE TABLE IF NOT EXISTS lms_member_retry(guild_id TEXT NOT NULL,discord_id TEXT NOT NULL,PRIMARY KEY(guild_id,discord_id));`);
    async function owner(guildId) { return (await (db.prepare('SELECT workspace_id FROM lms_workspace_guilds WHERE guild_id=?')).get(guildId))?.workspace_id; }
    async function config(guildId) {
        const row = await (db.prepare('SELECT * FROM lms_onboarding_settings WHERE guild_id=?')).get(guildId);
        return row ? { guildId, ...JSON.parse(row.data), revision: row.revision } : { guildId, ...defaults, revision: digest({ guildId, ...defaults }) };
    }
    async function read(id) {
        const meta = await workspaces.metadata(id), data = await workspaces.snapshot(id);
        return { guildIds: meta.guildIds, courses: data.courses.map(c => ({ id: c.id, title: c.title })),
            teams: data.teams.map(t => ({ ...t, members: data.learners.filter(l => l.courseId === t.courseId && l.team === t.name && l.status === '정상').length })),
            configs: await Promise.all(meta.guildIds.map(async (guildId) => ({ ...await config(guildId), report: await (db.prepare('SELECT revision,state,error,updated_at AS updatedAt FROM lms_onboarding_reports WHERE guild_id=?')).get(guildId) || null,
                progress: await (db.prepare('SELECT discord_id AS discordId,intro_done AS introDone,updated_at AS updatedAt FROM lms_onboarding_members WHERE guild_id=?')).all(guildId) }))) };
    }
    async function save(id, body) {
        const input = settings.parse(body);
        if (await owner(input.guildId) !== id)
            throw new ApiError(403, '이 워크스페이스의 Discord 서버를 선택하세요.');
        if (input.onboardingChannel === input.introChannel)
            throw new ApiError(422, '시작 안내와 자기소개 채널 이름을 다르게 입력하세요.');
        const data = await workspaces.snapshot(id);
        if (new Set(input.courseIds).size !== input.courseIds.length || input.courseIds.some(course => !data.courses.some(c => c.id === course)))
            throw new ApiError(422, '이 워크스페이스의 과정을 선택하세요.');
        if (data.teams.filter(t => input.courseIds.includes(t.courseId)).length > 50)
            throw new ApiError(422, 'Discord 서버당 최대 50개 팀을 연결할 수 있습니다.');
        await db.exec('BEGIN IMMEDIATE');
        try {
            if ((await config(input.guildId)).revision !== input.revision)
                throw new ApiError(409, '다른 관리자가 설정을 변경했습니다. 새로고침하세요.');
            const { guildId, revision: _revision, ...value } = input;
            await (db.prepare('INSERT INTO lms_onboarding_settings VALUES(?,?,?) ON CONFLICT(guild_id) DO UPDATE SET data=excluded.data,revision=excluded.revision')).run(guildId, JSON.stringify(value), digest({ guildId, ...value }));
            await (db.prepare('DELETE FROM lms_onboarding_reports WHERE guild_id=?')).run(guildId);
            await db.exec('COMMIT');
            return await read(id);
        }
        catch (error) {
            await db.exec('ROLLBACK');
            throw error;
        }
    }
    async function bundle(guildId) {
        const id = await owner(guildId);
        if (!id)
            return null;
        const cfg = await config(guildId);
        const { archivedAt } = await workspaces.metadata(id);
        if (archivedAt !== null)
            return { guildId, enabled: false, revision: digest({ revision: cfg.revision, archivedAt }) };
        if (!cfg.enabled)
            return { guildId, enabled: false, revision: cfg.revision };
        const data = await workspaces.snapshot(id);
        const teams = data.teams.filter(t => cfg.courseIds.includes(t.courseId)).map(t => ({ id: t.id, name: t.name, courseId: t.courseId }));
        if (teams.length > 50)
            return { guildId, enabled: true, error: 'team_limit', revision: digest({ ...cfg, teamCount: teams.length }) };
        const memberships = (await (db.prepare(`SELECT u.id AS userId,u.discord_id AS discordId,u.name,m.role
      FROM lms_workspace_members m JOIN lms_users u ON u.id=m.user_id
      JOIN lms_workspace_verifications v ON v.workspace_id=m.workspace_id AND v.user_id=m.user_id AND v.discord_id=u.discord_id
      WHERE m.workspace_id=? AND v.guild_id=?`)).all(id, guildId)).filter(m => /^\d{17,20}$/.test(m.discordId));
        const participants = await Promise.all(memberships.filter(m => m.role !== 'student').map(async ({ userId, ...m }) => {
            const scope = await workspaces.mentorScope(id, userId);
            const mentor = m.role === 'instructor' ? data.mentors.find(mentor => mentor.discordId === m.discordId) : null;
            return { ...m, name: mentor?.name || m.name, teamId: '', ...scope, teamIds: (scope.mentorType === 'main' ? teams.map(t => t.id) : scope.teamIds).filter(teamId => teams.some(t => t.id === teamId)) };
        }));
        for (const learner of data.learners.filter(l => cfg.courseIds.includes(l.courseId) && l.discordId && l.status === '정상')) {
            const member = memberships.find(m => m.discordId === learner.discordId);
            if (!member || participants.some(p => p.discordId === learner.discordId))
                continue;
            participants.push({ discordId: learner.discordId, name: learner.name, role: member.role, teamId: teams.find(t => t.courseId === learner.courseId && t.name === learner.team)?.id || '' });
        }
        const channels = (await provision.read([guildId])).plans[0]?.channels || [];
        const value = { ...cfg, workspaceName: data.name, teams, participants, channels };
        return { ...value, revision: digest(value), retryDiscordIds: (await (db.prepare('SELECT discord_id FROM lms_member_retry WHERE guild_id=?')).all(guildId)).map(r => r.discord_id) };
    }
    async function poll(body) {
        const { guildIds } = z.object({ guildIds: z.array(snowflake).max(10000) }).strict().parse(body);
        return { configs: (await Promise.all([...new Set(guildIds)].map(bundle))).filter(Boolean) };
    }
    async function report(body) {
        const member = z.object({ discordId: snowflake, state: z.enum(['ready', 'waiting', 'failed']), error: z.enum(['', 'permissions', 'role_hierarchy', 'discord_error', 'api_error', 'conflict', 'member_missing']) }).strict();
        const input = z.object({ guildId: snowflake, revision: z.string().length(64), state: z.enum(['ready', 'failed', 'disabled']), error: z.enum(['', 'permissions', 'role_hierarchy', 'discord_error', 'api_error', 'conflict', 'team_limit']), members: z.array(member).max(10000).default([]) }).strict().parse(body);
        if (!await owner(input.guildId))
            throw new ApiError(404, '연결된 서버가 아닙니다.');
        if ((await bundle(input.guildId)).revision !== input.revision)
            throw new ApiError(409, '설정이 변경되었습니다. 최신 설정을 가져오세요.');
        await (db.prepare('INSERT INTO lms_onboarding_reports VALUES(?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,error=excluded.error,updated_at=excluded.updated_at')).run(input.guildId, input.revision, input.state, input.error, now());
        const valid = new Set((await bundle(input.guildId)).participants?.map(p => p.discordId) || []);
        for (const member of input.members.filter(m => valid.has(m.discordId))) {
            await (db.prepare('INSERT INTO lms_member_sync VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id,discord_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,error=excluded.error,updated_at=excluded.updated_at')).run(input.guildId, member.discordId, input.revision, member.state, member.error, now());
            await (db.prepare('DELETE FROM lms_member_retry WHERE guild_id=? AND discord_id=?')).run(input.guildId, member.discordId);
        }
        return { ok: true };
    }
    async function progress(body) {
        const input = z.object({ guildId: snowflake, discordId: snowflake }).strict().parse(body);
        if (!await owner(input.guildId) || !(await config(input.guildId)).enabled)
            throw new ApiError(403, '온보딩을 사용할 수 없는 서버입니다.');
        await (db.prepare('INSERT INTO lms_onboarding_members VALUES(?,?,1,?) ON CONFLICT(guild_id,discord_id) DO UPDATE SET intro_done=1,updated_at=excluded.updated_at')).run(input.guildId, input.discordId, now());
        return { ok: true };
    }
    async function memberStates(id, learners) {
        const guildId = (await workspaces.metadata(id)).guildIds[0], cfg = guildId ? await bundle(guildId) : null;
        return await Promise.all(learners.map(async (learner) => {
            const proof = guildId && await (db.prepare(`SELECT 1 FROM lms_workspace_verifications v JOIN lms_workspace_members m ON m.workspace_id=v.workspace_id AND m.user_id=v.user_id JOIN lms_users u ON u.id=v.user_id AND u.discord_id=v.discord_id WHERE v.workspace_id=? AND v.guild_id=? AND v.discord_id=?`)).get(id, guildId, learner.discordId || '');
            const current = guildId && await (db.prepare('SELECT * FROM lms_member_sync WHERE guild_id=? AND discord_id=?')).get(guildId, learner.discordId || '');
            const report = guildId && await (db.prepare('SELECT * FROM lms_onboarding_reports WHERE guild_id=?')).get(guildId);
            const pending = guildId && await (db.prepare('SELECT 1 FROM lms_member_retry WHERE guild_id=? AND discord_id=?')).get(guildId, learner.discordId || '');
            const enabled = cfg?.enabled && cfg.courseIds?.includes(learner.courseId);
            const fresh = current?.revision === cfg?.revision && current?.updated_at > now() - 120000 && !pending;
            const globalFailure = report?.revision === cfg?.revision && report?.state === 'failed' && report?.updated_at > now() - 120000;
            const syncState = !proof ? 'Discord 미인증' : !enabled ? '연동 미설정' : fresh ? ({ ready: '적용 완료', waiting: '자기소개 대기', failed: '동기화 실패' }[current.state]) : globalFailure && !pending ? '동기화 실패' : '적용 대기';
            return { ...learner, syncState, syncError: fresh ? current.error : globalFailure ? report.error : '', syncedAt: current?.updated_at || null };
        }));
    }
    async function retryMembers(id, learners, actor) {
        const guildId = (await workspaces.metadata(id)).guildIds[0];
        if (!guildId)
            throw new ApiError(409, '연결된 Discord 서버가 없습니다.');
        if ((await memberStates(id, learners)).some(l => l.syncState !== '동기화 실패'))
            throw new ApiError(409, '실패한 구성원만 선택해 재시도하세요.');
        await db.exec('BEGIN IMMEDIATE');
        try {
            for (const l of learners)
                await (db.prepare('INSERT OR IGNORE INTO lms_member_retry VALUES(?,?)')).run(guildId, l.discordId);
            await (db.prepare('INSERT INTO lms_audit(actor,action,target,after_json) VALUES(?,?,?,?)')).run(actor, 'teams.retry', id, JSON.stringify(learners.map(l => l.id)));
            await db.exec('COMMIT');
        }
        catch (e) {
            await db.exec('ROLLBACK');
            throw e;
        }
    }
    return { read, save, poll, report, progress, memberStates, retryMembers };
}

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './store.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
const snowflake = z.string().regex(/^\d{17,20}$/);
const channel = z.object({ id: z.string().min(1).max(80), name: z.string().trim().min(1).max(80), type: z.enum(['category', 'text', 'voice']), parentId: z.string().max(80).default(''), guide: z.string().trim().max(1500).optional() }).strict().transform(item => ({ ...item, name: item.type === 'text' ? item.name.toLowerCase() : item.name }));
function validateLayout(plan, ctx) {
    const ids = new Set();
    const names = new Set();
    for (const item of plan.channels) {
        if (ids.has(item.id))
            ctx.addIssue({ code: 'custom', message: '채널 식별자가 중복됐습니다.' });
        ids.add(item.id);
        if (item.type === 'text' && !/^[\p{L}\p{N}_-]+$/u.test(item.name))
            ctx.addIssue({ code: 'custom', message: '텍스트 채널명은 문자·숫자·밑줄·하이픈으로 입력하세요.' });
        if (item.type === 'category' && item.parentId)
            ctx.addIssue({ code: 'custom', message: '카테고리는 다른 카테고리 안에 넣을 수 없습니다.' });
        if (item.parentId && !plan.channels.some(parent => parent.id === item.parentId && parent.type === 'category'))
            ctx.addIssue({ code: 'custom', message: '채널의 상위 카테고리를 확인하세요.' });
        const key = `${item.type}:${item.parentId}:${item.name}`;
        if (names.has(key))
            ctx.addIssue({ code: 'custom', message: '같은 카테고리 안에 동일한 이름과 유형의 채널이 있습니다.' });
        names.add(key);
    }
}
const layout = { name: z.string().trim().min(1).max(80), channels: z.array(channel).min(1).max(30), revision: z.string().max(64) };
export const templateSchema = z.object(layout).strict().superRefine(validateLayout);
const planSchema = z.object({ ...layout, guildId: snowflake, autoApply: z.boolean() }).strict().superRefine(validateLayout);
const outcome = z.object({ id: z.string().max(80), discordId: snowflake, action: z.enum(['created', 'reused']) }).strict();
const heartbeatSchema = z.object({
    bot: z.object({ id: snowflake, name: z.string().min(1).max(100), ready: z.boolean() }).strict().optional(),
    guilds: z.array(z.object({ id: snowflake, name: z.string().min(1).max(100), manageChannels: z.boolean(), memberCount: z.number().int().nonnegative().nullable().optional() }).strict()).max(10000),
}).strict();
export async function createProvision(db, { token = '', now = Date.now } = {}) {
    const enabled = token.length >= 32;
    await db.exec(`CREATE TABLE IF NOT EXISTS lms_discord_plans (
      guild_id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)), revision TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lms_discord_guilds (
      guild_id TEXT PRIMARY KEY, name TEXT NOT NULL, manage_channels INTEGER NOT NULL, seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lms_discord_jobs (
      id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, revision TEXT NOT NULL, plan TEXT NOT NULL CHECK(json_valid(plan)),
      state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed')),
      created_at INTEGER NOT NULL, completed_at INTEGER, lease_until INTEGER, claim_hash TEXT,
      error_code TEXT, results TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS lms_discord_active_job ON lms_discord_jobs(guild_id) WHERE state IN ('queued','running');
    CREATE TABLE IF NOT EXISTS lms_discord_worker (id INTEGER PRIMARY KEY CHECK(id=1), bot_id TEXT NOT NULL, name TEXT NOT NULL, ready INTEGER NOT NULL, seen_at INTEGER NOT NULL);`);
    if (!(await (db.prepare('PRAGMA table_info(lms_discord_guilds)')).all()).some(row => row.name === 'member_count'))
        await db.exec('ALTER TABLE lms_discord_guilds ADD COLUMN member_count INTEGER');
    function authorized(header = '') { return enabled && timingSafeEqual(Buffer.from(digest(header)), Buffer.from(digest(`Bearer ${token}`))); }
    async function expire() { await (db.prepare("UPDATE lms_discord_jobs SET state='failed',error_code='timeout',completed_at=? WHERE state='running' AND lease_until<=?")).run(now(), now()); }
    async function plan(guildId) { const row = await (db.prepare('SELECT * FROM lms_discord_plans WHERE guild_id=?')).get(guildId); return row ? { ...JSON.parse(row.data), revision: row.revision } : null; }
    async function active(guildId) { return await (db.prepare("SELECT id FROM lms_discord_jobs WHERE guild_id=? AND state IN ('queued','running')")).get(guildId); }
    async function save(body) {
        const input = planSchema.parse(body);
        await expire();
        if (await active(input.guildId))
            throw new ApiError(409, '적용 작업이 진행 중입니다. 완료 후 설정을 변경하세요.');
        const current = await plan(input.guildId);
        if ((current?.revision || '') !== input.revision)
            throw new ApiError(409, '다른 작업으로 설정이 변경됐습니다. 저장된 설정을 다시 불러오세요.');
        const { revision: _revision, ...value } = input;
        const data = JSON.stringify(value);
        const revision = digest(data);
        await (db.prepare('INSERT INTO lms_discord_plans VALUES(?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET data=excluded.data,revision=excluded.revision,updated_at=excluded.updated_at')).run(value.guildId, data, revision, now());
        return { ...value, revision };
    }
    async function enqueue(guildId, revision, allowOffline = false) {
        if (!enabled && !allowOffline)
            throw new ApiError(503, 'Discord 채널 설정 연결이 준비되지 않았습니다.');
        await expire();
        const current = await plan(snowflake.parse(guildId));
        if (!current || current.revision !== revision)
            throw new ApiError(409, '최신 설정을 저장한 후 적용하세요.');
        if (await active(guildId))
            throw new ApiError(409, '이미 대기 중이거나 실행 중인 적용 작업이 있습니다.');
        const id = randomUUID();
        await (db.prepare("INSERT INTO lms_discord_jobs(id,guild_id,revision,plan,state,created_at) VALUES(?,?,?,?,'queued',?)")).run(id, guildId, revision, JSON.stringify(current), now());
        return { id, state: 'queued' };
    }
    async function install(guildId, template) {
        const current = await plan(guildId);
        if (current)
            return { created: false, plan: current, job: await (db.prepare('SELECT id,state FROM lms_discord_jobs WHERE guild_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1')).get(guildId) || null };
        const saved = await save({ guildId, name: template.name, channels: template.channels, autoApply: true, revision: '' });
        return { created: true, plan: saved, job: await enqueue(guildId, saved.revision, true) };
    }
    async function read(guildIds = null) {
        await expire();
        const filter = guildIds === null ? '' : ' WHERE guild_id IN (SELECT value FROM json_each(?))';
        const args = guildIds === null ? [] : [JSON.stringify(guildIds)];
        const observed = await (db.prepare('SELECT bot_id AS id,name,ready,seen_at AS seenAt FROM lms_discord_worker WHERE id=1')).get();
        const worker = observed ? { ...observed, ready: Boolean(observed.ready), connected: Boolean(observed.ready) && observed.seenAt > now() - 90000 } : null;
        return { enabled, worker,
            plans: await Promise.all((await (db.prepare(`SELECT guild_id FROM lms_discord_plans${filter} ORDER BY updated_at DESC`)).all(...args)).map(async (row) => await plan(row.guild_id))),
            guilds: (await (db.prepare(`SELECT guild_id AS id,name,manage_channels AS manageChannels,member_count AS memberCount,seen_at AS seenAt FROM lms_discord_guilds${filter}`)).all(...args)).map(row => ({ ...row, connected: row.seenAt > now() - 90000 && (!worker || worker.connected) })),
            jobs: (await (db.prepare(`SELECT id,guild_id AS guildId,state,created_at AS createdAt,completed_at AS completedAt,error_code AS errorCode,results FROM lms_discord_jobs${filter} ORDER BY created_at DESC,rowid DESC LIMIT 50`)).all(...args)).map(row => ({ ...row, results: JSON.parse(row.results) })), };
    }
    async function heartbeat(body) {
        const { bot, guilds } = heartbeatSchema.parse(body);
        if (new Set(guilds.map(g => g.id)).size !== guilds.length)
            throw new ApiError(422, '중복된 서버입니다.');
        await db.exec('BEGIN IMMEDIATE');
        try {
            if (bot) {
                await (db.prepare('INSERT INTO lms_discord_worker VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET bot_id=excluded.bot_id,name=excluded.name,ready=excluded.ready,seen_at=excluded.seen_at')).run(bot.id, bot.name, Number(bot.ready), now());
                // A single bot reports its entire guild list, including departures.
                await (db.prepare('UPDATE lms_discord_guilds SET seen_at=0 WHERE guild_id NOT IN (SELECT value FROM json_each(?))')).run(JSON.stringify(guilds.map(g => g.id)));
            }
            for (const guild of guilds)
                await (db.prepare('INSERT INTO lms_discord_guilds(guild_id,name,manage_channels,seen_at,member_count) VALUES(?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET name=excluded.name,manage_channels=excluded.manage_channels,seen_at=excluded.seen_at,member_count=excluded.member_count')).run(guild.id, guild.name, Number(guild.manageChannels), now(), guild.memberCount ?? null);
            await db.exec('COMMIT');
            return { guilds: bot?.ready === false ? [] : guilds };
        }
        catch (error) {
            await db.exec('ROLLBACK');
            throw error;
        }
    }
    async function poll(body) {
        const { guilds } = await heartbeat(body);
        await expire();
        await db.exec('BEGIN IMMEDIATE');
        try {
            for (const guild of guilds) {
                const desired = await plan(guild.id);
                const attempted = desired && await (db.prepare('SELECT id FROM lms_discord_jobs WHERE guild_id=? AND revision=?')).get(guild.id, desired.revision);
                if (desired?.autoApply && !attempted && !await active(guild.id))
                    await enqueue(guild.id, desired.revision);
            }
            const available = (await (db.prepare("SELECT * FROM lms_discord_jobs WHERE state='queued' ORDER BY created_at")).all()).find(job => guilds.some(guild => guild.id === job.guild_id));
            let result = null;
            if (available) {
                const claim = randomBytes(32).toString('hex');
                await (db.prepare("UPDATE lms_discord_jobs SET state='running',lease_until=?,claim_hash=? WHERE id=?")).run(now() + 300000, digest(claim), available.id);
                result = { id: available.id, claim, plan: JSON.parse(available.plan) };
            }
            await db.exec('COMMIT');
            return { job: result };
        }
        catch (error) {
            await db.exec('ROLLBACK');
            throw error;
        }
    }
    async function complete(body) {
        const input = z.object({ id: z.string().uuid(), claim: z.string().regex(/^[a-f0-9]{64}$/), success: z.boolean(), errorCode: z.enum(['forbidden', 'missing_guild', 'conflict', 'timeout', 'api_error']).nullable(), results: z.array(outcome).max(30) }).strict().parse(body);
        await expire();
        const job = await (db.prepare('SELECT * FROM lms_discord_jobs WHERE id=?')).get(input.id);
        if (!job || job.state !== 'running' || !timingSafeEqual(Buffer.from(job.claim_hash), Buffer.from(digest(input.claim))))
            throw new ApiError(409, '유효하지 않거나 종료된 작업입니다.');
        const items = JSON.parse(job.plan).channels;
        if (new Set(input.results.map(row => row.id)).size !== input.results.length || input.results.some(row => !items.some(item => item.id === row.id)) || (input.success && (input.results.length !== items.length || input.errorCode !== null)) || (!input.success && !input.errorCode))
            throw new ApiError(422, '적용 결과가 설정과 일치하지 않습니다.');
        await (db.prepare('UPDATE lms_discord_jobs SET state=?,completed_at=?,error_code=?,results=?,claim_hash=NULL WHERE id=?')).run(input.success ? 'succeeded' : 'failed', now(), input.errorCode, JSON.stringify(input.results), input.id);
        return { ok: true };
    }
    return { enabled, authorized, save, enqueue, install, read, poll, complete, heartbeat };
}

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './store.mjs';
import { tableExists } from './workspace-verification.mjs';

const snowflake = z.string().regex(/^\d{17,20}$/);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// The caller owns the transaction. Operational history (rosters, attendance,
// submissions, bookings and reports) is deliberately not authentication state.
export async function clearDiscordIdentity(db, discordId) {
    if (!snowflake.safeParse(discordId).success) return [];
    const owners = await db.prepare('SELECT id,username FROM lms_users WHERE discord_id=?').all(discordId);
    for (const owner of owners) {
        await db.prepare('DELETE FROM lms_auth_sessions WHERE user_id=?').run(owner.id);
        await db.prepare('DELETE FROM lms_registrations WHERE user_id=?').run(owner.id);
        for (const table of ['lms_workspace_verifications', 'lms_staff_connections']) {
            if (await tableExists(db, table)) await db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(owner.id);
        }
        await db.prepare("UPDATE lms_users SET discord_id=?,guild_id='',verified_at=NULL WHERE id=?").run(`pending:${owner.id}`, owner.id);
    }
    for (const table of ['lms_registrations', 'lms_workspace_verifications', 'lms_staff_connections', 'lms_onboarding_members', 'lms_member_sync', 'lms_member_retry']) {
        if (await tableExists(db, table)) await db.prepare(`DELETE FROM ${table} WHERE discord_id=?`).run(discordId);
    }
    return owners;
}

export function createDiscordIdentities(db, auth, { now = Date.now } = {}) {
    async function inventory() {
        const users = await db.prepare('SELECT id,username,name,discord_id,guild_id,verified_at FROM lms_users ORDER BY id').all();
        const userById = new Map(users.map(user => [user.id, user]));
        const workspaces = await tableExists(db, 'lms_workspaces') ? await db.prepare('SELECT id,name FROM lms_workspaces').all() : [];
        const names = new Map(workspaces.map(workspace => [workspace.id, workspace.name]));
        const grouped = new Map();
        function add(discordId, record, signature = record) {
            if (!snowflake.safeParse(discordId).success) return;
            if (!grouped.has(discordId)) grouped.set(discordId, { discordId, account: null, records: [], signatures: [] });
            const item = grouped.get(discordId);
            item.records.push(record); item.signatures.push(signature);
        }
        const record = (kind, row, orphan) => ({ kind, userId: row.user_id || '', username: userById.get(row.user_id)?.username || row.username || '',
            workspaceId: row.workspace_id || '', workspaceName: names.get(row.workspace_id) || (row.workspace_id ? '삭제된 워크스페이스' : ''),
            guildId: row.guild_id || '', verifiedAt: row.verified_at ?? null, expiresAt: row.expires_at ?? null, orphan });
        for (const user of users) {
            add(user.discord_id, record('account', { user_id: user.id, guild_id: user.guild_id, verified_at: user.verified_at }, false));
            const item = grouped.get(user.discord_id);
            if (item) item.account = { id: user.id, username: user.username, name: user.name };
        }
        for (const [kind, table, columns, order] of [
            ['verification', 'lms_workspace_verifications', '*', 'workspace_id,user_id,guild_id'],
            ['registration', 'lms_registrations', 'ticket_hash,user_id,username,discord_id,guild_id,workspace_id,verified_at,expires_at,created_at,code_hash', 'ticket_hash'],
            ['staff', 'lms_staff_connections', '*', 'workspace_id,user_id'],
        ]) {
            if (!await tableExists(db, table)) continue;
            for (const row of await db.prepare(`SELECT ${columns} FROM ${table} ORDER BY ${order}`).all()) {
                const user = userById.get(row.user_id);
                const orphan = row.user_id ? !user || (user.discord_id !== row.discord_id && !(kind === 'registration' && user.discord_id.startsWith('pending:')))
                    : kind !== 'registration' || (row.verified_at !== null ? !users.some(u => u.discord_id === row.discord_id) : row.expires_at <= now());
                add(row.discord_id, record(kind, row, orphan || Boolean(row.workspace_id && !names.has(row.workspace_id))), row);
            }
        }
        return [...grouped.values()].map(({ signatures, ...item }) => ({ ...item, orphanCount: item.records.filter(row => row.orphan).length,
            state: item.account ? item.records.some(row => row.kind === 'account' && row.verifiedAt !== null) ? 'linked' : 'unverified' : item.records.every(row => row.kind === 'registration' && !row.orphan) ? 'pending' : 'orphan',
            revision: digest([item, signatures]) })).sort((a,b) => Number(b.state === 'orphan') - Number(a.state === 'orphan') || a.discordId.localeCompare(b.discordId));
    }
    async function list(user) { await auth.platformAdmin(user); return { identities: await inventory() }; }
    async function remove(user, discordId, body) {
        snowflake.parse(discordId);
        const input = z.object({ discordId: snowflake, revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(body);
        if (input.discordId !== discordId) throw new ApiError(422, '삭제할 Discord ID를 정확히 입력하세요.');
        await db.exec('BEGIN IMMEDIATE');
        try {
            const actor = await auth.platformAdmin(user);
            const before = (await inventory()).find(row => row.discordId === discordId);
            if (!before) throw new ApiError(404, '인증 기록이 없습니다. 목록을 새로고침하세요.');
            if (before.revision !== input.revision) throw new ApiError(409, '인증 정보가 변경되었습니다. 목록을 새로고침하고 다시 확인하세요.');
            const owners = await clearDiscordIdentity(db, discordId);
            await db.prepare('INSERT INTO lms_account_audit(actor_id,target_id,username,action,created_at) VALUES(?,?,?,?,?)')
                .run(actor.id, discordId, before.account?.username || '', 'discord.identity.clear', now());
            await db.exec('COMMIT');
            return { ok: true, signedOut: owners.some(owner => owner.id === actor.id) };
        } catch (error) { await db.exec('ROLLBACK'); throw error; }
    }
    return { list, remove };
}

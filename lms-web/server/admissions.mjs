import { asyncFilter } from './async-collections.mjs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './store.mjs';
import { workspaceVerified } from './workspace-verification.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
const snowflake = z.string().regex(/^\d{17,20}$/);
export async function createAdmissions(db, workspaces, { token = '', now = Date.now } = {}) {
    await db.exec(`CREATE TABLE IF NOT EXISTS lms_admissions (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES lms_workspaces(id), user_id TEXT NOT NULL REFERENCES lms_users(id),
    state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','joined')), created_at INTEGER NOT NULL,
    reviewed_by TEXT, reviewed_at INTEGER, guild_id TEXT, reason TEXT NOT NULL DEFAULT '',
    invite_state TEXT NOT NULL DEFAULT 'none', invite_code TEXT, invite_expires INTEGER, claim_hash TEXT, lease_until INTEGER,
    UNIQUE(workspace_id,user_id)
  );`);
    await db.exec('CREATE TABLE IF NOT EXISTS lms_runtime_state(guild_id TEXT NOT NULL,kind TEXT NOT NULL,record_key TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(guild_id,kind,record_key))');
    const studentProfile = async (id, userId) => JSON.parse((await db.prepare("SELECT data FROM lms_runtime_state WHERE guild_id=? AND kind='student-profile' AND record_key=?").get(`workspace:${id}`, userId))?.data || '{}');
    if (!(await (db.prepare('PRAGMA table_info(lms_admissions)')).all()).some(row => row.name === 'purpose'))
        await db.exec("ALTER TABLE lms_admissions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'student'");
    if (!(await (db.prepare('PRAGMA table_info(lms_admissions)')).all()).some(row => row.name === 'team_id'))
        await db.exec("ALTER TABLE lms_admissions ADD COLUMN team_id TEXT NOT NULL DEFAULT ''");
    async function availableTeams(id, user) {
        const data = await workspaces.snapshot(id);
        const scope = await workspaces.role(id, user) === 'instructor' ? await workspaces.mentorScope(id, user.id) : null;
        return data.teams.filter(t => !scope || scope.mentorType === 'main' || scope.teamIds.includes(t.id))
            .map(t => ({ id: t.id, name: t.name, courseId: t.courseId, courseTitle: data.courses.find(c => c.id === t.courseId)?.title || '' }));
    }
    async function syncLearner(row, team, account, active = false) {
        const data = await workspaces.snapshot(row.workspace_id);
        const profile = await studentProfile(row.workspace_id, account.id);
        const discordId = active ? account.discord_id : '';
        const existing = data.learners.find(l => l.id === `admission-${row.id}`) ||
            (account.verified_at !== null && data.learners.find(l => l.discordId === account.discord_id));
        const learner = { ...(existing || { id: `admission-${row.id}`, email: '', progress: 0, color: 'sage' }),
            name: profile.name || account.name, email: profile.email || existing?.email || '', discordId: discordId || existing?.discordId || '', courseId: team.courseId, team: team.name,
            status: active ? '정상' : existing?.status || '대기' };
        await workspaces.mutate(row.workspace_id, { revision: data.revision, changes: [{ kind: 'learners', value: learner }] }, active ? 'admission-verification' : 'admission-approval');
    }
    async function catalogue() { return await (db.prepare('SELECT id,name FROM lms_workspaces WHERE archived_at IS NULL ORDER BY created_at,rowid')).all(); }
    async function validateStudentIssue(id, teamId, actor) {
        await workspaces.requireRole(id, actor, ['admin']);
        const metadata = await workspaces.metadata(id);
        if (metadata.archivedAt !== null)
            throw new ApiError(409, '보관된 워크스페이스에서는 계정을 발급할 수 없습니다.');
        if (metadata.guildIds.length !== 1)
            throw new ApiError(422, 'Discord 서버 연결과 조 구성을 먼저 완료하세요.');
        const team = (await availableTeams(id, actor)).find(t => t.id === teamId);
        if (!team || !team.courseTitle)
            throw new ApiError(422, '이 워크스페이스의 과정과 조를 선택하세요.');
        return { team, guildId: metadata.guildIds[0], workspaceName: metadata.name };
    }
    async function assignStudent(id, teamId, user, actor) {
        const { team, guildId, workspaceName } = await validateStudentIssue(id, teamId, actor);
        const applicationId = randomUUID();
        await (db.prepare("INSERT INTO lms_admissions(id,workspace_id,user_id,state,created_at,reviewed_by,reviewed_at,guild_id,invite_state,purpose,team_id) VALUES(?,?,?,'approved',?,?,?,?,'queued','student',?)")).run(applicationId, id, user.id, now(), actor.id, now(), guildId, team.id);
        await (db.prepare("INSERT INTO lms_workspace_members VALUES(?,?,'student',?)")).run(id, user.id, now());
        await (db.prepare('INSERT INTO lms_audit(actor,action,target,after_json) VALUES(?,?,?,?)')).run(actor.username || actor.id, 'student.assign', `${id}/${user.id}`, JSON.stringify({ teamId: team.id, courseId: team.courseId }));
        return { applicationId, workspaceName, teamName: team.name, courseTitle: team.courseTitle };
    }
    async function studentAccounts(id, actor) {
        await workspaces.requireRole(id, actor, ['admin']);
        const data = await workspaces.snapshot(id);
        return { revision: data.revision, teams: await availableTeams(id, actor), guildIds: (await workspaces.metadata(id)).guildIds, archived: (await workspaces.metadata(id)).archivedAt !== null,
            accounts: await Promise.all((await (db.prepare("SELECT u.id,u.username,u.name,u.must_complete_profile AS setupPending,u.must_change_password AS passwordPending,a.id AS applicationId,a.team_id AS teamId,a.state FROM lms_admissions a JOIN lms_users u ON u.id=a.user_id WHERE a.workspace_id=? AND a.purpose='student' ORDER BY a.created_at DESC")).all(id)).map(async ({ applicationId, ...account }) => {
                const row = { id: applicationId, user_id: account.id, team_id: account.teamId };
                const learner = await assignedLearner(row, data), team = await assignedTeam(row, data);
                const profile = await studentProfile(id, account.id);
                return { ...account, ...profile, name: learner?.name || profile.name || account.name, email: learner?.email || profile.email || '', profileRevision: digest(JSON.stringify(profile)), teamId: team?.id || '', courseId: learner?.courseId || team?.courseId || '' };
            })) };
    }
    // Once a roster record exists it owns the assignment. This also reflects moves
    // made through learner editing or bulk team operations, without a second DB write.
    async function assignedLearner(row, data) {
        const account = await (db.prepare('SELECT discord_id,verified_at FROM lms_users WHERE id=?')).get(row.user_id);
        return data.learners.find(l => l.id === `admission-${row.id}`) ||
            (account?.discord_id && account.verified_at !== null ? data.learners.find(l => l.discordId === account.discord_id) : undefined);
    }
    async function assignedTeam(row, data) {
        const learner = await assignedLearner(row, data);
        return learner ? data.teams.find(t => t.courseId === learner.courseId && t.name === learner.team) : data.teams.find(t => t.id === row.team_id);
    }
    async function changeStudentTeam(id, userId, body, actor) {
        await workspaces.requireRole(id, actor, ['admin']);
        const input = z.object({ teamId: z.string().min(1), expectedTeamId: z.string(), revision: z.string().min(1) }).strict().parse(body);
        if ((await workspaces.metadata(id)).archivedAt !== null)
            throw new ApiError(409, '보관된 워크스페이스에서는 조를 변경할 수 없습니다.');
        const row = await (db.prepare("SELECT * FROM lms_admissions WHERE workspace_id=? AND user_id=? AND purpose='student'")).get(id, userId);
        if (!row)
            throw new ApiError(404, '이 워크스페이스의 학생 계정을 찾을 수 없습니다.');
        if (!['approved', 'joined'].includes(row.state))
            throw new ApiError(409, '승인된 학생 계정만 조를 변경할 수 있습니다.');
        const data = await workspaces.snapshot(id), learner = await assignedLearner(row, data), before = await assignedTeam(row, data);
        if (data.revision !== input.revision || (before?.id || '') !== input.expectedTeamId)
            throw new ApiError(409, '배정 정보가 변경됐습니다. 계정 상태를 새로고침한 뒤 다시 선택하세요.');
        const team = data.teams.find(t => t.id === input.teamId), courseId = learner?.courseId || before?.courseId;
        if (!team || courseId && team.courseId !== courseId)
            throw new ApiError(422, '현재 과정에 속한 조를 선택하세요.');
        if (before?.id === team.id)
            return await studentAccounts(id, actor);
        if (learner) {
            await workspaces.mutate(id, { revision: input.revision, changes: [{ kind: 'learners', value: { ...learner, team: team.name } }] }, actor.username || actor.id);
        }
        else {
            await db.exec('BEGIN IMMEDIATE');
            try {
                await (db.prepare('UPDATE lms_admissions SET team_id=?,reviewed_by=?,reviewed_at=? WHERE id=?')).run(team.id, actor.id, now(), row.id);
                await (db.prepare('INSERT INTO lms_audit(actor,action,target,before_json,after_json) VALUES(?,?,?,?,?)')).run(actor.username || actor.id, 'student.team-change', `${id}/${userId}`, JSON.stringify({ teamId: before?.id || '' }), JSON.stringify({ teamId: team.id }));
                await db.exec('COMMIT');
            }
            catch (error) {
                await db.exec('ROLLBACK');
                throw error;
            }
        }
        return await studentAccounts(id, actor);
    }
    async function apply(id, user) {
        if ((await workspaces.metadata(id)).archivedAt !== null)
            throw new ApiError(409, '보관된 워크스페이스에는 새 가입을 신청할 수 없습니다.');
        if (user.role === 'admin' || await workspaces.role(id, user))
            throw new ApiError(409, '이미 참여한 계정입니다.');
        const existing = await (db.prepare('SELECT * FROM lms_admissions WHERE workspace_id=? AND user_id=?')).get(id, user.id);
        if (existing)
            throw new ApiError(409, '이미 신청한 워크스페이스입니다.');
        const applicationId = randomUUID();
        await (db.prepare("INSERT INTO lms_admissions(id,workspace_id,user_id,state,created_at) VALUES(?,?,?,'pending',?)")).run(applicationId, id, user.id, now());
        return { id: applicationId, state: 'pending' };
    }
    async function own(user) {
        return await Promise.all((await (db.prepare('SELECT a.id,a.workspace_id AS workspaceId,w.name AS workspaceName,a.state,a.created_at AS createdAt,a.reason,a.invite_state AS inviteState,a.invite_code AS inviteCode,a.invite_expires AS inviteExpires FROM lms_admissions a JOIN lms_workspaces w ON w.id=a.workspace_id WHERE a.user_id=? ORDER BY a.created_at DESC')).all(user.id)).map(async (row) => {
            const { inviteCode, ...result } = row;
            return { ...result, discordVerified: await workspaceVerified(db, row.workspaceId, user.id), inviteUrl: row.state === 'approved' && inviteCode && row.inviteExpires > now() ? `https://discord.gg/${inviteCode}` : null };
        }));
    }
    async function staffInvite(id, user) {
        await workspaces.requireRole(id, user, ['admin', 'instructor']);
        const guilds = (await workspaces.metadata(id)).guildIds;
        if (guilds.length !== 1)
            throw new ApiError(409, '관리자가 Discord 서버를 먼저 연결해야 합니다.');
        const existing = await (db.prepare('SELECT * FROM lms_admissions WHERE workspace_id=? AND user_id=?')).get(id, user.id);
        if (existing && (['queued', 'running'].includes(existing.invite_state) || (existing.state === 'approved' && existing.invite_code && existing.invite_expires > now())))
            return;
        await (db.prepare(`INSERT INTO lms_admissions(id,workspace_id,user_id,state,created_at,reviewed_by,reviewed_at,guild_id,invite_state,purpose)
      VALUES(?,?,?,'approved',?,?,?,?, 'queued','staff') ON CONFLICT(workspace_id,user_id) DO UPDATE SET state='approved',purpose='staff',guild_id=excluded.guild_id,invite_state='queued',invite_code=NULL,invite_expires=NULL,claim_hash=NULL,lease_until=NULL`)).run(randomUUID(), id, user.id, now(), user.id, now(), guilds[0]);
    }
    async function reviewList(id, user) {
        await workspaces.requireRole(id, user, ['admin', 'instructor']);
        const data = await workspaces.snapshot(id);
        return { guildIds: (await workspaces.metadata(id)).guildIds, teams: await availableTeams(id, user), applications: await Promise.all((await (db.prepare("SELECT a.id,a.user_id,u.name,u.username,a.state,a.created_at AS createdAt,a.reason,a.invite_state AS inviteState,a.guild_id AS guildId,a.team_id AS teamId FROM lms_admissions a JOIN lms_users u ON u.id=a.user_id WHERE a.workspace_id=? AND a.purpose='student' ORDER BY a.created_at DESC")).all(id)).map(async ({ user_id, ...row }) => ({ ...row, teamId: (await assignedTeam({ ...row, user_id, team_id: row.teamId }, data))?.id || '' }))) };
    }
    async function review(id, applicationId, body, user) {
        await workspaces.requireRole(id, user, ['admin', 'instructor']);
        const input = z.object({ action: z.enum(['approve', 'reject']), guildId: z.union([snowflake, z.literal('')]).default(''), reason: z.string().trim().max(300).default(''), teamId: z.string().max(200).default('') }).strict().parse(body);
        const row = await (db.prepare('SELECT * FROM lms_admissions WHERE id=? AND workspace_id=?')).get(applicationId, id);
        if (!row)
            throw new ApiError(404, '가입 신청을 찾을 수 없습니다.');
        const needsTeam = ['approved', 'joined'].includes(row.state) && row.purpose === 'student' && !row.team_id && input.action === 'approve';
        if (row.state !== 'pending' && !needsTeam)
            throw new ApiError(409, '이미 처리한 신청입니다.');
        if (input.action === 'approve') {
            if (!(await workspaces.metadata(id)).guildIds.includes(input.guildId))
                throw new ApiError(422, '이 워크스페이스에 연결된 Discord 서버를 선택하세요.');
            const team = (await availableTeams(id, user)).find(t => t.id === input.teamId);
            if (!team)
                throw new ApiError(422, '승인할 수강생의 담당 팀을 반드시 선택하세요.');
            const account = await (db.prepare('SELECT * FROM lms_users WHERE id=?')).get(row.user_id);
            await syncLearner(row, team, account, row.state === 'joined' && await workspaceVerified(db, id, account.id, input.guildId));
            if (needsTeam) {
                await (db.prepare('UPDATE lms_admissions SET team_id=?,reviewed_by=?,reviewed_at=? WHERE id=?')).run(input.teamId, user.id, now(), row.id);
                return { ok: true };
            }
            await (db.prepare("UPDATE lms_admissions SET state='approved',reviewed_by=?,reviewed_at=?,guild_id=?,invite_state='queued',reason=?,team_id=? WHERE id=? AND state='pending'")).run(user.id, now(), input.guildId, input.reason, input.teamId, row.id);
        }
        else
            await (db.prepare("UPDATE lms_admissions SET state='rejected',reviewed_by=?,reviewed_at=?,reason=? WHERE id=? AND state='pending'")).run(user.id, now(), input.reason, row.id);
        return { ok: true };
    }
    async function bulkReview(id, body, user) {
        await workspaces.requireRole(id, user, ['admin', 'instructor']);
        const input = z.object({ applicationIds: z.array(z.string().uuid()).min(1).max(100).refine(ids => new Set(ids).size === ids.length, '중복된 신청이 있습니다.'), guildId: snowflake, teamId: z.string().min(1).max(200), reason: z.string().trim().max(300).default('') }).strict().parse(body);
        if ((await workspaces.metadata(id)).archivedAt !== null)
            throw new ApiError(409, '보관된 워크스페이스에서는 승인할 수 없습니다.');
        if (!(await workspaces.metadata(id)).guildIds.includes(input.guildId))
            throw new ApiError(422, '이 워크스페이스에 연결된 Discord 서버를 선택하세요.');
        if (!(await availableTeams(id, user)).some(team => team.id === input.teamId))
            throw new ApiError(422, '배정할 수 있는 조를 선택하세요.');
        // Validate ownership for the whole selection before making any change.
        const rows = await Promise.all(input.applicationIds.map(async (applicationId) => await (db.prepare("SELECT id FROM lms_admissions WHERE id=? AND workspace_id=? AND purpose='student'")).get(applicationId, id)));
        if (rows.some(row => !row))
            throw new ApiError(404, '이 워크스페이스의 수강생 신청만 선택하세요.');
        const succeeded = [], failed = [];
        for (const applicationId of input.applicationIds) {
            try {
                await review(id, applicationId, { action: 'approve', guildId: input.guildId, teamId: input.teamId, reason: input.reason }, user);
                succeeded.push(applicationId);
            }
            catch (error) {
                if (!(error instanceof ApiError))
                    console.error('Bulk admission review failed:', error.code || error.name);
                failed.push({ id: applicationId, error: error instanceof ApiError ? error.message : '저장하지 못했습니다. 목록을 새로고침하고 다시 시도하세요.' });
            }
        }
        return { succeeded, failed };
    }
    async function approved(applicationId, user) {
        const row = await (db.prepare('SELECT * FROM lms_admissions WHERE id=? AND user_id=?')).get(applicationId, user.id);
        if (!row || row.state !== 'approved')
            throw new ApiError(403, '승인된 가입 신청이 필요합니다.');
        return row;
    }
    async function renew(applicationId, user) {
        const row = await approved(applicationId, user);
        if (['queued', 'running'].includes(row.invite_state) || (row.invite_code && row.invite_expires > now()))
            throw new ApiError(409, '발급 중이거나 사용 가능한 초대 링크가 있습니다.');
        await (db.prepare("UPDATE lms_admissions SET invite_state='queued',invite_code=NULL,invite_expires=NULL,claim_hash=NULL,lease_until=NULL WHERE id=?")).run(row.id);
        return { ok: true };
    }
    async function activate(discordId, guildId) {
        const user = await (db.prepare('SELECT * FROM lms_users WHERE discord_id=?')).get(discordId);
        if (!user)
            return;
        const approvedRows = await asyncFilter((await (db.prepare("SELECT * FROM lms_admissions WHERE user_id=? AND guild_id=? AND state='approved'")).all(user.id, guildId)), async (row) => await workspaceVerified(db, row.workspace_id, user.id, guildId));
        // Materialize the approved assignment before granting membership. This is
        // idempotent if a later registry write fails; no role is granted prematurely.
        for (const row of approvedRows.filter(a => a.purpose === 'student')) {
            const data = await workspaces.snapshot(row.workspace_id);
            const team = await assignedTeam(row, data);
            if (!team)
                throw new ApiError(422, '승인된 팀이 없습니다. 운영자에게 팀 배정을 요청하세요.');
            await syncLearner(row, team, user, true);
        }
        await db.exec('BEGIN IMMEDIATE');
        try {
            for (const row of approvedRows) {
                if (row.purpose === 'student')
                    await (db.prepare("INSERT OR IGNORE INTO lms_workspace_members VALUES(?,?,'student',?)")).run(row.workspace_id, user.id, now());
                await (db.prepare("UPDATE lms_admissions SET state='joined',invite_code=NULL,invite_expires=NULL WHERE id=?")).run(row.id);
            }
            await db.exec('COMMIT');
        }
        catch (error) {
            await db.exec('ROLLBACK');
            throw error;
        }
    }
    async function expire() { await (db.prepare("UPDATE lms_admissions SET invite_state='failed' WHERE invite_state='running' AND lease_until<=?")).run(now()); }
    function authorized(header = '') { return token.length >= 32 && timingSafeEqual(Buffer.from(digest(header)), Buffer.from(digest(`Bearer ${token}`))); }
    async function poll(body) {
        const { guildIds } = z.object({ guildIds: z.array(snowflake).max(10000) }).strict().parse(body);
        await expire();
        await db.exec('BEGIN IMMEDIATE');
        try {
            const row = await (db.prepare("SELECT * FROM lms_admissions WHERE state='approved' AND invite_state='queued' AND guild_id IN (SELECT value FROM json_each(?)) ORDER BY reviewed_at LIMIT 1")).get(JSON.stringify(guildIds));
            let job = null;
            if (row) {
                const claim = randomBytes(32).toString('hex');
                await (db.prepare("UPDATE lms_admissions SET invite_state='running',claim_hash=?,lease_until=? WHERE id=?")).run(digest(claim), now() + 120000, row.id);
                job = { id: row.id, claim, guildId: row.guild_id };
            }
            await db.exec('COMMIT');
            return { job };
        }
        catch (error) {
            await db.exec('ROLLBACK');
            throw error;
        }
    }
    async function complete(body) {
        const input = z.object({ id: z.string().uuid(), claim: z.string().regex(/^[a-f0-9]{64}$/), code: z.string().regex(/^[a-zA-Z0-9_-]{2,100}$/).nullable(), success: z.boolean() }).strict().parse(body);
        await expire();
        const row = await (db.prepare("SELECT * FROM lms_admissions WHERE id=? AND invite_state='running' AND state='approved'")).get(input.id);
        if (!row || row.claim_hash !== digest(input.claim))
            throw new ApiError(409, '초대 발급 작업이 만료됐습니다.');
        if (input.success && !input.code)
            throw new ApiError(422, '발급한 초대 코드가 필요합니다.');
        await (db.prepare('UPDATE lms_admissions SET invite_state=?,invite_code=?,invite_expires=?,claim_hash=NULL,lease_until=NULL WHERE id=?')).run(input.success ? 'ready' : 'failed', input.success ? input.code : null, input.success ? now() + 23 * 3600000 : null, input.id);
        return { ok: true };
    }
    async function manageStudent(id, userId, body, actor, remove = false) {
        await workspaces.requireRole(id, actor, ['admin']);
        if ((await workspaces.metadata(id)).archivedAt !== null) throw new ApiError(409, '보관된 워크스페이스입니다.');
        const profileFields = { name: z.string().trim().min(1).max(50), email: z.union([z.email(), z.literal('')]), phone: z.string().trim().max(100), school: z.string().trim().max(100), department: z.string().trim().max(100) };
        const input = z.object({ username: z.string(), revision: z.string(), profileRevision: z.string(), ...(remove ? {} : profileFields) }).strict().parse(body);
        const target = (await workspaces.open(id)).db;
        await db.exec('BEGIN IMMEDIATE');
        try {
            if (target !== db) await target.exec('BEGIN IMMEDIATE');
            await workspaces.requireRole(id, actor, ['admin']);
            const application = await db.prepare("SELECT a.*,u.username,u.platform_role FROM lms_admissions a JOIN lms_users u ON u.id=a.user_id WHERE a.workspace_id=? AND a.user_id=? AND a.purpose='student'").get(id, userId);
            if (!application || application.username !== input.username) throw new ApiError(404, '이 워크스페이스의 수강생을 찾을 수 없습니다.');
            const membership = await db.prepare('SELECT role FROM lms_workspace_members WHERE workspace_id=? AND user_id=?').get(id, userId);
            if (application.platform_role === 'admin' || membership && membership.role !== 'student') throw new ApiError(403, '관리자·멘토 정보는 구성원 관리에서 변경하세요.');
            const data = await workspaces.snapshot(id), profile = await studentProfile(id, userId);
            if (data.revision !== input.revision || digest(JSON.stringify(profile)) !== input.profileRevision) throw new ApiError(409, '수강생 정보가 변경됐습니다. 목록을 새로고침하세요.');
            const learner = await assignedLearner(application, data);
            if (learner) {
                const value = remove ? { ...learner, status: '비활성' } : { ...learner, name: input.name, email: input.email };
                await target.prepare("UPDATE lms_records SET data=? WHERE kind='learners' AND id=?").run(JSON.stringify(value), learner.id);
                await target.prepare('INSERT INTO lms_audit(actor,action,target,before_json,after_json) VALUES(?,?,?,?,?)').run(actor.username, remove ? 'student.remove' : 'student.edit', learner.id, JSON.stringify(learner), JSON.stringify(value));
            }
            if (remove) {
                await db.prepare('DELETE FROM lms_admissions WHERE workspace_id=? AND user_id=?').run(id, userId);
                await db.prepare("DELETE FROM lms_workspace_members WHERE workspace_id=? AND user_id=? AND role='student'").run(id, userId);
                await db.prepare('DELETE FROM lms_workspace_verifications WHERE workspace_id=? AND user_id=?').run(id, userId);
                await db.prepare('DELETE FROM lms_registrations WHERE workspace_id=? AND user_id=?').run(id, userId);
                await db.prepare("DELETE FROM lms_runtime_state WHERE guild_id=? AND kind='student-profile' AND record_key=?").run(`workspace:${id}`, userId);
            } else {
                const value = Object.fromEntries(Object.keys(profileFields).map(key => [key, input[key]]));
                await db.prepare('INSERT INTO lms_runtime_state VALUES(?,?,?,?) ON CONFLICT(guild_id,kind,record_key) DO UPDATE SET data=excluded.data').run(`workspace:${id}`, 'student-profile', userId, JSON.stringify(value));
            }
            await db.prepare('INSERT INTO lms_audit(actor,action,target) VALUES(?,?,?)').run(actor.username, remove ? 'student.enrollment-remove' : 'student.profile-edit', `${id}/${userId}`);
            if (target !== db) await target.exec('COMMIT');
            await db.exec('COMMIT');
        } catch (error) {
            if (target !== db && target.isTransaction) await target.exec('ROLLBACK');
            if (db.isTransaction) await db.exec('ROLLBACK');
            throw error;
        }
        return await studentAccounts(id, actor);
    }
    return { catalogue, validateStudentIssue, assignStudent, studentAccounts, changeStudentTeam, manageStudent, apply, own, staffInvite, reviewList, review, bulkReview, approved, renew, activate, authorized, poll, complete };
}

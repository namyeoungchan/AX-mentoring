import express from 'express';
import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { ApiError } from './store.mjs';
import { studentLearning } from './student.mjs';
import { configuredOrigins } from './origins.mjs';
import { createRuntime } from './runtime.mjs';
import { databaseContext, closePostgresConnections } from './postgres/database.mjs';
import { createDataMaintenance, recoverDataMaintenance, MAX_BACKUP_BYTES } from './data-maintenance.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
config({ path: resolve(root, '.env'), quiet: true });
const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.API_PORT || 3001);
const host = production ? '0.0.0.0' : '127.0.0.1';
const allowedOrigins = configuredOrigins({ production, allowedOrigins: process.env.ALLOWED_ORIGINS, renderExternalUrl: process.env.RENDER_EXTERNAL_URL });
const dbPath = resolve(root, process.env.BOT_DB_PATH || '../data/mentoring.db');
recoverDataMaintenance(dbPath);
let runtime, store, renderSync, auth, provision, workspaces, admissions, onboarding, staff, teamOperations, botStorage, assignmentAlerts, outbox, attendance, attendanceCodes;
async function openRuntime() {
    runtime = await createRuntime(dbPath);
    ({ store, renderSync, auth, provision, workspaces, admissions, onboarding, staff, teamOperations, botStorage, assignmentAlerts, outbox, attendance, attendanceCodes } = runtime);
}
await databaseContext(openRuntime);
const maintenance = createDataMaintenance({ dbPath, getRuntime: () => runtime, closeRuntime: () => runtime.close(), openRuntime });
async function prepareAssignmentAlerts() {
    if (maintenance.busy)
        return;
    for (const row of await (store.db.prepare('SELECT id FROM lms_workspaces WHERE archived_at IS NULL')).all()) {
        try {
            await assignmentAlerts.prepare(row.id, outbox.channel);
        }
        catch {
            console.error('Assignment notification preparation failed for workspace', row.id);
        }
    }
}
const background = action => databaseContext(()=>maintenance.track(async()=>{if(!maintenance.busy) await action()})()).catch(()=>console.error('Background database operation failed'));
const alertTimer=setInterval(()=>background(prepareAssignmentAlerts), 60000).unref();
setTimeout(()=>background(prepareAssignmentAlerts), 0).unref();
const app = express();
// Track the complete async handler, including a disconnected client's pending writes.
// Maintenance routes drain these handlers before replacing a database generation.
for(const method of ['get','post','patch','delete','use']) {
    const register=app[method];
    app[method]=function(path,...handlers) {
        return register.call(this,path,...handlers.map(handler=>typeof handler==='function' && handler.length<4
            ? (req,res,next)=>databaseContext(()=>req.originalUrl.startsWith('/api/admin/data') ? handler(req,res,next) : maintenance.track(handler)(req,res,next))
            : handler));
    };
}
app.disable('x-powered-by');
const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 5)
    throw new Error('TRUST_PROXY_HOPS must be an integer between 0 and 5');
if (proxyHops)
    app.set('trust proxy', proxyHops);
app.use('/api', async (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
    if (!production && !['localhost', '127.0.0.1'].includes(req.hostname))
        return res.status(403).json({ error: '로컬 개발 서버는 localhost로만 접근할 수 있습니다.' });
    const origin = req.get('origin');
    if (origin && !allowedOrigins.has(origin))
        return res.status(403).json({ error: '허용되지 않은 Origin입니다.' });
    if (origin) {
        res.set('Access-Control-Allow-Origin', origin);
        res.vary('Origin');
        res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    }
    if (req.method === 'OPTIONS')
        return res.sendStatus(204);
    if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json'))
        return res.status(415).json({ error: 'JSON 요청만 지원합니다.' });
    if (maintenance.busy && req.path !== '/health')
        return res.status(503).json({ error: '데이터 관리 작업 중입니다. 잠시 후 다시 시도하세요.' });
    next();
});
app.use('/api/integrations/discord/storage/bootstrap', async (req, res, next) => provision.authorized(req.get('authorization')) ? next() : res.status(401).json({ error: '봇 인증에 실패했습니다.' }), express.json({ limit: '70mb' }));
// Authenticate uploads before allocating the larger request body.
app.use('/api/admin/data', async (req, res, next) => {
    if (maintenance.busy)
        return res.status(503).json({ error: '데이터 관리 작업 중입니다. 잠시 후 다시 시도하세요.' });
    try {
        const user = await auth.session(await sessionToken(req));
        if (!user)
            return res.status(401).json({ error: '로그인이 필요합니다.' });
        await auth.platformAdmin(user);
        next();
    }
    catch (error) {
        next(error);
    }
}, express.json({ limit: '45mb', inflate: false }));
app.use(express.json({ limit: '10mb' }));
// Recheck after body parsing: a maintenance job may have started during upload.
app.use('/api', async (req, res, next) => {
    if (maintenance.busy && req.path !== '/health')
        return res.status(503).json({ error: '데이터 관리 작업 중입니다. 잠시 후 다시 시도하세요.' });
    next();
});
app.get('/api/health', async (_req, res) => {
    if(maintenance.broken) return res.status(503).json({status:'recovery-required'});
    try {await store.db.prepare('SELECT 1').get();}
    catch {return res.status(503).json({status:'database-unavailable'});}
    res.json({status:'ok',database:'connected',backend:store.db.dialect==='postgres'?'postgresql':'sqlite',auth:'required'});
});
app.post('/api/integrations/render/snapshot', async (req, res) => {
    if (!renderSync.authorized(req.get('authorization')))
        return res.status(401).json({ error: '동기화 인증에 실패했습니다.' });
    res.json(await workspaces.ingest(req.body));
});
function setLogin(res, result) {
    return res.cookie('learningops_session', result.token, { httpOnly: true, sameSite: 'strict', secure: production, maxAge: 8 * 60 * 60 * 1000, path: '/api' }).json({ ok: true, ...result });
}
// Only migration regression tests may create legacy self-registered students.
const legacyStudentRegistration = process.env.NODE_ENV === 'test' && process.env.ALLOW_LEGACY_STUDENT_REGISTRATION === 'true';
app.get('/api/auth/config', async (_req, res) => res.json({ setupEnabled: await auth.setupEnabled(), legacyAdminEnabled: await auth.legacyEnabled(), registrationEnabled: auth.enabled, studentRegistrationEnabled: legacyStudentRegistration, workspaces: await admissions.catalogue() }));
app.post('/api/auth/setup', maintenance.track(async (req, res) => {
    await auth.limit('setup-ip', req.ip, 5, 15 * 60000);
    setLogin(await res.status(201), await auth.setup(req.body));
}));
app.post('/api/auth/student/register', maintenance.track(async (req, res) => {
    if (!legacyStudentRegistration)
        throw new ApiError(403, '수강생 계정은 워크스페이스 관리자가 발급합니다. 전달받은 아이디로 로그인하세요.');
    await auth.limit('registration-ip', req.ip, 100, 3600000);
    const { workspaceId, ...input } = req.body || {};
    await workspaces.metadata(typeof workspaceId === 'string' ? workspaceId : '');
    const result = await auth.signup(input, async (user) => await admissions.apply(workspaceId, user));
    setLogin(await res.status(201), result);
}));
app.post('/api/invitations/preview', async (req, res) => {
    await auth.limit('invitation-preview', req.ip, 60, 60000);
    res.json(await workspaces.previewInvitation(req.body?.token));
});
app.post('/api/auth/register', maintenance.track(async (req, res) => {
    await auth.limit('registration-ip', req.ip, 100, 3600000);
    const { invitationToken, ...input } = req.body || {};
    if (invitationToken) {
        const check = async (username) => {
            if ((await workspaces.previewInvitation(invitationToken)).username !== (typeof username === 'string' ? username.trim().toLowerCase() : ''))
                throw new ApiError(403, '초대받은 아이디로 가입하세요.');
        };
        await check(input.username);
        return setLogin(await res.status(201), await auth.signup(input, async (user) => await check(user.username)));
    }
    if (!legacyStudentRegistration)
        throw new ApiError(403, '수강생 계정은 워크스페이스 관리자에게 발급을 요청하세요.');
    res.status(201).json(await auth.register(input, process.env.LEARNINGOPS_AUTH_GUILD_ID || ''));
}));
app.post('/api/auth/registration/status', async (req, res) => {
    await auth.limit('status-ip-v2', req.ip, 1200, 60000);
    await auth.limit('status-ticket', String(req.body?.ticket || '').slice(0,128), 30, 60000);
    res.json(await auth.status(req.body?.ticket));
});
app.post('/api/auth/registration/renew', async (req, res) => {
    await auth.limit('renew-ip', req.ip, 10, 60000);
    res.json(await auth.renew(req.body?.ticket));
});
app.post('/api/integrations/discord/:operation', async (req, res) => {
    if (!auth.botAuthorized(req.get('authorization')))
        return res.status(401).json({ error: '봇 인증에 실패했습니다.' });
    await auth.limit('discord-verify', String(req.body?.discordId || ''), 10, 60000);
    if (req.params.operation === 'preview')
        return res.json(await auth.preview(req.body));
    if (req.params.operation === 'verify') {
        const result = await auth.verify(req.body);
        await admissions.activate(req.body.discordId, req.body.guildId);
        await staff.syncDiscord(req.body.discordId, req.body.guildId);
        return res.json(result);
    }
    return res.status(404).json({ error: '지원하지 않는 인증 작업입니다.' });
});
app.post('/api/integrations/discord/attendance/presence/:operation', async (req, res) => {
    if (!auth.botAuthorized(req.get('authorization'))) return res.status(401).json({ error: '출석 봇 인증에 실패했습니다.' });
    if (!['view', 'mark'].includes(req.params.operation)) throw new ApiError(404, '지원하지 않는 출석 작업입니다.');
    await auth.limit('attendance-presence-bot', `${req.body?.guildId || ''}:${req.body?.discordId || ''}`, 30, 60000);
    res.json(await runtime.attendancePresence.discord(req.body, req.params.operation === 'mark'));
});
app.post('/api/integrations/discord/attendance/checkin', async (req, res) => {
    if (!auth.botAuthorized(req.get('authorization')))
        return res.status(401).json({ error: '봇 인증에 실패했습니다.' });
    await auth.limit('attendance-presence-bot', `${req.body?.guildId || ''}:${req.body?.discordId || ''}`, 30, 60000);
    res.json(await attendanceCodes.checkIn(req.body));
});
app.post('/api/auth/login', maintenance.track(async (req, res) => {
    // A classroom shares one public IP. Account-level failed-attempt limits remain strict.
    await auth.limit('member-ip-v2', req.ip, 1200, 15 * 60000);
    setLogin(res, await auth.login(req.body));
}));
app.post('/api/integrations/discord/provision/:operation', async (req, res) => {
    if (!provision.authorized(req.get('authorization')))
        return res.status(401).json({ error: '채널 설정 봇 인증에 실패했습니다.' });
    if (req.params.operation === 'heartbeat') {
        await provision.heartbeat(req.body);
        return res.json({ ok: true });
    }
    if (req.params.operation === 'poll')
        return res.json(await provision.poll(req.body));
    if (req.params.operation === 'complete')
        return res.json(await provision.complete(req.body));
    return res.status(404).json({ error: '지원하지 않는 작업입니다.' });
});
app.post('/api/integrations/discord/onboarding/:operation', async (req, res) => {
    if (!provision.authorized(req.get('authorization')))
        return res.status(401).json({ error: '봇 인증에 실패했습니다.' });
    if (req.params.operation === 'poll')
        return res.json(await onboarding.poll(req.body));
    if (req.params.operation === 'report')
        return res.json(await onboarding.report(req.body));
    if (req.params.operation === 'progress')
        return res.json(await onboarding.progress(req.body));
    return res.status(404).json({ error: '지원하지 않는 작업입니다.' });
});
app.post('/api/integrations/discord/outbox/:operation', async (req, res) => {
    if (!provision.authorized(req.get('authorization')))
        return res.status(401).json({ error: '봇 인증에 실패했습니다.' });
    if (req.params.operation === 'poll')
        return res.json(await outbox.poll(req.body));
    if (req.params.operation === 'complete')
        return res.json(await outbox.complete(req.body));
    res.status(404).json({ error: '지원하지 않는 작업입니다.' });
});
app.post('/api/integrations/discord/storage/:operation', maintenance.track(async (req, res) => {
    if (!provision.authorized(req.get('authorization')))
        return res.status(401).json({ error: '봇 인증에 실패했습니다.' });
    if (req.params.operation === 'registry')
        return res.json(await botStorage.registry(req.body));
    if (req.params.operation === 'status')
        return res.json(await botStorage.status(req.body?.guildId));
    if (req.params.operation === 'snapshot')
        return res.json(await botStorage.snapshot(req.body?.guildId));
    if (req.params.operation === 'bootstrap')
        return res.json(await botStorage.bootstrap(req.body));
    if (req.params.operation === 'call')
        return res.json(await botStorage.call(req.body));
    if (req.params.operation === 'runtime')
        return res.json(await botStorage.runtime(req.body));
    if (req.params.operation === 'bind-panels')
        return res.json(await botStorage.bindPanels(req.body));
    return res.status(404).json({ error: '지원하지 않는 작업입니다.' });
}));
app.post('/api/login', async (req, res) => {
    await auth.limit('admin-ip', req.ip, 20, 60000);
    setLogin(res, await auth.adminLogin(req.body?.password));
});
app.post('/api/integrations/discord/admissions/:operation', async (req, res) => {
    if (!admissions.authorized(req.get('authorization')))
        return res.status(401).json({ error: '초대 발급 봇 인증에 실패했습니다.' });
    if (req.params.operation === 'poll')
        return res.json(await admissions.poll(req.body));
    if (req.params.operation === 'complete')
        return res.json(await admissions.complete(req.body));
    return res.status(404).json({ error: '지원하지 않는 작업입니다.' });
});
const sessionToken = async (req) => (req.get('authorization'))?.startsWith('Bearer ') ? (req.get('authorization')).slice(7) : req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('learningops_session='))?.slice('learningops_session='.length);
app.use('/api', async (req, res, next) => {
    req.account = await auth.session(await sessionToken(req));
    if (!req.account)
        return res.status(401).json({ error: '로그인이 필요합니다.' });
    if ((req.account.mustChangePassword || req.account.mustCompleteProfile) && !['/auth/me', '/auth/password', '/auth/first-login', '/logout'].includes(req.path))
        return res.status(403).json({ error: '초기 비밀번호를 변경한 뒤 이용하세요.', code: 'PASSWORD_CHANGE_REQUIRED' });
    next();
});
app.get('/api/auth/me', (req, res) => res.json({ user: req.account }));
app.post('/api/auth/first-login', maintenance.track(async (req, res) => setLogin(res, await auth.completeFirstLogin(req.account, req.body))));
app.post('/api/auth/password', maintenance.track(async (req, res) => setLogin(res, await auth.changePassword(req.account, req.body))));
app.get('/api/admin/accounts', async (req, res) => res.json(await auth.accounts(req.account)));
app.get('/api/admin/performance', async (req, res) => {
    await auth.platformAdmin(req.account);
    res.json({ storage: botStorage.diagnostics() });
});
app.post('/api/admin/accounts/:id/reset-password', maintenance.track(async (req, res) => res.json(await auth.resetAccount(req.account, req.params.id, req.body))));
app.delete('/api/admin/accounts/:id', async (req, res) => res.json(await auth.deleteAccount(req.account, req.params.id, req.body)));
app.use('/api/admin/data', async (req, _res, next) => { await auth.platformAdmin(req.account); next(); });
app.get('/api/admin/data', async (_req, res) => res.json(await maintenance.status()));
const sendBackup = async (res, bytes, name) => await res.type('application/octet-stream').attachment(name).send(bytes);
app.get('/api/admin/data/backup', async (req, res) => {
    const bytes = await maintenance.exclusive(async () => {
        await auth.platformAdmin(await auth.session(await sessionToken(req)));
        return await maintenance.backup();
    });
    await sendBackup(res, bytes, `learningops-${new Date().toISOString().slice(0, 10)}.axbackup`);
});
app.get('/api/admin/data/backups/:id', async (req, res) => await sendBackup(res, maintenance.download(req.params.id), req.params.id));
app.post('/api/admin/data/preview', async (req, res) => {
    await auth.limit('backup-preview', req.account.id, 10, 15 * 60000);
    const encoded = req.body?.backup;
    if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_BACKUP_BYTES / 3) * 4)
        throw new ApiError(413, '백업 파일은 최대 32MB까지 지원합니다.');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded)
        throw new ApiError(422, '백업 파일 형식이 올바르지 않습니다.');
    res.json(await maintenance.exclusive(async () => {
        await auth.platformAdmin(await auth.session(await sessionToken(req)));
        return await maintenance.preview(bytes, req.account.id);
    }));
});
for (const action of ['reset', 'restore'])
    app.post(`/api/admin/data/${action}`, async (req, res) => {
        await auth.limit('data-replace', req.account.id, 5, 15 * 60000);
        if (req.body?.confirmation !== (action === 'reset' ? '전체 데이터 초기화' : '백업으로 전체 복구'))
            throw new ApiError(422, '확인 문구를 정확히 입력하세요.');
        const result = await maintenance.exclusive(async () => {
            const user = await auth.session(await sessionToken(req));
            await auth.confirmAdmin(user, req.body?.currentPassword);
            return await maintenance.replace(action, req.body?.token, user.id);
        });
        res.clearCookie('learningops_session', { path: '/api' }).json(result);
    });
app.get('/api/me/admissions', async (req, res) => res.json({ applications: await admissions.own(req.account) }));
app.post('/api/me/admissions', async (req, res) => res.status(201).json(await admissions.apply(req.body?.workspaceId, req.account)));
app.post('/api/me/admissions/:id/renew', async (req, res) => {
    await auth.limit('admission-renew', req.account.id, 5, 3600000);
    res.json(await admissions.renew(req.params.id, req.account));
});
app.post('/api/me/admissions/:id/verification', async (req, res) => {
    const application = await admissions.approved(req.params.id, req.account);
    res.json(await auth.issueVerification(req.account, application.guild_id));
});
app.post('/api/invitations/accept', async (req, res) => res.json(await workspaces.acceptInvitation(req.body?.token, req.account)));
app.get('/api/me/learning', async (req, res) => {
    if (req.account.role !== 'student')
        return res.status(403).json({ error: '수강생 계정으로 로그인하세요.' });
    const workspace = (await workspaces.list(req.account))[0];
    if (!workspace)
        return res.status(403).json({ error: '소속된 워크스페이스가 없습니다.' });
    res.json(await studentLearning((await workspaces.open(workspace.id)).db, req.account, workspace.discordVerified));
});
app.post('/api/logout', async (req, res) => {
    await auth.logout(await sessionToken(req));
    res.clearCookie('learningops_session', { path: '/api' }).json({ ok: true });
});
const requireAdmin = async (req, res, next) => {
    if (req.account.role !== 'admin')
        return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    next();
};
app.get('/api/workspaces', async (req, res) => res.json({ workspaces: await workspaces.list(req.account, { includeArchived: req.query.includeArchived === 'true' }) }));
app.post('/api/workspaces', requireAdmin, async (req, res) => res.status(201).json(await workspaces.create(req.body)));
app.use('/api/workspaces/:workspaceId', async (req, _res, next) => {
    req.workspaceId = req.params.workspaceId;
    req.workspace = await workspaces.requireAccess(req.workspaceId, req.account);
    next();
});
app.get('/api/workspaces/:workspaceId', (req, res) => res.json(req.workspace));
app.get('/api/workspaces/:workspaceId/videos', async (req, res) => res.json(await runtime.courseVideos.list(req.workspaceId, req.account)));
app.post('/api/workspaces/:workspaceId/videos', async (req, res) => {
    await auth.limit('video-upload', req.account.id, 20, 3600000);
    res.status(201).json(await runtime.courseVideos.create(req.workspaceId, req.body, req.account));
});
app.post('/api/workspaces/:workspaceId/videos/:videoId/upload', async (req, res) => res.json(await runtime.courseVideos.upload(req.workspaceId, req.params.videoId, req.account)));
app.post('/api/workspaces/:workspaceId/videos/:videoId/refresh', async (req, res) => {
    await auth.limit('video-refresh', req.account.id, 120, 60000);
    res.json(await runtime.courseVideos.refresh(req.workspaceId, req.params.videoId, req.account));
});
app.patch('/api/workspaces/:workspaceId/videos/:videoId', async (req, res) => {
    await auth.limit('video-edit', req.account.id, 60, 60000);
    res.json(await runtime.courseVideos.edit(req.workspaceId, req.params.videoId, req.body, req.account));
});
app.get('/api/workspaces/:workspaceId/videos/:videoId/playback', async (req, res) => res.json(await runtime.courseVideos.playback(req.workspaceId, req.params.videoId, req.account)));
app.post('/api/workspaces/:workspaceId/me/verification', async (req, res) => {
    await workspaces.requireRole(req.workspaceId, req.account, ['admin', 'student']);
    if (req.workspace.guildIds.length !== 1)
        throw new ApiError(409, '워크스페이스에 Discord 서버 하나를 연결해야 합니다.');
    res.json(await auth.issueVerification(req.account, req.workspace.guildIds[0]));
});
app.get('/api/workspaces/:workspaceId/me/learning', async (req, res) => {
    await workspaces.requireRole(req.workspaceId, req.account, ['student']);
    res.json(await studentLearning((await workspaces.open(req.workspaceId)).db, req.account, req.workspace.discordVerified));
});
app.get('/api/workspaces/:workspaceId/teaching', async (req, res) => {
    await workspaces.requireRole(req.workspaceId, req.account, ['instructor']);
    res.json({ ...await workspaces.teaching(req.workspaceId, req.account), onboardingComplete: (await staff.read(req.workspaceId, req.account)).completed });
});
app.get('/api/workspaces/:workspaceId/me/attendance', async (req, res) => res.json(await runtime.attendancePresence.view(req.workspaceId, req.account)));
app.post('/api/workspaces/:workspaceId/me/attendance', async (req, res) => {
    await auth.limit('attendance-presence-web', `${req.workspaceId}:${req.account.id}`, 30, 60000);
    res.json(await runtime.attendancePresence.mark(req.workspaceId, req.body, req.account));
});
app.get('/api/workspaces/:workspaceId/attendance', async (req, res) => res.json(await attendance.view(req.workspaceId, req.query, req.account)));
app.post('/api/workspaces/:workspaceId/attendance', async (req, res) => res.json(await attendance.save(req.workspaceId, req.body, req.account)));
app.get('/api/workspaces/:workspaceId/attendance/code', async (req, res) => res.json(await attendanceCodes.status(req.workspaceId, req.query, req.account)));
app.post('/api/workspaces/:workspaceId/attendance/code', async (req, res) => {
    await auth.limit('attendance-code-issue', req.account.id, 30, 3600000);
    res.json(await attendanceCodes.issue(req.workspaceId, req.body, req.account));
});
app.post('/api/workspaces/:workspaceId/attendance/code/revoke', async (req, res) => res.json(await attendanceCodes.revoke(req.workspaceId, req.body, req.account)));
app.get('/api/workspaces/:workspaceId/attendance/discord', async (req, res) => res.json(await attendance.discord(req.workspaceId, req.query, req.account)));
app.post('/api/workspaces/:workspaceId/attendance/discord', async (req, res) => res.json(await attendance.share(req.workspaceId, req.body, req.account)));
app.get('/api/workspaces/:workspaceId/admissions', async (req, res) => res.json(await admissions.reviewList(req.workspaceId, req.account)));
app.post('/api/workspaces/:workspaceId/admissions/bulk-review', async (req, res) => res.json(await admissions.bulkReview(req.workspaceId, req.body, req.account)));
app.post('/api/workspaces/:workspaceId/admissions/:id/review', async (req, res) => res.json(await admissions.review(req.workspaceId, req.params.id, req.body, req.account)));
app.patch('/api/workspaces/:workspaceId/teaching', async (req, res) => res.json(await workspaces.teach(req.workspaceId, req.body, req.account)));
app.get('/api/workspaces/:workspaceId/team-operations', async (req, res) => res.json(await teamOperations.read(req.workspaceId, req.account)));
app.post('/api/workspaces/:workspaceId/team-operations', async (req, res) => res.json(await teamOperations.save(req.workspaceId, req.body, req.account)));
app.post('/api/workspaces/:workspaceId/team-operations/retry', async (req, res) => res.json(await teamOperations.retry(req.workspaceId, req.body, req.account)));
app.get('/api/workspaces/:workspaceId/staff/onboarding', async (req, res) => res.json(await staff.read(req.workspaceId, req.account)));
app.post('/api/workspaces/:workspaceId/staff/profile', async (req, res) => res.json(await staff.profile(req.workspaceId, req.body, req.account)));
app.post('/api/workspaces/:workspaceId/staff/invite', async (req, res) => { await auth.limit('staff-invite', req.account.id, 5, 3600000); res.json(await staff.invite(req.workspaceId, req.account)); });
app.post('/api/workspaces/:workspaceId/staff/step', async (req, res) => res.json(await staff.step(req.workspaceId, req.body, req.account)));
app.post('/api/workspaces/:workspaceId/staff/verification', async (req, res) => {
    const state = await staff.read(req.workspaceId, req.account);
    if (!state.profile || !state.guildId)
        throw new ApiError(409, '기본 정보와 Discord 서버 연결을 먼저 완료하세요.');
    res.json(await auth.issueVerification(req.account, state.guildId));
});
app.use('/api/workspaces/:workspaceId', async (req, _res, next) => { await workspaces.requireRole(req.workspaceId, req.account, ['admin']); next(); });
app.get('/api/workspaces/:workspaceId/student-accounts', async (req, res) => res.json(await admissions.studentAccounts(req.workspaceId, req.account)));
app.post('/api/workspaces/:workspaceId/student-roster/preview', async (req, res) => res.json(await runtime.studentRoster.preview(req.workspaceId, req.body, req.account)));
for (const action of ['groups', 'accounts']) app.post(`/api/workspaces/:workspaceId/student-roster/${action}`, async (req, res) => {
    await auth.limit('student-roster-import', req.account.id, 20, 3600000);
    res.json(await runtime.studentRoster.apply(req.workspaceId, req.body, req.account, action === 'accounts'));
});
app.patch('/api/workspaces/:workspaceId/student-accounts/:userId/team', async (req, res) => res.json(await admissions.changeStudentTeam(req.workspaceId, req.params.userId, req.body, req.account)));
app.patch('/api/workspaces/:workspaceId/student-accounts/:userId', async (req, res) => res.json(await admissions.manageStudent(req.workspaceId, req.params.userId, req.body, req.account)));
app.delete('/api/workspaces/:workspaceId/student-accounts/:userId', async (req, res) => res.json(await admissions.manageStudent(req.workspaceId, req.params.userId, req.body, req.account, true)));
app.post('/api/workspaces/:workspaceId/student-accounts', maintenance.track(async (req, res) => {
    await auth.limit('student-account-issue', req.account.id, 100, 3600000);
    const { teamId, ...input } = req.body || {};
    const authorize = async () => await admissions.validateStudentIssue(req.workspaceId, teamId, req.account);
    const result = await auth.createStudentAccount(input, req.account, authorize, async (user) => await admissions.assignStudent(req.workspaceId, teamId, user, req.account));
    res.status(201).json(result);
}));
app.get('/api/workspaces/:workspaceId/notices', async (req, res) => res.json(await outbox.notices(req.workspaceId, req.account)));
app.get('/api/workspaces/:workspaceId/courses/:courseId/manage', async (req, res) => res.json(await runtime.courseManagement.read(req.workspaceId, req.params.courseId, req.account)));
app.patch('/api/workspaces/:workspaceId/courses/:courseId/manage', async (req, res) => res.json(await runtime.courseManagement.update(req.workspaceId, req.params.courseId, req.body, req.account)));
app.get('/api/workspaces/:workspaceId/assignment-alerts', async (req, res) => res.json(await assignmentAlerts.read(req.workspaceId, req.account)));
app.get('/api/workspaces/:workspaceId/assignments/:id/deletion', async (req, res) => res.json(await botStorage.assignmentDeletion(req.workspaceId, req.params.id, null, req.account)));
app.delete('/api/workspaces/:workspaceId/assignments/:id', maintenance.track(async (req, res) => res.json(await botStorage.assignmentDeletion(req.workspaceId, req.params.id, req.body, req.account))));
app.post('/api/workspaces/:workspaceId/assignment-alerts/:id/publish', async (req, res) => res.json(await assignmentAlerts.publish(req.workspaceId, req.params.id, req.body, req.account)));
app.post('/api/workspaces/:workspaceId/assignment-alerts/:id/course', async (req, res) => res.json(await assignmentAlerts.bind(req.workspaceId, req.params.id, req.body, req.account)));
app.post('/api/workspaces/:workspaceId/notices/:noticeId/send', async (req, res) => res.json(await outbox.enqueueNotice(req.workspaceId, req.params.noticeId, req.body, req.account)));
app.post('/api/workspaces/:workspaceId/outbox/:id/retry', async (req, res) => res.json(await outbox.retry(req.workspaceId, req.params.id, req.account)));
app.post('/api/workspaces/:workspaceId/outbox/:id/manual', async (req, res) => res.json(await outbox.manual(req.workspaceId, req.params.id, req.body, req.account)));
app.post('/api/workspaces/:workspaceId/outbox/:id/hold', async (req, res) => res.json(await outbox.hold(req.workspaceId, req.params.id, req.account)));
app.get('/api/workspaces/:workspaceId/discord/groups', async (req, res) => res.json(await staff.groups(req.workspaceId)));
app.post('/api/workspaces/:workspaceId/discord/groups', async (req, res) => res.json(await staff.setupGroups(req.workspaceId, req.body, req.account)));
app.post('/api/workspaces/:workspaceId/archive', async (req, res) => res.json(await workspaces.setArchived(req.workspaceId, true, req.account)));
app.post('/api/workspaces/:workspaceId/restore', async (req, res) => res.json(await workspaces.setArchived(req.workspaceId, false, req.account)));
app.get('/api/workspaces/:workspaceId/members', async (req, res) => res.json(await staff.members(req.workspaceId, req.account)));
app.patch('/api/workspaces/:workspaceId/members/:memberId', async (req, res) => res.json(await staff.editMember(req.workspaceId, req.params.memberId, req.body, req.account)));
app.delete('/api/workspaces/:workspaceId/members/:memberId', async (req, res) => res.json(await staff.removeMember(req.workspaceId, req.params.memberId, req.account)));
app.patch('/api/workspaces/:workspaceId/members/:memberId/assignment', async (req, res) => res.json(await workspaces.assignMentor(req.workspaceId, req.params.memberId, req.body, req.account)));
app.get('/api/workspaces/:workspaceId/bot-data', async (req, res) => res.json(await botStorage.state(req.workspaceId)));
app.get('/api/workspaces/:workspaceId/bot-data/table/:table', async (req, res) => res.json(await botStorage.table(req.workspaceId, req.params.table, req.query.page)));
app.get('/api/workspaces/:workspaceId/bot-data/archive/:checksum', async (req, res) => res.json({ archive: await botStorage.archive(req.workspaceId, req.params.checksum) }));
app.post('/api/workspaces/:workspaceId/bot-data/settings', async (req, res) => res.json(await botStorage.settings(req.workspaceId, req.body)));
app.post('/api/workspaces/:workspaceId/bot-data/operation', maintenance.track(async (req, res) => res.json(await botStorage.call(req.body, req.account.username, req.workspaceId))));
app.get('/api/workspaces/:workspaceId/discord/onboarding', async (req, res) => res.json(await onboarding.read(req.workspaceId)));
app.post('/api/workspaces/:workspaceId/discord/onboarding', async (req, res) => res.json(await onboarding.save(req.workspaceId, req.body)));
app.post('/api/workspaces/:workspaceId/invitations', async (req, res) => res.status(201).json(await workspaces.invite(req.workspaceId, req.body, req.account)));
app.post('/api/workspaces/:workspaceId/invitations/account', requireAdmin, maintenance.track(async (req, res) => {
    await auth.limit('invitation-account', req.account.id, 20, 3600000);
    const result = await auth.createInvitationAccount(req.body, req.account, async (username) => await workspaces.invite(req.workspaceId, { username, role: 'admin' }, req.account));
    res.status(201).json(result);
}));
app.patch('/api/workspaces/:workspaceId/invitations/:invitationId', async (req, res) => { await workspaces.editInvitation(req.workspaceId, req.params.invitationId, req.body, req.account); res.json(await staff.members(req.workspaceId, req.account)); });
app.post('/api/workspaces/:workspaceId/invitations/:invitationId/revoke', async (req, res) => res.json(await workspaces.revokeInvitation(req.workspaceId, req.params.invitationId, req.account)));
app.get('/api/workspaces/:workspaceId/workspace', async (req, res) => res.json(await workspaces.snapshot(req.workspaceId)));
app.patch('/api/workspaces/:workspaceId/workspace', async (req, res) => res.json(await workspaces.mutate(req.workspaceId, req.body, req.account.username)));
app.get('/api/workspaces/:workspaceId/audit', async (req, res) => res.json(await ((await workspaces.open(req.workspaceId)).db.prepare('SELECT * FROM lms_audit ORDER BY id DESC LIMIT 500')).all()));
app.get('/api/workspaces/:workspaceId/integrations/render', async (req, res) => res.json({ ...await (await workspaces.remote(req.workspaceId)).read(), connection: await workspaces.connection(req.workspaceId) }));
app.get('/api/workspaces/:workspaceId/discord/provision', async (req, res) => res.json(await workspaces.provisionRead(req.workspaceId)));
app.post('/api/workspaces/:workspaceId/discord/provision/template', async (req, res) => res.json(await workspaces.saveTemplate(req.workspaceId, req.body)));
app.post('/api/workspaces/:workspaceId/discord/provision/servers', async (req, res) => {
    const result = await workspaces.addServer(req.workspaceId, req.body);
    await staff.enableTeams(req.workspaceId);
    res.status(result.created ? 201 : 200).json(result);
});
app.post('/api/workspaces/:workspaceId/discord/provision/plans', async (req, res) => res.json(await workspaces.savePlan(req.workspaceId, req.body)));
app.post('/api/workspaces/:workspaceId/discord/provision/jobs', async (req, res) => res.status(202).json(await workspaces.enqueue(req.workspaceId, req.body)));
// Legacy endpoints retain the original workspace for existing clients.
app.use('/api', requireAdmin);
app.get('/api/workspace', async (_req, res) => res.json(await workspaces.snapshot('default')));
app.get('/api/discord/provision', async (_req, res) => res.json(await workspaces.provisionRead('default')));
app.post('/api/discord/provision/plans', async (req, res) => res.json(await workspaces.savePlan('default', req.body)));
app.post('/api/discord/provision/jobs', async (req, res) => res.status(202).json(await workspaces.enqueue('default', req.body)));
app.patch('/api/workspace', async (req, res) => res.json(await workspaces.mutate('default', req.body, req.account.username)));
app.get('/api/audit', async (_req, res) => res.json(await (store.db.prepare('SELECT * FROM lms_audit ORDER BY id DESC LIMIT 500')).all()));
app.get('/api/integrations/render', async (_req, res) => res.json(await renderSync.read()));
app.use('/api', async (_req, res) => res.status(404).json({ error: '지원하지 않는 API입니다.' }));
app.use(express.static(resolve(root, 'dist')));
app.use(async (error, _req, res, _next) => {
    if (Number.isInteger(error.retryAfter) && error.retryAfter > 0) res.set('Retry-After', String(error.retryAfter));
    if (error instanceof ZodError)
        return res.status(422).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(' / ') });
    if (error.status)
        return res.status(error.status).json({ error: error.message, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) });
    if (/UNIQUE constraint/.test(error.message) || error.code==='23505')
        return res.status(409).json({ error: '중복된 과정 코드·기수, 이메일, Discord ID 또는 데이터입니다.' });
    if(['55P03','57014','40001','40P01','53300'].includes(error.code)) return res.status(503).json({error:'데이터 저장소가 사용 중입니다. 잠시 후 다시 시도하세요.'});
    console.error('API operation failed:', error.code || error.name);
    res.status(500).json({ error: '저장하지 못했습니다. 서버 로그와 데이터베이스 연결을 확인하세요.' });
});
await auth.cleanup();
const cleanup = setInterval(()=>background(()=>auth.cleanup()), 60000).unref();
const server = app.listen(port, host, () => console.log(`LearningOps API: http://${host}:${port} (authentication required)`));
for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => server.close(async () => { clearInterval(cleanup); clearInterval(alertTimer); runtime.close(); await closePostgresConnections(); process.exit(0); }));

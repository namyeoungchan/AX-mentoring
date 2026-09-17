import express from 'express'
import { config } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZodError } from 'zod'
import { ApiError, createStore } from './store.mjs'
import { createRenderSync } from './render-sync.mjs'
import { createAuth } from './auth.mjs'
import { studentLearning } from './student.mjs'
import { createProvision } from './provision.mjs'
import { createWorkspaces } from './workspaces.mjs'
import { createAdmissions } from './admissions.mjs'
import { configuredOrigins } from './origins.mjs'
import { createOnboarding } from './onboarding.mjs'
import { createBotStorage } from './bot-storage.mjs'
import { createStaffFlow } from './staff-flow.mjs'
import { createOutbox } from './outbox.mjs'
import { createAssignmentAlerts } from './assignment-alerts.mjs'
import { createTeamOperations } from './team-operations.mjs'
import { createAttendance } from './attendance.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
config({ path: resolve(root, '.env'), quiet: true })
const production = process.env.NODE_ENV === 'production'
const password = process.env.ADMIN_PASSWORD || ''
const port = Number(process.env.API_PORT || 3001)
const host = production ? '0.0.0.0' : '127.0.0.1'
const allowedOrigins = configuredOrigins({ production, allowedOrigins: process.env.ALLOWED_ORIGINS, renderExternalUrl: process.env.RENDER_EXTERNAL_URL })
const dbPath = resolve(root, process.env.BOT_DB_PATH || '../data/mentoring.db')
const store = createStore(dbPath)
const renderSync = createRenderSync(store.db, { token: process.env.LEARNINGOPS_SYNC_TOKEN || '', sourceId: process.env.LEARNINGOPS_SOURCE_ID || 'asan-ax' })
const auth = createAuth(store.db, { adminPassword: password, allowLegacyAdmin: !production && process.env.ALLOW_LEGACY_ADMIN === 'true', botToken: process.env.LEARNINGOPS_AUTH_TOKEN || '', guildId: process.env.LEARNINGOPS_AUTH_GUILD_ID || '', guildAllowed: id => id === process.env.LEARNINGOPS_AUTH_GUILD_ID || Boolean(store.db.prepare('SELECT 1 FROM lms_workspace_guilds WHERE guild_id=?').get(id)) })
if (production && !store.db.prepare("SELECT 1 FROM lms_users WHERE platform_role='admin'").get() && !auth.setupEnabled()) throw new Error('최초 관리자 등록을 위해 16자 이상의 ADMIN_PASSWORD 설정 키가 필요합니다.')
const provision = createProvision(store.db, { token: process.env.LEARNINGOPS_PROVISION_TOKEN || '' })
const workspaces = createWorkspaces({ store, dbPath, provision, syncToken: process.env.LEARNINGOPS_SYNC_TOKEN || '', sourceId: process.env.LEARNINGOPS_SOURCE_ID || 'asan-ax', authGuildId: process.env.LEARNINGOPS_AUTH_GUILD_ID || '' })
const admissions = createAdmissions(store.db, workspaces, { token: process.env.LEARNINGOPS_PROVISION_TOKEN || '' })
const onboarding = createOnboarding(store.db, workspaces, provision)
const staff = createStaffFlow(store.db, workspaces, onboarding, admissions)
const teamOperations = createTeamOperations(workspaces, onboarding)
const botStorage = createBotStorage(store.db, workspaces, onboarding)
const assignmentAlerts = createAssignmentAlerts(store.db, workspaces)
const outbox = createOutbox(store.db, workspaces, { prepare: assignmentAlerts.prepare })
const attendance = createAttendance(workspaces, { outbox })
function prepareAssignmentAlerts() {
  for (const row of store.db.prepare('SELECT id FROM lms_workspaces WHERE archived_at IS NULL').all()) {
    try { assignmentAlerts.prepare(row.id, outbox.channel) } catch { console.error('Assignment notification preparation failed for workspace', row.id) }
  }
}
setInterval(prepareAssignmentAlerts, 60000).unref()
setTimeout(prepareAssignmentAlerts, 0).unref()
const app = express()
app.disable('x-powered-by')
const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0)
if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 5) throw new Error('TRUST_PROXY_HOPS must be an integer between 0 and 5')
if (proxyHops) app.set('trust proxy', proxyHops)
app.use('/api/integrations/discord/storage/bootstrap', (req, res, next) => provision.authorized(req.get('authorization')) ? next() : res.status(401).json({ error: '봇 인증에 실패했습니다.' }), express.json({ limit: '70mb' }))
app.use(express.json({ limit: '10mb' }))
app.use('/api', (req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' })
  if (!production && !['localhost', '127.0.0.1'].includes(req.hostname)) return res.status(403).json({ error: '로컬 개발 서버는 localhost로만 접근할 수 있습니다.' })
  const origin = req.get('origin')
  if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ error: '허용되지 않은 Origin입니다.' })
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin)
    res.vary('Origin')
    res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
    res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error: 'JSON 요청만 지원합니다.' })
  next()
})
app.get('/api/health', (_req, res) => res.json({ status: 'ok', database: 'connected', auth: 'required' }))
app.post('/api/integrations/render/snapshot', (req, res) => {
  if (!renderSync.authorized(req.get('authorization'))) return res.status(401).json({ error: '동기화 인증에 실패했습니다.' })
  res.json(workspaces.ingest(req.body))
})
function setLogin(res, result) {
  return res.cookie('learningops_session', result.token, { httpOnly: true, sameSite: 'strict', secure: production, maxAge: 8 * 60 * 60 * 1000, path: '/api' }).json({ ok: true, ...result })
}
// Only migration regression tests may create legacy self-registered students.
const legacyStudentRegistration = process.env.NODE_ENV === 'test' && process.env.ALLOW_LEGACY_STUDENT_REGISTRATION === 'true'
app.get('/api/auth/config', (_req, res) => res.json({ setupEnabled: auth.setupEnabled(), legacyAdminEnabled: auth.legacyEnabled(), registrationEnabled: auth.enabled, studentRegistrationEnabled: legacyStudentRegistration, workspaces: admissions.catalogue() }))
app.post('/api/auth/setup', async (req, res) => {
  auth.limit('setup-ip', req.ip, 5, 15 * 60000)
  setLogin(res.status(201), await auth.setup(req.body))
})
app.post('/api/auth/student/register', async (req, res) => {
  if (!legacyStudentRegistration) throw new ApiError(403, '수강생 계정은 워크스페이스 관리자가 발급합니다. 전달받은 아이디로 로그인하세요.')
  auth.limit('registration-ip', req.ip, 100, 3600000)
  const { workspaceId, ...input } = req.body || {}
  workspaces.metadata(typeof workspaceId === 'string' ? workspaceId : '')
  const result = await auth.signup(input, user => admissions.apply(workspaceId, user))
  setLogin(res.status(201), result)
})
app.post('/api/invitations/preview', (req, res) => {
  auth.limit('invitation-preview', req.ip, 60, 60000)
  res.json(workspaces.previewInvitation(req.body?.token))
})
app.post('/api/auth/register', async (req, res) => {
  auth.limit('registration-ip', req.ip, 100, 3600000)
  const { invitationToken, ...input } = req.body || {}
  if (invitationToken) {
    const check = username => {
      if (workspaces.previewInvitation(invitationToken).username !== (typeof username === 'string' ? username.trim().toLowerCase() : '')) throw new ApiError(403, '초대받은 아이디로 가입하세요.')
    }
    check(input.username)
    return setLogin(res.status(201), await auth.signup(input, user => check(user.username)))
  }
  if (!legacyStudentRegistration) throw new ApiError(403, '수강생 계정은 워크스페이스 관리자에게 발급을 요청하세요.')
  res.status(201).json(await auth.register(input, process.env.LEARNINGOPS_AUTH_GUILD_ID || ''))
})
app.post('/api/auth/registration/status', (req, res) => {
  auth.limit('status-ip', req.ip, 120, 60000)
  res.json(auth.status(req.body?.ticket))
})
app.post('/api/auth/registration/renew', (req, res) => {
  auth.limit('renew-ip', req.ip, 10, 60000)
  res.json(auth.renew(req.body?.ticket))
})
app.post('/api/integrations/discord/:operation', (req, res) => {
  if (!auth.botAuthorized(req.get('authorization'))) return res.status(401).json({ error: '봇 인증에 실패했습니다.' })
  auth.limit('discord-verify', String(req.body?.discordId || ''), 10, 60000)
  if (req.params.operation === 'preview') return res.json(auth.preview(req.body))
  if (req.params.operation === 'verify') { const result = auth.verify(req.body); admissions.activate(req.body.discordId, req.body.guildId); staff.syncDiscord(req.body.discordId, req.body.guildId); return res.json(result) }
  return res.status(404).json({ error: '지원하지 않는 인증 작업입니다.' })
})
app.post('/api/auth/login', async (req, res) => {
  auth.limit('member-ip', req.ip, 120, 15 * 60000)
  setLogin(res, await auth.login(req.body))
})
app.post('/api/integrations/discord/provision/:operation', (req, res) => {
  if (!provision.authorized(req.get('authorization'))) return res.status(401).json({ error: '채널 설정 봇 인증에 실패했습니다.' })
  if (req.params.operation === 'heartbeat') { provision.heartbeat(req.body); return res.json({ ok: true }) }
  if (req.params.operation === 'poll') return res.json(provision.poll(req.body))
  if (req.params.operation === 'complete') return res.json(provision.complete(req.body))
  return res.status(404).json({ error: '지원하지 않는 작업입니다.' })
})
app.post('/api/integrations/discord/onboarding/:operation', (req, res) => {
  if (!provision.authorized(req.get('authorization'))) return res.status(401).json({ error: '봇 인증에 실패했습니다.' })
  if (req.params.operation === 'poll') return res.json(onboarding.poll(req.body))
  if (req.params.operation === 'report') return res.json(onboarding.report(req.body))
  if (req.params.operation === 'progress') return res.json(onboarding.progress(req.body))
  return res.status(404).json({ error: '지원하지 않는 작업입니다.' })
})
app.post('/api/integrations/discord/outbox/:operation', (req, res) => {
  if (!provision.authorized(req.get('authorization'))) return res.status(401).json({ error: '봇 인증에 실패했습니다.' })
  if (req.params.operation === 'poll') return res.json(outbox.poll(req.body))
  if (req.params.operation === 'complete') return res.json(outbox.complete(req.body))
  res.status(404).json({ error: '지원하지 않는 작업입니다.' })
})
app.post('/api/integrations/discord/storage/:operation', async (req, res) => {
  if (!provision.authorized(req.get('authorization'))) return res.status(401).json({ error: '봇 인증에 실패했습니다.' })
  if (req.params.operation === 'registry') return res.json(botStorage.registry(req.body))
  if (req.params.operation === 'status') return res.json(botStorage.status(req.body?.guildId))
  if (req.params.operation === 'snapshot') return res.json(botStorage.snapshot(req.body?.guildId))
  if (req.params.operation === 'bootstrap') return res.json(botStorage.bootstrap(req.body))
  if (req.params.operation === 'call') return res.json(await botStorage.call(req.body))
  if (req.params.operation === 'runtime') return res.json(botStorage.runtime(req.body))
  if (req.params.operation === 'bind-panels') return res.json(botStorage.bindPanels(req.body))
  return res.status(404).json({ error: '지원하지 않는 작업입니다.' })
})
app.post('/api/login', (req, res) => {
  auth.limit('admin-ip', req.ip, 20, 60000)
  setLogin(res, auth.adminLogin(req.body?.password))
})
app.post('/api/integrations/discord/admissions/:operation', (req, res) => {
  if (!admissions.authorized(req.get('authorization'))) return res.status(401).json({ error: '초대 발급 봇 인증에 실패했습니다.' })
  if (req.params.operation === 'poll') return res.json(admissions.poll(req.body))
  if (req.params.operation === 'complete') return res.json(admissions.complete(req.body))
  return res.status(404).json({ error: '지원하지 않는 작업입니다.' })
})
const sessionToken = req => req.get('authorization')?.startsWith('Bearer ') ? req.get('authorization').slice(7) : req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('learningops_session='))?.slice('learningops_session='.length)
app.use('/api', (req, res, next) => {
  req.account = auth.session(sessionToken(req))
  if (!req.account) return res.status(401).json({ error: '로그인이 필요합니다.' })
  if ((req.account.mustChangePassword || req.account.mustCompleteProfile) && !['/auth/me', '/auth/password', '/auth/first-login', '/logout'].includes(req.path)) return res.status(403).json({ error: '초기 비밀번호를 변경한 뒤 이용하세요.', code: 'PASSWORD_CHANGE_REQUIRED' })
  next()
})
app.get('/api/auth/me', (req, res) => res.json({ user: req.account }))
app.post('/api/auth/first-login', async (req, res) => setLogin(res, await auth.completeFirstLogin(req.account, req.body)))
app.post('/api/auth/password', async (req, res) => setLogin(res, await auth.changePassword(req.account, req.body)))
app.get('/api/admin/accounts', (req, res) => res.json(auth.accounts(req.account)))
app.post('/api/admin/accounts/:id/reset-password', async (req, res) => res.json(await auth.resetAccount(req.account, req.params.id, req.body)))
app.delete('/api/admin/accounts/:id', (req, res) => res.json(auth.deleteAccount(req.account, req.params.id, req.body)))
app.get('/api/me/admissions', (req, res) => res.json({ applications: admissions.own(req.account) }))
app.post('/api/me/admissions', (req, res) => res.status(201).json(admissions.apply(req.body?.workspaceId, req.account)))
app.post('/api/me/admissions/:id/renew', (req, res) => {
  auth.limit('admission-renew', req.account.id, 5, 3600000)
  res.json(admissions.renew(req.params.id, req.account))
})
app.post('/api/me/admissions/:id/verification', (req, res) => {
  const application = admissions.approved(req.params.id, req.account)
  res.json(auth.issueVerification(req.account, application.guild_id))
})
app.post('/api/invitations/accept', (req, res) => res.json(workspaces.acceptInvitation(req.body?.token, req.account)))
app.get('/api/me/learning', (req, res) => {
  if (req.account.role !== 'student') return res.status(403).json({ error: '수강생 계정으로 로그인하세요.' })
  const workspace = workspaces.list(req.account)[0]
  if (!workspace) return res.status(403).json({ error: '소속된 워크스페이스가 없습니다.' })
  res.json(studentLearning(workspaces.open(workspace.id).db, req.account, workspace.discordVerified))
})
app.post('/api/logout', (req, res) => {
  auth.logout(sessionToken(req)); res.clearCookie('learningops_session', { path: '/api' }).json({ ok: true })
})
const requireAdmin = (req, res, next) => {
  if (req.account.role !== 'admin') return res.status(403).json({ error: '관리자 권한이 필요합니다.' })
  next()
}
app.get('/api/workspaces', (req, res) => res.json({ workspaces: workspaces.list(req.account, { includeArchived: req.query.includeArchived === 'true' }) }))
app.post('/api/workspaces', requireAdmin, (req, res) => res.status(201).json(workspaces.create(req.body)))
app.use('/api/workspaces/:workspaceId', (req, _res, next) => {
  req.workspaceId = req.params.workspaceId
  req.workspace = workspaces.requireAccess(req.workspaceId, req.account)
  next()
})
app.get('/api/workspaces/:workspaceId', (req, res) => res.json(req.workspace))
app.post('/api/workspaces/:workspaceId/me/verification', (req, res) => {
  workspaces.requireRole(req.workspaceId, req.account, ['admin', 'student'])
  if (req.workspace.guildIds.length !== 1) throw new ApiError(409, '워크스페이스에 Discord 서버 하나를 연결해야 합니다.')
  res.json(auth.issueVerification(req.account, req.workspace.guildIds[0]))
})
app.get('/api/workspaces/:workspaceId/me/learning', (req, res) => {
  workspaces.requireRole(req.workspaceId, req.account, ['student'])
  res.json(studentLearning(workspaces.open(req.workspaceId).db, req.account, req.workspace.discordVerified))
})
app.get('/api/workspaces/:workspaceId/teaching', (req, res) => {
  workspaces.requireRole(req.workspaceId, req.account, ['instructor'])
  res.json({ ...workspaces.teaching(req.workspaceId, req.account), onboardingComplete: staff.read(req.workspaceId, req.account).completed })
})
app.get('/api/workspaces/:workspaceId/attendance', (req, res) => res.json(attendance.view(req.workspaceId, req.query, req.account)))
app.post('/api/workspaces/:workspaceId/attendance', (req, res) => res.json(attendance.save(req.workspaceId, req.body, req.account)))
app.get('/api/workspaces/:workspaceId/attendance/discord', (req, res) => res.json(attendance.discord(req.workspaceId, req.query, req.account)))
app.post('/api/workspaces/:workspaceId/attendance/discord', (req, res) => res.json(attendance.share(req.workspaceId, req.body, req.account)))
app.get('/api/workspaces/:workspaceId/admissions', (req, res) => res.json(admissions.reviewList(req.workspaceId, req.account)))
app.post('/api/workspaces/:workspaceId/admissions/bulk-review', (req, res) => res.json(admissions.bulkReview(req.workspaceId, req.body, req.account)))
app.post('/api/workspaces/:workspaceId/admissions/:id/review', (req, res) => res.json(admissions.review(req.workspaceId, req.params.id, req.body, req.account)))
app.patch('/api/workspaces/:workspaceId/teaching', (req, res) => res.json(workspaces.teach(req.workspaceId, req.body, req.account)))
app.get('/api/workspaces/:workspaceId/team-operations', (req, res) => res.json(teamOperations.read(req.workspaceId, req.account)))
app.post('/api/workspaces/:workspaceId/team-operations', (req, res) => res.json(teamOperations.save(req.workspaceId, req.body, req.account)))
app.post('/api/workspaces/:workspaceId/team-operations/retry', (req, res) => res.json(teamOperations.retry(req.workspaceId, req.body, req.account)))
app.get('/api/workspaces/:workspaceId/staff/onboarding', (req, res) => res.json(staff.read(req.workspaceId, req.account)))
app.post('/api/workspaces/:workspaceId/staff/profile', (req, res) => res.json(staff.profile(req.workspaceId, req.body, req.account)))
app.post('/api/workspaces/:workspaceId/staff/invite', (req, res) => { auth.limit('staff-invite', req.account.id, 5, 3600000); res.json(staff.invite(req.workspaceId, req.account)) })
app.post('/api/workspaces/:workspaceId/staff/step', (req, res) => res.json(staff.step(req.workspaceId, req.body, req.account)))
app.post('/api/workspaces/:workspaceId/staff/verification', (req, res) => {
  const state = staff.read(req.workspaceId, req.account)
  if (!state.profile || !state.guildId) throw new ApiError(409, '기본 정보와 Discord 서버 연결을 먼저 완료하세요.')
  res.json(auth.issueVerification(req.account, state.guildId))
})
app.use('/api/workspaces/:workspaceId', (req, _res, next) => { workspaces.requireRole(req.workspaceId, req.account, ['admin']); next() })
app.get('/api/workspaces/:workspaceId/student-accounts', (req, res) => res.json(admissions.studentAccounts(req.workspaceId, req.account)))
app.post('/api/workspaces/:workspaceId/student-accounts', async (req, res) => {
  auth.limit('student-account-issue', req.account.id, 100, 3600000)
  const { teamId, ...input } = req.body || {}
  const authorize = () => admissions.validateStudentIssue(req.workspaceId, teamId, req.account)
  const result = await auth.createStudentAccount(input, req.account, authorize, user => admissions.assignStudent(req.workspaceId, teamId, user, req.account))
  res.status(201).json(result)
})
app.get('/api/workspaces/:workspaceId/notices', (req, res) => res.json(outbox.notices(req.workspaceId, req.account)))
app.get('/api/workspaces/:workspaceId/assignment-alerts', (req, res) => res.json(assignmentAlerts.read(req.workspaceId, req.account)))
app.post('/api/workspaces/:workspaceId/assignment-alerts/:id/publish', (req, res) => res.json(assignmentAlerts.publish(req.workspaceId, req.params.id, req.body, req.account)))
app.post('/api/workspaces/:workspaceId/assignment-alerts/:id/course', (req, res) => res.json(assignmentAlerts.bind(req.workspaceId, req.params.id, req.body, req.account)))
app.post('/api/workspaces/:workspaceId/notices/:noticeId/send', (req, res) => res.json(outbox.enqueueNotice(req.workspaceId, req.params.noticeId, req.body, req.account)))
app.post('/api/workspaces/:workspaceId/outbox/:id/retry', (req, res) => res.json(outbox.retry(req.workspaceId, req.params.id, req.account)))
app.post('/api/workspaces/:workspaceId/outbox/:id/manual', (req, res) => res.json(outbox.manual(req.workspaceId, req.params.id, req.body, req.account)))
app.post('/api/workspaces/:workspaceId/outbox/:id/hold', (req, res) => res.json(outbox.hold(req.workspaceId, req.params.id, req.account)))
app.get('/api/workspaces/:workspaceId/discord/groups', (req, res) => res.json(staff.groups(req.workspaceId)))
app.post('/api/workspaces/:workspaceId/discord/groups', (req, res) => res.json(staff.setupGroups(req.workspaceId, req.body, req.account)))
app.post('/api/workspaces/:workspaceId/archive', (req, res) => res.json(workspaces.setArchived(req.workspaceId, true, req.account)))
app.post('/api/workspaces/:workspaceId/restore', (req, res) => res.json(workspaces.setArchived(req.workspaceId, false, req.account)))
app.get('/api/workspaces/:workspaceId/members', (req, res) => res.json(staff.members(req.workspaceId, req.account)))
app.patch('/api/workspaces/:workspaceId/members/:memberId', (req, res) => res.json(staff.editMember(req.workspaceId, req.params.memberId, req.body, req.account)))
app.delete('/api/workspaces/:workspaceId/members/:memberId', (req, res) => res.json(staff.removeMember(req.workspaceId, req.params.memberId, req.account)))
app.patch('/api/workspaces/:workspaceId/members/:memberId/assignment', (req, res) => res.json(workspaces.assignMentor(req.workspaceId, req.params.memberId, req.body, req.account)))
app.get('/api/workspaces/:workspaceId/bot-data', (req, res) => res.json(botStorage.state(req.workspaceId)))
app.get('/api/workspaces/:workspaceId/bot-data/table/:table', (req, res) => res.json(botStorage.table(req.workspaceId, req.params.table, req.query.page)))
app.get('/api/workspaces/:workspaceId/bot-data/archive/:checksum', (req, res) => res.json({ archive: botStorage.archive(req.workspaceId, req.params.checksum) }))
app.post('/api/workspaces/:workspaceId/bot-data/settings', (req, res) => res.json(botStorage.settings(req.workspaceId, req.body)))
app.post('/api/workspaces/:workspaceId/bot-data/operation', async (req, res) => res.json(await botStorage.call(req.body, req.account.username, req.workspaceId)))
app.get('/api/workspaces/:workspaceId/discord/onboarding', (req, res) => res.json(onboarding.read(req.workspaceId)))
app.post('/api/workspaces/:workspaceId/discord/onboarding', (req, res) => res.json(onboarding.save(req.workspaceId, req.body)))
app.post('/api/workspaces/:workspaceId/invitations', (req, res) => res.status(201).json(workspaces.invite(req.workspaceId, req.body, req.account)))
app.post('/api/workspaces/:workspaceId/invitations/account', requireAdmin, async (req, res) => {
  auth.limit('invitation-account', req.account.id, 20, 3600000)
  const result = await auth.createInvitationAccount(req.body, req.account, username => workspaces.invite(req.workspaceId, { username, role: 'admin' }, req.account))
  res.status(201).json(result)
})
app.patch('/api/workspaces/:workspaceId/invitations/:invitationId', (req, res) => { workspaces.editInvitation(req.workspaceId, req.params.invitationId, req.body, req.account); res.json(staff.members(req.workspaceId, req.account)) })
app.post('/api/workspaces/:workspaceId/invitations/:invitationId/revoke', (req, res) => res.json(workspaces.revokeInvitation(req.workspaceId, req.params.invitationId, req.account)))
app.get('/api/workspaces/:workspaceId/workspace', (req, res) => res.json(workspaces.snapshot(req.workspaceId)))
app.patch('/api/workspaces/:workspaceId/workspace', (req, res) => res.json(workspaces.mutate(req.workspaceId, req.body, req.account.username)))
app.get('/api/workspaces/:workspaceId/audit', (req, res) => res.json(workspaces.open(req.workspaceId).db.prepare('SELECT * FROM lms_audit ORDER BY id DESC LIMIT 500').all()))
app.get('/api/workspaces/:workspaceId/integrations/render', (req, res) => res.json({ ...workspaces.remote(req.workspaceId).read(), connection: workspaces.connection(req.workspaceId) }))
app.get('/api/workspaces/:workspaceId/discord/provision', (req, res) => res.json(workspaces.provisionRead(req.workspaceId)))
app.post('/api/workspaces/:workspaceId/discord/provision/template', (req, res) => res.json(workspaces.saveTemplate(req.workspaceId, req.body)))
app.post('/api/workspaces/:workspaceId/discord/provision/servers', (req, res) => {
  const result = workspaces.addServer(req.workspaceId, req.body)
  staff.enableTeams(req.workspaceId)
  res.status(result.created ? 201 : 200).json(result)
})
app.post('/api/workspaces/:workspaceId/discord/provision/plans', (req, res) => res.json(workspaces.savePlan(req.workspaceId, req.body)))
app.post('/api/workspaces/:workspaceId/discord/provision/jobs', (req, res) => res.status(202).json(workspaces.enqueue(req.workspaceId, req.body)))
// Legacy endpoints retain the original workspace for existing clients.
app.use('/api', requireAdmin)
app.get('/api/workspace', (_req, res) => res.json(workspaces.snapshot('default')))
app.get('/api/discord/provision', (_req, res) => res.json(workspaces.provisionRead('default')))
app.post('/api/discord/provision/plans', (req, res) => res.json(workspaces.savePlan('default', req.body)))
app.post('/api/discord/provision/jobs', (req, res) => res.status(202).json(workspaces.enqueue('default', req.body)))
app.patch('/api/workspace', (req, res) => res.json(workspaces.mutate('default', req.body, req.account.username)))
app.get('/api/audit', (_req, res) => res.json(store.db.prepare('SELECT * FROM lms_audit ORDER BY id DESC LIMIT 500').all()))
app.get('/api/integrations/render', (_req, res) => res.json(renderSync.read()))
app.use('/api', (_req, res) => res.status(404).json({ error: '지원하지 않는 API입니다.' }))
app.use(express.static(resolve(root, 'dist')))
app.use((error, _req, res, _next) => {
  if (error instanceof ZodError) return res.status(422).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(' / ') })
  if (error.status) return res.status(error.status).json({ error: error.message })
  if (/UNIQUE constraint/.test(error.message)) return res.status(409).json({ error: '중복된 과정 코드·기수, 이메일, Discord ID 또는 데이터입니다.' })
  console.error('API operation failed:', error.code || error.name)
  res.status(500).json({ error: '저장하지 못했습니다. 서버 로그와 데이터베이스 연결을 확인하세요.' })
})
auth.cleanup()
const cleanup = setInterval(() => auth.cleanup(), 60000).unref()
const server = app.listen(port, host, () => console.log(`LearningOps API: http://${host}:${port} (authentication required)`))
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => { clearInterval(cleanup); workspaces.close(); store.db.close(); process.exit(0) }))

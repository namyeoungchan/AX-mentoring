import { basename, dirname, join } from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ApiError, createStore } from './store.mjs'
import { createRenderSync } from './render-sync.mjs'
import { templateSchema } from './provision.mjs'
import defaultLayout from '../shared/discord-defaults.json' with { type: 'json' }
import branding from '../shared/branding.json' with { type: 'json' }

const creation = z.object({ name: z.string().trim().min(1).max(60).transform(value => value.normalize('NFKC')), description: z.string().trim().max(300).default(''), guildId: z.union([z.string().regex(/^\d{17,20}$/), z.literal('')]).default('') }).strict()

export function createWorkspaces({ store, dbPath, provision, syncToken = '', sourceId = 'asan-ax', authGuildId = '', now = Date.now }) {
  const db = store.db
  const stores = new Map([['default', store]])
  const remotes = new Map()
  db.exec(`CREATE TABLE IF NOT EXISTS lms_workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
      source_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lms_workspace_guilds (
      guild_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES lms_workspaces(id)
    );
    CREATE TABLE IF NOT EXISTS lms_workspace_members (
      workspace_id TEXT NOT NULL REFERENCES lms_workspaces(id), user_id TEXT NOT NULL REFERENCES lms_users(id),
      role TEXT NOT NULL CHECK(role IN ('admin','instructor','student')), joined_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS lms_workspace_invitations (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES lms_workspaces(id), token_hash TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','instructor','student')),
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, accepted_at INTEGER, revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS lms_workspace_migrations (name TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS lms_mentor_scopes (workspace_id TEXT NOT NULL, subject_id TEXT NOT NULL, kind TEXT NOT NULL, team_ids TEXT NOT NULL, PRIMARY KEY(workspace_id,subject_id));
    CREATE TABLE IF NOT EXISTS lms_discord_templates (workspace_id TEXT PRIMARY KEY REFERENCES lms_workspaces(id), data TEXT NOT NULL CHECK(json_valid(data)), revision TEXT NOT NULL, updated_at INTEGER NOT NULL);`)
  if (!db.prepare('PRAGMA table_info(lms_workspaces)').all().some(column => column.name === 'archived_at')) {
    db.exec('ALTER TABLE lms_workspaces ADD COLUMN archived_at INTEGER')
  }
  const migrateMembers = !db.prepare("SELECT 1 FROM lms_workspace_migrations WHERE name='members-v1'").get()
  const attachLegacyGuild = (guildId, id) => {
    if (!db.prepare('SELECT 1 FROM lms_workspace_guilds WHERE workspace_id=? AND guild_id<>?').get(id, guildId)) {
      db.prepare('INSERT OR IGNORE INTO lms_workspace_guilds VALUES(?,?)').run(guildId, id)
    }
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('INSERT OR IGNORE INTO lms_workspaces(id,name,description,source_id,created_at) VALUES(?,?,?,?,?)').run('default', store.snapshot().name, '기존 학습 운영 데이터', 'local-default', Date.now())
    db.prepare('INSERT OR IGNORE INTO lms_workspaces(id,name,description,source_id,created_at) VALUES(?,?,?,?,?)').run('asan-ax', '아산 AX', '아산 AX 학습 운영', sourceId, Date.now())
    db.prepare("UPDATE lms_workspaces SET name=? WHERE id='default' AND name=?").run(branding.name, branding.legacyName)
    if (/^\d{17,20}$/.test(authGuildId)) attachLegacyGuild(authGuildId, 'asan-ax')
    // Existing snapshots keep their source and records. Bind the legacy Asan source once.
    const snapshot = db.prepare('SELECT payload FROM lms_remote_snapshots WHERE source_id=?').get(sourceId)
    if (snapshot) attachLegacyGuild(JSON.parse(snapshot.payload).bot.guildId, 'asan-ax')
    for (const row of db.prepare('SELECT guild_id FROM lms_discord_plans ORDER BY guild_id').all()) attachLegacyGuild(row.guild_id, 'default')
    // Existing verified accounts retain access once. New members must accept an invitation.
    if (migrateMembers) for (const user of db.prepare('SELECT * FROM lms_users WHERE verified_at IS NOT NULL').all()) {
      for (const workspace of db.prepare('SELECT id FROM lms_workspaces').all()) {
        const guild = db.prepare('SELECT 1 FROM lms_workspace_guilds WHERE workspace_id=? AND guild_id=?').get(workspace.id, user.guild_id)
        const roster = open(workspace.id).db.prepare("SELECT 1 FROM lms_records WHERE kind='learners' AND json_extract(data,'$.discordId')=?").get(user.discord_id)
        if (guild || roster) db.prepare('INSERT OR IGNORE INTO lms_workspace_members VALUES(?,?,?,?)').run(workspace.id, user.id, 'student', now())
      }
    }
    db.prepare("INSERT OR IGNORE INTO lms_workspace_migrations VALUES('members-v1')").run()
    // Preserve any pre-existing ambiguous bindings for review instead of deleting data.
    // Such workspaces are excluded from bot discovery until their binding is resolved.
    if (!db.prepare('SELECT 1 FROM lms_workspace_guilds GROUP BY workspace_id HAVING COUNT(*)>1 LIMIT 1').get()) {
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS lms_workspace_single_guild ON lms_workspace_guilds(workspace_id)')
    }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }

  function metadata(id) {
    if (typeof id !== 'string') throw new ApiError(404, '워크스페이스를 찾을 수 없습니다.')
    const row = db.prepare('SELECT * FROM lms_workspaces WHERE id=?').get(id)
    if (!row) throw new ApiError(404, '워크스페이스를 찾을 수 없습니다.')
    return { id: row.id, name: row.name, description: row.description, sourceId: row.source_id, archivedAt: row.archived_at,
      guildIds: db.prepare('SELECT guild_id FROM lms_workspace_guilds WHERE workspace_id=? ORDER BY guild_id').all(id).map(g => g.guild_id) }
  }
  function open(id) {
    const meta = metadata(id)
    if (!stores.has(id)) {
      if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new ApiError(400, '잘못된 워크스페이스 ID입니다.')
      stores.set(id, createStore(join(dirname(dbPath), `${basename(dbPath)}.workspaces`, `${id}.db`), { workspaceId: id, defaultName: meta.name }))
    }
    return stores.get(id)
  }
  function role(id, user) { return user.role === 'admin' ? 'admin' : db.prepare('SELECT role FROM lms_workspace_members WHERE workspace_id=? AND user_id=?').get(id, user.id)?.role || null }
  function canAccess(id, user) { return Boolean(role(id, user)) }
  function requireAccess(id, user) {
    const meta = metadata(id)
    if (!canAccess(id, user)) throw new ApiError(403, '이 워크스페이스에 접근할 권한이 없습니다.')
    return { ...meta, role: role(id, user) }
  }
  function list(user, { includeArchived = false } = {}) {
    return db.prepare('SELECT id,archived_at FROM lms_workspaces ORDER BY created_at,rowid').all()
      .filter(row => (includeArchived || row.archived_at === null) && canAccess(row.id, user))
      .map(row => ({ ...metadata(row.id), role: role(row.id, user) }))
  }
  function setArchived(id, archived, user) {
    requireRole(id, user, ['admin'])
    z.boolean().parse(archived)
    db.exec('BEGIN IMMEDIATE')
    try {
      const before = metadata(id)
      if ((before.archivedAt !== null) !== archived) {
        const archivedAt = archived ? now() : null
        db.prepare('UPDATE lms_workspaces SET archived_at=? WHERE id=?').run(archivedAt, id)
        db.prepare('INSERT INTO lms_audit(actor,action,target,before_json,after_json) VALUES(?,?,?,?,?)')
          .run(user.username || user.id, archived ? 'workspace.archive' : 'workspace.restore', id,
            JSON.stringify({ archivedAt: before.archivedAt }), JSON.stringify({ archivedAt }))
      }
      db.exec('COMMIT')
      return { ...metadata(id), role: role(id, user) }
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function bindGuild(id, guildId) {
    if (!/^\d{17,20}$/.test(guildId)) throw new ApiError(422, 'Discord 서버 ID를 확인하세요.')
    const owner = db.prepare('SELECT workspace_id FROM lms_workspace_guilds WHERE guild_id=?').get(guildId)
    if (owner && owner.workspace_id !== id) throw new ApiError(409, '다른 워크스페이스에 연결된 Discord 서버입니다.')
    const connected = db.prepare('SELECT guild_id FROM lms_workspace_guilds WHERE workspace_id=? AND guild_id<>?').get(id, guildId)
    if (connected) throw new ApiError(409, '워크스페이스에는 Discord 서버 하나만 연결할 수 있습니다.')
    db.prepare('INSERT OR IGNORE INTO lms_workspace_guilds VALUES(?,?)').run(guildId, id)
  }
  function create(body) {
    const input = creation.parse(body)
    const id = randomUUID()
    db.exec('BEGIN IMMEDIATE')
    try {
      if (db.prepare('SELECT id FROM lms_workspaces WHERE lower(name)=lower(?)').get(input.name)) throw new ApiError(409, '같은 이름의 워크스페이스가 있습니다.')
      db.prepare('INSERT INTO lms_workspaces(id,name,description,source_id,created_at) VALUES(?,?,?,?,?)').run(id, input.name, input.description, id, Date.now())
      if (input.guildId) { bindGuild(id, input.guildId); provision.install(input.guildId, template(id)) }
      open(id)
      db.exec('COMMIT')
      return metadata(id)
    } catch (error) { db.exec('ROLLBACK'); stores.get(id)?.db.close(); stores.delete(id); throw error }
  }
  function snapshot(id) { return { ...open(id).snapshot(), name: metadata(id).name, authEnabled: true } }
  function mutate(id, body, actor) {
    const target = open(id)
    const result = target.mutate(body, actor)
    db.prepare('UPDATE lms_workspaces SET name=? WHERE id=?').run(result.name, id)
    return { ...result, authEnabled: true }
  }
  function remote(id) {
    if (!remotes.has(id)) remotes.set(id, createRenderSync(db, { token: syncToken, sourceId: metadata(id).sourceId }))
    return remotes.get(id)
  }
  function ingest(body) {
    const row = body?.sourceId === undefined
      ? db.prepare('SELECT w.id,w.source_id FROM lms_workspaces w JOIN lms_workspace_guilds g ON g.workspace_id=w.id WHERE g.guild_id=?').get(typeof body?.bot?.guildId === 'string' ? body.bot.guildId : '')
      : db.prepare('SELECT id,source_id FROM lms_workspaces WHERE source_id=?').get(typeof body?.sourceId === 'string' ? body.sourceId : '')
    if (!row) throw new ApiError(403, '등록된 워크스페이스의 데이터 소스가 아닙니다.')
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = remote(row.id).ingest({ ...body, sourceId: row.source_id })
      bindGuild(row.id, body.bot.guildId)
      db.exec('COMMIT')
      return result
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function connection(id) {
    const meta = metadata(id), state = provision.read(meta.guildIds)
    return { configured: state.enabled, worker: state.worker, guilds: meta.guildIds.map(guildId => state.guilds.find(g => g.id === guildId) || { id: guildId, name: guildId, connected: false, memberCount: null, seenAt: null, manageChannels: 0 }) }
  }
  function savePlan(id, body) {
    metadata(id)
    db.exec('BEGIN IMMEDIATE')
    try {
      bindGuild(id, body?.guildId)
      const result = provision.save(body)
      db.exec('COMMIT')
      return result
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function template(id) {
    metadata(id)
    let row = db.prepare('SELECT data,revision FROM lms_discord_templates WHERE workspace_id=?').get(id)
    if (!row) {
      const legacy = db.prepare('SELECT p.data FROM lms_discord_plans p JOIN lms_workspace_guilds g ON p.guild_id=g.guild_id WHERE g.workspace_id=? ORDER BY p.updated_at DESC LIMIT 1').get(id)
      const source = legacy ? JSON.parse(legacy.data) : defaultLayout
      const data = JSON.stringify({ name: source.name, channels: source.channels })
      const revision = createHash('sha256').update(`${id}:${data}`).digest('hex')
      db.prepare('INSERT OR IGNORE INTO lms_discord_templates VALUES(?,?,?,?)').run(id, data, revision, now())
      row = db.prepare('SELECT data,revision FROM lms_discord_templates WHERE workspace_id=?').get(id)
    }
    return { ...JSON.parse(row.data), revision: row.revision }
  }
  function saveTemplate(id, body) {
    const input = templateSchema.parse(body)
    db.exec('BEGIN IMMEDIATE')
    try {
      if (template(id).revision !== input.revision) throw new ApiError(409, '기본 구성이 변경됐습니다. 다시 불러온 후 저장하세요.')
      const data = JSON.stringify({ name: input.name, channels: input.channels })
      const revision = createHash('sha256').update(`${id}:${data}`).digest('hex')
      db.prepare('UPDATE lms_discord_templates SET data=?,revision=?,updated_at=? WHERE workspace_id=?').run(data, revision, now(), id)
      db.exec('COMMIT'); return { ...JSON.parse(data), revision }
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function addServer(id, body) {
    const input = z.object({ guildId: z.string().regex(/^\d{17,20}$/), templateRevision: z.string().length(64) }).strict().parse(body)
    db.exec('BEGIN IMMEDIATE')
    try {
      const saved = template(id)
      if (input.templateRevision !== saved.revision) throw new ApiError(409, '기본 구성이 변경됐습니다. 다시 불러온 후 서버를 추가하세요.')
      bindGuild(id, input.guildId)
      const result = provision.install(input.guildId, saved)
      db.exec('COMMIT'); return result
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function enqueue(id, body) {
    if (!metadata(id).guildIds.includes(body?.guildId)) throw new ApiError(403, '이 워크스페이스에 연결된 Discord 서버가 아닙니다.')
    return provision.enqueue(body.guildId, body.revision)
  }
  function requireRole(id, user, allowed) {
    requireAccess(id, user)
    if (!allowed.includes(role(id, user))) throw new ApiError(403, '이 작업을 수행할 권한이 없습니다.')
  }
  const digest = value => createHash('sha256').update(value).digest('hex')
  function mentorScope(id, subjectId) {
    const row = db.prepare('SELECT kind,team_ids FROM lms_mentor_scopes WHERE workspace_id=? AND subject_id=?').get(id, subjectId)
    return row ? { mentorType: row.kind, teamIds: JSON.parse(row.team_ids) } : { mentorType: 'main', teamIds: [] }
  }
  function validateScope(id, body) {
    const value = z.object({ mentorType: z.enum(['main', 'group']).default('main'), teamIds: z.array(z.string()).max(50).default([]) }).strict().parse(body)
    const teams = snapshot(id).teams
    if (new Set(value.teamIds).size !== value.teamIds.length || value.teamIds.some(team => !teams.some(t => t.id === team))) throw new ApiError(422, '이 워크스페이스의 조를 선택하세요.')
    if (value.mentorType === 'group' && !value.teamIds.length) throw new ApiError(422, '조 담당 멘토는 담당 조를 하나 이상 선택하세요.')
    return { ...value, teamIds: value.mentorType === 'main' ? [] : value.teamIds }
  }
  function putScope(id, subjectId, scope) {
    db.prepare('INSERT INTO lms_mentor_scopes VALUES(?,?,?,?) ON CONFLICT(workspace_id,subject_id) DO UPDATE SET kind=excluded.kind,team_ids=excluded.team_ids').run(id, subjectId, scope.mentorType, JSON.stringify(scope.teamIds))
  }
  function assignMentor(id, memberId, body, user) {
    requireRole(id, user, ['admin'])
    if (db.prepare('SELECT role FROM lms_workspace_members WHERE workspace_id=? AND user_id=?').get(id, memberId)?.role !== 'instructor') throw new ApiError(404, '워크스페이스 멘토를 찾을 수 없습니다.')
    const scope = validateScope(id, body)
    const before = mentorScope(id, memberId)
    db.exec('BEGIN IMMEDIATE')
    try {
      putScope(id, memberId, scope)
      db.prepare('INSERT INTO lms_audit(actor,action,target,before_json,after_json) VALUES(?,?,?,?,?)').run(user.username, 'mentor.assignment', `${id}/${memberId}`, JSON.stringify(before), JSON.stringify(scope))
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    return members(id, user)
  }
  function invite(id, body, user) {
    requireRole(id, user, ['admin'])
    const input = z.object({ username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.-]{3,31}$/), role: z.enum(['admin', 'instructor', 'student']), mentorType: z.enum(['main', 'group']).default('main'), teamIds: z.array(z.string()).max(50).default([]) }).strict().parse(body)
    const scope = validateScope(id, { mentorType: input.mentorType, teamIds: input.teamIds })
    if (input.role === 'student') throw new ApiError(422, '수강생은 가입 신청 후 관리자 또는 강사가 승인해야 합니다.')
    if (input.role === 'admin' && user.role !== 'admin') throw new ApiError(403, '워크스페이스 관리자 지정은 전체 관리자만 할 수 있습니다.')
    if (user.role !== 'admin' && db.prepare("SELECT 1 FROM lms_workspace_invitations WHERE workspace_id=? AND username=? AND role='admin' AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?").get(id, input.username, now())) throw new ApiError(403, '관리자 초대는 전체 관리자만 변경할 수 있습니다.')
    if (db.prepare('SELECT 1 FROM lms_workspace_members m JOIN lms_users u ON u.id=m.user_id WHERE m.workspace_id=? AND u.username=?').get(id, input.username)) throw new ApiError(409, '이미 참여한 구성원입니다.')
    const token = randomBytes(32).toString('hex'), invitationId = randomUUID(), expiresAt = now() + 7 * 24 * 3600000
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('UPDATE lms_workspace_invitations SET revoked_at=? WHERE workspace_id=? AND username=? AND accepted_at IS NULL AND revoked_at IS NULL').run(now(), id, input.username)
      db.prepare('INSERT INTO lms_workspace_invitations VALUES(?,?,?,?,?,?,?,?,NULL,NULL)').run(invitationId, id, digest(token), input.username, input.role, user.id, now(), expiresAt)
      if (input.role === 'instructor') putScope(id, invitationId, scope)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    return { id: invitationId, token, expiresAt, username: input.username, role: input.role, workspaceName: metadata(id).name }
  }
  function pendingInvitation(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new ApiError(404, '초대 링크를 확인하세요.')
    const row = db.prepare('SELECT * FROM lms_workspace_invitations WHERE token_hash=?').get(digest(token))
    if (!row || row.accepted_at !== null || row.revoked_at !== null || row.expires_at <= now()) throw new ApiError(410, '사용했거나 만료·취소된 초대입니다.')
    return row
  }
  function previewInvitation(token) {
    const row = pendingInvitation(token)
    return { workspaceName: metadata(row.workspace_id).name, role: row.role, username: row.username, expiresAt: row.expires_at, ...mentorScope(row.workspace_id, row.id) }
  }
  function invitationGuild(token, username) {
    const row = pendingInvitation(token)
    if (typeof username !== 'string' || row.username !== username.trim().toLowerCase()) throw new ApiError(403, '초대받은 아이디로 가입하세요.')
    const guilds = metadata(row.workspace_id).guildIds
    if (guilds.length !== 1) throw new ApiError(409, '초대한 워크스페이스에 Discord 서버 하나를 연결하세요.')
    return guilds[0]
  }
  function acceptInvitation(token, user) {
    if (user.role === 'admin') throw new ApiError(403, '초대 대상 개인 계정으로 로그인하세요.')
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = pendingInvitation(token)
      if (row.username !== user.username) throw new ApiError(403, '초대받은 아이디로 로그인하세요.')
      if (metadata(row.workspace_id).archivedAt !== null) throw new ApiError(409, '보관된 워크스페이스입니다.')
      if (role(row.workspace_id, user)) throw new ApiError(409, '이미 참여한 워크스페이스입니다.')
      db.prepare('INSERT INTO lms_workspace_members VALUES(?,?,?,?)').run(row.workspace_id, user.id, row.role, now())
      db.prepare('UPDATE lms_workspace_invitations SET accepted_at=? WHERE id=?').run(now(), row.id)
      if (row.role === 'instructor') putScope(row.workspace_id, user.id, validateScope(row.workspace_id, mentorScope(row.workspace_id, row.id)))
      db.exec('COMMIT')
      return { ...metadata(row.workspace_id), role: row.role }
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function members(id, user) {
    requireRole(id, user, ['admin'])
    return {
      members: db.prepare('SELECT u.id,u.name,u.username,m.role,m.joined_at AS joinedAt FROM lms_workspace_members m JOIN lms_users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY m.joined_at').all(id).map(m => ({ ...m, ...mentorScope(id, m.id) })),
      invitations: db.prepare('SELECT id,username,role,created_at AS createdAt,expires_at AS expiresAt,accepted_at AS acceptedAt,revoked_at AS revokedAt FROM lms_workspace_invitations WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100').all(id).map(m => ({ ...m, ...mentorScope(id, m.id) })),
      teams: snapshot(id).teams.map(t => ({ id: t.id, name: t.name })),
    }
  }
  function revokeInvitation(id, invitationId, user) {
    requireRole(id, user, ['admin'])
    const row = db.prepare('SELECT role FROM lms_workspace_invitations WHERE id=? AND workspace_id=?').get(invitationId, id)
    if (!row) throw new ApiError(404, '초대를 찾을 수 없습니다.')
    if (row.role === 'admin' && user.role !== 'admin') throw new ApiError(403, '관리자 초대는 전체 관리자만 취소할 수 있습니다.')
    db.prepare('UPDATE lms_workspace_invitations SET revoked_at=? WHERE id=? AND accepted_at IS NULL').run(now(), invitationId)
    return { ok: true }
  }
  function editInvitation(id, invitationId, body, user) {
    requireRole(id, user, ['admin'])
    if (metadata(id).archivedAt !== null) throw new ApiError(409, '보관된 워크스페이스입니다.')
    const row = db.prepare('SELECT * FROM lms_workspace_invitations WHERE workspace_id=? AND id=?').get(id, invitationId)
    if (!row) throw new ApiError(404, '초대를 찾을 수 없습니다.')
    if (row.accepted_at !== null || row.revoked_at !== null || row.expires_at <= now()) throw new ApiError(409, '대기 중인 초대만 수정할 수 있습니다.')
    const input = z.object({ role: z.enum(['admin', 'instructor']), mentorType: z.enum(['main', 'group']).default('main'), teamIds: z.array(z.string()).max(50).default([]) }).strict().parse(body)
    if ((row.role === 'admin' || input.role === 'admin') && user.role !== 'admin') throw new ApiError(403, '관리자 초대는 전체 관리자만 변경할 수 있습니다.')
    const scope = validateScope(id, input.role === 'instructor' ? { mentorType: input.mentorType, teamIds: input.teamIds } : {})
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('UPDATE lms_workspace_invitations SET role=? WHERE id=?').run(input.role, invitationId)
      putScope(id, invitationId, scope)
      db.prepare('INSERT INTO lms_audit(actor,action,target,before_json,after_json) VALUES(?,?,?,?,?)').run(user.username, 'invitation.update', `${id}/${invitationId}`, JSON.stringify({ role: row.role }), JSON.stringify(input))
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    return members(id, user)
  }
  function teaching(id, user) {
    const data = snapshot(id)
    const scope = user ? mentorScope(id, user.id) : { mentorType: 'main', teamIds: [] }
    if (scope.mentorType === 'group') {
      data.teams = data.teams.filter(t => scope.teamIds.includes(t.id))
      data.courses = data.courses.filter(c => data.teams.some(t => t.courseId === c.id))
      data.learners = data.learners.filter(l => data.teams.some(t => t.courseId === l.courseId && t.name === l.team))
      for (const kind of ['attendance', 'scores']) data[kind] = data[kind].filter(r => data.learners.some(l => l.id === r.studentId))
      data.assignments = data.assignments.filter(a => data.courses.some(c => c.id === a.courseId))
      const mentor = data.mentors.find(m => m.discordId === user.discordId)
      data.sessions = data.sessions.filter(s => mentor && s.mentorId === mentor.id)
    }
    return { ...data, servers: [], logs: [], notices: [], files: [], submissions: [], reminders: false, onboarding: false, qa: false,
      learners: data.learners.map(row => ({ ...row, email: '', discordId: '' })), mentors: [] }
  }
  function teach(id, body, user) {
    requireRole(id, user, ['instructor'])
    if (!Array.isArray(body?.changes) || body.changes.some(change => !['attendance', 'scores', 'assignments'].includes(change?.kind))) throw new ApiError(403, '멘토는 담당 범위의 출결·성적 관리와 과제 생성만 할 수 있습니다.')
    const allowed = teaching(id, user), all = snapshot(id)
    for (const { kind, value } of body.changes) {
      if (!allowed.courses.some(c => c.id === value?.courseId)) throw new ApiError(403, '담당 과정이 아닙니다.')
      if (kind === 'assignments') {
        if (all.assignments.some(a => a.id === value.id)) throw new ApiError(403, '기존 과제 변경은 관리자에게 요청하세요.')
      } else {
        if (!allowed.learners.some(l => l.id === value?.studentId)) throw new ApiError(403, '담당 수강생이 아닙니다.')
        if (all[kind].some(r => r.id === value.id) && !allowed[kind].some(r => r.id === value.id)) throw new ApiError(403, '담당 범위 밖의 기록입니다.')
      }
    }
    mutate(id, body, user.username)
    return teaching(id, user)
  }
  function close() { for (const [id, value] of stores) if (id !== 'default') value.db.close() }
  return { list, create, setArchived, metadata, requireAccess, open, snapshot, mutate, remote, ingest, savePlan, enqueue,
    provisionRead: id => ({ ...provision.read(metadata(id).guildIds), template: template(id), boundGuildIds: metadata(id).guildIds }), template, saveTemplate, addServer, connection, role, requireRole, invite, previewInvitation, invitationGuild, acceptInvitation, members, revokeInvitation, editInvitation, mentorScope, assignMentor, validateScope, teaching, teach, close }
}

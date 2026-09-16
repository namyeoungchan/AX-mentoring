import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { ApiError } from './store.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(resolve(root, '../database.py'), 'utf8')
const operations = new Set([...source.matchAll(/^async def (\w+)\(/gm)].map(m => m[1]).filter(n => n !== 'init_db' && !n.startsWith('_')))
export const BOT_TABLES = Object.freeze({ mentors: '멘토', slots: '예약 가능 시간', bookings: '멘토링 예약', panels: '멘토링 패널', slot_templates: '예약 시간 규칙', blocked_dates: '휴무 날짜', reminders: '예약 알림 이력', qa_alerts: '질문 알림 이력', blocked_weekdays: '휴무 요일', onboarding_progress: '온보딩 기록', assignments: '과제', submissions: '제출물', assignment_panels: '과제·평가 패널', assignment_reminders: '과제 알림 이력', peer_eval_rounds: '비밀평가 회차', peer_evaluations: '비밀평가 기록' })
const snowflake = z.string().regex(/^\d{17,20}$/)
const checksum = text => createHash('sha256').update(text).digest('hex')
const settingNames = ['ADMIN_ROLE_ID', 'STUDENT_ROLE_ID', 'ONBOARDING_COMPLETE_ROLE_ID', 'ONBOARDING_CHANNEL_ID', 'INTRO_CHANNEL_ID', 'ASSIGNMENT_DASHBOARD_CHANNEL_ID', 'ASSIGNMENT_SUBMIT_CHANNEL_ID', 'MENTORING_CHANNEL_ID', 'QA_FORUM_CHANNEL_ID']
const settingsSchema = z.object({ channels: z.partialRecord(z.enum(settingNames), z.union([snowflake, z.literal('')])), teams: z.array(z.object({ name: z.string().trim().min(1).max(100), channelId: z.union([snowflake, z.literal('')]) }).strict()).max(50), qaNotifyRoleIds: z.array(snowflake).max(25).optional(), qaUnansweredHours: z.number().int().min(1).max(168) }).strict()
const python = process.env.PYTHON_EXECUTABLE || (existsSync(resolve(root, '.tools/venv/Scripts/python.exe')) ? resolve(root, '.tools/venv/Scripts/python.exe') : 'python3')

function install(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS lms_storage_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO lms_storage_state VALUES(1,0);
    CREATE TABLE IF NOT EXISTS lms_storage_receipts(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lms_storage_imports(checksum TEXT PRIMARY KEY,guild_id TEXT NOT NULL,archive TEXT NOT NULL,state TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT(datetime('now')));
    CREATE TABLE IF NOT EXISTS lms_bot_settings(guild_id TEXT PRIMARY KEY,data TEXT NOT NULL);`)
  for (const table of Object.keys(BOT_TABLES)) for (const event of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS storage_revision_${table}_${event} AFTER ${event} ON ${table} BEGIN UPDATE lms_storage_state SET revision=revision+1 WHERE id=1; END`)
}

export function createBotStorage(main, workspaces, onboarding) {
  const initialized = new Set(), running = new Map()
  main.exec('CREATE TABLE IF NOT EXISTS lms_runtime_state(guild_id TEXT NOT NULL,kind TEXT NOT NULL,record_key TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(guild_id,kind,record_key))')
  function open(id) {
    const store = workspaces.open(id)
    if (!initialized.has(id)) { install(store.db); initialized.add(id) }
    return store.db
  }
  function owner(guildId) {
    snowflake.parse(guildId)
    const row = main.prepare('SELECT workspace_id FROM lms_workspace_guilds WHERE guild_id=?').get(guildId)
    if (!row) throw new ApiError(403, '웹 워크스페이스에 Discord 서버 ID를 먼저 등록하세요.')
    if (workspaces.metadata(row.workspace_id).guildIds.length !== 1) throw new ApiError(409, '워크스페이스와 Discord 서버를 1:1로 연결하세요.')
    return row.workspace_id
  }
  function state(id) {
    const db = open(id)
    return { revision: String(db.prepare('SELECT revision FROM lms_storage_state WHERE id=1').get().revision),
      guildIds: workspaces.metadata(id).guildIds,
      tables: Object.entries(BOT_TABLES).map(([key, label]) => ({ key, label, count: db.prepare(`SELECT COUNT(*) AS n FROM ${key}`).get().n })),
      imports: db.prepare('SELECT checksum,guild_id AS guildId,state,error,created_at AS createdAt FROM lms_storage_imports ORDER BY created_at DESC').all(),
      settings: db.prepare('SELECT guild_id AS guildId,data FROM lms_bot_settings').all().map(row => ({ guildId: row.guildId, revision: checksum(row.data), ...JSON.parse(row.data) })) }
  }
  function table(id, name, page = 0) {
    if (!Object.hasOwn(BOT_TABLES, name)) throw new ApiError(404, '지원하지 않는 항목입니다.')
    page = z.coerce.number().int().min(0).max(100000).parse(page)
    const db = open(id)
    if (name === 'peer_evaluations') {
      const total = db.prepare('SELECT COUNT(*) AS n FROM (SELECT 1 FROM peer_evaluations GROUP BY round_id,team,target_id)').get().n
      return { name, label: '비밀평가 결과', page, total, rows: db.prepare("SELECT round_id,team,target_id,MAX(target_name) AS target_name,COUNT(*) AS evaluation_count,ROUND(AVG(score1),2) AS score1,ROUND(AVG(score2),2) AS score2,ROUND(AVG(score3),2) AS score3,ROUND(AVG(score4),2) AS score4,GROUP_CONCAT(NULLIF(comment,''),char(10)) AS comment FROM peer_evaluations GROUP BY round_id,team,target_id ORDER BY round_id,target_id LIMIT 100 OFFSET ?").all(page * 100) }
    }
    return { name, label: BOT_TABLES[name], page, total: db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n, rows: db.prepare(`SELECT * FROM ${name} ORDER BY rowid LIMIT 100 OFFSET ?`).all(page * 100) }
  }
  function archive(id, hash) {
    const row = open(id).prepare('SELECT archive FROM lms_storage_imports WHERE checksum=?').get(hash)
    if (!row) throw new ApiError(404, '이관 원본을 찾을 수 없습니다.')
    return row.archive
  }
  function status(guildId) {
    const id = owner(guildId), db = open(id)
    const imported = db.prepare("SELECT checksum FROM lms_storage_imports WHERE guild_id=? AND state='complete' LIMIT 1").get(guildId)
    const settings = db.prepare('SELECT data FROM lms_bot_settings WHERE guild_id=?').get(guildId)
    const value = settings ? JSON.parse(settings.data) : { channels: {}, teams: [], qaUnansweredHours: 24 }
    // Discord assigns IDs at creation. Read this guild's persisted resource map;
    // explicit web settings override generated defaults, including an empty alert list.
    const resourceId = (kind, key) => {
      const row = main.prepare('SELECT data FROM lms_runtime_state WHERE guild_id=? AND kind=? AND record_key=?').get(guildId, kind, key)
      const id = row ? JSON.parse(row.data).id : ''
      return typeof id === 'string' && snowflake.safeParse(id).success ? id : ''
    }
    for (const [setting, kind, key] of [
      ['ADMIN_ROLE_ID', 'role', 'admin'], ['STUDENT_ROLE_ID', 'role', 'student'], ['ONBOARDING_COMPLETE_ROLE_ID', 'role', 'complete'],
      ['ONBOARDING_CHANNEL_ID', 'channel', 'start'], ['INTRO_CHANNEL_ID', 'channel', 'intro'],
      ['ASSIGNMENT_DASHBOARD_CHANNEL_ID', 'channel', 'assignment-dashboard'],
    ]) {
      const id = resourceId(kind, key)
      if (!value.channels[setting] && id) value.channels[setting] = id
    }
    value.qaNotifyRoleIds ??= ['admin', 'instructor'].map(key => resourceId('role', key)).filter(Boolean)
    let teamMembers = null
    const managed = main.prepare("SELECT data FROM lms_onboarding_settings WHERE guild_id=?").get(guildId)
    if (value && managed && JSON.parse(managed.data).enabled) {
      const courseIds = JSON.parse(managed.data).courseIds
      const teams = workspaces.snapshot(id).teams.filter(t => courseIds.includes(t.courseId))
      value.teams = teams.map(team => {
        const channel = main.prepare("SELECT data FROM lms_runtime_state WHERE guild_id=? AND kind='channel' AND record_key=?").get(guildId, `team-text:${team.id}`)
        return { name: team.name, channelId: channel ? String(JSON.parse(channel.data).id) : '' }
      })
      const participants = onboarding?.poll({ guildIds: [guildId] }).configs[0]?.participants || []
      teamMembers = Object.fromEntries(participants.filter(p => p.role === 'student').map(p => [p.discordId, teams.find(t => t.id === p.teamId)?.name || '']))
    }
    return { workspaceId: id, migrated: Boolean(imported), checksum: imported?.checksum || '', settings: value, teamMembers }
  }
  function snapshot(guildId) {
    const db = open(owner(guildId))
    const counts = Object.fromEntries(['mentors', 'bookings', 'assignments', 'submissions', 'onboarding_progress'].map(t => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]))
    counts.pending_bookings = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status='pending'").get().n
    return { rowLimit: 1000, counts,
      mentors: db.prepare('SELECT id,name,discord_id,bio FROM mentors ORDER BY id DESC LIMIT 1000').all(),
      bookings: db.prepare('SELECT b.id,b.user_name,b.status,s.label,s.start_time,s.end_time,m.name AS mentor_name FROM bookings b JOIN slots s ON b.slot_id=s.id JOIN mentors m ON s.mentor_id=m.id ORDER BY b.id DESC LIMIT 1000').all(),
      assignments: db.prepare('SELECT a.id,a.week,a.title,a.due_date,a.type,a.is_active,(SELECT COUNT(*) FROM submissions s WHERE s.assignment_id=a.id) AS submitted FROM assignments a ORDER BY a.id DESC LIMIT 1000').all(),
      submissions: db.prepare('SELECT s.id,s.assignment_id,s.user_name,s.team,s.content,s.link,s.submitted_at,a.title AS assignment_title FROM submissions s JOIN assignments a ON s.assignment_id=a.id ORDER BY s.id DESC LIMIT 1000').all() }
  }
  function registry(body) {
    const { guildIds } = z.object({ guildIds: z.array(snowflake).max(10000) }).strict().parse(body)
    const result = { workspaces: [], unavailable: [] }
    for (const guildId of new Set(guildIds)) {
      if (!main.prepare('SELECT 1 FROM lms_workspace_guilds WHERE guild_id=?').get(guildId)) continue
      try { result.workspaces.push({ guildId, ...status(guildId) }) }
      catch (error) { result.unavailable.push({ guildId, code: error.status === 409 ? 'guild_binding_conflict' : 'storage_unavailable' }) }
    }
    return result
  }
  function bootstrap(body) {
    const input = z.object({ guildId: snowflake, archive: z.string().max(64 * 1024 * 1024), checksum: z.string().length(64) }).strict().parse(body)
    if (checksum(input.archive) !== input.checksum) throw new ApiError(422, '이관 원본 체크섬이 다릅니다.')
    const id = owner(input.guildId), db = open(id)
    const previous = db.prepare('SELECT state FROM lms_storage_imports WHERE checksum=?').get(input.checksum)
    if (previous?.state === 'complete') return status(input.guildId)
    if (status(input.guildId).migrated) throw new ApiError(409, '이미 웹으로 전환한 서버입니다. 이전 봇 DB를 다시 덮어쓸 수 없습니다.')
    const data = z.object({ version: z.literal(1), guildId: snowflake, tables: z.record(z.string(), z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()])))), settings: settingsSchema,
      runtime: z.array(z.object({ guild_id: z.string(), kind: z.string(), record_key: z.string(), data: z.string() })).default([]) }).strict().parse(JSON.parse(input.archive))
    if (data.guildId !== input.guildId || Object.keys(data.tables).some(t => !Object.hasOwn(BOT_TABLES, t)) || Object.keys(data.tables).length !== Object.keys(BOT_TABLES).length) throw new ApiError(422, '이관 대상 테이블이나 서버가 일치하지 않습니다.')
    db.prepare("INSERT INTO lms_storage_imports(checksum,guild_id,archive,state) VALUES(?,?,?,'pending') ON CONFLICT(checksum) DO NOTHING").run(input.checksum, input.guildId, input.archive)
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const name of Object.keys(BOT_TABLES)) {
        const columns = db.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name)
        for (const row of data.tables[name]) {
          const keys = Object.keys(row)
          if (!keys.length || keys.some(k => !columns.includes(k))) throw new Error(`${BOT_TABLES[name]}: 원본 열 구성이 다릅니다.`)
          if (row.guild_id && row.guild_id !== input.guildId) throw new Error(`${BOT_TABLES[name]}: 다른 서버 데이터가 포함되어 있습니다.`)
          const where = keys.map(k => `${k} IS ?`).join(' AND ')
          if (db.prepare(`SELECT 1 FROM ${name} WHERE ${where}`).get(...keys.map(k => row[k]))) continue
          try { db.prepare(`INSERT INTO ${name}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map(k => row[k])) }
          catch { throw new Error(`${BOT_TABLES[name]}: 기존 데이터와 번호 또는 연결 관계가 충돌합니다.`) }
        }
      }
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('원본 데이터의 연결 관계를 확인하세요.')
      db.prepare('INSERT INTO lms_bot_settings VALUES(?,?) ON CONFLICT(guild_id) DO NOTHING').run(input.guildId, JSON.stringify(data.settings))
      // Completion is recorded only after the shared runtime state is also durable.
      db.prepare('INSERT INTO lms_audit(actor,action,target) VALUES(?,?,?)').run('discord-bot', 'bot-storage.import', input.checksum)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      db.prepare("UPDATE lms_storage_imports SET state='conflict',error=? WHERE checksum=?").run(error.message, input.checksum)
      throw new ApiError(409, error.message)
    }
    main.exec('BEGIN IMMEDIATE')
    try {
      for (const row of data.runtime) {
        // One bot manages multiple guilds. Keep each guild's existing metadata under its own key.
        // Never import stale configuration caches or metadata for unregistered guilds.
        if (main.prepare('SELECT 1 FROM lms_workspace_guilds WHERE guild_id=?').get(row.guild_id) && ['member', 'role', 'channel', 'panel', 'panel-channel', 'panel-options'].includes(row.kind)) {
          JSON.parse(row.data)
          main.prepare('INSERT OR IGNORE INTO lms_runtime_state VALUES(?,?,?,?)').run(row.guild_id, row.kind, row.record_key, row.data)
        }
      }
      main.exec('COMMIT')
    } catch {
      main.exec('ROLLBACK')
      throw new ApiError(409, '역할·채널 상태 이관을 완료하지 못했습니다. 원본은 보관되어 있으며 다시 시도합니다.')
    }
    db.prepare("UPDATE lms_storage_imports SET state='complete',error='' WHERE checksum=?").run(input.checksum)
    return status(input.guildId)
  }
  function settings(id, body) {
    const { guildId, value, revision } = z.object({ guildId: snowflake, value: settingsSchema, revision: z.string().max(64) }).strict().parse(body)
    if (owner(guildId) !== id) throw new ApiError(403, '다른 워크스페이스의 서버입니다.')
    const db = open(id)
    const previous = db.prepare('SELECT data FROM lms_bot_settings WHERE guild_id=?').get(guildId)
    if ((previous ? checksum(previous.data) : '') !== revision) throw new ApiError(409, '다른 작업으로 서버 설정이 변경되었습니다. 편집을 다시 열어 주세요.')
    db.prepare('INSERT INTO lms_bot_settings VALUES(?,?) ON CONFLICT(guild_id) DO UPDATE SET data=excluded.data').run(guildId, JSON.stringify(value))
    return state(id)
  }
  function bindPanels(body) {
    const input = z.object({ guildId: snowflake, channels: z.partialRecord(z.enum(['ASSIGNMENT_DASHBOARD_CHANNEL_ID', 'ASSIGNMENT_SUBMIT_CHANNEL_ID', 'MENTORING_CHANNEL_ID']), snowflake) }).strict().parse(body)
    const db = open(owner(input.guildId))
    const previous = db.prepare('SELECT data FROM lms_bot_settings WHERE guild_id=?').get(input.guildId)
    const value = previous ? JSON.parse(previous.data) : { channels: {}, teams: [], qaUnansweredHours: 24 }
    Object.assign(value.channels, input.channels)
    db.prepare('INSERT INTO lms_bot_settings VALUES(?,?) ON CONFLICT(guild_id) DO UPDATE SET data=excluded.data').run(input.guildId, JSON.stringify(value))
    return { ok: true }
  }
  function runtime(body) {
    const input = z.object({ guildId: z.string(), kind: z.enum(['config', 'member', 'role', 'channel', 'panel', 'panel-channel', 'panel-options']), key: z.string().max(200).optional(), operation: z.enum(['get', 'all', 'put']), value: z.unknown().optional() }).strict().parse(body)
    if (input.guildId === '0') { if (input.kind !== 'config') throw new ApiError(403, '잘못된 공통 상태입니다.') }
    else owner(input.guildId)
    if (input.operation === 'all') return Object.fromEntries(main.prepare('SELECT record_key,data FROM lms_runtime_state WHERE guild_id=? AND kind=?').all(input.guildId, input.kind).map(r => [r.record_key, JSON.parse(r.data)]))
    if (!input.key) throw new ApiError(422, '상태 키가 필요합니다.')
    if (input.operation === 'put') {
      const value = JSON.stringify(input.value)
      if (!value || value.length > 1024 * 1024) throw new ApiError(422, '상태 값이 올바르지 않습니다.')
      main.prepare('INSERT INTO lms_runtime_state VALUES(?,?,?,?) ON CONFLICT(guild_id,kind,record_key) DO UPDATE SET data=excluded.data').run(input.guildId, input.kind, input.key, value)
      return { ok: true }
    }
    const row = main.prepare('SELECT data FROM lms_runtime_state WHERE guild_id=? AND kind=? AND record_key=?').get(input.guildId, input.kind, input.key)
    return row ? JSON.parse(row.data) : null
  }
  async function call(body, actor = 'discord-bot', workspaceId = null) {
    const input = z.object({ guildId: snowflake, operation: z.string(), args: z.array(z.unknown()).default([]), kwargs: z.unknown().default({}), requestId: z.uuid(), revision: z.string().optional() }).strict().parse(body)
    const id = owner(input.guildId)
    if (workspaceId && workspaceId !== id) throw new ApiError(403, '다른 워크스페이스의 서버입니다.')
    if (workspaceId && input.revision === undefined) throw new ApiError(422, '최신 화면에서 작업을 요청하세요.')
    if (!operations.has(input.operation)) throw new ApiError(422, '지원하지 않는 작업입니다.')
    const db = open(id), filename = db.prepare('PRAGMA database_list').all().find(r => r.name === 'main').file
    // Serialize subprocess operations per workspace; SQLite transactions also protect normal web writes.
    const previous = running.get(id) || Promise.resolve()
    const next = previous.catch(() => {}).then(() => invoke(filename, { ...input, actor }))
    running.set(id, next)
    try { return { result: await next } } finally { if (running.get(id) === next) running.delete(id) }
  }
  return { state, table, archive, status, registry, snapshot, bootstrap, settings, bindPanels, runtime, call }
}

function invoke(filename, request) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(python, [resolve(root, 'server/storage_worker.py'), filename], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', size = 0
    child.stdout.setEncoding('utf8')
    const timer = setTimeout(() => child.kill(), 25000)
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 64 * 1024 * 1024) child.kill(); else output += chunk.toString('utf8') })
    child.stderr.resume()
    child.on('error', () => { clearTimeout(timer); reject(new ApiError(503, '웹 데이터 처리기를 시작하지 못했습니다. 서버의 Python 설정을 확인하세요.')) })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const response = JSON.parse(output)
        if (!response.ok) return reject(new ApiError(response.error === 'stale_revision' ? 409 : 422, response.error === 'stale_revision' ? '다른 작업으로 데이터가 변경되었습니다. 새로고침하세요.' : '입력 값이나 데이터 연결 관계를 확인하세요.'))
        resolveResult(response.result)
      } catch { reject(new ApiError(503, '웹 데이터 처리에 실패했습니다. 원본 데이터는 유지됩니다.')) }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(request))
  })
}

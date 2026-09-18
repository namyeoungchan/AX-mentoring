import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, renameSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync, gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { createRuntime } from './runtime.mjs'
import { createDataMaintenance, decodeBackup, recoverDataMaintenance } from './data-maintenance.mjs'

const env = { NODE_ENV: 'production', ADMIN_PASSWORD: 'initial-setup-key-12345', LEARNINGOPS_AUTH_GUILD_ID: '123456789012345678' }
async function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ax-data-maintenance-')), dbPath = join(dir, 'main.db')
  let runtime = createRuntime(dbPath, env), failOpen = false
  const maintenance = createDataMaintenance({ dbPath, env: { ...env, ...overrides }, getRuntime: () => runtime,
    closeRuntime: () => runtime.close(), openRuntime: () => {
      if (failOpen) { failOpen = false; throw new Error('Injected reopen failure') }
      runtime = createRuntime(dbPath, env)
    } })
  const login = await runtime.auth.setup({ username: 'data.admin', name: '총관리자', password: 'admin-password-12345', setupKey: env.ADMIN_PASSWORD })
  t.after(() => { runtime.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, dbPath, maintenance, login, get runtime() { return runtime }, failNextOpen() { failOpen = true } }
}
function modify(bytes, action) {
  const envelope = JSON.parse(gunzipSync(bytes)), data = JSON.parse(envelope.payload)
  action(data)
  envelope.payload = JSON.stringify(data)
  envelope.sha256 = createHash('sha256').update(envelope.payload).digest('hex')
  return gzipSync(JSON.stringify(envelope))
}

test('backup/reset/restore covers archived workspaces, credentials, sequences, WAL and automatic recovery downloads', async t => {
  const f = await fixture(t), m = f.maintenance
  const extra = f.runtime.workspaces.create({ name: '보관 과정' })
  f.runtime.workspaces.setArchived(extra.id, true, f.login.user)
  const db = f.runtime.workspaces.open(extra.id).db
  db.prepare("INSERT INTO mentors(discord_id,name) VALUES('123456789012345679','보관 멘토')").run()
  db.prepare("INSERT INTO lms_attendance_codes VALUES('code','hash','course','2026-09-18',1,'guild','actor','[]',0,9999999999999,NULL)").run()
  db.prepare("INSERT INTO lms_outbox(id,event_key,kind,source_id,payload,actor,created_at,state) VALUES('pending','pending','notice','n','{}','admin',0,'pending'),('sent','sent','notice','s','{}','admin',0,'sent'),('manual','manual','notice','m','{}','admin',0,'manual')").run()
  const bytes = await m.exclusive(() => m.backup())
  assert.equal(decodeBackup(bytes).databases.length, 3)
  const reset = await m.exclusive(() => m.replace('reset', null, f.login.user.id))
  assert.equal(f.runtime.store.db.prepare('SELECT COUNT(*) n FROM lms_users').get().n, 0)
  assert.equal(f.runtime.store.db.prepare('SELECT COUNT(*) n FROM lms_workspace_guilds').get().n, 0)
  assert.equal(f.runtime.auth.setupEnabled(), true)
  assert.equal(f.runtime.auth.session(f.login.token), null)
  assert.equal(m.backups().length, 1)
  assert.deepEqual(decodeBackup(m.download(reset.backupId)).databases.map(x => x.id), decodeBackup(bytes).databases.map(x => x.id))
  const fresh = await f.runtime.auth.setup({ username: 'new.admin', name: '새 관리자', password: 'new-admin-password', setupKey: env.ADMIN_PASSWORD })
  const preview = await m.exclusive(() => m.preview(bytes, fresh.user.id))
  assert.equal(preview.accounts, 1)
  assert.equal(preview.workspaces, 3)
  await assert.rejects(m.exclusive(() => m.replace('restore', preview.token, 'someone-else')), /다시 선택/)
  await m.exclusive(() => m.replace('restore', preview.token, fresh.user.id))
  const restored = f.runtime.workspaces.open(extra.id).db
  assert.equal(restored.prepare('SELECT name FROM mentors').get().name, '보관 멘토')
  assert.equal(restored.prepare('SELECT expires_at FROM lms_attendance_codes').get().expires_at, 0)
  assert.equal(f.runtime.workspaces.metadata(extra.id).archivedAt !== null, true)
  assert.equal(f.runtime.auth.session(f.login.token), null)
  assert.equal(f.runtime.auth.session(fresh.token), null)
  assert.equal((await f.runtime.auth.login({ username: 'data.admin', password: 'admin-password-12345' })).user.id, f.login.user.id)
  assert.deepEqual(restored.prepare('SELECT id,state FROM lms_outbox ORDER BY id').all().map(r => [r.id,r.state]), [['manual','manual'],['pending','held'],['sent','sent']])
  assert.equal(m.backups().length, 2)
  assert.equal(restored.prepare("INSERT INTO mentors(discord_id,name) VALUES('123456789012345680','다음 멘토') RETURNING id").get().id, 2)
})

test('malformed, tampered, duplicate, path traversal, SQL identifiers and broken relationships never change live data', async t => {
  const f = await fixture(t), m = f.maintenance, bytes = m.backup()
  for (const bad of [Buffer.from('not a backup'), bytes.subarray(0, bytes.length - 10),
    modify(bytes, data => { data.databases.push(data.databases[0]) }),
    modify(bytes, data => { data.databases[1].id = '../escape' }),
    modify(bytes, data => { data.databases[0].tables[0].name = 'lms_users; DROP TABLE lms_users' }),
    modify(bytes, data => { data.databases[0].tables.find(t => t.name === 'lms_workspace_members').rows.push(['missing', 'missing', 'admin', 0]) }),
    modify(bytes, data => { data.databases = data.databases.filter(d => d.id === 'main') }),
  ]) assert.throws(() => m.preview(bad, f.login.user.id), /백업 파일/)
  const envelope = JSON.parse(gunzipSync(bytes)); envelope.payload += ' '
  assert.throws(() => m.preview(gzipSync(JSON.stringify(envelope)), f.login.user.id), /백업 파일/)
  assert.equal(f.runtime.auth.session(f.login.token).id, f.login.user.id)
  assert.equal(m.backups().length, 0)
})

test('a failed runtime reopen rolls every database back and keeps a usable safety backup', async t => {
  const f = await fixture(t), m = f.maintenance
  f.runtime.workspaces.open('asan-ax').db.prepare("INSERT INTO mentors(discord_id,name) VALUES('123456789012345679','원본')").run()
  f.failNextOpen()
  await assert.rejects(m.exclusive(() => m.replace('reset', null, f.login.user.id)), /Injected/)
  assert.equal(f.runtime.auth.session(f.login.token).id, f.login.user.id)
  assert.equal(f.runtime.workspaces.open('asan-ax').db.prepare('SELECT name FROM mentors').get().name, '원본')
  assert.equal(m.backups().length, 1)
  assert.equal(m.busy, false)
})

test('maintenance drains async work, rejects concurrent operations and releases its gate on errors', async t => {
  const f = await fixture(t), m = f.maintenance
  let release, ran = false
  const running = m.track(() => new Promise(resolve => { release = resolve }))({}, {})
  const operation = m.exclusive(() => { ran = true })
  assert.equal(m.busy, true); assert.equal(ran, false)
  await assert.rejects(m.exclusive(() => {}), /작업 중/)
  release(); await running; await operation
  assert.equal(ran, true); assert.equal(m.busy, false)
  await assert.rejects(m.exclusive(() => { throw new Error('failed') }), /failed/)
  assert.equal(m.busy, false)
})

test('reset refuses missing bootstrap key; destructive reauthentication requires a real platform admin', async t => {
  const f = await fixture(t, { ADMIN_PASSWORD: '' })
  await assert.rejects(f.maintenance.exclusive(() => f.maintenance.replace('reset', null, f.login.user.id)), /설정 키/)
  await assert.rejects(f.runtime.auth.confirmAdmin({ id: 'admin', role: 'admin' }, 'anything'), /관리자/)
  await assert.rejects(f.runtime.auth.confirmAdmin(f.login.user, 'incorrect'), /비밀번호/)
  await f.runtime.auth.confirmAdmin(f.login.user, 'admin-password-12345')
  assert.equal(f.runtime.auth.session(f.login.token).id, f.login.user.id)
})

test('backup validation preserves submission rows without executing notification triggers', async t => {
  const f = await fixture(t), db = f.runtime.workspaces.open('asan-ax').db
  db.prepare("INSERT INTO assignments(id,week,title,due_date) VALUES(1,1,'과제','2030-01-01')").run()
  db.prepare("INSERT INTO submissions(assignment_id,user_id,user_name,content) VALUES(1,'student','학생','제출')").run()
  const count = db.prepare('SELECT COUNT(*) n FROM lms_outbox').get().n
  assert.equal(count, 1)
  const bytes = f.maintenance.backup(), preview = f.maintenance.preview(bytes, f.login.user.id)
  await f.maintenance.exclusive(() => f.maintenance.replace('restore', preview.token, f.login.user.id))
  const restored = f.runtime.workspaces.open('asan-ax').db
  assert.equal(restored.prepare('SELECT COUNT(*) n FROM submissions').get().n, 1)
  assert.equal(restored.prepare('SELECT COUNT(*) n FROM lms_outbox').get().n, count)
  assert.equal(restored.prepare('SELECT state FROM lms_outbox').get().state, 'held')
})

test('startup recovery rolls back an interrupted multi-file install using fixed paths', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ax-recovery-')), file = join(dir, 'main.db'), job = file + '.maintenance'
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(job, 'previous', 'workspaces'), { recursive: true })
  writeFileSync(join(job, 'previous', 'main.db'), 'original')
  writeFileSync(join(job, 'previous', 'workspaces', 'a.db'), 'workspace-original')
  writeFileSync(file, 'partial replacement')
  writeFileSync(file + '-wal', 'partial WAL')
  mkdirSync(file + '.workspaces')
  writeFileSync(join(job, 'journal.json'), JSON.stringify({ state: 'installing', existed: { main: true, workspaces: true } }))
  recoverDataMaintenance(file)
  assert.equal(readFileSync(file, 'utf8'), 'original')
  assert.equal(readFileSync(join(file + '.workspaces', 'a.db'), 'utf8'), 'workspace-original')
  assert.equal(existsSync(file + '-wal'), false)
  assert.equal(existsSync(job), false)
  // An interruption before the second rename must retain that untouched original.
  mkdirSync(join(job, 'previous'), { recursive: true })
  renameSync(file, join(job, 'previous', 'main.db'))
  writeFileSync(join(job, 'journal.json'), JSON.stringify({ state: 'installing', existed: { main: true, workspaces: true } }))
  recoverDataMaintenance(file)
  assert.equal(readFileSync(file, 'utf8'), 'original')
  assert.equal(readFileSync(join(file + '.workspaces', 'a.db'), 'utf8'), 'workspace-original')
})
